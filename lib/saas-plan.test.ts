import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createTestDatabase } from "../scripts/saas-test-db";
import { migrateDatabase } from "./db/migrate";
import { withTenantJob } from "./tenant-context";
import { createTenantFlow, deleteTenantFlow } from "./tenant-flows";
import { enqueueRun } from "./saas-jobs";
import { accountUsage, AI_ACTION_URL, AI_ACTION_COUPON, PlanLimitError } from "./saas-plan";
import { createKnowledgeBase, saveKnowledgeSource, deleteKnowledgeSource } from "./tenant-knowledge";
import { DEFAULT_SPLITTER } from "./knowledge-types";
import { accountProfile, changePassword, loginUser } from "./saas-auth";
import { hashToken, passwordHash, randomToken } from "./saas-security";
import { httpError } from "./saas-http";
import { block } from "./flow-types";

const testDb = await createTestDatabase();
const { db } = testDb;
const a = randomUUID(), b = randomUUID();
const asA = <T>(action: () => T | Promise<T>) => withTenantJob(db, a, action);
const asB = <T>(action: () => T | Promise<T>) => withTenantJob(db, b, action);
process.env.CHAVE_MESTRA = randomBytes(32).toString("base64");
const previous = { flows: process.env.LIMITE_FLUXOS, runs: process.env.LIMITE_EXECUCOES_MES };
test.before(async () => { await migrateDatabase(db); process.env.LIMITE_FLUXOS = "5"; process.env.LIMITE_EXECUCOES_MES = "3"; });
test.after(async () => { process.env.LIMITE_FLUXOS = previous.flows; process.env.LIMITE_EXECUCOES_MES = previous.runs; await testDb.close(); });
test.beforeEach(async () => {
  await testDb.exec("TRUNCATE users CASCADE");
  for (const id of [a, b]) await db.query("INSERT INTO users(id,name,email,email_verified_at,beta_status) VALUES($1,'Pessoa teste',$2,now(),'approved')", [id, `${id}@example.com`]);
});
// Start → End runs for real without any AI connection.
const direct = () => createTenantFlow("Direto", false, { name: "Direto", description: "", graph: { nodes: [block("start", "inicio", 0, 0), block("end", "resposta", 300, 0)], edges: [{ id: "e1", source: "inicio", target: "resposta" }] } });
const isPlanLimit = (error: unknown) => error instanceof PlanLimitError && error.status === 403 && error.code === "plan_limit";

test("beta aceita até 5 fluxos por conta; excluir libera espaço e AI Action é ilimitado", async () => {
  const flows: { id: string }[] = [];
  for (let i = 0; i < 5; i++) flows.push(await asA(direct));
  await assert.rejects(asA(direct), isPlanLimit);
  await asB(direct);
  await asA(() => deleteTenantFlow(flows[0].id));
  await asA(direct);
  assert.deepEqual((await accountUsage(db, a)).flows, { used: 5, limit: 5 });
  await db.query("UPDATE users SET plan='ai_action' WHERE id=$1", [a]);
  for (let i = 0; i < 3; i++) await asA(direct);
  assert.deepEqual((await accountUsage(db, a)).flows, { used: 8, limit: null });
});

test("execuções reais contam no mês; simulações não; excluir fluxo não devolve o uso", async () => {
  const flow = await asA(direct);
  for (let i = 0; i < 3; i++) await asA(() => enqueueRun(flow.id, `Real ${i}`, false, false));
  await asA(() => enqueueRun(flow.id, "Simulação", false, true));
  await assert.rejects(asA(() => enqueueRun(flow.id, "Excedente", false, false)), isPlanLimit);
  // The rejected run left nothing behind: no run, no job, no extra usage.
  assert.equal((await db.query("SELECT id FROM runs WHERE user_id=$1", [a])).rows.length, 4);
  assert.equal((await db.query("SELECT id FROM jobs WHERE user_id=$1", [a])).rows.length, 4);
  const usage = await accountUsage(db, a);
  assert.deepEqual(usage.runs, { used: 3, limit: 3 });
  assert.match(usage.month, /^\d{4}-\d{2}$/);
  assert.equal(usage.upgradeUrl, AI_ACTION_URL);
  await db.query("UPDATE jobs SET status='done',finished_at=now() WHERE user_id=$1", [a]);
  await db.query(`UPDATE runs SET status='completed',body=body || '{"status":"completed"}'::jsonb WHERE user_id=$1`, [a]);
  await asA(() => deleteTenantFlow(flow.id));
  assert.equal((await accountUsage(db, a)).runs.used, 3);
  // Another account and a past month are independent.
  const other = await asB(direct);
  await asB(() => enqueueRun(other.id, "B", false, false));
  await db.query("UPDATE usage_months SET month='2000-01' WHERE user_id=$1", [a]);
  const again = await asA(direct);
  await asA(() => enqueueRun(again.id, "Novo mês", false, false));
  assert.equal((await accountUsage(db, a)).runs.used, 1);
});

test("AI Action executa sem limite mensal e continua registrando o uso", async () => {
  await db.query("UPDATE users SET plan='ai_action' WHERE id=$1", [a]);
  const flow = await asA(direct);
  for (let i = 0; i < 5; i++) await asA(() => enqueueRun(flow.id, `Run ${i}`, false, false));
  assert.deepEqual((await accountUsage(db, a)).runs, { used: 5, limit: null });
});

test("erro de limite informa código e endereço do AI Action à interface", async () => {
  const response = httpError(new PlanLimitError("Limite"));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Limite", code: "plan_limit", upgradeUrl: AI_ACTION_URL });
  assert.deepEqual(Object.keys(await httpError(new Error("x")).json()), ["error"]);
});

test("alterar senha exige a atual, mantém esta sessão e encerra as demais; conta Google não tem senha", async () => {
  const current = "Senha-Atual-2026!", next = "Senha-Nova-2026!";
  await db.query("UPDATE users SET password_hash=$2 WHERE id=$1", [a, await passwordHash(current)]);
  const keep = randomToken(), other = randomToken();
  for (const token of [keep, other]) await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hashToken(token), a]);
  assert.deepEqual(await accountProfile(db, a), { name: "Pessoa teste", email: `${a}@example.com`, hasPassword: true, google: false });
  await assert.rejects(changePassword(db, a, { current: "Errada-2026!", password: next }, keep), /atual não confere/);
  await assert.rejects(changePassword(db, a, { current, password: "fraca" }, keep));
  await assert.rejects(changePassword(db, a, { current, password: current }, keep), /diferente/);
  await changePassword(db, a, { current, password: next }, keep);
  const sessions = (await db.query<{ token_hash: string }>("SELECT token_hash FROM sessions WHERE user_id=$1", [a])).rows.map((row) => row.token_hash);
  assert.deepEqual(sessions, [hashToken(keep)]);
  await loginUser(db, { email: `${a}@example.com`, password: next }, "plan-test");
  await assert.rejects(loginUser(db, { email: `${a}@example.com`, password: current }, "plan-test-2"), /não conferem/);
  await db.query("UPDATE users SET google_sub='google-b' WHERE id=$1", [b]);
  assert.deepEqual(await accountProfile(db, b), { name: "Pessoa teste", email: `${b}@example.com`, hasPassword: false, google: true });
  await assert.rejects(changePassword(db, b, { current: "x", password: next }, undefined), /Google/);
});

test("bases de conhecimento armazenam até o limite em arquivos de até 10 MB cada, por conta", async () => {
  const previousStorage = process.env.LIMITE_ARMAZENAMENTO_MB;
  process.env.LIMITE_ARMAZENAMENTO_MB = "1";
  try {
    const file = (kb: number) => [{ name: "doc.txt", data: Buffer.alloc(kb * 1024, "a").toString("base64") }];
    const input = { name: "Arquivo", loader: "text", config: {}, splitter: DEFAULT_SPLITTER, metadata: {} };
    const base = await asA(() => createKnowledgeBase({ name: "Base" }));
    const first = await asA(() => saveKnowledgeSource(base.id, input, file(600)));
    await assert.rejects(asA(() => saveKnowledgeSource(base.id, input, file(600))), (e: Error) => /até 1 MB/.test(e.message) && /Exclua fontes/.test(e.message));
    // Replacing a source's files only counts the new files.
    await asA(() => saveKnowledgeSource(base.id, input, file(900), first.id));
    assert.deepEqual((await accountUsage(db, a)).storage, { used: 900 * 1024, limit: 1024 * 1024 });
    assert.deepEqual((await accountUsage(db, b)).storage, { used: 0, limit: 1024 * 1024 });
    // Sources saved before storage was counted are measured once and recorded.
    await db.query("UPDATE knowledge_sources SET body=body-'fileBytes' WHERE user_id=$1", [a]);
    assert.equal((await accountUsage(db, a)).storage.used, 900 * 1024);
    assert.equal((await db.query<{ n: string }>("SELECT body->>'fileBytes' n FROM knowledge_sources WHERE user_id=$1", [a])).rows[0].n, String(900 * 1024));
    await asA(() => deleteKnowledgeSource(base.id, first.id));
    assert.equal((await accountUsage(db, a)).storage.used, 0);
    process.env.LIMITE_ARMAZENAMENTO_MB = "50";
    await assert.rejects(asA(() => saveKnowledgeSource(base.id, input, file(10 * 1024 + 1))), /até 10 MB cada/);
    await asA(() => saveKnowledgeSource(base.id, input, [...file(9 * 1024), ...file(9 * 1024)]));
    await assert.rejects(asA(() => saveKnowledgeSource(base.id, input, [...file(9 * 1024), ...file(9 * 1024), ...file(9 * 1024)])), /20 MB/);
    assert.equal((await accountUsage(db, a)).coupon, AI_ACTION_COUPON);
  } finally { process.env.LIMITE_ARMAZENAMENTO_MB = previousStorage; }
});
