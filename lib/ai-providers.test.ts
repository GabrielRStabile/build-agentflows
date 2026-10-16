import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTenantTestContext, commitTestConfig } from "../scripts/tenant-test-context";
import { saveToolCredential, listToolCredentials, deleteToolCredential } from "./tool-credential-store";
import { modelCredentialKey, importModelCredentials, saveOpenRouterOAuth } from "./ai-credentials";
import { AI_PROVIDERS, builtinToolsFor, imageDetail, modelSettings } from "./ai-providers";
import { runProviderModel } from "./ai-runtime";
import { providerModels } from "./ai-models";
import { publicModelCache } from "./public-model-cache";
import { getConfig, setConfig } from "./store";
import { template } from "./flow-types";
import { createFlow, saveFlow } from "./flow-service";
import { startRun } from "./flow-runtime";
import { withTenantSession } from "./tenant-context";
import { hashToken, randomToken } from "./saas-security";

test("cache público compartilha uma chamada, expira e mantém catálogo durante falha temporária", async () => {
  let now = 1, calls = 0, fail = false;
  const cached = publicModelCache(async () => { calls++; if (fail) throw new Error("offline"); return Array.from({ length: 650 }, (_, id) => ({ id })); }, () => now);
  const results = await Promise.all(Array.from({ length: 20 }, () => cached()));
  assert.equal(calls, 1); assert.equal(results[0].length, 650);
  assert.strictEqual(results[0], await cached());
  now += 3600_001; await cached(); assert.equal(calls, 2);
  now += 3600_001; fail = true; assert.equal((await cached()).length, 650);
  now += 24 * 3600_000; await assert.rejects(cached(), /offline/);
});

test("fornecedores usam credenciais cifradas por usuário, preservam migração e impedem exclusão em uso", async t => {
  const tenant = await createTenantTestContext(); t.after(tenant.close);
  let credentialId = "";
  await tenant.asTenant(async () => {
    for (const p of AI_PROVIDERS) {
      const c = saveToolCredential({ name: p.name, provider: `ai_${p.id}`, fields: { [p.key]: `private-${p.id}` } });
      assert.equal(modelCredentialKey(p.id, c.id), `private-${p.id}`);
      assert.ok(!JSON.stringify(c).includes(`private-${p.id}`));
      if (p.id === "openai") credentialId = c.id;
    }
    assert.throws(() => modelCredentialKey("google", credentialId), /não pertence/);
    setConfig("AI_DEFAULT_OPENROUTER_CREDENTIAL", null);
    setConfig("OPENROUTER_API_KEY", "legacy-router"); importModelCredentials(); importModelCredentials();
    assert.equal(listToolCredentials("ai_openrouter").length, 2);
    const migrated = listToolCredentials("ai_openrouter").find(c => c.name.includes("existente"))!;
    saveToolCredential({ name: migrated.name, fields: { OPENROUTER_API_KEY: "rotated" } }, migrated.id);
    assert.equal(getConfig("OPENROUTER_API_KEY"), "rotated");
    const oauth = saveOpenRouterOAuth("oauth-private");
    assert.equal(modelCredentialKey("openrouter", oauth.id), "oauth-private");
    assert.equal(getConfig("OPENROUTER_API_KEY"), "rotated", "nova autorização não substitui a conexão em uso");
    await commitTestConfig();
    const rows = await tenant.db.query("SELECT ciphertext FROM credentials WHERE user_id=$1", [tenant.owner]);
    assert.ok(!JSON.stringify(rows).includes("private-openai"));
    const flow = await createFlow("Credencial de modelo"); const graph = template();
    graph.nodes[1].data.config = { model: "openai:gpt-4.1-mini", modelCredentialId: credentialId };
    await saveFlow(flow.id, { ...flow, graph });
    await assert.rejects(async () => { deleteToolCredential(credentialId); await commitTestConfig(); }, /em uso/);
    assert.equal(modelCredentialKey("openai", credentialId), "private-openai");
  });
  const other = randomUUID(), token = randomToken();
  await tenant.db.query("INSERT INTO users(id,name,email,email_verified_at,beta_status) VALUES($1,'Other',$2,now(),'approved')", [other, `${other}@example.com`]);
  await tenant.db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hashToken(token), other]);
  await withTenantSession(tenant.db, token, () => { assert.throws(() => modelCredentialKey("openai", credentialId), /não existe/); assert.equal(listToolCredentials().length, 0); });
});

test("OpenAI, Google e Groq enviam chave selecionada e parâmetros, e executam ferramentas", async t => {
  const tenant = await createTenantTestContext(); t.after(tenant.close);
  await tenant.asTenant(async () => {
    for (const id of ["openai", "google", "groq"] as const) {
      const p = AI_PROVIDERS.find(p => p.id === id)!;
      const c = saveToolCredential({ name: id, provider: `ai_${id}`, fields: { [p.key]: `secret-${id}` } });
      let calls = 0;
      const result = await runProviderModel({ model: `${id}:fixture`, modelCredentialId: c.id, modelTemperature: "0.5", modelMaxTokens: "2048" }, {
        system: "Ajude", prompt: "Some", tools: [{ name: "soma", description: "Soma", schema: { type: "object" }, call: async () => "5" }],
        fetcher: async (url, init) => {
          assert.equal(String(url), `${p.url}/chat/completions`);
          assert.equal(new Headers(init?.headers).get("authorization"), `Bearer secret-${id}`);
          const body = JSON.parse(String(init?.body)); assert.equal(body.temperature, 0.5);
          assert.equal(body[id === "openai" ? "max_completion_tokens" : "max_tokens"], 2048);
          if (++calls === 1) return Response.json({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "call", function: { name: "soma", arguments: "{}" } }] } }] });
          assert.equal(body.messages.at(-1).content, "5");
          return Response.json({ choices: [{ message: { content: "Resultado 5" } }] });
        },
      });
      assert.equal(result, "Resultado 5"); assert.equal(calls, 2);
    }
    assert.throws(() => modelSettings({ modelTemperature: "NaN" }));
    assert.throws(() => modelSettings({ modelMaxTokens: "2.5" }));
  });
});

test("Claude usa Messages, conserva blocos de ferramentas e registra tokens", async t => {
  const tenant = await createTenantTestContext(); t.after(tenant.close);
  await tenant.asTenant(async () => {
    const c = saveToolCredential({ name: "Claude", provider: "ai_anthropic", fields: { ANTHROPIC_API_KEY: "private-claude" } });
    let calls = 0, tokens = 0;
    const result = await runProviderModel({ model: "anthropic:claude-sonnet-4-6", modelCredentialId: c.id, modelMaxTokens: "1000" }, {
      system: "Ajude", prompt: "Calcule", images: ["data:image/png;base64,aW1hZ2Vt"],
      tools: [{ name: "soma", description: "Soma", schema: { type: "object" }, call: async () => "8" }], onUsage: u => { tokens = u.total; },
      fetcher: async (url, init) => {
        assert.equal(String(url), "https://api.anthropic.com/v1/messages");
        assert.equal(new Headers(init?.headers).get("x-api-key"), "private-claude");
        const body = JSON.parse(String(init?.body)); assert.equal(body.max_tokens, 1000);
        assert.equal(body.messages[0].content[1].source.media_type, "image/png");
        if (++calls === 1) return Response.json({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "call", name: "soma", input: {} }], usage: { input_tokens: 5, output_tokens: 2 } });
        assert.equal(body.messages.at(-1).content[0].content, "8");
        return Response.json({ content: [{ type: "text", text: "Oito" }], usage: { input_tokens: 10, output_tokens: 3 } });
      },
    });
    assert.equal(result, "Oito"); assert.equal(tokens, 20);
  });
});

test("motor executa modelo direto sem assinatura ChatGPT e catálogo não expõe chaves", async t => {
  const tenant = await createTenantTestContext(); t.after(tenant.close);
  await tenant.asTenant(async () => {
    const c = saveToolCredential({ name: "OpenAI", provider: "ai_openai", fields: { OPENAI_API_KEY: "private-runtime" } }); await commitTestConfig();
    const models = await providerModels("openai", c.id, async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-runtime");
      return Response.json({ data: [{ id: "gpt-4.1-mini" }, { id: "text-embedding-3-small" }, { id: "gpt-4o-audio-preview" }, { id: "gpt-5" }] });
    });
    assert.equal(models.length, 2); assert.ok(!JSON.stringify(models).includes("private-runtime"));
    assert.ok(!models.find(m => m.id === "openai:gpt-5")!.parameters.includes("temperature"));
    const f = await createFlow("Direto"); const graph = template(); graph.nodes[1].data.config = { model: "openai:gpt-4.1-mini", modelCredentialId: c.id, system: "Ajude" };
    await saveFlow(f.id, { ...f, graph });
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-runtime");
      return Response.json({ choices: [{ message: { content: "Execução direta" } }] });
    });
    const run = await startRun(f.id, "Oi", false, false); assert.equal(run.status, "completed"); assert.match(run.output, /Execução direta/);
  });
});

test("OAuth OpenRouter vincula PKCE à conta e grava uma credencial reutilizável", async t => {
  const tenant = await createTenantTestContext(); t.after(tenant.close);
  const { GET: begin } = await import("../app/api/conexoes/openrouter/route");
  const { GET: callback } = await import("../app/api/conexoes/openrouter/callback/route");
  const start = await tenant.connect(() => begin(tenant.request("/api/conexoes/openrouter?popup=1")));
  assert.equal(start.status, 302);
  const authorization = new URL(start.headers.get("location")!);
  assert.equal(authorization.origin, "https://openrouter.ai");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  const destination = new URL(authorization.searchParams.get("callback_url")!);
  destination.searchParams.set("code", "one-time-code");
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  let exchanges = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    exchanges++; assert.equal(String(url), "https://openrouter.ai/api/v1/auth/keys");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.code, "one-time-code"); assert.equal(body.code_verifier, cookie.split("=")[1]);
    return Response.json({ key: "private-oauth-key" });
  });
  const request = () => {
    const req = tenant.request(destination.pathname + destination.search);
    req.headers.set("cookie", req.headers.get("cookie") + "; " + cookie); return req;
  };
  const completed = await tenant.connect(() => callback(request()));
  assert.equal(completed.status, 302);
  const returned = new URL(completed.headers.get("location")!, "https://app.example.com");
  assert.equal(returned.pathname, "/credenciais/openrouter");
  const id = returned.searchParams.get("credentialId")!; assert.ok(id);
  await tenant.asTenant(() => {
    assert.equal(modelCredentialKey("openrouter", id), "private-oauth-key");
    assert.ok(!JSON.stringify(listToolCredentials()).includes("private-oauth-key"));
  });
  await tenant.connect(() => callback(request())); assert.equal(exchanges, 1, "código OAuth não pode ser reutilizado");
});

test("OpenAI: esforço de raciocínio é enviado e o gpt-6-luna usa ferramentas só com none", async t => {
  const tenant = await createTenantTestContext(); t.after(tenant.close);
  await tenant.asTenant(async () => {
    const c = saveToolCredential({ name: "OpenAI", provider: "ai_openai", fields: { OPENAI_API_KEY: "secret-reasoning" } });
    const sent: Record<string, unknown>[] = [];
    const fetcher: typeof fetch = async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return Response.json({ choices: [{ message: { content: "ok" } }] }); };
    const tools = [{ name: "soma", description: "Soma", schema: { type: "object" }, call: async () => "5" }];
    await runProviderModel({ model: "openai:gpt-6-luna", modelCredentialId: c.id }, { system: "s", prompt: "p", tools, fetcher });
    assert.equal(sent[0].reasoning_effort, "none", "com ferramentas o motor aplica none sozinho");
    await runProviderModel({ model: "openai:gpt-6-luna", modelCredentialId: c.id }, { system: "s", prompt: "p", fetcher });
    assert.equal(sent[1].reasoning_effort, undefined, "sem ferramentas o padrão do modelo é mantido");
    await runProviderModel({ model: "openai:gpt-5.5", modelCredentialId: c.id, modelReasoningEffort: "xhigh" }, { system: "s", prompt: "p", tools, fetcher });
    assert.equal(sent[2].reasoning_effort, "xhigh");
    await runProviderModel({ model: "openai:gpt-4.1-mini", modelCredentialId: c.id, modelReasoningEffort: "high" }, { system: "s", prompt: "p", fetcher });
    assert.equal(sent[3].reasoning_effort, undefined, "modelos sem raciocínio ignoram o nível");
    await assert.rejects(runProviderModel({ model: "openai:gpt-6-luna", modelCredentialId: c.id, modelReasoningEffort: "high" }, { system: "s", prompt: "p", tools, fetcher }), /só usa ferramentas com esforço de raciocínio "none"/);
    assert.throws(() => modelSettings({ modelReasoningEffort: "turbo" }), /esforço de raciocínio/);
    // Qualidade das imagens: em branco é alta; original só no ChatGPT por assinatura.
    assert.equal(imageDetail({}), "high");
    assert.equal(imageDetail({ model: "", imageDetail: "original" }), "original");
    assert.throws(() => modelSettings({ model: "openai:gpt-5.5", imageDetail: "original" }), /original.*ChatGPT/);
    assert.throws(() => modelSettings({ imageDetail: "máxima" }), /qualidade das imagens/);
    const image = "data:image/png;base64,aW1hZ2Vt";
    for (const detail of ["high", "low"] as const) {
      await runProviderModel({ model: "openai:gpt-5.5", modelCredentialId: c.id }, { system: "s", prompt: "p", images: [image], imageDetail: detail, fetcher });
      assert.deepEqual((sent.at(-1)!.messages as { content: unknown }[])[1].content, [{ type: "text", text: "p" }, { type: "image_url", image_url: { url: image, detail } }]);
    }
    // Em branco: o padrão do modelo; se o fornecedor exigir none para ferramentas, repete uma vez com none e lembra o modelo.
    const tries: unknown[] = [];
    const strict: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); tries.push(body.reasoning_effort);
      return body.reasoning_effort === "none" ? Response.json({ choices: [{ message: { content: "ok" } }] })
        : Response.json({ error: { message: "Function calling is not supported with reasoning_effort 'medium'; use reasoning_effort 'none'." } }, { status: 400 });
    };
    assert.equal((await runProviderModel({ model: "openai:gpt-7-mini", modelCredentialId: c.id }, { system: "s", prompt: "p", tools, fetcher: strict })), "ok");
    assert.deepEqual(tries, [undefined, "none"]);
    await runProviderModel({ model: "openai:gpt-7-mini", modelCredentialId: c.id }, { system: "s", prompt: "p", tools, fetcher: strict });
    assert.deepEqual(tries, [undefined, "none", "none"], "a próxima chamada já começa com none");
    await assert.rejects(runProviderModel({ model: "openai:gpt-7-nano", modelCredentialId: c.id, modelReasoningEffort: "low" }, { system: "s", prompt: "p", tools, fetcher: strict }), /Function calling/, "nível escolhido não é trocado");
    await assert.rejects(runProviderModel({ model: "openai:gpt-7-nano", modelCredentialId: c.id }, { system: "s", prompt: "p", fetcher: strict }), /Function calling/, "sem ferramentas não repete");
    const models = await providerModels("openai", c.id, async () => Response.json({ data: [{ id: "gpt-4.1-mini" }, { id: "gpt-6-luna" }, { id: "o3" }] }));
    assert.deepEqual(models.map(m => [m.id, m.parameters.includes("reasoning_effort")]), [["openai:gpt-4.1-mini", false], ["openai:gpt-6-luna", true], ["openai:o3", true]]);
  });
});

test("OpenAI: ferramentas nativas usam a Responses API e registram buscas, código e imagens", async t => {
  const tenant = await createTenantTestContext(); t.after(tenant.close);
  await tenant.asTenant(async () => {
    const c = saveToolCredential({ name: "OpenAI", provider: "ai_openai", fields: { OPENAI_API_KEY: "secret-builtin" } });
    assert.throws(() => modelSettings({ model: "anthropic:claude-x", builtinTools: "web_search" }), /só funcionam com modelos da OpenAI ou do Google/);
    assert.throws(() => modelSettings({ model: "openai:gpt-5.5", builtinTools: "file_search" }), /opções da lista de OpenAI/);
    assert.deepEqual(modelSettings({ model: "openai:gpt-5.5", builtinTools: "web_search, image_generation" }).builtins, ["web_search", "image_generation"]);
    const png = Buffer.from("png-bytes");
    const urls: string[] = [], bodies: Record<string, unknown>[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      urls.push(String(url));
      if (String(url).endsWith("/content")) return new Response(new Uint8Array(Buffer.from("grafico")));
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (bodies.length === 1) return Response.json({ id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, output: [
        { type: "web_search_call", status: "completed", action: { type: "search", query: "clima hoje", sources: [{ url: "https://exemplo.com" }] } },
        { type: "function_call", call_id: "call_1", name: "soma", arguments: "{\"a\":2}" },
      ] });
      return Response.json({ id: "resp_2", status: "completed", usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28, output_tokens_details: { reasoning_tokens: 3 } }, output: [
        { type: "image_generation_call", status: "completed", revised_prompt: "um gato", result: png.toString("base64") },
        { type: "code_interpreter_call", status: "completed", code: "print(1)", container_id: "cntr_1", outputs: [{ type: "logs", logs: "1" }] },
        { type: "message", content: [{ type: "output_text", text: "Pronto [gráfico](sandbox:/mnt/data/g.png)", annotations: [{ type: "container_file_citation", container_id: "cntr_1", file_id: "cfile_1", filename: "g.png" }] }] },
      ] });
    };
    const calls: { tool: string; input: string; output: string; images: Buffer[] }[] = [];
    let usage: unknown;
    const tools = [{ name: "soma", description: "Soma", schema: { type: "object" }, call: async () => "5" }];
    const text = await runProviderModel({ model: "openai:gpt-5.5", modelCredentialId: c.id, builtinTools: "web_search,code_interpreter,image_generation", modelReasoningEffort: "low" },
      { system: "s", prompt: "p", tools, fetcher, history: [{ role: "assistant", content: "oi" }], onUsage: u => { usage = u; }, onBuiltin: async call => { calls.push(call); } });
    assert.equal(text, "Pronto gráfico");
    assert.equal(urls[0], "https://api.openai.com/v1/responses");
    assert.deepEqual(bodies[0].tools, [{ type: "function", name: "soma", description: "Soma", parameters: { type: "object" }, strict: false }, { type: "web_search" }, { type: "code_interpreter", container: { type: "auto" } }, { type: "image_generation" }]);
    assert.deepEqual(bodies[0].reasoning, { effort: "low" });
    assert.equal(bodies[0].instructions, "s");
    assert.equal(bodies[0].max_output_tokens, 4000);
    assert.deepEqual((bodies[0].input as unknown[])[0], { role: "assistant", content: "oi" });
    assert.deepEqual(bodies[1].input, [{ type: "function_call_output", call_id: "call_1", output: "5" }]);
    assert.equal(bodies[1].previous_response_id, "resp_1");
    assert.equal(bodies[1].instructions, "s", "as instruções seguem em cada volta");
    assert.equal(urls[2], "https://api.openai.com/v1/containers/cntr_1/files/cfile_1/content");
    assert.deepEqual(calls.map(call => [call.tool, call.input, call.images.length]), [["web_search", "clima hoje", 0], ["image_generation", "um gato", 1], ["code_interpreter", "print(1)", 0], ["code_interpreter", "Arquivos gerados pelo código", 1]]);
    assert.equal(calls[0].output, "https://exemplo.com");
    assert.deepEqual(usage, { input: 30, output: 13, total: 43, cachedInput: undefined, reasoning: 3, partial: undefined });
    // Sem onBuiltin (resumo da memória) ou sem ferramentas marcadas, o bloco continua em Chat Completions.
    const plain: string[] = [];
    const chat: typeof fetch = async url => { plain.push(String(url)); return Response.json({ choices: [{ message: { content: "ok" } }] }); };
    await runProviderModel({ model: "openai:gpt-5.5", modelCredentialId: c.id, builtinTools: "web_search" }, { system: "s", prompt: "p", fetcher: chat });
    await runProviderModel({ model: "openai:gpt-5.5", modelCredentialId: c.id }, { system: "s", prompt: "p", fetcher: chat, onBuiltin: async () => {} });
    assert.deepEqual(plain, ["https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/chat/completions"]);
  });
});

test("motor registra ferramentas nativas da OpenAI como etapas e mostra a imagem gerada", async t => {
  const tenant = await createTenantTestContext(); t.after(tenant.close);
  await tenant.asTenant(async () => {
    const c = saveToolCredential({ name: "OpenAI", provider: "ai_openai", fields: { OPENAI_API_KEY: "private-builtin" } }); await commitTestConfig();
    const { default: sharp } = await import("sharp");
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#f00" } }).png().toBuffer();
    const f = await createFlow("Nativas"); const graph = template();
    graph.nodes[1].data.config = { model: "openai:gpt-5.5", modelCredentialId: c.id, system: "Ajude", builtinTools: "image_generation" };
    await saveFlow(f.id, { ...f, graph });
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
      assert.equal(String(url), "https://api.openai.com/v1/responses");
      return Response.json({ id: "resp_1", status: "completed", output: [
        { type: "image_generation_call", status: "completed", revised_prompt: "um quadrado vermelho", result: png.toString("base64") },
        { type: "message", content: [{ type: "output_text", text: "Aqui está." }] },
      ] });
    });
    const run = await startRun(f.id, "Desenhe", false, false);
    assert.equal(run.status, "completed");
    assert.match(run.output, /^Aqui está\.\n\n!\[Imagem gerada 1\]\(\/api\/attachments\/[^)]+\)/);
    const step = run.trace.find(trace => trace.label === "OpenAI: Geração de imagens")!;
    assert.equal(step.type, "tool"); assert.equal(step.input, "um quadrado vermelho"); assert.equal(step.images?.length, 1);
  });
});

test("Google: ferramentas nativas usam generateContent, devolvem o turno do modelo e registram busca, URLs e código", async t => {
  const tenant = await createTenantTestContext(); t.after(tenant.close);
  await tenant.asTenant(async () => {
    const c = saveToolCredential({ name: "Google", provider: "ai_google", fields: { GEMINI_API_KEY: "secret-gemini" } });
    assert.throws(() => modelSettings({ model: "google:gemini-3-pro", builtinTools: "web_search" }), /opções da lista de Google/);
    const urls: string[] = [], bodies: Record<string, unknown>[] = [], keys: (string | null)[] = [];
    const modelTurn = [{ functionCall: { id: "f1", name: "soma", args: { a: 2 } }, thoughtSignature: "sig" }];
    const fetcher: typeof fetch = async (url, init) => {
      urls.push(String(url)); keys.push(new Headers(init?.headers).get("x-goog-api-key"));
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) return Response.json({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 16 }, candidates: [{ content: { role: "model", parts: modelTurn }, finishReason: "STOP" }] });
      return Response.json({ usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 6, totalTokenCount: 26 }, candidates: [{ finishReason: "STOP",
        groundingMetadata: { webSearchQueries: ["clima hoje"], groundingChunks: [{ web: { uri: "https://exemplo.com", title: "Exemplo" } }] },
        urlContextMetadata: { urlMetadata: [{ retrievedUrl: "https://site.com", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" }] },
        content: { role: "model", parts: [
          { text: "pensando", thought: true },
          { executableCode: { language: "PYTHON", code: "print(1)" } }, { codeExecutionResult: { outcome: "OUTCOME_OK", output: "1\n" } },
          { inlineData: { mimeType: "image/png", data: Buffer.from("png").toString("base64") } },
          { text: "Resposta final" },
        ] } }] });
    };
    const calls: { tool: string; input: string; output: string; images: Buffer[] }[] = [];
    let usage: unknown;
    const tools = [{ name: "soma", description: "Soma", schema: { type: "object" }, call: async () => "5" }];
    const image = "data:image/png;base64,aW1hZ2Vt";
    const text = await runProviderModel({ model: "google:gemini-3-pro", modelCredentialId: c.id, builtinTools: "google_search,url_context,code_execution", modelMaxTokens: "900" },
      { system: "s", prompt: "p", tools, images: [image], imageDetail: "high", fetcher, history: [{ role: "assistant", content: "oi" }], onUsage: u => { usage = u; }, onBuiltin: async call => { calls.push(call); } });
    assert.equal(text, "Resposta final");
    assert.equal(urls[0], "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent");
    assert.equal(keys[0], "secret-gemini");
    assert.deepEqual(bodies[0].tools, [{ functionDeclarations: [{ name: "soma", description: "Soma", parametersJsonSchema: { type: "object" } }] }, { google_search: {} }, { url_context: {} }, { code_execution: {} }]);
    assert.deepEqual(bodies[0].systemInstruction, { parts: [{ text: "s" }] });
    assert.deepEqual(bodies[0].generationConfig, { maxOutputTokens: 900, mediaResolution: "MEDIA_RESOLUTION_HIGH" });
    assert.deepEqual((bodies[0].contents as unknown[])[0], { role: "user", parts: [{ text: "Sua resposta anterior:\noi\n\np" }, { inlineData: { mimeType: "image/png", data: "aW1hZ2Vt" } }] });
    const second = bodies[1].contents as { role: string; parts: unknown[] }[];
    assert.deepEqual(second[1], { role: "model", parts: modelTurn }, "turno do modelo volta inteiro, com assinatura");
    assert.deepEqual(second[2], { role: "user", parts: [{ functionResponse: { id: "f1", name: "soma", response: { result: "5" } } }] });
    assert.deepEqual(calls.map(call => [call.tool, call.input, call.images.length]), [["code_execution", "print(1)", 0], ["code_execution", "Imagem gerada pelo código", 1], ["google_search", "clima hoje", 0], ["url_context", "https://site.com", 0]]);
    assert.equal(calls[2].output, "Exemplo · https://exemplo.com");
    assert.deepEqual(usage, { input: 30, output: 12, total: 42, cachedInput: undefined, reasoning: 2, partial: undefined });
    // Sem ferramentas nativas o Google continua no endpoint compatível com OpenAI.
    const plain: string[] = [];
    await runProviderModel({ model: "google:gemini-3-pro", modelCredentialId: c.id }, { system: "s", prompt: "p", onBuiltin: async () => {}, fetcher: async url => { plain.push(String(url)); return Response.json({ choices: [{ message: { content: "ok" } }] }); } });
    assert.deepEqual(plain, ["https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"]);
  });
});

test("Google: modelos de imagem entram no catálogo e respondem pela API nativa com as imagens entregues", async t => {
  const tenant = await createTenantTestContext(); t.after(tenant.close);
  await tenant.asTenant(async () => {
    const c = saveToolCredential({ name: "Google", provider: "ai_google", fields: { GEMINI_API_KEY: "secret-gemini" } });
    const models = await providerModels("google", c.id, async () => Response.json({ data: [{ id: "models/gemini-3-pro" }, { id: "models/gemini-2.5-flash-image" }, { id: "models/gemini-embedding-001" }] }));
    assert.deepEqual(models.map(m => [m.id, m.outputModalities]), [["google:gemini-2.5-flash-image", ["text", "image"]], ["google:gemini-3-pro", undefined]]);
    assert.deepEqual(builtinToolsFor("google:gemini-3-pro-image-preview").map(tool => tool.id), ["google_search"]);
    assert.throws(() => modelSettings({ model: "google:gemini-2.5-flash-image", builtinTools: "code_execution" }), /apenas a Busca Google/);
    const bodies: Record<string, unknown>[] = [], urls: string[] = [];
    const jpeg = Buffer.from("jpeg");
    const fetcher: typeof fetch = async (url, init) => {
      urls.push(String(url)); bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1290, totalTokenCount: 1295 }, candidates: [{ finishReason: "STOP", content: { role: "model", parts: [
        { inlineData: { mimeType: "image/png", data: Buffer.from("rascunho").toString("base64") }, thought: true },
        { text: "Aqui está." },
        { inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } },
      ] } }] });
    };
    const calls: { tool: string; input: string; images: Buffer[] }[] = [];
    const text = await runProviderModel({ model: "google:gemini-2.5-flash-image", modelCredentialId: c.id }, { system: "s", prompt: "Desenhe um gato", fetcher, onBuiltin: async call => { calls.push(call); } });
    assert.equal(text, "Aqui está.");
    assert.deepEqual(urls, ["https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent"], "sem ferramentas nativas, o modelo de imagem também usa a API nativa");
    assert.deepEqual(bodies[0].generationConfig, { responseModalities: ["TEXT", "IMAGE"] }, "o limite de saída fica com o modelo, pois cada imagem consome muitos tokens");
    assert.deepEqual(bodies[0].tools, []);
    assert.deepEqual(calls.map(call => [call.tool, call.input, call.images]), [["image_generation", "Desenhe um gato", [jpeg]]], "a imagem do raciocínio não é entregue");
    // Resposta sem texto nem imagem vira erro claro.
    await assert.rejects(runProviderModel({ model: "google:gemini-2.5-flash-image", modelCredentialId: c.id, modelMaxTokens: "800" }, { system: "s", prompt: "p", onBuiltin: async () => {},
      fetcher: async (_url, init) => { assert.equal(JSON.parse(String(init?.body)).generationConfig.maxOutputTokens, 800); return Response.json({ candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }] }); } }), /não gerou imagem \(IMAGE_SAFETY\)/);
  });
});

test("motor mostra a imagem gerada por um modelo de imagem do Gemini", async t => {
  const tenant = await createTenantTestContext(); t.after(tenant.close);
  await tenant.asTenant(async () => {
    const c = saveToolCredential({ name: "Google", provider: "ai_google", fields: { GEMINI_API_KEY: "private-gemini" } }); await commitTestConfig();
    const { default: sharp } = await import("sharp");
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#00f" } }).jpeg().toBuffer();
    const f = await createFlow("Gemini imagem"); const graph = template();
    graph.nodes[1].data.config = { model: "google:gemini-2.5-flash-image", modelCredentialId: c.id, system: "Ajude" };
    await saveFlow(f.id, { ...f, graph });
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
      assert.equal(String(url), "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent");
      return Response.json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } }] } }] });
    });
    const run = await startRun(f.id, "Desenhe", false, false);
    assert.equal(run.status, "completed", run.error);
    assert.match(run.output, /^!\[Imagem gerada 1\]\(\/api\/attachments\/[^)]+\)/);
    const step = run.trace.find(trace => trace.label === "Google: Geração de imagens")!;
    assert.equal(step.type, "tool"); assert.equal(step.images?.length, 1);
  });
});
