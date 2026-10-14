import nodeTest, { type TestContext } from "node:test";
import { createTenantTestContext } from "../scripts/tenant-test-context";
const testTenant = await createTenantTestContext();
function test(name: string, action: (t: TestContext) => unknown | Promise<unknown>) { return nodeTest(name, async t => { await testTenant.asTenant(() => action(t)); }); }
nodeTest.after(testTenant.close);
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "agentflows-openrouter-"));
process.env.DATA_DIR = dir;
const { setConfig } = await import("./store");
const { runOpenRouter, isOpenRouterModel } = await import("./openrouter");
nodeTest.after(() => rmSync(dir, { recursive: true, force: true }));
function fakeFetch(answers: unknown[]) {
  const calls: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      body: JSON.parse(String(init?.body)),
      headers: init?.headers as Record<string, string>,
    });
    const answer = answers.shift();
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}
test("sem chave o OpenRouter recusa e pede a conexão", async () => {
  setConfig("OPENROUTER_API_KEY", null);
  await assert.rejects(
    () => runOpenRouter({ system: "", prompt: "oi", model: "openrouter:x/y" }),
    /Conecte o OpenRouter/,
  );
  assert.equal(isOpenRouterModel("openrouter:x/y"), true);
  assert.equal(isOpenRouterModel("gpt-5"), false);
});
test("turnos anteriores entram com seus papéis antes da mensagem atual", async () => {
  setConfig("OPENROUTER_API_KEY", "sk-or-teste");
  const { fetcher, calls } = fakeFetch([{ usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, choices: [{ finish_reason: "stop", message: { content: "Pronto" } }] }]);
  await runOpenRouter({ system: "Instruções", prompt: "Agora traduza", model: "openrouter:a/b", fetcher, history: [{ role: "user", content: "Pedido" }, { role: "assistant", content: "Resposta" }] });
  assert.deepEqual((calls[0].body.messages as { role: string; content: string }[]).map((message: { role: string; content: string }) => [message.role, message.content]), [["system", "Instruções"], ["user", "Pedido"], ["assistant", "Resposta"], ["user", "Agora traduza"]]);
});
test("executa ferramentas em ciclo e devolve o texto final com a chave da conexão", async () => {
  setConfig("OPENROUTER_API_KEY", "sk-or-teste");
  const { fetcher, calls } = fakeFetch([
    {
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "soma", arguments: '{"a":2,"b":3}' } },
              { id: "c2", type: "function", function: { name: "proibida", arguments: "{}" } },
            ],
          },
        },
      ],
    },
    { usage: { prompt_tokens: 160, completion_tokens: 30, total_tokens: 190 }, choices: [{ finish_reason: "stop", message: { content: "Resultado: 5" } }] },
  ]);
  const texts: string[] = [];
  const usage: number[] = [];
  const out = await runOpenRouter({
    system: "sys",
    prompt: "some 2 e 3",
    model: "openrouter:openai/gpt-4.1-mini",
    fetcher,
    onText: (t) => texts.push(t),
    onUsage: (value) => usage.push(value.total),
    tools: [
      {
        name: "soma",
        description: "Soma",
        schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
        call: async (args) => String((args as { a: number; b: number }).a + (args as { a: number; b: number }).b),
      },
    ],
  });
  assert.equal(out, "Resultado: 5");
  assert.deepEqual(texts, ["Resultado: 5"]);
  assert.deepEqual(usage, [120, 310]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, "Bearer sk-or-teste");
  assert.equal(calls[0].body.model, "openai/gpt-4.1-mini");
  const messages = calls[1].body.messages as { role: string; content: string; tool_call_id?: string }[];
  assert.equal(messages.find((m) => m.tool_call_id === "c1")?.content, "5");
  assert.match(messages.find((m) => m.tool_call_id === "c2")?.content || "", /não autorizada/);
});
test("erro do provedor vira mensagem de negócio", async () => {
  setConfig("OPENROUTER_API_KEY", "sk-or-teste");
  const { fetcher } = fakeFetch([
    new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), { status: 402 }),
  ]);
  await assert.rejects(
    () => runOpenRouter({ system: "", prompt: "oi", model: "openrouter:a/b", fetcher }),
    (e: Error) => e.message.length > 10,
  );
});

test("consumo incompleto entre rodadas é sinalizado como parcial", async () => {
  for (const missingFirst of [true, false]) {
    const known = { prompt_tokens: 100, completion_tokens: 20 };
    const { fetcher } = fakeFetch([
      { usage: missingFirst ? undefined : known, choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "c1", function: { name: "soma", arguments: "{}" } }] } }] },
      { usage: missingFirst ? known : undefined, choices: [{ message: { content: "Fim" } }] },
    ]);
    let latest: { total: number; partial?: boolean } | undefined;
    await runOpenRouter({ system: "", prompt: "Some", model: "openrouter:test", fetcher, onUsage: (value) => { latest = value; }, tools: [{ name: "soma", description: "Soma", schema: { type: "object" }, call: async () => "2" }] });
    assert.equal(latest?.total, 120);
    assert.equal(latest?.partial, true);
  }
});

test("catálogo informa modalidades e envia imagens no conteúdo nativo do modelo escolhido", async () => {
  const fetch0 = globalThis.fetch;
  const { listModels } = await import("./openrouter");
  globalThis.fetch = async () => Response.json({ data: [
    { id: "test/vision", name: "Visão", architecture: { input_modalities: ["text", "image"] } },
    { id: "test/text", name: "Texto", architecture: { input_modalities: ["text"] } },
    { id: "test/unknown", name: "Desconhecido" },
  ] });
  try {
    const models = await listModels(true);
    assert.deepEqual(models.find((m) => m.id === "test/vision")?.inputModalities, ["text", "image"]);
    const image = "data:image/png;base64,aW1hZ2Vt";
    const { fetcher, calls } = fakeFetch([{ choices: [{ message: { content: "Imagem lida" } }] }]);
    assert.equal(await runOpenRouter({ system: "", prompt: "Analise", model: "openrouter:test/vision", images: [image], fetcher }), "Imagem lida");
    assert.equal(calls[0].body.model, "test/vision");
    assert.deepEqual((calls[0].body.messages as { content: unknown }[])[1].content, [{ type: "text", text: "Analise" }, { type: "image_url", image_url: { url: image } }]);
    for (const model of ["test/text", "test/unknown", "openrouter/auto"]) {
      await assert.rejects(() => runOpenRouter({ system: "", prompt: "Leia", model: `openrouter:${model}`, images: [image], fetcher }), /suporte a imagens/);
    }
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = fetch0; }
});
