/** Server-Sent Events for one run: the current state right away, then a new `run` event whenever PostgreSQL
 * announces a change (or the queue moves while the run waits). Ends with `end` once the run needs no watching. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Run } from "./flow-types";
import { saasDatabase, type Database } from "./saas-db";
import { findSession, requireBetaAccess } from "./saas-auth";
import { consumeRateLimit } from "./saas-rate-limit";
import { withTenantSession } from "./tenant-context";
import { httpError, sessionToken } from "./saas-http";
import { describeRun } from "./saas-jobs";
import { watchRun } from "./run-events";

export const STREAM_LIMITS = {
  /** Coalesces bursts of notices (progress is written every 500 ms while a model streams). */
  debounceMs: 150,
  /** Safety re-read, in case a notice is lost; also the cadence without NOTIFY support. */
  refreshMs: 10000,
  refreshWithoutNotifyMs: 2000,
  /** Comment line that keeps proxies from closing an idle stream. */
  pingMs: 15000,
  /** The client reconnects after this; it bounds how long one validated session serves a stream. */
  maxMs: 15 * 60_000,
};
/** A run needs no stream once it waits for a decision or has finished. */
export const streamDone = (run: Run) => run.status !== "running";
/** What a client already holds; a new event is sent only when it changes. */
export const runStamp = (run: Run) => `${run.updatedAt}|${run.status}|${run.queue ? `${run.queue.position}/${run.queue.running}/${run.queue.workers}` : ""}`;
const encoder = new TextEncoder();
const frame = (name: string, data: unknown) => encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

export async function runEventStream(req: Request, runId: string, db: Database = saasDatabase()) {
  try {
    const token = sessionToken(req), user = await findSession(db, token);
    requireBetaAccess(user);
    await consumeRateLimit(db, `api:user:${user.id}`, 120, 60);
    const stop = new AbortController();
    const signal = AbortSignal.any([req.signal, stop.signal, AbortSignal.timeout(STREAM_LIMITS.maxMs)]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let release: (() => void) | undefined;
        const write = (bytes: Uint8Array) => { if (closed) return; try { controller.enqueue(bytes); } catch { closed = true; release?.(); } };
        const send = (name: string, data: unknown) => write(frame(name, data));
        const finish = (reason: string) => {
          if (closed) return;
          send("end", { reason }); closed = true;
          try { controller.close(); } catch { /* already closed by the consumer */ }
          release?.();
        };
        void withTenantSession(db, token, async () => {
          let sent = "", pending = false, reading = Promise.resolve();
          const read = () => {
            if (closed || pending) return reading;
            pending = true;
            reading = reading.then(async () => {
              pending = false;
              if (closed) return;
              const run = await describeRun(runId), stamp = runStamp(run);
              if (stamp !== sent) { sent = stamp; send("run", run); }
              if (streamDone(run)) finish("done");
            }).catch((error) => {
              send("error", { message: error instanceof Error ? error.message : "Não foi possível acompanhar a execução." });
              finish("error");
            });
            return reading;
          };
          let debounce: ReturnType<typeof setTimeout> | undefined;
          // Notices arrive from the LISTEN connection, outside this request's tenant context: bind it here.
          const schedule = AsyncLocalStorage.bind(() => { if (debounce || closed) return; debounce = setTimeout(() => { debounce = undefined; void read(); }, STREAM_LIMITS.debounceMs); });
          let watcher: Awaited<ReturnType<typeof watchRun>> | undefined, refresh: ReturnType<typeof setInterval> | undefined, ping: ReturnType<typeof setInterval> | undefined;
          try {
            await read();
            if (closed) return;
            watcher = await watchRun(db, user.id, runId, schedule, schedule);
            refresh = setInterval(() => void read(), watcher.live ? STREAM_LIMITS.refreshMs : STREAM_LIMITS.refreshWithoutNotifyMs);
            ping = setInterval(() => write(encoder.encode(": ping\n\n")), STREAM_LIMITS.pingMs);
            await new Promise<void>((resolve) => {
              release = () => resolve();
              signal.addEventListener("abort", release, { once: true });
              if (signal.aborted || closed) resolve();
            });
            finish(signal.aborted ? "timeout" : "done");
          } finally {
            if (debounce) clearTimeout(debounce);
            if (refresh) clearInterval(refresh);
            if (ping) clearInterval(ping);
            watcher?.stop();
            await reading.catch(() => {});
          }
        }).catch((error) => { send("error", { message: error instanceof Error ? error.message : "Não foi possível acompanhar a execução." }); finish("error"); });
      },
      cancel() { stop.abort(); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" } });
  } catch (error) { return httpError(error); }
}
