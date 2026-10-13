import test from "node:test";
import assert from "node:assert/strict";
import { addTokenUsage, formatCost, runCost, tokenUsage } from "./token-usage";

test("consumo ausente ou inválido não é exibido como zero", () => {
  for (const value of [undefined, {}, { inputTokens: -1, outputTokens: 2 }, { inputTokens: 10 }, { inputTokens: NaN, outputTokens: 2 }]) {
    assert.equal(tokenUsage(value, "chatgpt"), undefined);
  }
  assert.equal(tokenUsage({ inputTokens: 0, outputTokens: 0 }, "chatgpt")?.total, 0);
});

test("cache e raciocínio são detalhados sem somá-los novamente ao total", () => {
  assert.deepEqual(tokenUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 10 } }, "openrouter"), {
    input: 100, output: 20, total: 120, cachedInput: 80, reasoning: 10,
  });
});

test("custo aparece só quando o provedor informa e soma as chamadas", () => {
  const first = tokenUsage({ prompt_tokens: 10, completion_tokens: 5, cost: 0.0012 }, "openrouter")!;
  assert.equal(first.cost, 0.0012);
  assert.equal("cost" in tokenUsage({ prompt_tokens: 10, completion_tokens: 5 }, "openrouter")!, false);
  assert.equal("cost" in tokenUsage({ inputTokens: 10, outputTokens: 5, cost: 1 }, "chatgpt")!, false, "assinatura ChatGPT não tem custo por chamada");
  assert.equal(addTokenUsage(first, { input: 1, output: 1, total: 2, cost: 0.0008 }).cost, 0.002);
  assert.equal("cost" in addTokenUsage({ input: 1, output: 1, total: 2 }, { input: 1, output: 1, total: 2 }), false);
  assert.equal(runCost([{ usage: { input: 1, output: 1, total: 2 } }, {}]), undefined, "nada estimado");
  assert.equal(runCost([{ usage: first }, { cost: 0.05 }, {}]), 0.0512);
  assert.equal(formatCost(0.0512), "US$ 0,0512");
  assert.equal(formatCost(0.000123), "US$ 0,000123");
});
