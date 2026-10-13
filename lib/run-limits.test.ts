import test from "node:test";
import assert from "node:assert/strict";
import { runBudgetMs, runBudgetSeconds } from "./run-limits";

test("limite de execução vem do ambiente com padrão de 180 s e faixa de 30 a 900 s", () => {
  const before = process.env.LIMITE_EXECUCAO_SEGUNDOS;
  try {
    delete process.env.LIMITE_EXECUCAO_SEGUNDOS; assert.equal(runBudgetSeconds(), 180); assert.equal(runBudgetMs(), 180000);
    process.env.LIMITE_EXECUCAO_SEGUNDOS = "120"; assert.equal(runBudgetMs(), 120000);
    process.env.LIMITE_EXECUCAO_SEGUNDOS = "5"; assert.equal(runBudgetSeconds(), 30);
    process.env.LIMITE_EXECUCAO_SEGUNDOS = "5000"; assert.equal(runBudgetSeconds(), 900);
    process.env.LIMITE_EXECUCAO_SEGUNDOS = "abc"; assert.equal(runBudgetSeconds(), 180);
  } finally { if (before === undefined) delete process.env.LIMITE_EXECUCAO_SEGUNDOS; else process.env.LIMITE_EXECUCAO_SEGUNDOS = before; }
});
