// Jornada de conta pelo HTTP real: sobe `next start` contra um banco descartável criado em
// SAAS_TEST_DATABASE_URL (nunca DATABASE_URL) e percorre cadastro com convite, link de confirmação
// com ?invite=, confirmação, login com convite pendente, convite sem clique e redirecionamento de
// /acesso para contas liberadas. Exige `npm run build` antes. Sem credenciais reais nem e-mails enviados.
//   SAAS_TEST_DATABASE_URL=postgresql://usuario:senha@127.0.0.1:5432/postgres npm run test:jornada
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { Pool } from "pg";

const url = process.env.SAAS_TEST_DATABASE_URL;
if (!url) throw new Error("Defina SAAS_TEST_DATABASE_URL (servidor PostgreSQL de teste com permissão CREATE DATABASE).");
const base = new URL(url);
base.searchParams.delete("options");
const name = "tenant_jornada_" + randomUUID().replaceAll("-", "");
const admin = new Pool({ connectionString: base.toString(), max: 1, connectionTimeoutMillis: 5000 });
await admin.query(`CREATE DATABASE ${name}`);
const testUrl = new URL(base); testUrl.pathname = "/" + name;
const port = 3900 + Math.floor(Math.random() * 100);
const origin = `http://127.0.0.1:${port}`;
// Ambiente próprio: o `next start` lê .env, mas não sobrescreve o que já está definido aqui.
Object.assign(process.env, {
  DATABASE_URL: testUrl.toString(), APP_URL: origin, CHAVE_MESTRA: randomBytes(32).toString("base64"),
  RESEND_API_KEY: "test-resend-key", RESEND_FROM: "Agentflows <test@example.com>", REDIS_URL: "", DATA_DIR: process.env.DATA_DIR || "",
});
let server;
const log = [];
try {
  const { saasDatabase } = await import("../lib/saas-db.ts");
  const { migrateDatabase } = await import("../lib/db/migrate.ts");
  const { hashToken, unseal } = await import("../lib/saas-security.ts");
  const db = saasDatabase();
  await migrateDatabase(db);
  const CODE = "convite-jornada-" + randomUUID().slice(0, 8);
  await db.query("INSERT INTO invites(id,code_hash,max_uses) VALUES ($1,$2,5)", [randomUUID(), hashToken(CODE)]);
  async function latestLink(email) {
    const { rows } = await db.query("SELECT id,payload_ciphertext FROM mail_outbox ORDER BY created_at DESC");
    for (const row of rows) { const mail = JSON.parse(unseal(row.payload_ciphertext, `mail:${row.id}`)); if (mail.to === email) return new URL(mail.text.match(/https?:\/\/\S+/)[0]); }
    throw new Error("sem e-mail para " + email);
  }
  async function account(email, status, verified) {
    const { registerUser, loginUser } = await import("../lib/saas-auth.ts");
    const password = "Senha-Forte-2026!";
    await registerUser(db, { name: "Conta", email, password }, "127.0.0.1");
    await db.query("UPDATE users SET beta_status=$2, email_verified_at=$3 WHERE email=$1", [email, status, verified ? new Date() : null]);
    return `agentflows_session=${(await loginUser(db, { email, password }, "127.0.0.1")).token}`;
  }
  const released = await account("liberada@example.com", "approved", true);
  const pending = await account("pendente@example.com", "pending", true);
  const unverified = await account("semconfirmar@example.com", "pending", false);

  server = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "start", "-p", String(port)], { cwd: new URL("..", import.meta.url), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  for (let i = 0; ; i++) {
    try { if ((await fetch(origin + "/entrar", { redirect: "manual" })).status === 200) break; } catch { /* ainda subindo */ }
    if (i === 120) throw new Error("A aplicação não subiu:\n" + log.join(""));
    await new Promise((r) => setTimeout(r, 500));
  }
  const cookieOf = (r, n) => (r.headers.getSetCookie().find((c) => c.startsWith(n + "=")) || "").split(";")[0];
  const get = (path, cookie = "") => fetch(origin + path, { redirect: "manual", headers: { cookie } });
  const post = (action, body, cookie = "") => fetch(`${origin}/api/auth/${action}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", origin, cookie }, body: JSON.stringify(body) });
  const location = (r) => new URL(r.headers.get("location"), origin).pathname;
  const results = [];
  const step = (label, value) => results.push({ etapa: label, resultado: value });

  // /acesso: liberada redireciona (limpando o convite guardado); pendente, sem confirmar e sem sessão veem a página.
  const acesso = await get(`/acesso?invite=${CODE}`, released);
  assert.equal(acesso.status, 307); assert.equal(location(acesso), "/");
  assert.match(cookieOf(acesso, "agentflows_invite"), /=$/, "cookie de convite limpo");
  step("liberada em /acesso", `307 → /`);
  for (const [label, cookie] of [["pendente", pending], ["sem confirmar", unverified], ["sem sessão", ""]]) {
    assert.equal((await get("/acesso", cookie)).status, 200); step(`${label} em /acesso`, 200);
  }
  assert.equal((await get("/", released)).status, 200);
  const home = await get("/", pending); assert.equal(home.status, 307); assert.equal(location(home), "/acesso");
  step("pendente em /", "307 → /acesso");

  // Cadastro com ?invite=: cookie pelo proxy, convite no corpo, link de confirmação com ?invite=.
  const conta = await get(`/conta?invite=${CODE}`);
  const inviteCookie = cookieOf(conta, "agentflows_invite");
  assert.equal(conta.status, 200); assert.ok(inviteCookie.includes(encodeURIComponent(CODE)));
  const email = "jornada@example.com", password = "Senha-Forte-2026!";
  assert.equal((await post("register", { name: "Jornada", email, password, confirmPassword: password, invite: CODE })).status, 202);
  const link = await latestLink(email);
  assert.equal(link.pathname, "/verificar-email"); assert.equal(link.searchParams.get("invite"), CODE);
  step("link de confirmação", link.pathname + link.search);
  // Abrir o link guarda o convite; a tela confirma sozinha com o POST.
  const open = await fetch(link.toString(), { redirect: "manual" });
  assert.equal(open.status, 200); assert.ok(cookieOf(open, "agentflows_invite").includes(encodeURIComponent(CODE)));
  assert.equal((await post("verify-email", { token: new URLSearchParams(link.hash.slice(1)).get("token") })).status, 200);
  step("confirmação pelo link", 200);
  // Login com o convite guardado: resposta avisa invitePending; a tela usa o convite sem clique.
  const login = await post("login", { email, password }, inviteCookie);
  assert.equal(login.status, 200);
  const session = cookieOf(login, "agentflows_session");
  const body = await login.json();
  assert.equal(body.invitePending, true); assert.equal(body.user.beta_status, "pending");
  const redeem = await post("invite", {}, `${session}; ${inviteCookie}`);
  assert.equal(redeem.status, 200, await redeem.text());
  step("login + convite sem clique", redeem.status);
  assert.equal((await (await fetch(`${origin}/api/auth/session`, { headers: { cookie: session } })).json()).user.beta_status, "approved");
  const after = await get("/acesso", session); assert.equal(after.status, 307); assert.equal(location(after), "/");
  assert.equal((await get("/", session)).status, 200);
  step("conta liberada após o convite", "/acesso 307 → /, / 200");
  // Convite pelo código do ?invite= da URL de login (sem cookie).
  const email2 = "jornada2@example.com";
  assert.equal((await post("register", { name: "Dois", email: email2, password, confirmPassword: password })).status, 202);
  assert.equal((await latestLink(email2)).searchParams.has("invite"), false);
  assert.equal((await post("verify-email", { token: new URLSearchParams((await latestLink(email2)).hash.slice(1)).get("token") })).status, 200);
  const login2 = await post("login", { email: email2, password });
  assert.equal((await login2.json()).invitePending, false);
  const session2 = cookieOf(login2, "agentflows_session");
  assert.equal((await post("invite", { code: CODE }, session2)).status, 200);
  assert.equal((await get("/acesso", session2)).status, 307);
  step("convite pelo código da URL", "200, /acesso 307");
  console.table(results);
  console.log("Jornada de conta verificada pelo HTTP real.");
} finally {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  try { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); }
}
