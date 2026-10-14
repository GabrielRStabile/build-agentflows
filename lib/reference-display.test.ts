import test from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_ALIASES, displayReferences, nodeAlias, storedReferences, type ReferenceAlias } from "./reference-display";

const aliases = [nodeAlias("a1", "Analista"), nodeAlias("r2", "Revisor"), nodeAlias("a3", "Analista")].filter((a): a is ReferenceAlias => !!a);

test("o campo mostra o nome do bloco e grava o id", () => {
  assert.equal(displayReferences("Use {{nodes.a1}} e {{ nodes.r2 }} com {{input}}.", aliases), "Use {{Analista}} e {{Revisor}} com {{input}}.");
  assert.equal(storedReferences("Use {{Analista}} e {{Revisor}} com {{input}}.", aliases), "Use {{nodes.a1}} e {{nodes.r2}} com {{input}}.");
  assert.equal(displayReferences("{{nodes.sumiu}}", aliases), "{{nodes.sumiu}}", "bloco apagado continua pelo id, para o destaque avisar");
  assert.equal(storedReferences("{{Desconhecido}} {{nodes.x}} {{fluxo.cliente}}", aliases), "{{Desconhecido}} {{nodes.x}} {{fluxo.cliente}}");
});

test("nomes repetidos preservam o id de cada ocorrência enquanto o texto é editado", () => {
  const stored = "{{nodes.a3}} depois {{nodes.a1}} e {{nodes.a3}}";
  const shown = displayReferences(stored, aliases);
  assert.equal(shown, "{{Analista}} depois {{Analista}} e {{Analista}}");
  assert.equal(storedReferences(shown, aliases, stored), stored);
  assert.equal(storedReferences(shown + " {{Analista}}", aliases, stored), stored + " {{nodes.a1}}", "ocorrência nova usa o primeiro bloco com o nome");
  assert.equal(storedReferences("{{Analista}}", aliases), "{{nodes.a1}}");
});

test("referências nativas aparecem em português e voltam às chaves do motor", () => {
  const all = [...BUILT_IN_ALIASES, ...aliases];
  assert.equal(displayReferences("{{input}} → {{ last }} ({{state.approval}}) {{fluxo.cliente}} {{nodes.r2}}", all), "{{Conversa}} → {{Etapa anterior}} ({{Decisão da aprovação}}) {{fluxo.cliente}} {{Revisor}}");
  assert.equal(storedReferences("{{Conversa}} → {{Etapa anterior}} ({{Decisão da aprovação}}) {{fluxo.cliente}} {{Revisor}}", all), "{{input}} → {{last}} ({{state.approval}}) {{fluxo.cliente}} {{nodes.r2}}");
  assert.equal(storedReferences("{{last}} digitado à mão", all), "{{last}} digitado à mão", "a chave do motor continua aceita");
  assert.equal(displayReferences("Hoje é {{currentDateTime}}.", all), "Hoje é {{Data e hora atual}}.");
  assert.equal(storedReferences("Hoje é {{Data e hora atual}}.", all), "Hoje é {{currentDateTime}}.");
  assert.equal(nodeAlias("x", "Etapa anterior"), null, "bloco com o nome de uma referência nativa segue pelo id");
  assert.equal(nodeAlias("x", "conversa"), null);
});

test("nomes que confundiriam com referências nativas não ganham apelido", () => {
  assert.equal(nodeAlias("x", "input"), null);
  assert.equal(nodeAlias("x", "fluxo.cliente"), null);
  assert.equal(nodeAlias("x", "Chave {x}"), null);
  assert.equal(nodeAlias("x", "  "), null);
  assert.deepEqual(nodeAlias("x", " Agente de vendas "), { value: "{{nodes.x}}", display: "{{Agente de vendas}}" });
});
