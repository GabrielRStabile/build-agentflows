import test from "node:test";
import assert from "node:assert/strict";
import { queueExplanation, queueLabel } from "./queue-status";

test("rótulo e explicação da fila cobrem sem worker, próximo e posição", () => {
  assert.equal(queueLabel(), "Na fila");
  assert.equal(queueLabel({ position: 3, ahead: 2, running: 6, slots: 6, workers: 0 }), "Na fila · aguardando o processador");
  assert.equal(queueLabel({ position: 1, ahead: 0, running: 6, slots: 6, workers: 1 }), "Na fila · começa em instantes");
  assert.equal(queueLabel({ position: 2, ahead: 1, running: 6, slots: 6, workers: 1 }), "Na fila · 1 execução à frente");
  assert.equal(queueLabel({ position: 12, ahead: 11, running: 6, slots: 6, workers: 2 }), "Na fila · 11 execuções à frente");
  assert.match(queueExplanation(), /não é preciso enviar de novo/i);
  assert.match(queueExplanation({ position: 3, ahead: 2, running: 0, slots: 6, workers: 0 }), /Nenhum processador/);
  assert.match(queueExplanation({ position: 1, ahead: 0, running: 6, slots: 6, workers: 1 }), /^Você é o próximo: 6 de 6 vagas em uso/);
  assert.match(queueExplanation({ position: 12, ahead: 11, running: 1, slots: 1, workers: 1 }), /^Posição 12 na fila, 1 de 1 vaga em uso/);
});
