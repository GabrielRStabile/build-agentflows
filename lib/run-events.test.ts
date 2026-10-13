import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createTestDatabase } from "../scripts/saas-test-db";
import { migrateDatabase } from "./db/migrate";
import { withTenantJob } from "./tenant-context";
import { createTenantFlow, putTenantRun, cancelTenantRun, getTenantRun } from "./tenant-flows";
import { enqueueRun, claimJob, finishJob } from "./saas-jobs";
import { announceQueue, announceRun, stopWatching, watchRun } from "./run-events";
import { template } from "./flow-types";

const testDb = await createTestDatabase();
const { db } = testDb;
const a = randomUUID(), b = randomUUID();
const asA = <T>(action: () => T | Promise<T>) => withTenantJob(db, a, action);
process.env.CHAVE_MESTRA = randomBytes(32).toString("base64");
test.before(async () => { await migrateDatabase(db); });
test.after(async () => { await stopWatching(db); await testDb.close(); });
test.beforeEach(async () => {
  await testDb.exec("TRUNCATE users CASCADE");
  for (const id of [a, b]) await db.query("INSERT INTO users(id,name,email,email_verified_at,beta_status) VALUES($1,'Test user',$2,now(),'approved')", [id, `${id}@example.com`]);
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const create = () => createTenantFlow("Events", false, { name: "Events", description: "", graph: template() });

test("avisos chegam só ao observador da execução e a fila avisa todos", async () => {
  const mine: number[] = [], other: number[] = [], queue: number[] = [];
  const first = await watchRun(db, a, "run-1", () => mine.push(1), () => queue.push(1));
  const second = await watchRun(db, b, "run-2", () => other.push(1), () => {});
  assert.equal(first.live, true);
  await announceRun(db, a, "run-1"); await settle();
  assert.deepEqual([mine.length, other.length], [1, 0]);
  await announceRun(db, b, "run-1"); await settle(); // same run id, another owner: not mine
  assert.deepEqual([mine.length, other.length], [1, 0]);
  await announceQueue(db); await settle();
  assert.equal(queue.length, 1);
  first.stop(); second.stop();
  await announceRun(db, a, "run-1"); await settle();
  assert.equal(mine.length, 1);
});

test("gravar, enfileirar, reivindicar, finalizar e cancelar execuções emitem avisos no commit", async () => {
  const flow = await asA(create);
  const { run, job } = await asA(() => enqueueRun(flow.id, "Entrada", false, true));
  const runEvents: number[] = [], queueEvents: number[] = [];
  const watcher = await watchRun(db, a, run.id, () => runEvents.push(1), () => queueEvents.push(1));
  try {
    await asA(() => putTenantRun({ ...run, output: "progresso" })); await settle();
    assert.equal(runEvents.length, 1);
    const claimed = (await claimJob(db, job.id))!; await settle();
    assert.equal(queueEvents.length, 1);
    await finishJob(db, claimed, "falhou"); await settle();
    assert.ok(runEvents.length >= 2); assert.equal(queueEvents.length, 2);
    assert.equal((await asA(() => getTenantRun(run.id))).status, "failed");
    // A transaction that rolls back announces nothing.
    const before = runEvents.length;
    await assert.rejects(db.transaction(async (sql) => { await announceRun(sql, a, run.id); throw new Error("rollback"); }));
    await settle(); assert.equal(runEvents.length, before);
    const another = await asA(() => enqueueRun(flow.id, "Outra", false, true));
    const second = await watchRun(db, a, another.run.id, () => runEvents.push(2), () => {});
    await asA(() => cancelTenantRun(another.run.id)); await settle();
    assert.equal(runEvents.at(-1), 2);
    second.stop();
  } finally { watcher.stop(); }
});
