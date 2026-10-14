import test from "node:test";
import assert from "node:assert/strict";
import { providerFailure, providerDetail } from "./ai-provider-error";
import { runChatCompletion } from "./chat-completion";

test("falha do fornecedor inclui a explicação devolvida no corpo", async () => {
  const body = JSON.stringify({ error: { message: "Function calling requires reasoning_effort 'none' on chat completions.", type: "invalid_request_error" } });
  const error = providerFailure(400, body);
  assert.equal(error.status, 400);
  assert.match(error.message, /recusou os parâmetros/);
  assert.match(error.message, /Resposta do fornecedor: Function calling requires reasoning_effort 'none'/);
  assert.equal(providerFailure(400).message, "O fornecedor recusou os parâmetros ou a mensagem. Revise as configurações do modelo.");
  assert.equal(providerDetail("<html><body>Bad gateway</body></html>"), "", "páginas HTML não entram na mensagem");
  assert.equal(providerDetail("x".repeat(400)).length, 301, "detalhes longos são cortados");
  assert.equal(providerDetail('{"message":"texto"}'), "texto");
  assert.equal(providerFailure(503, "upstream down").status, 502);
  await assert.rejects(runChatCompletion({ key: "k", url: "https://api.openai.com/v1/chat/completions", system: "s", prompt: "p", model: "gpt-6-luna",
    fetcher: async () => new Response(body, { status: 400 }) }), /Resposta do fornecedor: Function calling/);
});

test("limite de uso: repete quando o fornecedor diz quanto esperar e desiste quando a espera é longa", async () => {
  const { retryAfterMs, fetchWithRateLimitRetry, RATE_LIMIT_ATTEMPTS } = await import("./ai-provider-error");
  const groq = JSON.stringify({ error: { message: "Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on input tokens per minute (ITPM): Limit 7000, Used 6641, Requested 1706. Please try again in 11.545714285s. Need more tokens? Upgrade to Dev Tier today", type: "tokens" } });
  assert.equal(Math.round(retryAfterMs(new Headers(), groq)!), 11546);
  assert.equal(retryAfterMs(new Headers(), '{"error":{"message":"try again in 1m2.5s"}}'), 62500);
  assert.equal(retryAfterMs(new Headers(), '{"error":{"message":"try again in 250ms"}}'), 250);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "3" }), ""), 3000);
  assert.ok(retryAfterMs(new Headers({ "retry-after": new Date(Date.now() + 5000).toUTCString() }), "")! <= 5000);
  assert.equal(retryAfterMs(new Headers(), '{"error":{"message":"quota exceeded"}}'), undefined);
  let calls = 0; const waits: number[] = [];
  const limited = (message: string) => new Response(JSON.stringify({ error: { message } }), { status: 429 });
  const { response } = await fetchWithRateLimitRetry(async () => ++calls === 1 ? limited("try again in 20ms") : Response.json({ ok: true }), undefined, ms => waits.push(ms));
  assert.ok(response.ok); assert.equal(calls, 2); assert.deepEqual(waits, [20]);
  calls = 0;
  const long = await fetchWithRateLimitRetry(async () => { calls++; return limited("try again in 2m"); });
  assert.equal(long.response.status, 429); assert.equal(calls, 1, "espera acima do limite não repete"); assert.match(long.detail, /2m/);
  calls = 0;
  const exhausted = await fetchWithRateLimitRetry(async () => { calls++; return limited("try again in 1ms"); });
  assert.equal(exhausted.response.status, 429); assert.equal(calls, RATE_LIMIT_ATTEMPTS);
  calls = 0;
  const other = await fetchWithRateLimitRetry(async () => { calls++; return new Response("bad", { status: 400, headers: { "retry-after": "1" } }); });
  assert.equal(other.response.status, 400); assert.equal(calls, 1, "só 429 repete");
  const controller = new AbortController(); setTimeout(() => controller.abort(), 5);
  await assert.rejects(fetchWithRateLimitRetry(async () => limited("try again in 10s"), controller.signal), /cancelada/);
  await assert.rejects(runChatCompletion({ key: "k", url: "https://api.groq.com/openai/v1/chat/completions", system: "s", prompt: "p", model: "m",
    fetcher: async () => limited("try again in 5m") }), /limite de uso.*Resposta do fornecedor: Rate limit|limite de uso.*try again in 5m/);
});
