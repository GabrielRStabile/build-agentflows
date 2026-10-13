import nodeTest, { type TestContext } from "node:test";
import { createTenantTestContext } from "../scripts/tenant-test-context";
const testTenant = await createTenantTestContext();
function test(name: string, action: (t: TestContext) => unknown | Promise<unknown>) { return nodeTest(name, async t => { await testTenant.asTenant(() => action(t)); }); }
nodeTest.after(testTenant.close);
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "tool-catalog-")); process.env.DATA_DIR = dir;
const { AGENT_TOOL_CATALOG } = await import("./tool-presentation");
const { builtinTools, resolveTools } = await import("./tools");
const { saveToolCredential } = await import("./tool-credential-store");
const { readToolCards, replaceToolCard, validateToolCards } = await import("./agent-tools");
const { block } = await import("./flow-types");
const store = await import("./flow-service");
const { chatGPT } = await import("./chatgpt");
const { POST } = await import("../app/api/tools/options/route");
nodeTest.after(() => rmSync(dir, { recursive: true, force: true }));
function cards(target: string, params: Record<string, string>, credentialId?: string) { return JSON.stringify([{ id: "one", kind: "tool", target, params, credentialId }]); }
test("catálogo tem exatamente as 19 ferramentas pedidas, ordenadas, com ícones e implementação", () => {
  assert.deepEqual(AGENT_TOOL_CATALOG.map((t) => t.name).sort(), ["Agent as a Tool", "BraveSearch", "Calculator", "Code Interpreter by E2B", "Search API", "Tavily API", "Exa AI", "Web Scraper Tool", "Arxiv", "Composio", "CurrentDateTime", "Brave Search MCP", "Browserless MCP", "Postgres MCP", "Github MCP", "Microsoft Teams", "WolframAlpha", "Custom MCP", "OpenAPI Toolkit", "Replicate"].sort());
  assert.deepEqual(AGENT_TOOL_CATALOG.map((t) => t.name), AGENT_TOOL_CATALOG.map((t) => t.name).sort((a,b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" })));
  for (const item of AGENT_TOOL_CATALOG) { assert.ok(builtinTools().some((tool) => tool.id === item.id), item.name); assert.ok(existsSync(join(process.cwd(), "public", item.icon)), item.icon); }
});
test("parâmetros persistem e são removidos ao trocar ferramenta; ações inválidas são rejeitadas", () => {
  const encoded = cards("interno:executar_fluxo", { flowId: "flow-a", description: "Ajuda" });
  validateToolCards(encoded);
  const parsed = readToolCards("interno:executar_fluxo", encoded);
  assert.equal(parsed[0].params?.flowId, "flow-a");
  assert.equal(replaceToolCard(["interno:executar_fluxo"], parsed, "one", "interno:calculadora").cards[0].params, undefined);
  assert.throws(() => validateToolCards(cards("interno:github_mcp", { actions: "null" })), /Confira/);
  assert.throws(() => validateToolCards(cards("interno:github_mcp", { actions: '[4]' })), /Confira/);
  assert.throws(() => validateToolCards(cards("interno:github_mcp", { apiKey: "secret" })), /Confira/);
});
test("Agent as a Tool chama somente o fluxo escolhido e o fuso horário é aplicado", async () => {
  chatGPT().account = async () => ({ account: { type: "chatgpt", email: "test@example.com", planType: "plus" }, login: null, error: null });
  const flow = (await store.createFlow("Alvo"));
  const end = block("end", "end", 0, 0); end.data.config.text = "Alvo: {{input}}";
  (await store.saveFlow(flow.id, { name: flow.name, description: "", graph: { nodes: [block("start", "start", 0,0), end], edges: [{ id: "edge", source: "start", target: "end" }] } })); (await store.publishFlow(flow.id));
  const [tool] = await resolveTools(["interno:executar_fluxo"], cards("interno:executar_fluxo", { flowId: flow.id, description: "Meu agente" }));
  assert.equal(tool.description, "Meu agente");
  assert.equal(JSON.parse(await tool.call({ entrada: "Oi", fluxo: "injetado" })).output, "Alvo: Oi");
  await assert.rejects(() => resolveTools(["interno:executar_fluxo"], cards("interno:executar_fluxo", { flowId: "" })), /Selecione/);
  const [clock] = await resolveTools(["interno:data_hora"], cards("interno:data_hora", { timezone: "UTC" }));
  assert.equal(JSON.parse(await clock.call({})).fuso, "UTC");
});
nodeTest("MCP Github e Custom usam a conta escolhida, listam opções e respeitam ações autorizadas", async (t) => {
  const tenant = await (await import("../scripts/tenant-test-context")).createTenantTestContext(); t.after(tenant.close);
  const fetch0 = globalThis.fetch;
  const credential = await tenant.asTenant(() => saveToolCredential({ name: "Github", provider: "github_mcp", fields: { TOOL_GITHUB_TOKEN: "github-fixture" }  }));
  const custom = await tenant.asTenant(() => saveToolCredential({ name: "Custom", provider: "custom_mcp", fields: { TOOL_CUSTOM_MCP_URL: "https://mcp.example/mcp", TOOL_CUSTOM_MCP_TOKEN: "custom-fixture" }  }));
  globalThis.fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), String(url).includes("github") ? "Bearer github-fixture" : "Bearer custom-fixture");
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    const msg = JSON.parse(String(init?.body));
    if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = msg.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : msg.method === "tools/list" ? { tools: ["read", "write"].map((name) => ({ name, inputSchema: { type: "object" } })) } : { content: [{ type: "text", text: "OK" }] };
    return Response.json({ jsonrpc: "2.0", id: msg.id, result });
  };
  try {
    const response = await tenant.connect(() => POST(tenant.request("/api/tools/options", { method: "POST", body: JSON.stringify({ tool: "interno:github_mcp", credentialId: credential.id }) })));
    assert.equal(response.status, 200); assert.equal((await response.json()).length, 2);
    await tenant.asTenant(async () => {
    const resolved = await resolveTools(["interno:github_mcp"], cards("interno:github_mcp", { actions: '["github_mcp_read"]' }, credential.id));
    assert.deepEqual(resolved.map((t) => t.name), ["github_mcp_read"]); assert.match(await resolved[0].call({}), /OK/);
    const [remote] = await resolveTools(["interno:custom_mcp"], cards("interno:custom_mcp", { actions: '["custom_mcp_read"]' }, custom.id)); assert.match(await remote.call({}), /OK/);
    await assert.rejects(() => resolveTools(["interno:github_mcp"], cards("interno:github_mcp", { actions: "[]" }, credential.id)), /Selecione/);
    await assert.rejects(() => resolveTools(["interno:github_mcp"], cards("interno:github_mcp", { actions: '["missing"]' }, credential.id)), /não está mais disponível/);
    });
  } finally { globalThis.fetch = fetch0; }
});
test("Brave e Postgres inicializam os servidores MCP instalados e encerram os processos", async () => {
  const { localTools } = await import("./tool-mcp");
  const brave = await localTools("brave_mcp", "brave", "fixture-key"); assert.ok(brave.some((tool) => tool.name.includes("web_search")));
  const postgres = await localTools("postgres_mcp", "postgres", "postgresql://test:test@localhost:65432/test"); assert.ok(postgres.some((tool) => tool.name.includes("query")));
});
test("Composio busca ações e executa somente com a conta e a versão da ferramenta selecionadas", async () => {
  const fetch0 = globalThis.fetch;
  const credential = saveToolCredential({ name: "Composio", provider: "composio", fields: { TOOL_COMPOSIO_KEY: "composio-fixture" } });
  globalThis.fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("x-api-key"), "composio-fixture");
    if (String(url).includes("/execute/")) { const b = JSON.parse(String(init?.body)); assert.equal(b.connected_account_id, "account-a"); assert.equal(b.version, "20260901_00"); return Response.json({ successful: true, data: { ok: true } }); }
    return Response.json({ items: [{ slug: "GMAIL_SEND_EMAIL", name: "Enviar email", version: "20260901_00", input_parameters: { type: "object", properties: {} } }] });
  };
  try {
    const [tool] = await resolveTools(["interno:composio"], cards("interno:composio", { app: "gmail", connectedAccountId: "account-a", actions: '["GMAIL_SEND_EMAIL"]' }, credential.id));
    assert.deepEqual(JSON.parse(await tool.call({})), { ok: true });
  } finally { globalThis.fetch = fetch0; }
});
