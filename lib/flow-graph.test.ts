import test from "node:test";
import assert from "node:assert/strict";
import { block, template, type Graph } from "./flow-types";
import {
  connect,
  connectionProblem,
  layout,
  loopTargets,
  outputLabel,
  outputs,
  upgradeGraph,
} from "./flow-graph";
test("cada tipo de bloco expõe as saídas certas", () => {
  assert.deepEqual(outputs("agent"), [{ id: null, label: "" }]);
  assert.deepEqual(
    outputs("condition").map((o) => o.id),
    ["yes", "no"],
  );
  assert.deepEqual(outputs("loop"), [], "Repetir volta ao bloco escolhido, sem setas");
  assert.deepEqual(outputs("end"), []);
  assert.equal(outputLabel("approval", "no"), "Rejeitar");
  assert.equal(outputLabel("agent", null), "");
});
test("conexão recusa auto-conexão, Início como destino e saída da Resposta", () => {
  const g = template();
  assert.match(
    connectionProblem(g, { source: "analista", target: "analista" })!,
    /blocos diferentes/,
  );
  assert.match(
    connectionProblem(g, { source: "analista", target: "inicio" })!,
    /Início/,
  );
  assert.match(
    connectionProblem(g, { source: "resposta", target: "analista" })!,
    /Resposta/,
  );
});
test("cada saída aceita uma única conexão", () => {
  const g = template();
  assert.match(
    connectionProblem(g, { source: "inicio", target: "resposta" })!,
    /já está conectada/,
  );
  const c = block("condition", "cond", 0, 0);
  const g2: Graph = {
    nodes: [...g.nodes, c],
    edges: [{ id: "x", source: "cond", target: "resposta", sourceHandle: "yes" }],
  };
  assert.equal(
    connectionProblem(g2, { source: "cond", target: "analista", sourceHandle: "no" }),
    null,
  );
  assert.match(
    connectionProblem(g2, { source: "cond", target: "analista", sourceHandle: "yes" })!,
    /já está conectada/,
  );
});
test("conexões nunca formam ciclo; Repetir escolhe o destino pelo nome e não tem saída", () => {
  const g: Graph = {
    nodes: [
      block("start", "inicio", 0, 0),
      block("agent", "a", 0, 0),
      block("condition", "c", 0, 0),
      block("loop", "rep", 0, 0),
      block("end", "fim", 0, 0),
    ],
    edges: [
      { id: "1", source: "inicio", target: "a" },
      { id: "2", source: "a", target: "c" },
      { id: "3", source: "c", target: "rep", sourceHandle: "no" },
    ],
  };
  assert.match(connectionProblem(g, { source: "rep", target: "a", sourceHandle: "repeat" })!, /não tem saída/);
  assert.match(connectionProblem(g, { source: "rep", target: "a" })!, /não tem saída/);
  assert.match(connectionProblem(g, { source: "c", target: "a", sourceHandle: "yes" })!, /ciclo/);
  assert.equal(connectionProblem(g, { source: "c", target: "fim", sourceHandle: "yes" }), null);
  const linked = connect(g, { source: "c", target: "fim", sourceHandle: "yes" });
  assert.equal(linked.edges.at(-1)?.id, "c-yes-fim");
  assert.deepEqual(loopTargets(g, "rep").map((n) => n.id), ["a", "c"], "sem ele mesmo, Início e Resposta");
});
test("fluxos antigos com setas Repetir/Concluir viram destino escolhido", () => {
  const g: Graph = {
    nodes: [
      block("start", "inicio", 0, 0),
      block("agent", "a", 0, 0),
      block("loop", "rep", 0, 0),
      block("end", "fim", 0, 0),
    ],
    edges: [
      { id: "1", source: "inicio", target: "a" },
      { id: "2", source: "a", target: "rep" },
      { id: "3", source: "rep", target: "a", sourceHandle: "repeat" },
      { id: "4", source: "rep", target: "fim", sourceHandle: "done" },
    ],
  };
  const upgraded = upgradeGraph(g);
  assert.equal(upgraded.nodes.find((n) => n.id === "rep")?.data.config.target, "a");
  assert.deepEqual(upgraded.edges.map((e) => e.id), ["1", "2"]);
  assert.equal(upgradeGraph(upgraded), upgraded, "sem setas antigas, o grafo volta intacto");
  const already = structuredClone(g);
  already.nodes[2].data.config.target = "inicio";
  assert.equal(upgradeGraph(already).nodes[2].data.config.target, "inicio", "um destino já escolhido é preservado");
});
test("layout distribui blocos em colunas pela distância do Início", () => {
  const g: Graph = {
    nodes: [
      block("start", "inicio", 0, 0),
      block("condition", "c", 0, 0),
      block("agent", "a", 0, 0),
      block("agent", "b", 0, 0),
      block("end", "fim", 0, 0),
      block("state", "solto", 0, 0),
    ],
    edges: [
      { id: "1", source: "inicio", target: "c" },
      { id: "2", source: "c", target: "a", sourceHandle: "yes" },
      { id: "3", source: "c", target: "b", sourceHandle: "no" },
      { id: "4", source: "a", target: "fim" },
      { id: "5", source: "b", target: "fim" },
    ],
  };
  const out = layout(g);
  const pos = Object.fromEntries(out.nodes.map((n) => [n.id, n.position]));
  assert.equal(pos.inicio.x, 60);
  assert.equal(pos.c.x, 400);
  assert.equal(pos.a.x, pos.b.x);
  assert.notEqual(pos.a.y, pos.b.y);
  assert.ok(pos.fim.x > pos.a.x);
  assert.ok(pos.solto.x > pos.fim.x);
});
