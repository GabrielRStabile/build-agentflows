import type { Database } from "./saas-db";
import { withTenantJob } from "./tenant-context";
import { assertJobLease, withJobLease } from "./saas-job-context";
import { finishJob, heartbeatJob, type Job } from "./saas-jobs";
import { getTenantRun } from "./tenant-flows";
import { deliverChannelReply } from "./channel-flows";
import { execute } from "./flow-runtime";
import { indexKnowledge, processKnowledgeSource } from "./tenant-knowledge-index";
import { FlowError } from "./flow-store";
import { AuthError } from "./saas-security";

const LEASE_GRACE_MS = 45_000;

/** One leased job, suitable for CLI worker and integration tests. */
export async function runClaimedJob(db: Database, job: Job, shutdown?: AbortSignal) {
  if (!job.lease_token || job.status !== "running") throw new Error("Job sem autorização de execução.");
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, ...(shutdown ? [shutdown] : []), AbortSignal.timeout(15 * 60_000)]);
  // A revoked lease aborts at once; a transient database error (busy pool with many slots) only aborts
  // once the 60 s lease could have expired, since the next renewal usually succeeds.
  let heartbeat = Promise.resolve(), checking = false, renewedAt = Date.now();
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    heartbeat = heartbeatJob(db, job).then((valid) => { if (valid) renewedAt = Date.now(); else abort.abort(); })
      .catch(() => { if (Date.now() - renewedAt >= LEASE_GRACE_MS) abort.abort(); }).finally(() => { checking = false; });
  }, 10000);
  let failure: string | undefined;
  try {
    await withJobLease({ id: job.id, owner: job.user_id, token: job.lease_token, signal }, () => withTenantJob(db, job.user_id, async () => {
      signal.throwIfAborted();
      await assertJobLease(db, job.user_id);
      if (job.kind === "run") {
        const run = await getTenantRun(job.run_id!);
        if (run.status !== "running") return;
        delete run.queued;
        const result = await execute(run, signal);
        await deliverChannelReply(result);
        if (result.status === "failed") failure = result.error || "A execução falhou.";
      } else if (job.kind === "index") await indexKnowledge(job.base_id!);
      else await processKnowledgeSource(job.base_id!, job.source_id!);
    }));
  } catch (error) {
    failure = error instanceof FlowError || error instanceof AuthError ? error.message : "A tarefa foi interrompida. Confira os resultados antes de tentar novamente.";
  } finally {
    clearInterval(timer); await heartbeat;
    await finishJob(db, job, failure);
  }
  return { ok: !failure, error: failure };
}
