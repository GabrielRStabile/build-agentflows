import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "agentflows-edit-"));
process.env.DATA_DIR = dir;
const { applyFlowPatch, editFlow, validateFlowMessages } = await import("./flow-ai-edit");
const { block } = await import("./flow-types");
const { validateGraph } = await import("./flow-service");
test.after(() => rmSync(dir, { recursive: true, force: true }));
function context() {
  const start = block("start", "inicio", -210, 365);
  start.data.config.state = '{"Resumo":"rascunho não salvo"}';
  const agent = block("agent", "analista", 200, 478);
  Object.assign(agent.data.config, { system: "Instrução manual", model: "openrouter:custom", tools: "[]", stateUpdates: '[{"key":"Resumo","value":"{{nodes.analista}}"}]' });
  return { name: "Meu fluxo", description: "Descrição original", graph: { nodes: [start, agent], edges: [{ id: "conexao_original", source: "inicio", target: "analista" }] } };
}
test("ajuste pontual preserva IDs, posições, modelos, variáveis, conexões e contexto original", () => {
  const current = context(), before = structuredClone(current);
  const result = applyFlowPatch(current, JSON.stringify({ summary: "Resposta mais breve.", updates: [{ id: "analista", config: { system: "Responda em uma frase." } }] }));
  assert.deepEqual(current, before);
  const expected = structuredClone(current);
  expected.graph.nodes[1].data.config.system = "Responda em uma frase.";
  assert.deepEqual(result, { ...expected, summary: "Resposta mais breve." });
});
test("adições e remoções alteram só o pedido, posicionam novos blocos e mantêm fluxo executável", () => {
  const current = context();
  const added = applyFlowPatch(current, JSON.stringify({ summary: "Adicionei uma resposta final.", additions: [{ id: "fim", kind: "end", config: { text: "{{last}}" } }], connections: { add: [{ source: "analista", target: "fim" }] } }));
  assert.deepEqual(added.graph.nodes.slice(0, 2), current.graph.nodes);
  assert.equal(added.graph.nodes.length, 3);
  assert.doesNotThrow(() => validateGraph(added.graph, true));
  const removed = applyFlowPatch(added, JSON.stringify({ summary: "Removi a resposta final.", removals: ["fim"] }));
  assert.deepEqual(removed.graph, current.graph);
});
test("edição permite rascunho só com Início, pergunta sem mudanças e histórico limitado", () => {
  const current = context(); current.graph.nodes.pop(); current.graph.edges = [];
  assert.deepEqual(applyFlowPatch(current, '{"summary":"Qual deve ser o tom?"}'), { ...current, summary: "Qual deve ser o tom?" });
  assert.throws(() => validateFlowMessages([{ role: "system", content: "x" }]), /histórico/);
  assert.throws(() => validateFlowMessages(Array.from({ length: 13 }, () => ({ role: "user", content: "x" }))), /histórico/);
});
test("rejeita blocos inexistentes e conexões inválidas sem tocar no canvas", () => {
  const current = context(), before = structuredClone(current);
  for (const patch of [
    { updates: [{ id: "ausente", label: "X" }] },
    { additions: [{ id: "analista", kind: "llm" }] },
    { additions: [{ id: "novo", kind: "agent" }, { id: "novo", kind: "agent" }] },
    { additions: [{ id: "x", kind: "pesquisador" }] },
    { removals: ["analista"], additions: [{ id: "analista", kind: "agent" }] },
    { connections: { add: [{ source: "inicio", target: "analista" }] } },
    { connections: { remove: ["ausente"] } },
    { removals: ["inicio"] },
  ]) assert.throws(() => applyFlowPatch(current, JSON.stringify({ summary: "Ajuste", ...patch })));
  assert.deepEqual(current, before);
});
test("bloco existente repetido em additions ao inserir uma etapa antes dele vira atualização", () => {
  const current = context();
  const result = applyFlowPatch(current, JSON.stringify({
    summary: "Adicionei um pesquisador antes do analista.",
    additions: [{ id: "pesquisador", kind: "agent", label: "Pesquisador", config: { system: "Pesquise o tema." } }, { id: "analista", kind: "agent", label: "Analista" }],
    connections: { remove: ["conexao_original"], add: [{ source: "inicio", target: "pesquisador" }, { source: "pesquisador", target: "analista" }] },
  }));
  assert.deepEqual(result.graph.nodes.slice(0, 2), current.graph.nodes.map((n) => n.id === "analista" ? { ...n, data: { ...n.data, label: "Analista" } } : n));
  assert.deepEqual(result.graph.nodes.map((n) => n.id), ["inicio", "analista", "pesquisador"]);
  assert.doesNotThrow(() => validateGraph(result.graph, true));
});
test("conversa usa proposta anterior como contexto e tenta reparar uma resposta inválida", async () => {
  const first = await editFlow("Seja breve", context(), [], async () => '{"summary":"Agora é breve.","updates":[{"id":"analista","config":{"system":"Seja breve"}}]}');
  let calls = 0;
  const history = [{ role: "user" as const, content: "Seja breve" }, { role: "assistant" as const, content: first.summary }];
  const second = await editFlow("E cordial", first, history, async (system, input) => {
    assert.match(system, /MODO EDIÇÃO/); assert.match(input, /Agora é breve/); assert.match(input, /rascunho não salvo/);
    assert.match(input, /"system":"Seja breve"/);
    return ++calls === 1 ? "erro" : '{"summary":"Breve e cordial.","updates":[{"id":"analista","config":{"system":"Seja breve e cordial"}}]}';
  });
  assert.equal(calls, 2); assert.equal(second.graph.nodes[1].data.config.system, "Seja breve e cordial");
  assert.equal(second.graph.nodes[1].data.config.model, "openrouter:custom");
});
test("API edita contexto não salvo via JSON ou stream, sem persistir, e rejeita contexto inválido", async (t) => {
  const tenant = await (await import("../scripts/tenant-test-context")).createTenantTestContext(); t.after(tenant.close);
  const { POST } = await import("../app/api/flows/[id]/generate/route");
  const { chatGPT } = await import("./chatgpt");
  const bridge = await tenant.asTenant(() => chatGPT()), originalAccount = bridge.account, originalRun = bridge.run;
  bridge.account = async () => ({ account: { type: "chatgpt", email: "test@example.com", planType: "plus" }, login: null, error: null });
  bridge.run = async () => '{"summary":"Renomeado.","updates":[{"id":"analista","label":"Atendente"}]}';
  const send = (accept: string, extra = {}) => tenant.connect(() => POST(tenant.request("/api/flows/new/generate", { method: "POST", headers: { Accept: accept }, body: JSON.stringify({ mode: "edit", prompt: "Renomear agente", context: context(), history: [], ...extra }) }), { params: Promise.resolve({ id: "new" }) }));
  try {
    const response = await send("application/json"); assert.equal(response.status, 200);
    assert.equal((await response.json()).graph.nodes[1].data.label, "Atendente");
    const streamed = await send("application/x-ndjson");
    const events = (await streamed.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.at(-1).result.summary, "Renomeado.");
    assert.equal((await tenant.asTenant(() => import("./tenant-flows").then((m) => m.listTenantFlows()))).length, 0);
    assert.equal((await send("application/json", { context: null })).status, 400);
    assert.equal((await send("application/json", { mode: "invalid" })).status, 400);
  } finally { bridge.account = originalAccount; bridge.run = originalRun; }
});
