import test from "node:test";
import assert from "node:assert/strict";
import { template } from "./flow-types";
import { createTenantFlow, putTenantRun } from "./tenant-flows";
import { enqueueRun } from "./saas-jobs";
import { stopWatching } from "./run-events";
import { runEventStream, runStamp, STREAM_LIMITS } from "./run-stream";
import { createTenantTestContext } from "../scripts/tenant-test-context";

const tenant = await createTenantTestContext();
test.after(async () => { await stopWatching(tenant.db); await tenant.close(); });
const flow = await tenant.asTenant(() => createTenantFlow("Stream", false, { name: "Stream", description: "", graph: template() }));
type Frame = { event: string; data: Record<string, unknown> };
async function* frames(response: Response): AsyncGenerator<Frame> {
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (block.startsWith(":")) continue;
      const event = /^event: (.*)$/m.exec(block)?.[1] || "message", data = /^data: (.*)$/m.exec(block)?.[1] || "{}";
      yield { event, data: JSON.parse(data) };
    }
  }
}
const open = (id: string, signal?: AbortSignal) => tenant.connect(() => runEventStream(tenant.request(`/api/runs/${id}/events`, { signal }), id, tenant.db));

test("stream envia o estado atual, depois cada mudança anunciada e encerra quando a execução termina", async () => {
  const { run } = await tenant.asTenant(() => enqueueRun(flow.id, "Entrada", false, true));
  const response = await open(run.id);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  const received: Frame[] = [];
  const reading = (async () => { for await (const frame of frames(response)) received.push(frame); })();
  const until = async (n: number) => { for (let i = 0; i < 100 && received.length < n; i++) await new Promise((r) => setTimeout(r, 20)); };
  await until(1);
  assert.equal(received[0].event, "run"); assert.equal(received[0].data.id, run.id); assert.equal(received[0].data.queued, true);
  assert.ok(received[0].data.queue, "queued run carries its position");
  await tenant.asTenant(() => putTenantRun({ ...run, output: "andando" }));
  await until(2);
  assert.equal(received[1].data.output, "andando", JSON.stringify(received.map((f) => [f.event, f.data.status, f.data.output, f.data.message])));
  await tenant.asTenant(() => putTenantRun({ ...run, output: "fim", status: "completed", next: null }));
  await reading;
  const last = received.at(-1)!, final = received.at(-2)!;
  assert.equal(final.event, "run"); assert.equal(final.data.status, "completed");
  assert.deepEqual(last, { event: "end", data: { reason: "done" } });
});

test("execução já terminada responde o estado e fecha; outra conta ou id desconhecido recebe erro no stream", async () => {
  const { run } = await tenant.asTenant(() => enqueueRun(flow.id, "Pronta", false, true));
  await tenant.asTenant(() => putTenantRun({ ...run, status: "completed", next: null }));
  const received: Frame[] = [];
  for await (const frame of frames(await open(run.id))) received.push(frame);
  assert.deepEqual(received.map((f) => f.event), ["run", "end"]);
  const unknown: Frame[] = [];
  for await (const frame of frames(await open("nao-existe"))) unknown.push(frame);
  assert.deepEqual(unknown.map((f) => f.event), ["error", "end"]);
  assert.match(String(unknown[0].data.message), /não encontrada/);
  const anonymous = await tenant.connect(() => runEventStream(new Request("https://app.example.com/api/runs/x/events"), "x", tenant.db));
  assert.equal(anonymous.status, 401);
});

test("cancelar a requisição libera o observador; carimbo muda com progresso e posição na fila", async () => {
  const { run } = await tenant.asTenant(() => enqueueRun(flow.id, "Cancelada pelo cliente", false, true));
  const abort = new AbortController();
  const response = await open(run.id, abort.signal);
  const reader = response.body!.getReader();
  await reader.read();
  abort.abort();
  const rest = await reader.read().catch(() => ({ done: true, value: undefined }));
  assert.ok(rest.done || new TextDecoder().decode(rest.value).includes("end"));
  assert.ok(STREAM_LIMITS.refreshMs > STREAM_LIMITS.debounceMs);
  const base = { ...run, queue: { position: 2, ahead: 1, running: 1, slots: 2, workers: 1 } };
  assert.notEqual(runStamp(base), runStamp({ ...base, queue: { ...base.queue, position: 1, ahead: 0 } }));
  assert.equal(runStamp(run), runStamp({ ...run, output: "ignored" }));
});
