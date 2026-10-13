/** Browser side of run tracking: a Server-Sent Events stream when available, the polling loop otherwise.
 * Pure of DOM globals so it can be unit-tested with fakes. */
export type WatchedRun = { id: string; status: string; updatedAt: string; queued?: boolean };
export type EventSourceLike = {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  close(): void;
};
export type WatchOptions<T extends WatchedRun> = {
  /** GET /api/runs/[id]?after=; null means unchanged. */
  poll: (id: string, after?: string) => Promise<T | null>;
  /** Opens the stream; undefined when the browser has no EventSource. */
  open?: (url: string) => EventSourceLike;
  pollIntervalMs?: number;
  /** Without any stream event in this time, polling takes over. */
  streamTimeoutMs?: number;
};
export const streamUrl = (id: string) => "/api/runs/" + encodeURIComponent(id) + "/events";
export const watchDone = (run: WatchedRun) => run.status !== "running";
/** Follows a run until it stops running, calling onUpdate with every new state. Returns the stop function. */
export function watchRun<T extends WatchedRun>(id: string, after: string | undefined, onUpdate: (run: T) => void, options: WatchOptions<T>) {
  const { poll, open, pollIntervalMs = 2000, streamTimeoutMs = 5000 } = options;
  let stopped = false, latest = after, stream: EventSourceLike | undefined, timer: ReturnType<typeof setInterval> | undefined, guard: ReturnType<typeof setTimeout> | undefined;
  const deliver = (run: T) => { if (stopped) return; latest = run.updatedAt; onUpdate(run); if (watchDone(run)) stop(); };
  const stop = () => { stopped = true; stream?.close(); stream = undefined; if (timer) clearInterval(timer); if (guard) clearTimeout(guard); };
  const startPolling = () => {
    if (stopped || timer) return;
    let inFlight = false;
    timer = setInterval(() => {
      if (inFlight || stopped) return;
      inFlight = true;
      poll(id, latest).then((run) => { if (run) deliver(run); }).catch(() => {}).finally(() => { inFlight = false; });
    }, pollIntervalMs);
  };
  const startStream = () => {
    if (stopped || !open) { startPolling(); return; }
    let source: EventSourceLike;
    try { source = open(streamUrl(id)); } catch { startPolling(); return; }
    stream = source;
    let received = false;
    const fallback = () => { if (stream !== source) return; source.close(); stream = undefined; if (guard) clearTimeout(guard); startPolling(); };
    guard = setTimeout(() => { if (!received) fallback(); }, streamTimeoutMs);
    source.addEventListener("run", (event) => {
      received = true; if (guard) clearTimeout(guard);
      try { deliver(JSON.parse(event.data || "") as T); } catch { /* ignore malformed frame */ }
    });
    source.addEventListener("end", (event) => {
      if (stream !== source) return;
      let reason = ""; try { reason = JSON.parse(event.data || "{}").reason || ""; } catch { /* ignore */ }
      source.close(); stream = undefined;
      // The server closes finished runs after sending them; anything else (session window, error) is retried.
      if (!stopped && reason !== "done") startStream();
      else if (!stopped && reason === "done") startPolling();
    });
    source.addEventListener("error", () => fallback());
  };
  startStream();
  return stop;
}
