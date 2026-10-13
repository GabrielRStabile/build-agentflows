import { randomUUID } from "node:crypto";
import type { Database, Sql } from "./saas-db";
import { currentTenant } from "./tenant-context";
import { FlowError } from "./flow-store";
import { buildRun, clientRunId } from "./flow-runtime";
import { getTenantRun, persistTenantRun } from "./tenant-flows";
import type { QueueStatus } from "./queue-status";
import { settleChannelDelivery } from "./channel-flows";
import type { Run } from "./flow-types";
import { consumeMonthlyRun } from "./saas-plan";

export type Job = { id: string; user_id: string; kind: "run" | "index" | "extract"; resource_id: string; run_id: string | null; base_id: string | null; source_id: string | null; status: string; lease_token: string | null; error: string | null; created_at?: Date | string; started_at?: Date | string | null };
export const queueLock = (sql: Sql) => sql.query("SELECT pg_advisory_xact_lock(742193802)");
const positive = (name: string, fallback: number) => { const n = Number(process.env[name]); return Number.isInteger(n) && n > 0 ? n : fallback; };
/** Read per call so tests and deploys can tune limits without code changes. Each account still runs one job at a time (ChatGPT session lease). */
export const queueLimits = () => ({ perUser: positive("FILA_LIMITE_USUARIO", 100), total: positive("FILA_LIMITE_TOTAL", 2000), running: positive("EXECUCOES_SIMULTANEAS", 6) });
export async function capacity(sql: Sql, owner: string) {
  await queueLock(sql);
  const user = await sql.query("SELECT id FROM users WHERE id=$1 AND beta_status='approved' AND email_verified_at IS NOT NULL FOR UPDATE", [owner]);
  if (!user.rows.length) throw new FlowError("Acesso ao beta pendente ou suspenso.", 403);
  const { rows } = await sql.query<{ own: number; total: number }>("SELECT count(*) FILTER(WHERE user_id=$1)::int own,count(*)::int total FROM jobs WHERE status IN ('queued','running') OR (status='cancelled' AND lease_until IS NOT NULL)", [owner]);
  const limits = queueLimits();
  if (rows[0].own >= limits.perUser || rows[0].total >= limits.total) throw new FlowError("A fila atingiu o limite. Aguarde as tarefas em andamento.", 429);
}
export async function insertJob(sql: Sql, job: Pick<Job, "user_id" | "kind" | "resource_id" | "run_id" | "base_id" | "source_id">) {
  const id = randomUUID();
  const { rows } = await sql.query<Job>(`INSERT INTO jobs(id,user_id,kind,resource_id,run_id,base_id,source_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *`, [id, job.user_id, job.kind, job.resource_id, job.run_id, job.base_id, job.source_id]);
  if (!rows[0]) throw new FlowError("Este recurso já tem uma tarefa na fila.", 409);
  if (job.kind === "run") await sql.query(`INSERT INTO channel_deliveries(user_id,job_id,run_id)
    SELECT user_id,$2,run_id FROM channel_events WHERE user_id=$1 AND run_id=$3 AND channel='whatsapp'`, [job.user_id, id, job.run_id]);
  return rows[0];
}
export async function enqueueRun(...args: Parameters<typeof buildRun>) {
  const { db, user } = currentTenant();
  const requested = clientRunId(args[7]);
  // A retried request (lost response during a deploy or a proxy timeout) must not start a second execution.
  if (requested) {
    const existing = await db.query<{ body: Run }>("SELECT body FROM runs WHERE user_id=$1 AND id=$2", [user.id, requested]);
    if (existing.rows[0]) {
      if (existing.rows[0].body.flowId !== args[0]) throw new FlowError("Este identificador pertence a outro fluxo.", 409);
      const job = (await db.query<Job>("SELECT * FROM jobs WHERE user_id=$1 AND kind='run' AND run_id=$2 ORDER BY created_at DESC LIMIT 1", [user.id, requested])).rows[0];
      if (!job) throw new FlowError("Esta execução já existe e não está na fila.", 409);
      return { run: existing.rows[0].body, job, repeated: true as const };
    }
  }
  const run = await buildRun(...args);
  run.queued = true;
  const job = await db.transaction(async (sql) => {
    await capacity(sql, user.id);
    // Simulations never reach a model; approval resumes continue an already counted run.
    if (!run.demo) await consumeMonthlyRun(sql, user.id);
    await persistTenantRun(sql, user.id, run);
    for (const item of run.attachments || []) await sql.query("UPDATE attachments SET used=true WHERE user_id=$1 AND id=$2", [user.id, item.id]);
    return insertJob(sql, { user_id: user.id, kind: "run", resource_id: run.id, run_id: run.id, base_id: null, source_id: null });
  });
  return { run, job, repeated: false as const };
}
export async function enqueueResume(id: string, decision: unknown) {
  if (!["yes", "no"].includes(String(decision))) throw new FlowError("Escolha aprovar ou rejeitar.");
  const { db, user } = currentTenant();
  return db.transaction(async (sql) => {
    await queueLock(sql);
    // Match worker/cancellation lock order: job before owner and run.
    const active = await sql.query("SELECT id FROM jobs WHERE user_id=$1 AND run_id=$2 AND status IN ('queued','running') FOR UPDATE", [user.id, id]);
    if (active.rows.length) throw new FlowError("A etapa anterior ainda está terminando. Aguarde e tente a decisão novamente.", 409);
    await capacity(sql, user.id);
    const { rows } = await sql.query<{ body: Run }>("SELECT body FROM runs WHERE user_id=$1 AND id=$2 FOR UPDATE", [user.id, id]);
    const run = rows[0]?.body;
    if (!run) throw new FlowError("Execução não encontrada.", 404);
    if (run.status !== "waiting" || run.interrupted) throw new FlowError("Esta execução não aguarda essa decisão.", 409);
    const node = run.graph.nodes.find((n) => n.id === run.next);
    if (!node || node.data.kind !== "approval") throw new FlowError("Etapa de aprovação inválida.", 409);
    run.trace.push({ type: "step", status: "completed", nodeId: node.id, label: node.data.label, output: decision === "yes" ? "Aprovado" : "Rejeitado", at: new Date().toISOString(), ms: 0 });
    run.state.approval = String(decision);
    run.next = run.graph.edges.find((edge) => edge.source === node.id && edge.sourceHandle === decision)?.target || null;
    run.status = "running"; run.queued = true; run.updatedAt = new Date().toISOString();
    // Both the decision and its dispatch commit together; a crash cannot strand an approved run.
    await sql.query("UPDATE runs SET status='running',body=$3 WHERE user_id=$1 AND id=$2", [user.id, id, JSON.stringify(run)]);
    const job = await insertJob(sql, { user_id: user.id, kind: "run", resource_id: id, run_id: id, base_id: null, source_id: null });
    return { run, job };
  });
}
export async function enqueueKnowledge(kind: "index" | "extract", baseId: string, sourceId?: string) {
  const { db, user } = currentTenant();
  return db.transaction(async (sql) => {
    await capacity(sql, user.id);
    if (!(await sql.query("SELECT id FROM knowledge_bases WHERE user_id=$1 AND id=$2", [user.id, baseId])).rows.length) throw new FlowError("Base não encontrada.", 404);
    if (kind === "extract" && !(await sql.query("SELECT id FROM knowledge_sources WHERE user_id=$1 AND base_id=$2 AND id=$3", [user.id, baseId, sourceId])).rows.length) throw new FlowError("Fonte não encontrada.", 404);
    return insertJob(sql, { user_id: user.id, kind, resource_id: kind === "index" ? baseId : `${baseId}:${sourceId}`, run_id: null, base_id: baseId, source_id: kind === "extract" ? sourceId! : null });
  });
}
/** PostgreSQL remains authoritative if Redis loses a notification or is unavailable. */
export async function claimJob(db: Database, preferredId?: string): Promise<Job | undefined> {
  return db.transaction(async (sql) => {
    await queueLock(sql);
    // Cancellation revokes execution immediately, but holds capacity until the
    // worker acknowledges shutdown or recovery expires its lease.
    if ((await sql.query<{ n: number }>("SELECT count(*)::int n FROM jobs WHERE status='running' OR (status='cancelled' AND lease_until IS NOT NULL)", [])).rows[0].n >= queueLimits().running) return undefined;
    const { rows } = await sql.query<Job>(`SELECT j.* FROM jobs j JOIN users u ON u.id=j.user_id
      WHERE j.status='queued' AND u.beta_status='approved' AND u.email_verified_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM jobs busy WHERE busy.user_id=j.user_id AND (busy.status='running' OR (busy.status='cancelled' AND busy.lease_until IS NOT NULL)))
      ORDER BY (j.id::text=$1) DESC,j.created_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, [preferredId || ""]);
    if (!rows[0]) return undefined;
    const job = rows[0], token = randomUUID();
    return (await sql.query<Job>("UPDATE jobs SET status='running',lease_token=$2,lease_until=now()+interval '60 seconds',started_at=now() WHERE id=$1 RETURNING *", [job.id, token])).rows[0];
  });
}
export async function heartbeatJob(db: Database, job: Job) {
  return !!(await db.query(`UPDATE jobs j SET lease_until=now()+interval '60 seconds' FROM users u
    WHERE j.id=$1 AND j.lease_token=$2 AND j.status='running' AND j.lease_until>now()
    AND j.started_at>now()-interval '15 minutes' AND u.id=j.user_id AND u.beta_status='approved'
    AND u.email_verified_at IS NOT NULL RETURNING j.id`, [job.id, job.lease_token])).rows.length;
}
export async function finishJob(db: Database, job: Job, error?: string) {
  await db.transaction(async (sql) => {
    await sql.query("UPDATE jobs SET lease_until=NULL,finished_at=now() WHERE id=$1 AND lease_token=$2 AND status='cancelled'", [job.id, job.lease_token]);
    const { rows } = await sql.query<Job>("UPDATE jobs SET status=$3,error=$4,finished_at=now(),lease_until=NULL WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() RETURNING *", [job.id, job.lease_token, error ? "failed" : "done", error || null]);
    const owned = await sql.query("SELECT id FROM jobs WHERE id=$1 AND user_id=$2 AND lease_token=$3 AND status IN ('done','failed','cancelled') FOR UPDATE", [job.id, job.user_id, job.lease_token]);
    if (owned.rows.length) await settleChannelDelivery(sql, job);
    if (error && rows[0]?.run_id) await sql.query(`UPDATE runs SET status='failed',body=(body-'queued') || $3::jsonb
      WHERE user_id=$1 AND id=$2 AND status='running'`, [rows[0].user_id, rows[0].run_id, JSON.stringify({ status: "failed", error, updatedAt: new Date().toISOString() })]);
  });
}
export async function recoverExpiredJobs(db: Database) {
  return db.transaction(async (sql) => {
    await queueLock(sql);
    const cancelled = await sql.query<Job>("UPDATE jobs SET lease_until=NULL,finished_at=now() WHERE status='cancelled' AND lease_until<now() RETURNING *");
    for (const job of cancelled.rows) await settleChannelDelivery(sql, job);
    const { rows } = await sql.query<Job>(`SELECT * FROM jobs WHERE status='running' AND lease_until<now() FOR UPDATE SKIP LOCKED`);
    for (const job of rows) {
      const error = "A tarefa foi interrompida. Revise os efeitos já realizados antes de iniciar outra execução.";
      // No blind replay: an external side effect may have succeeded before the process died.
      await sql.query("UPDATE jobs SET status='interrupted',error=$2,finished_at=now(),lease_until=NULL WHERE id=$1", [job.id, error]);
      await settleChannelDelivery(sql, job);
      if (job.run_id) await sql.query(`UPDATE runs SET status='failed',body=body || $3::jsonb
        WHERE user_id=$1 AND id=$2 AND status='running'`, [job.user_id, job.run_id, JSON.stringify({ status: "failed", interrupted: true, error, updatedAt: new Date().toISOString() })]);
      if (job.run_id) await sql.query("UPDATE embed_commands SET status='cancelled',body=body || '{\"status\":\"cancelled\"}'::jsonb WHERE user_id=$1 AND run_id=$2 AND status IN ('pending','delivered')", [job.user_id, job.run_id]);
      if (job.base_id) {
        await sql.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [job.user_id]);
        await sql.query("SELECT id FROM knowledge_bases WHERE user_id=$1 AND id=$2 FOR UPDATE", [job.user_id, job.base_id]);
        const lock = (await sql.query<{ job_id: string | null; job_token: string | null }>("SELECT job_id,job_token FROM knowledge_locks WHERE user_id=$1 AND base_id=$2", [job.user_id, job.base_id])).rows[0];
        // Another operation may have acquired the base after this worker died.
        if (lock && (lock.job_id !== job.id || lock.job_token !== job.lease_token)) continue;
        await sql.query("UPDATE knowledge_bases SET body=body || $3::jsonb WHERE user_id=$1 AND id=$2 AND body->>'status'='indexing'", [job.user_id, job.base_id, JSON.stringify({ status: "failed", error })]);
        await sql.query("UPDATE knowledge_runs SET body=body || $3::jsonb WHERE user_id=$1 AND base_id=$2 AND body->>'status'='running'", [job.user_id, job.base_id, JSON.stringify({ status: "failed", error, finishedAt: new Date().toISOString() })]);
        await sql.query("UPDATE knowledge_sources SET body=body || $3::jsonb WHERE user_id=$1 AND base_id=$2 AND body->>'status'='processing'", [job.user_id, job.base_id, JSON.stringify({ status: "failed", error })]);
        await sql.query("DELETE FROM knowledge_locks WHERE user_id=$1 AND base_id=$2 AND job_id=$3 AND job_token=$4", [job.user_id, job.base_id, job.id, job.lease_token]);
      }
    }
    return rows.length;
  });
}
/** Aggregate picture for operators (health endpoint): backlog, slots in use, live workers and the oldest wait. */
export async function queueStats(sql: Sql) {
  const { rows } = await sql.query<{ queued: number; running: number; workers: number; oldest: number | null }>(`SELECT
    (SELECT count(*)::int FROM jobs WHERE status='queued') AS queued,
    (SELECT count(*)::int FROM jobs WHERE status='running' OR (status='cancelled' AND lease_until IS NOT NULL)) AS running,
    (SELECT count(*)::int FROM worker_heartbeats WHERE updated_at>now()-interval '45 seconds') AS workers,
    (SELECT floor(extract(epoch FROM now()-min(created_at)))::int FROM jobs WHERE status='queued') AS oldest`);
  return { queued: rows[0].queued, running: rows[0].running, slots: queueLimits().running, workers: rows[0].workers, oldestQueuedSeconds: rows[0].oldest ?? 0 };
}
/** Position of a queued run, in the worker's claim order, plus whether any worker is alive to claim it. */
export async function runQueueStatus(sql: Sql, owner: string, runId: string): Promise<QueueStatus | undefined> {
  const { rows } = await sql.query<{ ahead: number; running: number; workers: number }>(`SELECT
    (SELECT count(*)::int FROM jobs q WHERE q.status='queued' AND (q.created_at<j.created_at OR (q.created_at=j.created_at AND q.id<j.id))) AS ahead,
    (SELECT count(*)::int FROM jobs WHERE status='running' OR (status='cancelled' AND lease_until IS NOT NULL)) AS running,
    (SELECT count(*)::int FROM worker_heartbeats WHERE updated_at>now()-interval '45 seconds') AS workers
    FROM jobs j WHERE j.user_id=$1 AND j.kind='run' AND j.run_id=$2 AND j.status='queued'`, [owner, runId]);
  if (!rows[0]) return undefined;
  return { position: rows[0].ahead + 1, ahead: rows[0].ahead, running: rows[0].running, slots: queueLimits().running, workers: rows[0].workers };
}
/** Run as the API returns it: the persisted body plus the live queue position while it waits. */
export async function describeRun(id: string): Promise<Run> {
  const run = await getTenantRun(id);
  if (!run.queued || run.status !== "running") return run;
  const { db, user } = currentTenant();
  const queue = await runQueueStatus(db, user.id, run.id);
  return queue ? { ...run, queue } : run;
}
export async function listKnowledgeJobs(baseId: string) {
  const { db, user } = currentTenant();
  return (await db.query<Pick<Job, "id" | "kind" | "status" | "source_id" | "error">>("SELECT id,kind,status,source_id,error FROM jobs WHERE user_id=$1 AND base_id=$2 ORDER BY created_at DESC LIMIT 20", [user.id, baseId])).rows;
}
