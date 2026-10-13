import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createTestDatabase } from "../scripts/saas-test-db";
import { migrateDatabase } from "./db/migrate";
import { withTenantJob } from "./tenant-context";
import { createTenantFlow, getTenantRun, listTenantRuns, putTenantRun, cancelTenantRun } from "./tenant-flows";
import { enqueueRun, enqueueResume, enqueueKnowledge, claimJob, queueLimits, recoverExpiredJobs, heartbeatJob, finishJob } from "./saas-jobs";
import { runClaimedJob } from "./saas-worker";
import { withJobLease } from "./saas-job-context";
import { template, block } from "./flow-types";
import * as knowledge from "./tenant-knowledge";
import { DEFAULT_SPLITTER } from "./knowledge-types";
import { setConfig } from "./store";

const testDb = await createTestDatabase();
const { db } = testDb;
const a = randomUUID(), b = randomUUID();
const asA = <T>(action: () => T | Promise<T>) => withTenantJob(db, a, action);
const asB = <T>(action: () => T | Promise<T>) => withTenantJob(db, b, action);
process.env.CHAVE_MESTRA = randomBytes(32).toString("base64");
test.before(async () => { await migrateDatabase(db); await migrateDatabase(db); });
test.after(async () => testDb.close());
test.beforeEach(async () => {
  await testDb.exec("TRUNCATE users CASCADE");
  for (const id of [a, b]) await db.query("INSERT INTO users(id,name,email,email_verified_at,beta_status) VALUES($1,'Test user',$2,now(),'approved')", [id, `${id}@example.com`]);
});
const create = () => createTenantFlow("Queued", false, { name: "Queued", description: "", graph: template() });

test("fila grava run/job atomicamente, limita backlog por conta e não aceita fluxo alheio", async () => {
  const flow = await asA(create);
  await assert.rejects(asB(() => enqueueRun(flow.id, "Foreign", false, true)), /não encontrado/);
  for (let i = 0; i < 10; i++) await asA(() => enqueueRun(flow.id, `Input ${i}`, false, true));
  await assert.rejects(asA(() => enqueueRun(flow.id, "Overflow", false, true)), (error: unknown) => (error as { status: number }).status === 429);
  assert.equal((await asA(() => listTenantRuns(flow.id))).length, 10);
  assert.equal((await db.query("SELECT id FROM jobs WHERE user_id=$1", [a])).rows.length, 10);
  const other = await asB(create);
  await asB(() => enqueueRun(other.id, "Capacity B", false, true));
});

test("worker reivindica uma tarefa por usuário, duas globais e executa só o contexto persistido", async () => {
  const flow = await asA(create), other = await asB(create);
  const one = await asA(() => enqueueRun(flow.id, "A1", false, true));
  await asA(() => enqueueRun(flow.id, "A2", false, true));
  const two = await asB(() => enqueueRun(other.id, "B1", false, true));
  const jobA = (await claimJob(db, one.job.id))!, jobB = (await claimJob(db, two.job.id))!;
  assert.equal(jobA.user_id, a); assert.equal(jobB.user_id, b);
  assert.equal(await claimJob(db), undefined);
  assert.equal(await heartbeatJob(db, jobA), true);
  assert.deepEqual(await runClaimedJob(db, jobA), { ok: true, error: undefined });
  assert.equal((await asA(() => getTenantRun(one.run.id))).status, "completed");
  await assert.rejects(asB(() => getTenantRun(one.run.id)), /não encontrada/);
  assert.equal((await claimJob(db))?.user_id, a);
});

test("aprovação e novo job são uma transação; decisão concorrente só entra uma vez", async () => {
  const graph = template(); graph.nodes[1] = block("approval", "analista", 0, 0); graph.edges[1].sourceHandle = "yes";
  graph.edges.push({ ...graph.edges[1], id: "rejected", sourceHandle: "no" });
  const flow = await asA(() => createTenantFlow("Approval", false, { name: "Approval", description: "", graph }));
  const queued = await asA(() => enqueueRun(flow.id, "Review", false, true));
  await runClaimedJob(db, (await claimJob(db))!);
  assert.equal((await asA(() => getTenantRun(queued.run.id))).status, "waiting");
  await assert.rejects(asB(() => enqueueResume(queued.run.id, "yes")), /não encontrada/);
  const decisions = await Promise.allSettled([asA(() => enqueueResume(queued.run.id, "yes")), asA(() => enqueueResume(queued.run.id, "yes"))]);
  assert.equal(decisions.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await db.query("SELECT id FROM jobs WHERE run_id=$1", [queued.run.id])).rows.length, 2);
  await runClaimedJob(db, (await claimJob(db))!);
  assert.equal((await asA(() => getTenantRun(queued.run.id))).status, "completed");
});

test("fluxos, extração e indexação compartilham a mesma vaga por usuário", async () => {
  const flow = await asA(create);
  const base = await asA(() => knowledge.createKnowledgeBase({ name: "Shared capacity" }));
  const source = await asA(() => knowledge.saveKnowledgeSource(base.id, { name: "Text", loader: "plain", config: { text: "Conteúdo" }, splitter: DEFAULT_SPLITTER, metadata: {} }));
  const run = await asA(() => enqueueRun(flow.id, "Flow", false, true));
  const extraction = await asA(() => enqueueKnowledge("extract", base.id, source.id));
  const indexing = await asA(() => enqueueKnowledge("index", base.id));
  const active = (await claimJob(db, run.job.id))!;
  assert.equal(await claimJob(db, extraction.id), undefined);
  assert.equal(await claimJob(db, indexing.id), undefined);
  const other = await asB(create);
  const otherRun = await asB(() => enqueueRun(other.id, "Independent", false, true));
  assert.equal((await claimJob(db, otherRun.job.id))?.user_id, b);
  await runClaimedJob(db, active);
  const next = (await claimJob(db, extraction.id))!;
  assert.equal(next.id, extraction.id);
  assert.equal(await claimJob(db, indexing.id), undefined);
  await runClaimedJob(db, next);
  assert.equal((await claimJob(db, indexing.id))?.id, indexing.id);
});

test("limite global impede um terceiro usuário de executar até liberar uma vaga", async () => {
  const third = randomUUID();
  await db.query("INSERT INTO users(id,name,email,email_verified_at,beta_status) VALUES($1,'Third user',$2,now(),'approved')", [third, `${third}@example.com`]);
  for (const owner of [a, b, third]) await withTenantJob(db, owner, async () => {
    const flow = await create();
    await enqueueRun(flow.id, "Global capacity", false, true);
  });
  const claimed = (await Promise.all(Array.from({ length: 6 }, () => claimJob(db)))).filter((job) => !!job);
  assert.equal(claimed.length, 2);
  assert.equal(new Set(claimed.map((job) => job.user_id)).size, 2);
  await runClaimedJob(db, claimed[0]);
  const next = await claimJob(db);
  assert.ok(next);
  assert.ok(!claimed.some((job) => job.user_id === next.user_id));
});

test("limites da fila vêm do ambiente, com padrões para turmas grandes e uma execução por conta", async () => {
  const keys = ["FILA_LIMITE_USUARIO", "FILA_LIMITE_TOTAL", "EXECUCOES_SIMULTANEAS"] as const, saved = keys.map((key) => process.env[key]);
  try {
    delete process.env.FILA_LIMITE_USUARIO; delete process.env.EXECUCOES_SIMULTANEAS; process.env.FILA_LIMITE_TOTAL = "0";
    assert.deepEqual(queueLimits(), { perUser: 100, total: 2000, running: 6 });
    process.env.FILA_LIMITE_USUARIO = "3"; process.env.EXECUCOES_SIMULTANEAS = "1";
    const flow = await asA(create), other = await asB(create);
    for (let i = 0; i < 3; i++) await asA(() => enqueueRun(flow.id, `Env ${i}`, false, true));
    await assert.rejects(asA(() => enqueueRun(flow.id, "Overflow", false, true)), (error: unknown) => (error as { status: number }).status === 429);
    await asB(() => enqueueRun(other.id, "Other", false, true));
    assert.ok(await claimJob(db)); assert.equal(await claimJob(db), undefined);
    process.env.EXECUCOES_SIMULTANEAS = "4";
    // Uma conta continua com uma tarefa por vez, mesmo com vagas globais livres.
    const second = await claimJob(db); assert.ok(second); assert.equal(await claimJob(db), undefined);
  } finally { keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }); }
});

test("cancelar tarefa ativa preserva a vaga até confirmação do worker", async () => {
  const flow = await asA(create), other = await asB(create);
  const first = await asA(() => enqueueRun(flow.id, "Cancel", false, true));
  const next = await asA(() => enqueueRun(flow.id, "Wait", false, true));
  const active = (await claimJob(db, first.job.id))!;
  await asA(() => cancelTenantRun(first.run.id));
  assert.equal(await heartbeatJob(db, active), false);
  assert.equal(await claimJob(db, next.job.id), undefined);
  await assert.rejects(withJobLease({ id: active.id, owner: a, token: active.lease_token! }, () => asA(() => setConfig("AFTER_CANCEL", "denied"))), /expirou/);
  const otherRun = await asB(() => enqueueRun(other.id, "Independent", false, true));
  assert.equal((await claimJob(db, otherRun.job.id))?.user_id, b);
  await finishJob(db, { ...active, lease_token: randomUUID() });
  assert.equal(await claimJob(db, next.job.id), undefined, "outro token não libera a vaga");
  await finishJob(db, active);
  assert.equal((await claimJob(db, next.job.id))?.id, next.job.id);
  assert.equal((await asA(() => getTenantRun(first.run.id))).status, "cancelled");
});

test("cancelamento seguido de crash libera a vaga só após expirar a autorização", async () => {
  const flow = await asA(create);
  const first = await asA(() => enqueueRun(flow.id, "Cancel then crash", false, true));
  const next = await asA(() => enqueueRun(flow.id, "Wait", false, true));
  const active = (await claimJob(db, first.job.id))!;
  await asA(() => cancelTenantRun(first.run.id));
  await recoverExpiredJobs(db);
  assert.equal(await claimJob(db), undefined);
  await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [active.id]);
  await recoverExpiredJobs(db);
  assert.equal((await claimJob(db))?.id, next.job.id);
  assert.equal((await asA(() => getTenantRun(first.run.id))).status, "cancelled");
});

test("crash não repete efeitos externos e lease antiga não grava execução ou credencial", async () => {
  const flow = await asA(create);
  const queued = await asA(() => enqueueRun(flow.id, "Interrupted", false, true));
  const job = (await claimJob(db))!;
  await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
  assert.equal(await recoverExpiredJobs(db), 1);
  assert.equal(await claimJob(db), undefined, "job interrompido não volta à fila automaticamente");
  assert.equal((await asA(() => getTenantRun(queued.run.id))).status, "failed");
  await assert.rejects(withJobLease({ id: job.id, owner: a, token: job.lease_token! }, () => asA(() => putTenantRun(queued.run))), /expirou/);
  await assert.rejects(withJobLease({ id: job.id, owner: a, token: job.lease_token! }, () => asA(() => setConfig("ROTATED_TOKEN", "stale-secret"))), /expirou/);
  assert.equal((await db.query("SELECT * FROM credentials WHERE user_id=$1", [a])).rows.length, 0);
});

test("cancelamento retira job da fila e conta suspensa não recebe nova execução", async () => {
  const flow = await asA(create);
  const queued = await asA(() => enqueueRun(flow.id, "Cancelled", false, true));
  await asA(() => cancelTenantRun(queued.run.id));
  assert.equal(await claimJob(db), undefined);
  assert.equal((await db.query("SELECT status FROM jobs WHERE id=$1", [queued.job.id])).rows[0].status, "cancelled");
  await asA(() => enqueueRun(flow.id, "Blocked", false, true));
  await db.query("UPDATE users SET beta_status='blocked' WHERE id=$1", [a]);
  assert.equal(await claimJob(db), undefined);
});

test("worker extrai conhecimento do dono e rejeita duplicação/acesso cruzado à fonte", async () => {
  const base = await asA(() => knowledge.createKnowledgeBase({ name: "Documents" }));
  const source = await asA(() => knowledge.saveKnowledgeSource(base.id, { name: "Private", loader: "plain", config: { text: "Texto privado" }, splitter: DEFAULT_SPLITTER, metadata: {} }));
  const queued = await asA(() => enqueueKnowledge("extract", base.id, source.id));
  await assert.rejects(asA(() => enqueueKnowledge("extract", base.id, source.id)), /já tem/);
  await assert.rejects(asB(() => enqueueKnowledge("extract", base.id, source.id)), /não encontrada/);
  const job = (await claimJob(db, queued.id))!;
  assert.equal((await runClaimedJob(db, job)).ok, true);
  assert.equal((await asA(() => knowledge.getKnowledgeSource(base.id, source.id))).status, "processed");
  assert.equal((await asA(() => knowledge.listKnowledgeChunks(base.id)))[0].pageContent, "Texto privado");
});

test("suspensão após reivindicar encerra run e job sem executar o fluxo", async () => {
  const flow = await asA(create);
  const queued = await asA(() => enqueueRun(flow.id, "Blocked after claim", false, true));
  const job = (await claimJob(db))!;
  await db.query("UPDATE users SET beta_status='blocked' WHERE id=$1", [a]);
  assert.equal((await runClaimedJob(db, job)).ok, false);
  const run = (await db.query("SELECT body FROM runs WHERE user_id=$1 AND id=$2", [a, queued.run.id])).rows[0].body;
  assert.equal(run.status, "failed");
  assert.equal(run.queued, undefined);
  assert.equal((await db.query("SELECT status FROM jobs WHERE id=$1", [job.id])).rows[0].status, "failed");
});

test("recuperação de worker expirado preserva a operação de conhecimento que substituiu a antiga", async () => {
  const base = await asA(() => knowledge.createKnowledgeBase({ name: "Replacement" }));
  const queued = await asA(() => enqueueKnowledge("index", base.id));
  const job = (await claimJob(db, queued.id))!;
  const replacementToken = randomUUID();
  await db.query("INSERT INTO knowledge_locks(user_id,base_id,token,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')", [a, base.id, replacementToken]);
  await db.query("UPDATE knowledge_bases SET body=body || $3::jsonb WHERE user_id=$1 AND id=$2", [a, base.id, JSON.stringify({ status: "indexing" })]);
  await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
  assert.equal(await recoverExpiredJobs(db), 1);
  assert.equal((await asA(() => knowledge.getKnowledgeBase(base.id))).status, "indexing");
  assert.equal((await db.query("SELECT token FROM knowledge_locks WHERE user_id=$1 AND base_id=$2", [a, base.id])).rows[0].token, replacementToken);
});

test("requisições e workers concorrentes preservam quotas, dono e reivindicação única", async () => {
  const flow = await asA(create), other = await asB(create);
  const enqueues = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => asA(() => enqueueRun(flow.id, `Concurrent ${i}`, false, true))));
  assert.equal(enqueues.filter((r) => r.status === "fulfilled").length, 10);
  for (const r of enqueues) if (r.status === "rejected") assert.equal(r.reason.status, 429);
  await asB(() => enqueueRun(other.id, "B", false, true));
  const claims = (await Promise.all(Array.from({ length: 8 }, () => claimJob(db)))).filter((job) => !!job);
  assert.equal(claims.length, 2);
  assert.equal(new Set(claims.map((job) => job.id)).size, 2);
  assert.deepEqual(new Set(claims.map((job) => job.user_id)), new Set([a, b]));
  await Promise.all(claims.map((job) => runClaimedJob(db, job)));
  const states = await db.query("SELECT status FROM jobs WHERE status='done'");
  assert.equal(states.rows.length, 2);
});

test("posição na fila segue a ordem de reivindicação e informa workers ativos", async () => {
  const { runQueueStatus, describeRun } = await import("./saas-jobs");
  const flow = await asA(create), other = await asB(create);
  const first = await asA(() => enqueueRun(flow.id, "A1", false, true));
  const second = await asB(() => enqueueRun(other.id, "B1", false, true));
  const third = await asA(() => enqueueRun(flow.id, "A2", false, true));
  assert.deepEqual(await runQueueStatus(db, b, second.run.id), { position: 2, ahead: 1, running: 0, slots: queueLimits().running, workers: 0 });
  assert.equal((await runQueueStatus(db, a, third.run.id))?.position, 3);
  // Another account never learns about a run it does not own; a running run has no queue position.
  assert.equal(await runQueueStatus(db, a, second.run.id), undefined);
  await db.query("INSERT INTO worker_heartbeats(id) VALUES($1)", [randomUUID()]);
  const claimed = (await claimJob(db, first.job.id))!;
  assert.equal(claimed.run_id, first.run.id);
  assert.deepEqual(await runQueueStatus(db, b, second.run.id), { position: 1, ahead: 0, running: 1, slots: queueLimits().running, workers: 1 });
  assert.equal(await runQueueStatus(db, a, first.run.id), undefined);
  const described = await asB(() => describeRun(second.run.id));
  assert.equal(described.queue?.ahead, 0);
  assert.equal(described.queued, true);
  // The live field never reaches the stored body.
  await asB(() => putTenantRun(described));
  assert.equal((await asB(() => getTenantRun(second.run.id))).queue, undefined);
  await runClaimedJob(db, claimed);
  assert.equal((await asA(() => describeRun(first.run.id))).queue, undefined);
});

test("identificador de execução do cliente: repetição devolve a mesma execução sem nova tarefa ou consumo", async () => {
  const flow = await asA(create), other = await asB(create);
  const runId = "7f0a2d3e-5b6c-4d7e-8f90-1a2b3c4d5e6f";
  const first = await asA(() => enqueueRun(flow.id, "Primeira", false, true, undefined, undefined, undefined, runId));
  assert.equal(first.run.id, runId); assert.equal(first.repeated, false); assert.ok(first.job);
  const again = await asA(() => enqueueRun(flow.id, "Primeira", false, true, undefined, undefined, undefined, runId.toUpperCase()));
  assert.equal(again.repeated, true); assert.equal(again.job.id, first.job.id); assert.equal(again.run.id, runId);
  assert.equal((await db.query("SELECT count(*)::int n FROM jobs WHERE user_id=$1", [a])).rows[0].n, 1);
  assert.equal((await db.query("SELECT count(*)::int n FROM runs WHERE user_id=$1", [a])).rows[0].n, 1);
  // Same id on another flow of the same account is refused; another account never sees it and gets its own run.
  await assert.rejects(asA(() => enqueueRun(other.id, "Outro fluxo", false, true, undefined, undefined, undefined, runId)), /pertence a outro fluxo/);
  const mine = await asB(() => enqueueRun(other.id, "De B", false, true, undefined, undefined, undefined, runId));
  assert.equal(mine.repeated, false); assert.equal(mine.run.id, runId);
  await assert.rejects(asA(() => enqueueRun(flow.id, "Inválido", false, true, undefined, undefined, undefined, "nao-e-uuid")), /Identificador de execução inválido/);
  await assert.rejects(asA(() => enqueueRun(flow.id, "v1", false, true, undefined, undefined, undefined, "7f0a2d3e-5b6c-1d7e-8f90-1a2b3c4d5e6f")), /inválido/);
  // After the run finishes, a late retry still returns the finished run rather than starting over.
  await runClaimedJob(db, (await claimJob(db, first.job.id))!);
  const late = await asA(() => enqueueRun(flow.id, "Primeira", false, true, undefined, undefined, undefined, runId));
  assert.equal(late.repeated, true); assert.equal(late.run.status, "completed");
});

test("resumo da fila para o operador: pendentes, vagas em uso, workers vivos e espera mais antiga", async () => {
  const { queueStats } = await import("./saas-jobs");
  await db.query("DELETE FROM worker_heartbeats");
  assert.deepEqual(await queueStats(db), { queued: 0, running: 0, slots: queueLimits().running, workers: 0, oldestQueuedSeconds: 0 });
  const flow = await asA(create), other = await asB(create);
  const one = await asA(() => enqueueRun(flow.id, "A1", false, true));
  await asB(() => enqueueRun(other.id, "B1", false, true));
  await db.query("INSERT INTO worker_heartbeats(id,updated_at) VALUES($1,now()),($2,now()-interval '2 minutes')", [randomUUID(), randomUUID()]);
  await claimJob(db, one.job.id);
  const stats = await queueStats(db);
  assert.equal(stats.queued, 1); assert.equal(stats.running, 1); assert.equal(stats.workers, 1);
  assert.ok(stats.oldestQueuedSeconds >= 0 && stats.oldestQueuedSeconds < 60);
});
