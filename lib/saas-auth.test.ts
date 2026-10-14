import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createTestDatabase } from "../scripts/saas-test-db";
import { generateKeyPair, SignJWT } from "jose";
import { migrateDatabase } from "./db/migrate";
import { registerUser, loginUser, findSession, requestActionMail, consumeActionToken, redeemInvite, requireBetaAccess, loginGoogleIdentity, revokeSession } from "./saas-auth";
import { appOrigin, hashToken, randomToken, seal, unseal, verifyPassword } from "./saas-security";
import { credentialsFor } from "./saas-credentials";
import { consumeRateLimit } from "./saas-rate-limit";
import { deliverAuthMail, mailStats } from "./saas-mail";
import { beginGoogleLogin, finishGoogleLogin, verifyGoogleIdToken } from "./saas-google";
import { authAction } from "./saas-http";

// Runs against PGlite or an isolated PostgreSQL server schema.
const testDb = await createTestDatabase();
const { db } = testDb;
process.env.CHAVE_MESTRA = randomBytes(32).toString("base64");
process.env.APP_URL = "https://app.example.com";
process.env.RESEND_API_KEY = "test-resend-key";
process.env.RESEND_FROM = "Agentflows <test@example.com>";
process.env.GOOGLE_CLIENT_ID = "test-google-client";
process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
const password = "Senha-Segura-2026!";

test("origem permite Docker em loopback e exige HTTPS em domínios públicos", () => {
  const previous = process.env.APP_URL;
  try {
    for (const origin of ["http://localhost:3019", "http://127.0.0.1:3019", "https://app.example.com"]) {
      process.env.APP_URL = origin;
      assert.equal(appOrigin(), origin);
    }
    for (const origin of ["http://app.example.com", "http://localhost.evil.example", "https://user:pass@app.example.com", "https://app.example.com/path"]) {
      process.env.APP_URL = origin;
      assert.throws(appOrigin, /HTTPS/);
    }
  } finally { process.env.APP_URL = previous; }
});

test.before(async () => { await migrateDatabase(db); await migrateDatabase(db); });
test.after(() => testDb.close());
test.beforeEach(async () => {
  await testDb.exec("TRUNCATE users,invites,rate_limits,mail_outbox,oauth_states CASCADE");
});

async function register(email: string) {
  await registerUser(db, { name: "Pessoa teste", email, password }, email);
  return (await loginUser(db, { email, password }, email));
}
async function actionToken(email: string) {
  const result = await db.query<{ id: string; payload_ciphertext: string }>("SELECT id,payload_ciphertext FROM mail_outbox ORDER BY created_at DESC");
  for (const row of result.rows) {
    if (!row.payload_ciphertext) continue;
    const mail = JSON.parse(unseal(row.payload_ciphertext, `mail:${row.id}`));
    if (mail.to === email) return new URLSearchParams(new URL(mail.text.match(/https:\/\/\S+/)[0]).hash.slice(1)).get("token")!;
  }
  throw new Error("Email não encontrado.");
}
async function verified(email: string) {
  const account = await register(email);
  await consumeActionToken(db, await actionToken(email), "verify_email");
  return account;
}

test("sessão HTTP retorna só o usuário autenticado e logout revoga seu perfil", async () => {
  const account = await register("profile@example.com");
  const request = () => new Request("https://app.example.com/api/auth/session", { headers: { cookie: `agentflows_session=${account.token}` } });
  const response = await authAction(db, request(), "session");
  const result = await response.json();
  assert.equal(result.user.name, "Pessoa teste");
  assert.equal(result.user.id, account.user.id);
  assert.equal(result.user.password_hash, undefined);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  const logout = await authAction(db, new Request("https://app.example.com/api/auth/logout", { method: "POST", headers: { cookie: `agentflows_session=${account.token}`, origin: "https://app.example.com" } }), "logout");
  assert.equal(logout.status, 200);
  assert.equal((await (await authAction(db, request(), "session")).json()).user, null);
});
async function invite(code: string, limit: number, expires?: string) {
  const id = randomUUID();
  await db.query("INSERT INTO invites(id,code_hash,max_uses,expires_at) VALUES ($1,$2,$3,$4)", [id, hashToken(code), limit, expires || null]);
  return id;
}

test("cadastro não libera beta; tokens não ficam em texto puro, verificação é de uso único", async () => {
  const { token, user } = await register("person@example.com");
  assert.equal(user.beta_status, "pending");
  assert.equal(user.email_verified_at, null);
  assert.throws(() => requireBetaAccess(user), /Confirme/);
  const action = await actionToken(user.email);
  const dump = JSON.stringify((await db.query("SELECT * FROM action_tokens")).rows);
  assert.ok(!dump.includes(action));
  assert.ok(!JSON.stringify((await db.query("SELECT * FROM sessions")).rows).includes(token));
  assert.ok(!JSON.stringify((await db.query("SELECT * FROM mail_outbox")).rows).includes(action));
  await assert.rejects(consumeActionToken(db, action, "reset_password", password));
  await consumeActionToken(db, action, "verify_email");
  await assert.rejects(consumeActionToken(db, action, "verify_email"));
  assert.throws(() => requireBetaAccess({ ...user, email_verified_at: new Date() }), /Aguarde/);
  await db.query("UPDATE users SET beta_status='approved',approved_at=now() WHERE id=$1", [user.id]);
  requireBetaAccess(await findSession(db, token));
  await db.query("UPDATE users SET beta_status='blocked' WHERE id=$1", [user.id]);
  const awaitUser = await findSession(db, token);
  assert.throws(() => requireBetaAccess(awaitUser), /suspenso/);
});

test("cadastro duplicado não substitui senha nem emite nova sessão ou novo e-mail", async () => {
  const a = await register("same@example.com");
  await registerUser(db, { name: "Outro", email: "SAME@example.com", password: "Outra-Senha-2026!" }, "another-ip");
  assert.equal((await db.query("SELECT * FROM users")).rows.length, 1);
  assert.equal((await db.query("SELECT * FROM mail_outbox")).rows.length, 1);
  assert.equal((await findSession(db, a.token))?.id, a.user.id);
  await assert.rejects(loginUser(db, { email: a.user.email, password: "Outra-Senha-2026!" }, "ip"));
});

test("convite limitado conta um uso por pessoa e registra auditoria; rejeita esgotado e expirado", async () => {
  const a = await verified("a@example.com"), b = await verified("b@example.com");
  const id = await invite("invite-unique", 1);
  await Promise.all([redeemInvite(db, a.user.id, "invite-unique"), redeemInvite(db, a.user.id, "invite-unique")]);
  assert.equal((await db.query("SELECT uses FROM invites WHERE id=$1", [id])).rows[0].uses, 1);
  assert.equal((await db.query("SELECT user_id FROM invite_redemptions")).rows[0].user_id, a.user.id);
  await assert.rejects(redeemInvite(db, b.user.id, "invite-unique"), /esgotado/);
  await invite("invite-expired", 1, "2020-01-01T00:00:00Z");
  await assert.rejects(redeemInvite(db, b.user.id, "invite-expired"), /expirado/);
  requireBetaAccess(await findSession(db, a.token));
  assert.throws(() => requireBetaAccess(b.user));
});

test("resgates de contas concorrentes não ultrapassam limite; conta não verificada não consome", async () => {
  const a = await verified("a@example.com"), b = await verified("b@example.com"), c = await register("c@example.com");
  await invite("limited-invite", 1);
  await assert.rejects(redeemInvite(db, c.user.id, "limited-invite"), /Confirme/);
  const results = await Promise.allSettled([redeemInvite(db, a.user.id, "limited-invite"), redeemInvite(db, b.user.id, "limited-invite")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await db.query("SELECT uses FROM invites")).rows[0].uses, 1);
});

test("link de convite fica no cookie até a conta confirmada usá-lo; esgotado limpa e logout descarta", async () => {
  await invite("link-invite-1", 1);
  const pending = await register("link@example.com");
  const call = (action: string, token: string, cookie = "", body?: unknown) => authAction(db, new Request(`https://app.example.com/api/auth/${action}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: `agentflows_session=${token}${cookie ? `; ${cookie}` : ""}`, origin: "https://app.example.com", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), action);
  const cookie = "agentflows_invite=link-invite-1";
  assert.equal((await (await call("session", pending.token, cookie)).json()).invitePending, true);
  assert.equal((await (await call("session", pending.token)).json()).invitePending, false);
  // Not confirmed yet: the invite is neither consumed nor discarded.
  const early = await call("invite", pending.token, cookie, {});
  assert.equal(early.status, 403);
  assert.equal(early.headers.get("set-cookie"), null);
  assert.equal((await db.query("SELECT uses FROM invites")).rows[0].uses, 0);
  await consumeActionToken(db, await actionToken("link@example.com"), "verify_email");
  const redeemed = await call("invite", pending.token, cookie, {});
  assert.equal(redeemed.status, 200);
  assert.match(redeemed.headers.get("set-cookie")!, /^agentflows_invite=; .*Max-Age=0/);
  requireBetaAccess(await findSession(db, pending.token));
  const other = await verified("other-link@example.com");
  const exhausted = await call("invite", other.token, cookie, {});
  assert.equal(exhausted.status, 400);
  assert.match(exhausted.headers.get("set-cookie")!, /^agentflows_invite=; .*Max-Age=0/);
  const logout = await call("logout", other.token, cookie, {});
  assert.ok(logout.headers.getSetCookie().some((value) => /^agentflows_invite=; .*Max-Age=0/.test(value)));
});

test("recuperação não revela conta inexistente, invalida sessões e exige token válido", async () => {
  const a = await verified("recover@example.com");
  await requestActionMail(db, "missing@example.com", "reset_password", "ip");
  assert.equal((await db.query("SELECT * FROM mail_outbox")).rows.length, 1);
  await requestActionMail(db, a.user.email, "reset_password", "ip");
  const token = await actionToken(a.user.email);
  await consumeActionToken(db, token, "reset_password", "Nova-Senha-2026!");
  assert.equal(await findSession(db, a.token), null);
  await assert.rejects(consumeActionToken(db, token, "reset_password", password));
  await assert.rejects(loginUser(db, { email: a.user.email, password }, "ip"));
  const next = await loginUser(db, { email: a.user.email, password: "Nova-Senha-2026!" }, "ip");
  await revokeSession(db, next.token);
  assert.equal(await findSession(db, next.token), null);
  assert.equal(await verifyPassword("wrong", null), false);
});

test("credenciais são privadas por usuário e ciphertext não pode ser movido entre contas ou serviços", async () => {
  const a = await verified("a@example.com"), b = await verified("b@example.com");
  const ca = credentialsFor(db, a.user.id), cb = credentialsFor(db, b.user.id);
  await ca.set("REPLICATE_API_TOKEN", "secret-A");
  await cb.set("REPLICATE_API_TOKEN", "secret-B");
  assert.equal(await ca.get("REPLICATE_API_TOKEN"), "secret-A");
  assert.equal(await cb.get("REPLICATE_API_TOKEN"), "secret-B");
  const raw = (await db.query<{ ciphertext: string }>("SELECT ciphertext FROM credentials WHERE user_id=$1", [a.user.id])).rows[0].ciphertext;
  assert.ok(!raw.includes("secret-A"));
  await db.query("UPDATE credentials SET ciphertext=$2 WHERE user_id=$1", [b.user.id, raw]);
  await assert.rejects(cb.get("REPLICATE_API_TOKEN"));
  assert.throws(() => unseal(raw, `credential:${a.user.id}:MUAPI_API_KEY`));
  const cipher = seal("x", "purpose");
  assert.throws(() => unseal(cipher.replace(/^v2/, "v1"), "purpose"));
  await ca.set("REPLICATE_API_TOKEN", null);
  assert.equal(await ca.get("REPLICATE_API_TOKEN"), undefined);
});

test("rate limit atômico persiste entre chamadas e retorna espera", async () => {
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => consumeRateLimit(db, "same-user", 3, 60)));
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 3);
  await assert.rejects(consumeRateLimit(db, "same-user", 3, 60), (error: unknown) => {
    assert.equal((error as { status: number }).status, 429);
    assert.ok((error as { retryAfter: number }).retryAfter > 0); return true;
  });
  await consumeRateLimit(db, "other-user", 3, 60);
  await db.query("UPDATE rate_limits SET resets_at=now()-interval '1 minute'");
  await consumeRateLimit(db, "same-user", 3, 60);
});

test("Resend usa idempotência, retenta falhas e apaga conteúdo após envio", async () => {
  await register("mail@example.com");
  const keys: string[] = [];
  const sender: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.resend.com/emails");
    const payload = JSON.parse(String(init?.body)) as { text: string; html: string; to: string[] };
    assert.match(payload.text, /Confirme seu e-mail/);
    // Versão HTML com a logo servida pela própria aplicação e o mesmo link do texto.
    assert.match(payload.html, /<img src="https:\/\/app\.example\.com\/brand\/agentflows-logo\.png"/);
    assert.ok(payload.html.includes(payload.text.match(/https:\/\/\S+/)![0]));
    keys.push(new Headers(init?.headers).get("Idempotency-Key")!);
    return Response.json(keys.length === 1 ? { error: "unavailable" } : { id: "resend-id" }, { status: keys.length === 1 ? 503 : 200 });
  };
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => { logged.push(String(line)); };
  try {
    assert.deepEqual(await mailStats(db), { pending: 1, failedLast24h: 0, sentLast24h: 0, oldestPendingSeconds: 0, configured: true });
    await deliverAuthMail(db, sender);
    assert.equal((await db.query("SELECT sent_at FROM mail_outbox")).rows[0].sent_at, null);
    await db.query("UPDATE mail_outbox SET available_at=now()");
    await deliverAuthMail(db, sender);
  } finally { console.log = originalLog; }
  assert.equal(keys[0], keys[1]);
  const row = (await db.query("SELECT * FROM mail_outbox")).rows[0];
  assert.ok(row.sent_at);
  assert.equal(row.payload_ciphertext, "");
  assert.equal(await deliverAuthMail(db, sender), 0);
  // Cada tentativa deixa um registro com status e resultado, sem destinatário nem conteúdo.
  const events = logged.map((line) => JSON.parse(line) as { evento: string; status: number; resultado: string; tentativa: number });
  assert.deepEqual(events.map((e) => [e.evento, e.tentativa, e.status, e.resultado]), [["email_envio", 1, 503, "repetir"], ["email_envio", 2, 200, "enviado"]]);
  assert.ok(!logged.join("").includes("mail@example.com"));
  assert.deepEqual(await mailStats(db), { pending: 0, failedLast24h: 0, sentLast24h: 1, oldestPendingSeconds: 0, configured: true });
});

test("Google exige assinatura, audiência, nonce e e-mail verificado; não associa conta por coincidência de e-mail", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const sign = (claims: Record<string, unknown> = {}) => new SignJWT({ nonce: "nonce", email: "google@example.com", email_verified: true, ...claims })
    .setProtectedHeader({ alg: "RS256" }).setIssuer("https://accounts.google.com").setAudience(typeof claims.aud === "string" ? claims.aud : "test-google-client")
    .setSubject("google-subject").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const identity = await verifyGoogleIdToken(await sign(), "nonce", async () => publicKey);
  assert.equal(identity.email, "google@example.com");
  await assert.rejects(verifyGoogleIdToken(await sign(), "different", async () => publicKey));
  await assert.rejects(verifyGoogleIdToken(await sign({ email_verified: false }), "nonce", async () => publicKey));
  await assert.rejects(verifyGoogleIdToken(await sign({ aud: "foreign-client" }), "nonce", async () => publicKey));
  const other = await generateKeyPair("RS256");
  await assert.rejects(verifyGoogleIdToken(await sign(), "nonce", async () => other.publicKey));
  const login = await loginGoogleIdentity(db, identity);
  assert.equal(login.user.beta_status, "pending");
  assert.ok(login.user.email_verified_at);
  const again = await loginGoogleIdentity(db, identity);
  assert.equal(login.user.id, again.user.id);
  await register("password@example.com");
  await assert.rejects(loginGoogleIdentity(db, { sub: "different-subject", email: "password@example.com", name: "X" }), /senha/);
});

test("Google usa PKCE, vínculo ao navegador e state descartável antes da troca de código", async () => {
  const start = await beginGoogleLogin(db, "ip");
  const url = new URL(start.url);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.example.com/api/auth/google/callback");
  const state = url.searchParams.get("state");
  let calls = 0;
  const send: typeof fetch = async () => { calls++; return Response.json({}, { status: 400 }); };
  await assert.rejects(finishGoogleLogin(db, { state, binding: randomToken(), code: "code" }, send));
  assert.equal(calls, 0);
  await assert.rejects(finishGoogleLogin(db, { state, binding: start.binding, code: "code" }, send));
  assert.equal(calls, 1);
  await assert.rejects(finishGoogleLogin(db, { state, binding: start.binding, code: "code" }, send));
  assert.equal(calls, 1);
});
