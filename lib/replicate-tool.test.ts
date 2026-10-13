import test from "node:test";
import assert from "node:assert/strict";
import { replicateAgentTool, replicateToolReport, toolRunScope } from "./replicate-tool";
import { replicateCapabilities } from "./media-provider";
import { validateToolCards } from "./agent-tools";
import type { Run, Trace } from "./flow-types";

const schema = (input: Record<string, unknown>) => ({ latest_version: { id: "a".repeat(64), openapi_schema: { components: { schemas: { Input: { properties: input }, Output: { type: "string", format: "uri" } } } } } });
const multimodal = schema({ prompt: { type: "string" }, image_input: { type: "array", items: { type: "string", format: "uri" } } });
const textOnly = schema({ prompt: { type: "string" }, aspect_ratio: { type: "string" } });
// Only the free model read is answered; any other request would be a charge.
const reading = (body: unknown, status = 200) => (async (url: unknown, init?: RequestInit) => {
  assert.match(String(url), /^https:\/\/api\.replicate\.com\/v1\/models\/[a-z0-9-]+\/[a-z0-9.-]+$/);
  assert.equal(init?.method, undefined);
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer token");
  return Response.json(body, { status });
}) as typeof fetch;

test("Replicate como ferramenta: detecta modelos multimodais pelo schema", async () => {
  assert.deepEqual(replicateCapabilities({ input: { prompt: { type: "string" }, image_input: { type: "array", items: { type: "string", format: "uri" } } } }), { promptField: "prompt", imageField: "image_input", multipleImages: true });
  assert.deepEqual(replicateCapabilities({ input: { prompt: { type: "string" }, image: { type: "string", format: "uri" } } }), { promptField: "prompt", imageField: "image", multipleImages: false });
  assert.deepEqual(await replicateToolReport({ model: "google/nano-banana-pro" }, "token", reading(multimodal)), { model: "google/nano-banana-pro", promptField: "prompt", imageField: "image_input", multipleImages: true });
  assert.equal((await replicateToolReport({ model: "acme/text-only" }, "token", reading(textOnly))).imageField, undefined);
  await assert.rejects(replicateToolReport({ model: "acme/missing" }, "token", reading({}, 404)), /não foi encontrado na Replicate/);
  await assert.rejects(replicateToolReport({ model: "acme/seed" }, "token", reading(schema({ seed: { type: "integer" } }))), /não recebe uma descrição em texto/);
  await assert.rejects(replicateToolReport({ model: "" }, "token", reading(multimodal)), /Informe o modelo/);
  await assert.rejects(replicateToolReport({ model: "Google/Nano" }, "token", reading(multimodal)), /empresa\/modelo/);
});

test("Replicate como ferramenta: o agente só recebe imagens de referência em modelos multimodais", async () => {
  const image = await replicateAgentTool({ model: "google/nano-banana-pro", description: "Use para as artes." }, "token", reading(multimodal));
  assert.equal(image.name, "replicate");
  assert.match(image.description, /^Use para as artes\. .*google\/nano-banana-pro.*usar_imagens=true.*até 5 imagens/);
  assert.deepEqual(Object.keys((image.schema as { properties: object }).properties), ["descricao", "usar_imagens"]);
  const text = await replicateAgentTool({ model: "acme/text-only" }, "token", reading(textOnly), async () => ({ text: "Resposta" }));
  assert.match(text.description, /apenas texto e não aceita imagens de referência/);
  assert.deepEqual(Object.keys((text.schema as { properties: object }).properties), ["descricao"]);
  await assert.rejects(text.call({ descricao: "Um gato" }), /Use esta ferramenta em um bloco Agente/);
  const trace = { type: "tool", nodeId: "agente", label: "Ferramenta: replicate", output: "", at: "", ms: 0 } as Trace;
  const run = { flowId: "fluxo", trace: [], attachments: [] } as unknown as Run;
  const scoped = (args: unknown) => toolRunScope.run({ run, nodeId: "agente", signal: new AbortController().signal, trace }, () => text.call(args));
  // Refused before any download or submission.
  await assert.rejects(scoped({ descricao: "Edite a foto", usar_imagens: true }), /não aceita imagens de referência/);
  await assert.rejects(scoped({ descricao: " " }), /Informe a descrição/);
  assert.equal(await scoped({ descricao: "Um gato" }), "Resposta");
  assert.equal(trace.input, JSON.stringify({ descricao: "Um gato" }, null, 2));
});

test("Replicate como ferramenta: o cartão guarda só o modelo e a credencial", () => {
  const card = (params: Record<string, string>) => JSON.stringify([{ id: "c1", kind: "tool", target: "interno:replicate", params }]);
  validateToolCards(card({ model: "google/nano-banana-pro", description: "Artes" }));
  validateToolCards(card({ model: "" }));
  assert.throws(() => validateToolCards(card({ model: "Google/Nano Banana" })), /empresa\/modelo/);
  assert.throws(() => validateToolCards(card({ token: "segredo" })), /Confira as ferramentas/);
});
