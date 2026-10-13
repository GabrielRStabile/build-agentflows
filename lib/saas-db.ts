import { Client, Pool, type QueryResultRow } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./db/schema";
import { AsyncLocalStorage } from "node:async_hooks";

export type Orm = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Sql {
  orm: Orm;
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Sql {
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  /** Subscribes to a NOTIFY channel; resolves to the unsubscribe function. Absent when the backend cannot listen. */
  listen?(channel: string, handler: (payload: string) => void): Promise<() => Promise<void>>;
}

type Connection = Database & { close(): Promise<void> };
let instance: Connection | undefined;
const connections = new AsyncLocalStorage<Connection>();

/** Explicit dependency scope for integration tests and controlled background work. */
export function withDatabase<T>(db: Connection, action: () => T): T { return connections.run(db, action); }

/** A bounded pool per process; web and workers use the same authoritative database. */
export function saasDatabase() {
  const scoped = connections.getStore();
  if (scoped) return scoped;
  if (instance) return instance;
  if (!process.env.DATABASE_URL) throw new Error("Configure DATABASE_URL para o PostgreSQL.");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.POSTGRES_CONEXOES) > 0 ? Number(process.env.POSTGRES_CONEXOES) : 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000,
  });
  // Do not log a connection URL, SQL parameters or provider secrets.
  pool.on("error", () => console.error("Conexão ociosa com PostgreSQL interrompida."));
  // One dedicated connection per process receives NOTIFY for every subscriber; it reconnects and re-issues LISTEN.
  const channels = new Map<string, Set<(payload: string) => void>>();
  let listener: Client | undefined, opening: Promise<Client> | undefined, closed = false;
  const ensureListener = (): Promise<Client> => {
    if (listener) return Promise.resolve(listener);
    if (opening) return opening;
    opening = (async () => {
      const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
      client.on("notification", (message) => { for (const handler of channels.get(message.channel) || []) handler(message.payload || ""); });
      const dropped = () => {
        if (listener !== client) return;
        listener = undefined;
        if (closed || !channels.size) return;
        console.error("Conexão de avisos com PostgreSQL interrompida; reconectando.");
        // Streams keep working meanwhile through their periodic re-read; retry until the database is back.
        const retry = () => { if (closed || listener || !channels.size) return; ensureListener().catch(() => setTimeout(retry, 5000).unref()); };
        setTimeout(retry, 2000).unref();
      };
      client.on("error", dropped); client.on("end", dropped);
      await client.connect();
      for (const channel of channels.keys()) await client.query(`LISTEN "${channel}"`);
      listener = client;
      return client;
    })().finally(() => { opening = undefined; });
    return opening;
  };
  instance = {
    orm: drizzle(pool, { schema }),
    query: (text, values) => pool.query(text, values),
    async listen(channel, handler) {
      if (!/^[a-z_]{1,63}$/.test(channel)) throw new Error("Canal de aviso inválido.");
      const first = !channels.has(channel);
      const handlers = channels.get(channel) || new Set(); handlers.add(handler); channels.set(channel, handlers);
      const client = await ensureListener();
      if (first) await client.query(`LISTEN "${channel}"`);
      return async () => {
        handlers.delete(handler);
        if (handlers.size) return;
        channels.delete(channel);
        if (listener === client) await client.query(`UNLISTEN "${channel}"`).catch(() => {});
      };
    },
    async transaction(fn) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query("BEGIN");
        const result = await fn({ query: (text, values) => client.query(text, values), orm: drizzle(client, { schema }) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { broken = true; }
        throw error;
      } finally { client.release(broken); }
    },
    async close() { closed = true; const client = listener; listener = undefined; await client?.end().catch(() => {}); await pool.end(); instance = undefined; },
  };
  return instance;
}
