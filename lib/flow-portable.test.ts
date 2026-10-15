import test from "node:test";
import assert from "node:assert/strict";
import { portableGraph, portableToolCards } from "./flow-portable";
import type { Graph } from "./flow-types";

test("portableGraph remove credenciais, bases, subfluxos e contas conectadas, preservando o resto", () => {
  const cards = JSON.stringify([
    { id: "c1", kind: "tool", target: "interno:replicate", credentialId: "11111111-1111-4111-8111-111111111111", params: { model: "google/nano-banana" } },
    { id: "c2", kind: "tool", target: "interno:subfluxo", params: { flowId: "abc", description: "Chama outro fluxo" } },
    { id: "c3", kind: "tool", target: "interno:composio", credentialId: "22222222-2222-4222-8222-222222222222", params: { app: "gmail", connectedAccountId: "ca_1" } },
    { id: "c4", kind: "mcp", target: "meu-servidor" },
  ]);
  const graph: Graph = { edges: [], nodes: [
    { id: "n1", type: "block", position: { x: 0, y: 0 }, data: { kind: "agent", label: "Agente", config: {
      model: "openai:gpt-6", modelCredentialId: "33333333-3333-4333-8333-333333333333", system: "Olá {{input}}",
      tools: "interno:replicate,interno:subfluxo,interno:composio,mcp:meu-servidor:buscar", toolCards: cards,
      knowledgeBases: JSON.stringify([{ baseId: "kb1", description: "" }]), knowledgeReferences: "true",
    } } },
    { id: "n2", type: "block", position: { x: 0, y: 0 }, data: { kind: "llm", label: "LLM", config: { model: "chatgpt:gpt-6", knowledgeBase: "kb-legado", system: "x" } } },
  ] as Graph["nodes"] };
  const out = portableGraph(graph);
  const agent = out.nodes[0].data.config, llm = out.nodes[1].data.config;
  assert.equal(agent.modelCredentialId, undefined);
  assert.equal(agent.knowledgeBases, undefined);
  assert.equal(llm.knowledgeBase, undefined);
  assert.equal(agent.model, "openai:gpt-6");
  assert.equal(agent.system, "Olá {{input}}");
  assert.equal(agent.knowledgeReferences, "true");
  assert.equal(agent.tools, "interno:replicate,interno:subfluxo,interno:composio,mcp:meu-servidor:buscar");
  assert.deepEqual(JSON.parse(agent.toolCards), [
    { id: "c1", kind: "tool", target: "interno:replicate", params: { model: "google/nano-banana" } },
    { id: "c2", kind: "tool", target: "interno:subfluxo", params: { description: "Chama outro fluxo" } },
    { id: "c3", kind: "tool", target: "interno:composio", params: { app: "gmail" } },
    { id: "c4", kind: "mcp", target: "meu-servidor" },
  ]);
  // O grafo original não muda.
  assert.equal(graph.nodes[0].data.config.modelCredentialId, "33333333-3333-4333-8333-333333333333");
  assert.ok(graph.nodes[0].data.config.toolCards.includes("credentialId"));
});

test("portableToolCards tolera valores inválidos", () => {
  assert.equal(portableToolCards("não é json"), "não é json");
  assert.equal(portableToolCards('{"id":"x"}'), '{"id":"x"}');
  assert.equal(portableToolCards("[null,1]"), "[null,1]");
});
