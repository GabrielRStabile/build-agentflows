import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client, Pool, type PoolClient } from "pg";
import { drizzle as postgresOrm } from "drizzle-orm/node-postgres";
import { drizzle as pgliteOrm } from "drizzle-orm/pglite";
import type { PgliteClient } from "drizzle-orm/pglite";
import * as schema from "../lib/db/schema";
import type { Database, Sql } from "../lib/saas-db";

// Server tests assert the original small limits; production defaults live in queueLimits().
process.env.FILA_LIMITE_USUARIO ??= "10";
process.env.EXECUCOES_SIMULTANEAS ??= "2";
// Older suites create many flows per account; saas-plan.test.ts sets the beta limits explicitly.
process.env.LIMITE_FLUXOS ??= "1000";

/** Never uses DATABASE_URL. Server tests own a fresh, disposable database per file. */
export async function createTestDatabase() {
  const url = process.env.SAAS_TEST_DATABASE_URL;
  if (!url) {
    const pg = new PGlite();
    const adapter = (sql: Pick<PGlite, "query" | "exec">): Sql => ({ orm: pgliteOrm(sql as PgliteClient, { schema }), async query(text, values) {
      if (!values && text.trimStart().startsWith("CREATE TABLE ")) { await sql.exec(text); return { rows: [] }; }
      return sql.query(text, values);
    } });
    const db: Database = { ...adapter(pg), transaction: (fn) => pg.transaction((tx) => fn(adapter(tx))), listen: (channel, handler) => pg.listen(channel, (payload) => handler(payload)) };
    return { db, exec: (text: string) => pg.exec(text), close: () => pg.close() };
  }
  const connection = new URL(url);
  connection.searchParams.delete("options");
  const connectionString = connection.toString();
  const testDatabase = "tenant_test_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  await admin.query(`CREATE DATABASE ${testDatabase}`);
  connection.pathname = "/" + testDatabase;
  const pool = new Pool({ connectionString: connection.toString(), max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 });
  const adapter = (sql: Pool | PoolClient): Sql => ({ orm: postgresOrm(sql, { schema }), async query(text, values) {
    const result = await sql.query(text, values);
    return { rows: Array.isArray(result) ? [] : result.rows };
  } });
  let listener: Client | undefined;
  const handlers = new Map<string, Set<(payload: string) => void>>();
  const db: Database = { ...adapter(pool), async transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(adapter(client));
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }, async listen(channel, handler) {
    if (!listener) {
      listener = new Client({ connectionString: connection.toString() });
      listener.on("notification", (m) => { for (const h of handlers.get(m.channel) || []) h(m.payload || ""); });
      await listener.connect();
    }
    const set = handlers.get(channel) || new Set(); const first = !handlers.has(channel); set.add(handler); handlers.set(channel, set);
    if (first) await listener.query(`LISTEN "${channel}"`);
    return async () => { set.delete(handler); if (!set.size) { handlers.delete(channel); await listener?.query(`UNLISTEN "${channel}"`); } };
  } };
  return { db, exec: (text: string) => pool.query(text), async close() {
    await listener?.end();
    await pool.end();
    try { await admin.query(`DROP DATABASE ${testDatabase}`); }
    finally { await admin.end(); }
  } };
}
