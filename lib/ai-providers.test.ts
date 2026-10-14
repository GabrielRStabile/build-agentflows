import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTenantTestContext, commitTestConfig } from "../scripts/tenant-test-context";
import { saveToolCredential, listToolCredentials, deleteToolCredential } from "./tool-credential-store";
import { modelCredentialKey, importModelCredentials, saveOpenRouterOAuth } from "./ai-credentials";
import { AI_PROVIDERS, modelSettings } from "./ai-providers";
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
    const models = await providerModels("openai", c.id, async () => Response.json({ data: [{ id: "gpt-4.1-mini" }, { id: "gpt-6-luna" }, { id: "o3" }] }));
    assert.deepEqual(models.map(m => [m.id, m.parameters.includes("reasoning_effort")]), [["openai:gpt-4.1-mini", false], ["openai:gpt-6-luna", true], ["openai:o3", true]]);
  });
});
