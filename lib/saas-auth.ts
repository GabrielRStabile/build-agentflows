import { randomUUID } from "node:crypto";
import type { Database, Sql } from "./saas-db";
import { AuthError, hashToken, normalizedEmail, passwordHash, randomToken, validatePassword, verifyPassword } from "./saas-security";
import { enqueueAuthMail, enqueueExistingAccountMail } from "./saas-mail";
import { consumeRateLimit } from "./saas-rate-limit";

export type SaasUser = {
  id: string; name: string; email: string; email_verified_at: Date | null;
  beta_status: "pending" | "approved" | "blocked";
  /** Momento em que a conta resgatou um convite; ausente nas contas liberadas pelo administrador. */
  invited_at?: Date | string | null;
};
/** Campos da conta carregados no contexto do tenant (sessão e worker). */
export const TENANT_USER_FIELDS = "u.id,u.name,u.email,u.email_verified_at,u.beta_status,(SELECT r.redeemed_at FROM invite_redemptions r WHERE r.user_id=u.id) AS invited_at";
const USER_FIELDS = "id,name,email,email_verified_at,beta_status";
export const SAAS_SESSION_COOKIE = "agentflows_session";
export const SESSION_SECONDS = 30 * 86400;

export function requireBetaAccess(user: SaasUser | null): asserts user is SaasUser {
  if (!user) throw new AuthError("Entre na sua conta para continuar.", 401);
  if (!user.email_verified_at) throw new AuthError("Confirme seu e-mail para continuar.", 403);
  if (user.beta_status !== "approved") throw new AuthError(user.beta_status === "blocked" ? "Acesso suspenso." : "Aguarde sua liberação ou utilize um convite.", 403);
}

export async function findSession(sql: Sql, token: string | undefined): Promise<SaasUser | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { rows } = await sql.query<SaasUser>(`SELECT ${TENANT_USER_FIELDS}
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [hashToken(token)]);
  // No process cache: an admin's database change takes effect on the next request.
  return rows[0] || null;
}

async function newSession(sql: Sql, id: string) {
  const token = randomToken();
  await sql.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+$3*interval '1 second')", [hashToken(token), id, SESSION_SECONDS]);
  return token;
}
export async function revokeSession(sql: Sql, token: string | undefined) {
  if (token) await sql.query("DELETE FROM sessions WHERE token_hash=$1", [hashToken(token)]);
}
async function issueAction(sql: Sql, user: Pick<SaasUser, "id" | "email">, purpose: "verify_email" | "reset_password") {
  const token = randomToken();
  await sql.query("DELETE FROM action_tokens WHERE user_id=$1 AND purpose=$2", [user.id, purpose]);
  await sql.query(`INSERT INTO action_tokens(token_hash,user_id,purpose,expires_at)
    VALUES ($1,$2,$3,now()+$4*interval '1 second')`, [hashToken(token), user.id, purpose, purpose === "verify_email" ? 86400 : 1800]);
  await enqueueAuthMail(sql, user.email, purpose, token);
}

export async function registerUser(db: Database, data: { name: unknown; email: unknown; password: unknown }, client: string) {
  await consumeRateLimit(db, `register:ip:${client}`, 5, 3600);
  const email = normalizedEmail(data.email);
  if (typeof data.name !== "string" || !data.name.trim() || data.name.trim().length > 120) throw new AuthError("Informe um nome com até 120 caracteres.");
  validatePassword(data.password);
  const encoded = await passwordHash(data.password);
  const name = data.name.trim();
  // A duplicate gets the same HTTP outcome; never sign in or replace an existing account.
  const created = await db.transaction(async (sql) => {
    const { rows } = await sql.query<SaasUser>(`INSERT INTO users(id,name,email,password_hash) VALUES ($1,$2,$3,$4)
      ON CONFLICT(email) DO NOTHING RETURNING ${USER_FIELDS}`, [randomUUID(), name, email, encoded]);
    if (rows[0]) await issueAction(sql, rows[0], "verify_email");
    return !!rows[0];
  });
  if (created) return;
  // E-mail já cadastrado: a dona da conta recebe a confirmação pendente de novo ou um aviso de que já tem conta.
  // A resposta ao navegador é a mesma; o limite por e-mail impede usar o cadastro para encher a caixa de alguém.
  await consumeRateLimit(db, `mail:email:${email}`, 3, 3600);
  await db.transaction(async (sql) => {
    const { rows } = await sql.query<SaasUser>(`SELECT ${USER_FIELDS} FROM users WHERE email=$1 FOR UPDATE`, [email]);
    const existing = rows[0];
    if (!existing || existing.beta_status === "blocked") return;
    if (existing.email_verified_at) await enqueueExistingAccountMail(sql, email);
    else await issueAction(sql, existing, "verify_email");
  });
}

export async function loginUser(db: Database, data: { email: unknown; password: unknown }, client: string) {
  await consumeRateLimit(db, `login:ip:${client}`, 20, 60);
  const email = normalizedEmail(data.email);
  await consumeRateLimit(db, `login:email:${email}`, 10, 900);
  const { rows } = await db.query<SaasUser & { password_hash: string | null }>(`SELECT ${USER_FIELDS},password_hash FROM users WHERE email=$1`, [email]);
  const user = rows[0];
  const valid = await verifyPassword(data.password, user?.password_hash || null);
  if (!user || !valid) throw new AuthError("E-mail ou senha não conferem.", 401);
  if (user.beta_status === "blocked") throw new AuthError("Acesso suspenso.", 403);
  return db.transaction(async (sql) => {
    // Lock and compare after the KDF: a concurrent password reset must not create a stale session.
    const current = await sql.query<SaasUser & { password_hash: string }>(`SELECT ${USER_FIELDS},password_hash FROM users WHERE id=$1 FOR UPDATE`, [user.id]);
    if (!current.rows[0] || current.rows[0].password_hash !== user.password_hash) throw new AuthError("E-mail ou senha não conferem.", 401);
    if (current.rows[0].beta_status === "blocked") throw new AuthError("Acesso suspenso.", 403);
    const { password_hash: _hash, ...publicUser } = current.rows[0];
    void _hash;
    return { user: publicUser, token: await newSession(sql, user.id) };
  });
}

export async function requestActionMail(db: Database, emailInput: unknown, purpose: "verify_email" | "reset_password", client: string) {
  await consumeRateLimit(db, `mail:ip:${client}`, 10, 3600);
  const email = normalizedEmail(emailInput);
  await consumeRateLimit(db, `mail:email:${email}`, 3, 3600);
  await db.transaction(async (sql) => {
    const { rows } = await sql.query<SaasUser>(`SELECT ${USER_FIELDS} FROM users WHERE email=$1 FOR UPDATE`, [email]);
    const user = rows[0];
    if (!user || user.beta_status === "blocked" || (purpose === "verify_email" && user.email_verified_at)) return;
    await issueAction(sql, user, purpose);
  });
}

export async function consumeActionToken(db: Database, token: unknown, purpose: "verify_email" | "reset_password", password?: unknown) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AuthError("Link inválido ou expirado.");
  let encoded: string | undefined;
  if (purpose === "reset_password") { validatePassword(password); encoded = await passwordHash(password); }
  return db.transaction(async (sql) => {
    // Lock the user before tokens, consistently with login and issuance.
    const { rows } = await sql.query<SaasUser>(`SELECT u.id,u.name,u.email,u.email_verified_at,u.beta_status
      FROM users u JOIN action_tokens t ON t.user_id=u.id
      WHERE t.token_hash=$1 AND t.purpose=$2 AND t.expires_at>now() FOR UPDATE OF u`, [hashToken(token), purpose]);
    const user = rows[0];
    if (!user || user.beta_status === "blocked") throw new AuthError("Link inválido ou expirado.");
    const consumed = await sql.query("DELETE FROM action_tokens WHERE token_hash=$1 AND purpose=$2 AND expires_at>now() RETURNING user_id", [hashToken(token), purpose]);
    if (!consumed.rows.length) throw new AuthError("Link inválido ou expirado.");
    if (purpose === "verify_email") {
      await sql.query("UPDATE users SET email_verified_at=coalesce(email_verified_at,now()) WHERE id=$1", [user.id]);
    } else {
      await sql.query("UPDATE users SET password_hash=$2 WHERE id=$1", [user.id, encoded]);
      await sql.query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
      await sql.query("DELETE FROM action_tokens WHERE user_id=$1 AND purpose='reset_password'", [user.id]);
    }
  });
}

export async function redeemInvite(db: Database, userId: string, code: unknown) {
  await consumeRateLimit(db, `invite:${userId}`, 10, 3600);
  if (typeof code !== "string" || code.trim().length < 8 || code.length > 128) throw new AuthError("Convite inválido, esgotado ou expirado.");
  return db.transaction(async (sql) => {
    const { rows } = await sql.query<SaasUser>(`SELECT ${USER_FIELDS} FROM users WHERE id=$1 FOR UPDATE`, [userId]);
    const user = rows[0];
    if (!user || !user.email_verified_at || user.beta_status === "blocked") throw new AuthError("Confirme sua conta antes de utilizar um convite.", 403);
    // Idempotent even if a client retries after a successful commit and lost response.
    if (user.beta_status === "approved") return;
    const previous = await sql.query("SELECT 1 FROM invite_redemptions WHERE user_id=$1", [userId]);
    if (previous.rows.length) throw new AuthError("Esta conta já utilizou um convite. Aguarde a liberação do administrador.", 403);
    const invite = await sql.query<{ id: string }>(`UPDATE invites SET uses=uses+1
      WHERE code_hash=$1 AND uses<max_uses AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) RETURNING id`, [hashToken(code.trim())]);
    if (!invite.rows[0]) throw new AuthError("Convite inválido, esgotado ou expirado.");
    await sql.query("INSERT INTO invite_redemptions(user_id,invite_id) VALUES ($1,$2)", [userId, invite.rows[0].id]);
    await sql.query("UPDATE users SET beta_status='approved',approved_at=now() WHERE id=$1", [userId]);
  });
}

export async function loginGoogleIdentity(db: Database, identity: { sub: string; email: string; name: string }) {
  const email = normalizedEmail(identity.email);
  return db.transaction(async (sql) => {
    const existing = await sql.query<SaasUser>(`SELECT ${USER_FIELDS} FROM users WHERE google_sub=$1 FOR UPDATE`, [identity.sub]);
    let user = existing.rows[0];
    if (!user) {
      const created = await sql.query<SaasUser>(`INSERT INTO users(id,name,email,google_sub,email_verified_at)
        VALUES ($1,$2,$3,$4,now()) ON CONFLICT DO NOTHING RETURNING ${USER_FIELDS}`,
      [randomUUID(), identity.name.trim().slice(0, 120) || email.split("@")[0], email, identity.sub]);
      user = created.rows[0];
      if (!user) {
        // Concurrent first sign-ins with the same Google subject are safe to reuse.
        const concurrent = await sql.query<SaasUser>(`SELECT ${USER_FIELDS} FROM users WHERE google_sub=$1 FOR UPDATE`, [identity.sub]);
        user = concurrent.rows[0];
      }
      // Do not silently attach a Google identity to an existing password account by email.
      if (!user) throw new AuthError("Já existe uma conta com este e-mail. Entre com sua senha.", 409);
    }
    if (user.beta_status === "blocked") throw new AuthError("Acesso suspenso.", 403);
    return { user, token: await newSession(sql, user.id) };
  });
}

export async function cleanupAuth(sql: Sql) {
  await sql.query("DELETE FROM sessions WHERE expires_at<=now()");
  await sql.query("DELETE FROM action_tokens WHERE expires_at<=now()");
  await sql.query("DELETE FROM oauth_states WHERE expires_at<=now()");
  await sql.query("DELETE FROM rate_limits WHERE resets_at<=now()");
  await sql.query("DELETE FROM mail_outbox WHERE coalesce(sent_at,failed_at)<now()-interval '7 days'");
}

export async function accountProfile(sql: Sql, userId: string) {
  const { rows } = await sql.query<{ name: string; email: string; has_password: boolean; google: boolean }>(
    "SELECT name,email,password_hash IS NOT NULL has_password,google_sub IS NOT NULL google FROM users WHERE id=$1", [userId]);
  if (!rows[0]) throw new AuthError("Conta não encontrada.", 404);
  return { name: rows[0].name, email: rows[0].email, hasPassword: rows[0].has_password, google: rows[0].google };
}

/** Requires the current password; other sessions are revoked and this one is kept. */
export async function changePassword(db: Database, userId: string, data: { current: unknown; password: unknown }, keepToken: string | undefined) {
  await consumeRateLimit(db, `password-change:${userId}`, 5, 900);
  const { rows } = await db.query<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id=$1", [userId]);
  if (!rows[0]?.password_hash) throw new AuthError("Esta conta entra com o Google e não tem senha.", 409);
  if (!(await verifyPassword(data.current, rows[0].password_hash))) throw new AuthError("A senha atual não confere.", 403);
  validatePassword(data.password);
  if (data.password === data.current) throw new AuthError("Escolha uma senha diferente da atual.");
  const encoded = await passwordHash(data.password);
  await db.transaction(async (sql) => {
    // Compare after the KDF: a concurrent reset must not be overwritten by a stale check.
    const updated = await sql.query("UPDATE users SET password_hash=$3 WHERE id=$1 AND password_hash=$2 RETURNING id", [userId, rows[0].password_hash, encoded]);
    if (!updated.rows.length) throw new AuthError("A senha foi alterada em outra sessão. Entre novamente.", 409);
    await sql.query("DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2", [userId, keepToken ? hashToken(keepToken) : ""]);
    await sql.query("DELETE FROM action_tokens WHERE user_id=$1 AND purpose='reset_password'", [userId]);
  });
}
