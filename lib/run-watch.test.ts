import test from "node:test";
import assert from "node:assert/strict";
import { streamUrl, watchRun, type EventSourceLike } from "./run-watch";

type Run = { id: string; status: string; updatedAt: string };
class FakeSource implements EventSourceLike {
  listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  closed = false;
  url: string;
  constructor(url: string) { this.url = url; }
  addEventListener(type: string, listener: (event: { data?: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  close() { this.closed = true; }
  emit(type: string, data?: unknown) { for (const l of this.listeners.get(type) || []) l({ data: data === undefined ? undefined : JSON.stringify(data) }); }
}
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("stream entrega as atualizações e para sozinho quando a execução termina", async () => {
  const sources: FakeSource[] = [];
  const seen: string[] = [];
  let polls = 0;
  const stop = watchRun<Run>("r1", "t0", (run) => seen.push(run.updatedAt), { poll: async () => { polls++; return null; }, open: (url) => { const s = new FakeSource(url); sources.push(s); return s; }, pollIntervalMs: 10, streamTimeoutMs: 50 });
  assert.equal(sources[0].url, streamUrl("r1"));
  sources[0].emit("run", { id: "r1", status: "running", updatedAt: "t1" });
  sources[0].emit("run", { id: "r1", status: "completed", updatedAt: "t2" });
  sources[0].emit("end", { reason: "done" });
  await tick(30);
  assert.deepEqual(seen, ["t1", "t2"]);
  assert.equal(sources[0].closed, true); assert.equal(polls, 0); assert.equal(sources.length, 1);
  stop();
});

test("sem evento a tempo ou com erro, o polling assume com o último updatedAt", async () => {
  const sources: FakeSource[] = [];
  const after: (string | undefined)[] = [];
  const states: Run[] = [{ id: "r2", status: "running", updatedAt: "t1" }, { id: "r2", status: "completed", updatedAt: "t2" }];
  const seen: string[] = [];
  watchRun<Run>("r2", "t0", (run) => seen.push(run.updatedAt), { poll: async (_id, a) => { after.push(a); return states.shift() || null; }, open: (url) => { const s = new FakeSource(url); sources.push(s); return s; }, pollIntervalMs: 10, streamTimeoutMs: 20 });
  await tick(60);
  assert.equal(sources[0].closed, true);
  assert.deepEqual(seen, ["t1", "t2"]);
  assert.deepEqual(after.slice(0, 2), ["t0", "t1"]);
  const errored: FakeSource[] = [];
  const got: string[] = [];
  const pending: Run[] = [{ id: "r3", status: "completed", updatedAt: "x" }];
  watchRun<Run>("r3", undefined, (run) => got.push(run.updatedAt), { poll: async () => pending.shift() || null, open: (url) => { const s = new FakeSource(url); errored.push(s); return s; }, pollIntervalMs: 10, streamTimeoutMs: 1000 });
  errored[0].emit("error");
  await tick(40);
  assert.deepEqual(got, ["x"]); assert.equal(errored.length, 1);
});

test("fim por janela de sessão reabre o stream; sem EventSource usa polling; stop encerra tudo", async () => {
  const sources: FakeSource[] = [];
  const stop = watchRun<Run>("r4", undefined, () => {}, { poll: async () => null, open: (url) => { const s = new FakeSource(url); sources.push(s); return s; }, pollIntervalMs: 10, streamTimeoutMs: 1000 });
  sources[0].emit("run", { id: "r4", status: "running", updatedAt: "t1" });
  sources[0].emit("end", { reason: "timeout" });
  await tick(5);
  assert.equal(sources.length, 2); assert.equal(sources[0].closed, true);
  stop();
  assert.equal(sources[1].closed, true);
  let polls = 0;
  const halt = watchRun<Run>("r5", undefined, () => {}, { poll: async () => { polls++; return null; }, pollIntervalMs: 10 });
  await tick(35);
  assert.ok(polls >= 2);
  halt();
  const before = polls; await tick(30); assert.equal(polls, before);
});
