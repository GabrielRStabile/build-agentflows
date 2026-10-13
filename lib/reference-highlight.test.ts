import test from "node:test";
import assert from "node:assert/strict";
import { canonicalReference, referenceSegments } from "./reference-highlight";

const known = ["{{input}}", "{{last}}", "{{fluxo.cliente}}", "{{state.approval}}", "{{nodes.agente-1}}"];

test("texto sem referências volta inteiro como texto", () => {
  assert.deepEqual(referenceSegments("Olá, tudo bem?", known), [{ text: "Olá, tudo bem?", kind: "text" }]);
  assert.deepEqual(referenceSegments("", known), []);
});

test("referências conhecidas e inexistentes são separadas do texto ao redor", () => {
  assert.deepEqual(referenceSegments("Responda {{input}} usando {{nodes.sumiu}}.", known), [
    { text: "Responda ", kind: "text" },
    { text: "{{input}}", kind: "known" },
    { text: " usando ", kind: "text" },
    { text: "{{nodes.sumiu}}", kind: "unknown" },
    { text: ".", kind: "text" },
  ]);
});

test("espaços internos e o apelido state. seguem a mesma regra do motor", () => {
  assert.equal(canonicalReference(" state.cliente "), "fluxo.cliente");
  assert.equal(canonicalReference("state.approval"), "state.approval");
  const segments = referenceSegments("{{ input }}{{state.cliente}}{{state.outra}}{{state.approval}}", known);
  assert.deepEqual(segments.map((s) => s.kind), ["known", "known", "unknown", "known"]);
  assert.equal(segments[0].text, "{{ input }}");
});

test("chaves abertas sem fechamento continuam texto comum; {{ }} é referência vazia, como no motor", () => {
  assert.deepEqual(referenceSegments("Digite {{inp", known), [{ text: "Digite {{inp", kind: "text" }]);
  assert.deepEqual(referenceSegments("{{}} e {{ }}", known), [
    { text: "{{}} e ", kind: "text" },
    { text: "{{ }}", kind: "unknown" },
  ]);
});
