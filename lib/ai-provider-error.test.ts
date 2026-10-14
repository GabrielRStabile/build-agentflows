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
