/** Push notifications for run progress: PostgreSQL NOTIFY fires on commit, one LISTEN connection per process
 * fans out to the SSE streams of that process. Payloads carry ids only, never run content. */
import type { Database, Sql } from "./saas-db";

export const RUN_CHANNEL = "agentflows_runs";
export const QUEUE_CHANNEL = "agentflows_queue";
export const runEventKey = (owner: string, runId: string) => `${owner}:${runId}`;
/** Call inside the transaction that changed the run; the notice is delivered only if it commits. */
export async function announceRun(sql: Sql, owner: string, runId: string) {
  await sql.query("SELECT pg_notify($1,$2)", [RUN_CHANNEL, runEventKey(owner, runId)]);
}
/** A slot was taken or released: queued runs may have a new position. */
export async function announceQueue(sql: Sql) {
  await sql.query("SELECT pg_notify($1,'')", [QUEUE_CHANNEL]);
}

type Handler = () => void;
type Hub = { runs: Map<string, Set<Handler>>; queue: Set<Handler>; ready?: Promise<boolean>; stop?: () => Promise<void> };
const hubs = new WeakMap<Database, Hub>();
function hubOf(db: Database): Hub {
  let hub = hubs.get(db);
  if (!hub) { hub = { runs: new Map(), queue: new Set() }; hubs.set(db, hub); }
  return hub;
}
/** True when NOTIFY is wired for this process; false means watchers must re-read on their own. */
function ensureListening(db: Database, hub: Hub): Promise<boolean> {
  if (hub.ready) return hub.ready;
  hub.ready = (async () => {
    if (!db.listen) return false;
    const stops: (() => Promise<void>)[] = [];
    try {
      stops.push(await db.listen(RUN_CHANNEL, (payload) => { for (const handler of hub.runs.get(payload) || []) handler(); }));
      stops.push(await db.listen(QUEUE_CHANNEL, () => { for (const handler of hub.queue) handler(); }));
    } catch {
      for (const stop of stops) await stop().catch(() => {});
      hub.ready = undefined; // Try again on the next watcher; until then, watchers re-read periodically.
      return false;
    }
    hub.stop = async () => { for (const stop of stops) await stop().catch(() => {}); hub.ready = undefined; hub.stop = undefined; };
    return true;
  })();
  return hub.ready;
}
/** Subscribes to one run (and to queue movements). Resolves to { live, stop }: live is false without NOTIFY support. */
export async function watchRun(db: Database, owner: string, runId: string, onRun: Handler, onQueue: Handler = onRun) {
  const hub = hubOf(db), key = runEventKey(owner, runId);
  const live = await ensureListening(db, hub);
  const handlers = hub.runs.get(key) || new Set(); handlers.add(onRun); hub.runs.set(key, handlers);
  hub.queue.add(onQueue);
  return {
    live,
    stop() {
      handlers.delete(onRun); if (!handlers.size) hub.runs.delete(key);
      hub.queue.delete(onQueue);
    },
  };
}
/** Tests and shutdown: releases the LISTEN subscriptions of this process. */
export async function stopWatching(db: Database) { await hubs.get(db)?.stop?.(); }
