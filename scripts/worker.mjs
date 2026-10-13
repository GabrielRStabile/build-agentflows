import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saasDatabase } from "../lib/saas-db.ts";
import { migrateDatabase } from "../lib/db/migrate.ts";
import { claimJob, queueLimits, recoverExpiredJobs } from "../lib/saas-jobs.ts";
import { runClaimedJob } from "../lib/saas-worker.ts";
import { nextJobNotification, waitJobNotification, closeQueue } from "../lib/saas-queue.ts";
import { deliverAuthMail } from "../lib/saas-mail.ts";
import { cleanupAuth } from "../lib/saas-auth.ts";
import { runBudgetMs } from "../lib/run-limits.ts";

// A deploy stops claiming new jobs but lets active runs finish (LIMITE_EXECUCAO_SEGUNDOS, 180 s by default);
// only after DRAIN_MS are they aborted. Keep stop_grace_period above DRAIN_MS + EXIT_MARGIN_MS.
const DRAIN_MS = runBudgetMs() + 5000, EXIT_MARGIN_MS = 10000;
// Operational log lines (JSON, no user content) so queue latency is visible in the host's logs.
const log = (evento, extra) => console.log(JSON.stringify({ evento, ...extra, em: new Date().toISOString() }));
const db = saasDatabase(), id = randomUUID(), stop = new AbortController(), drain = new AbortController();
const active = new Set();
let mail = Promise.resolve(), sendingMail = false, lastMaintenance = 0, hint;
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  stop.abort();
  setTimeout(() => drain.abort(), DRAIN_MS).unref();
});
await migrateDatabase(db);
log("worker_pronto", { id, vagas: queueLimits().running, limiteExecucaoMs: runBudgetMs(), drenagemMs: DRAIN_MS });
writeFileSync(path.join(tmpdir(), "agentflows-worker-id"), id, { mode: 0o600 });
try {
  while (!stop.signal.aborted) {
    try {
      await db.query("INSERT INTO worker_heartbeats(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET updated_at=now()", [id]);
      await recoverExpiredJobs(db);
      if (Date.now() - lastMaintenance > 60000) {
        lastMaintenance = Date.now(); await cleanupAuth(db);
        await db.query("DELETE FROM worker_heartbeats WHERE updated_at<now()-interval '1 day'");
        await db.query("DELETE FROM jobs WHERE finished_at<now()-interval '7 days' AND status NOT IN ('queued','running')");
      }
      if (!sendingMail && process.env.RESEND_API_KEY && process.env.RESEND_FROM) {
        sendingMail = true;
        mail = deliverAuthMail(db).catch(() => console.error("Não foi possível processar a fila de e-mails."))
          .finally(() => { sendingMail = false; });
      }
      // Fill every free slot per tick so a burst does not start at one job per second.
      while (active.size < queueLimits().running && !stop.signal.aborted) {
        const preferred = hint || await nextJobNotification() || undefined; hint = undefined;
        const job = await claimJob(db, preferred);
        if (!job) break;
        const started = Date.now();
        log("tarefa_iniciada", { id: job.id, tipo: job.kind, esperaMs: Math.max(0, started - new Date(job.created_at).getTime()), ativas: active.size + 1 });
        const work = runClaimedJob(db, job, drain.signal)
          .then((result) => log("tarefa_concluida", { id: job.id, tipo: job.kind, duracaoMs: Date.now() - started, ok: result.ok, ...(result.error ? { erro: result.error.slice(0, 200) } : {}) }))
          .catch(() => console.error("Falha ao finalizar job; a recuperação verificará a autorização expirada."))
          .finally(() => active.delete(work));
        active.add(work);
      }
    } catch { console.error("Worker aguardando recuperação da infraestrutura."); }
    // With a free slot, wait on Redis for up to a second and claim the notified job right away;
    // without Redis (or with every slot busy) pace the durable PostgreSQL poll at one tick per second.
    const tickStarted = Date.now();
    if (!stop.signal.aborted && active.size < queueLimits().running) hint = await waitJobNotification(1) || undefined;
    const remaining = 1000 - (Date.now() - tickStarted);
    if (!hint && remaining > 0) await new Promise((resolve) => { const timer = setTimeout(done, remaining); function done() { clearTimeout(timer); stop.signal.removeEventListener("abort", done); resolve(); } stop.signal.addEventListener("abort", done, { once: true }); if (stop.signal.aborted) done(); });
  }
} finally {
  const deadline = setTimeout(() => process.exit(1), DRAIN_MS + EXIT_MARGIN_MS); deadline.unref();
  await Promise.allSettled([...active, mail]);
  await db.query("DELETE FROM worker_heartbeats WHERE id=$1", [id]);
  closeQueue(); await db.close(); clearTimeout(deadline);
}
