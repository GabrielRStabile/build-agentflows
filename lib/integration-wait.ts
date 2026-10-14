import { AsyncLocalStorage } from "node:async_hooks";
import type { Run } from "./flow-types";
import { currentTenant } from "./tenant-context";
import { getTenantRun } from "./tenant-flows";
import { watchRun } from "./run-events";
import { runBudgetMs } from "./run-limits";

// Espera síncrona da execução publicada: a resposta HTTP só volta quando a execução termina
// (concluída, falha, cancelada ou aguardando aprovação). Avisos chegam por LISTEN; sem eles, consulta.
export const WAIT_MARGIN_MS = 15_000;
export const settled = (run: Run) => run.status !== "running";
export function integrationWaitMs(requested: string | null) {
  const max = runBudgetMs() + WAIT_MARGIN_MS;
  if (requested === null || requested === "") return max;
  const seconds = Number(requested);
  if (!Number.isFinite(seconds) || seconds < 0) return max;
  return Math.min(max, Math.floor(seconds * 1000));
}
export async function awaitRun(runId: string, timeoutMs: number): Promise<Run> {
  const { db, user } = currentTenant();
  let latest = await getTenantRun(runId);
  if (timeoutMs <= 0 || settled(latest)) return latest;
  return new Promise<Run>((resolve, reject) => {
    let finished = false, reading: Promise<void> = Promise.resolve();
    let watcher: Awaited<ReturnType<typeof watchRun>> | undefined, poll: ReturnType<typeof setInterval> | undefined;
    const finish = (run: Run) => { if (finished) return; finished = true; cleanup(); resolve(run); };
    const fail = (error: unknown) => { if (finished) return; finished = true; cleanup(); reject(error); };
    const timer = setTimeout(() => finish(latest), timeoutMs);
    const cleanup = () => { clearTimeout(timer); if (poll) clearInterval(poll); watcher?.stop(); };
    // Avisos vêm da conexão LISTEN, fora do contexto desta requisição: a leitura é ligada a ele aqui.
    const read = AsyncLocalStorage.bind(() => {
      if (finished) return;
      reading = reading.then(async () => {
        if (finished) return;
        latest = await getTenantRun(runId);
        if (settled(latest)) finish(latest);
      }).catch(fail);
    });
    watchRun(db, user.id, runId, read, read).then((started) => {
      if (finished) { started.stop(); return; }
      watcher = started;
      poll = setInterval(read, started.live ? 5000 : 300);
      read();
    }).catch(fail);
  });
}
