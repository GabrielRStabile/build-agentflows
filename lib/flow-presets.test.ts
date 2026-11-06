import test from "node:test";
import assert from "node:assert/strict";
import { PRESETS, preset, presetSteps } from "./flow-presets";
import { PRESET_GRAPHS } from "./flow-presets-graphs";
import { BLOCKS } from "./flow-types";

test("modelos: ids únicos e todo grafo de arquivo tem metadados", () => {
  const ids = PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of Object.keys(PRESET_GRAPHS)) assert.ok(ids.includes(id), `grafo sem metadados: ${id}`);
});

test("modelos: cada passo aponta para um bloco do grafo, a partir do Início", () => {
  for (const p of PRESETS) {
    const nodes = preset(p.id).nodes.map((n) => n.id);
    for (const [id] of p.steps) assert.ok(nodes.includes(id), `${p.id}: passo ${id} não existe no grafo`);
    const steps = presetSteps(p);
    assert.equal(steps[0]?.kind, "start", `${p.id}: o primeiro passo não é o Início`);
    for (const s of steps) assert.ok(BLOCKS[s.kind], `${p.id}: tipo desconhecido ${s.kind}`);
  }
});

test("modelos: área, entrada e três sugeridos", () => {
  for (const p of PRESETS) {
    assert.ok(p.category.trim() && p.input.trim() && p.description.trim(), p.id);
  }
  assert.equal(PRESETS.filter((p) => p.suggested).length, 3);
});

test("modelos: preset devolve cópia, sem alterar o grafo guardado", () => {
  const [id] = Object.keys(PRESET_GRAPHS);
  const g = preset(id);
  g.nodes[0].data.label = "alterado";
  assert.notEqual(preset(id).nodes[0].data.label, "alterado");
});
