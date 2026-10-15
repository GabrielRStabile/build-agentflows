import nodeTest, { type TestContext } from "node:test";
import { createTenantTestContext } from "../scripts/tenant-test-context";
const testTenant = await createTenantTestContext();
function test(name: string, action: (t: TestContext) => unknown | Promise<unknown>) { return nodeTest(name, async t => { await testTenant.asTenant(() => action(t)); }); }
nodeTest.after(testTenant.close);
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "agentflows-services-"));
process.env.DATA_DIR = dir;
const { getConfig } = await import("./store");
const { builtinTools, resolveTools, callTool } = await import("./tools");
const { salvarCampos } = await import("./conexoes");
const { serviceToken } = await import("./tool-services");
const api = await import("../app/api/tools/route");
nodeTest.after(() => rmSync(dir, { recursive: true, force: true }));

nodeTest("catálogo inclui as 24 ferramentas pedidas e compartilha a credencial sem expor segredos", async (t) => {
  const tenant = await (await import("../scripts/tenant-test-context")).createTenantTestContext(); t.after(tenant.close);
  await tenant.asTenant(async () => {
  const expected = ["BraveSearch API", "Browserless MCP", "Calculator", "Code Interpreter by E2B", "Exa Search", "Gmail", "Google Calendar", "Google Custom Search", "Google Drive", "Google Sheets", "Microsoft Outlook", "Microsoft Teams", "OpenAPI Toolkit", "Read File", "Request Get", "Request Post", "SearchApi", "SearXNG", "Serp API", "Serper", "Slack MCP", "Tavily", "Web Browser", "Write File"];
  const labels = builtinTools().map((t) => t.label);
  for (const label of expected) assert.ok(labels.includes(label), label);
  salvarCampos({ TOOL_GOOGLE_TOKEN: "google-secret-token" });
  const catalog = builtinTools();
  for (const name of ["gmail", "google_calendar", "google_drive", "google_sheets"]) assert.equal(catalog.find((t) => t.name === name)?.configured, true);
  assert.ok(!JSON.stringify(catalog).includes("google-secret-token"));
  const a = await resolveTools(["interno:gmail", "interno:calculadora"]), b = await resolveTools(["interno:gmail", "interno:calculadora"]);
  assert.deepEqual(a.map((t) => t.name), b.map((t) => t.name));
  assert.equal(await a[1].call({ expressao: "6*7" }), "42");
  assert.equal(await b[1].call({ expressao: "2+3" }), "5");
  });
  const res = await tenant.connect(() => api.PUT(tenant.request("/api/tools", { method: "PUT", body: JSON.stringify({ campos: { WHATSAPP_PROVEDOR: "zapi" } }) })));
  assert.equal(res.status, 400);
});

test("arquivos compartilhados entre agentes preservam conteúdo e recusam escape e symlinks", async () => {
  const [writer] = await resolveTools(["interno:write_file"]), [reader] = await resolveTools(["interno:read_file"]);
  await writer.call({ caminho: "relatorios/hoje.txt", conteudo: "Olá, StartSe" });
  assert.equal(await reader.call({ caminho: "relatorios/hoje.txt" }), "Olá, StartSe");
  for (const caminho of ["../app.sqlite", "/etc/passwd", "relatorios/../../chatgpt/auth.json", "a\\..\\b"]) await assert.rejects(() => reader.call({ caminho }), /caminho/i);
  writeFileSync(join(dir, "secret"), "secret");
  symlinkSync(join(dir, "secret"), join(dir, "users", testTenant.owner, "tool-files", "alias"));
  await assert.rejects(() => reader.call({ caminho: "alias" }), /simbólicos/);
  await assert.rejects(() => writer.call({ caminho: "alias", conteudo: "x" }), /simbólicos/);
  await assert.rejects(() => writer.call({ caminho: "grande", conteudo: "x".repeat(1024 * 1024 + 1) }), /1 MB/);
});

test("Google e Microsoft usam as contas salvas, rotas corretas e formatos de envio", async () => {
  salvarCampos({ TOOL_GOOGLE_TOKEN: "google-secret-token", TOOL_MICROSOFT_TOKEN: "ms-secret" });
  const fetch0 = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ ok: true }); }) as typeof fetch;
  try {
    await callTool("interno:gmail", { acao: "listar", consulta: "from:teste@example.com" });
    await callTool("interno:gmail", { acao: "enviar", para: "teste@example.com", assunto: "Olá", texto: "Bom dia" });
    assert.match(calls[0].url, /gmail\/v1\/users\/me\/messages\?/);
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer google-secret-token");
    const mime = Buffer.from(JSON.parse(String(calls[1].init?.body)).raw, "base64url").toString();
    assert.match(mime, /To: teste@example.com/);
    assert.match(mime, /Subject: =\?UTF-8\?B\?/);
    await assert.rejects(() => callTool("interno:gmail", { acao: "enviar", para: "x\r\nBcc: y", assunto: "A", texto: "B" }), /inválido/);
    await callTool("interno:google_calendar", { acao: "criar", dados: { summary: "Reunião", start: { date: "2026-09-21" }, end: { date: "2026-09-22" } } });
    await callTool("interno:google_drive", { acao: "exportar", id: "documento" });
    await callTool("interno:google_sheets", { acao: "adicionar", planilha: "sheet", intervalo: "A1:B2", valores: [[1, 2]] });
    assert.match(calls[2].url, /calendars\/primary\/events$/);
    assert.match(calls[3].url, /files\/documento\/export\?mimeType=text%2Fplain$/);
    assert.match(calls[4].url, /:append\?valueInputOption=RAW/);
    assert.deepEqual(JSON.parse(String(calls[4].init?.body)).values, [[1, 2]]);
    await callTool("interno:outlook", { acao: "enviar", para: "teste@example.com", assunto: "Oi", texto: "Tudo bem" });
    await callTool("interno:teams", { acao: "enviar", equipe: "team", canal: "channel", texto: "Olá" });
    assert.match(calls[5].url, /me\/sendMail$/);
    assert.equal((calls[5].init?.headers as Record<string, string>).Authorization, "Bearer ms-secret");
    assert.match(calls[6].url, /teams\/team\/channels\/channel\/messages$/);
    assert.deepEqual(JSON.parse(String(calls[6].init?.body)), { body: { contentType: "text", content: "Olá" } });
    await assert.rejects(() => callTool("interno:teams", { acao: "qualquer" }), /ação disponível/);
    globalThis.fetch = async () => new Response("sensitive provider details", { status: 403 });
    await assert.rejects(() => callTool("interno:outlook", { acao: "listar" }), /erro 403/);
  } finally { globalThis.fetch = fetch0; }
});

test("tokens renovados são reutilizados pelas ferramentas e falhas não viram credenciais", async () => {
  salvarCampos({ TOOL_GOOGLE_REFRESH_TOKEN: "refresh", TOOL_GOOGLE_CLIENT_ID: "client", TOOL_GOOGLE_CLIENT_SECRET: "secret" });
  const fetch0 = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url, init) => { calls++; assert.equal(String(url), "https://oauth2.googleapis.com/token"); assert.match(String(init?.body), /grant_type=refresh_token/); return Response.json({ access_token: "new", expires_in: 3600 }); }) as typeof fetch;
  try { assert.equal(await serviceToken("GOOGLE"), "new"); assert.equal(await serviceToken("GOOGLE"), "new"); assert.equal(calls, 1); assert.equal(getConfig("TOOL_GOOGLE_TOKEN"), "new"); }
  finally { globalThis.fetch = fetch0; }
});

test("Request Get/Post e Web Browser executam requisições e extraem texto", async () => {
  const fetch0 = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (_, init) => { methods.push(init?.method || "GET"); if (init?.method === "POST") assert.deepEqual(JSON.parse(String(init.body)), { valor: 1 }); return new Response("<h1>Título</h1><p>Texto</p>"); }) as typeof fetch;
  try {
    await callTool("interno:request_get", { url: "https://example.com" });
    await callTool("interno:request_post", { url: "https://example.com", corpo: { valor: 1 } });
    assert.equal(await callTool("interno:web_browser", { url: "https://example.com" }), "Título\nTexto");
    assert.deepEqual(methods, ["GET", "POST", "GET"]);
  } finally { globalThis.fetch = fetch0; }
});

test("OpenAPI resolve operações e referências locais sem expor o segredo no schema", async () => {
  salvarCampos({ TOOL_OPENAPI_URL: "https://spec.example/openapi.json", TOOL_OPENAPI_TOKEN: "openapi-secret" });
  const fetch0 = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes("spec.example")) return Response.json({ openapi: "3.0.3", servers: [{ url: "https://service.example/v1" }], components: { schemas: { Id: { type: "string" } } }, paths: { "/items/{id}": { get: { operationId: "getItem", parameters: [{ name: "id", in: "path", required: true, schema: { $ref: "#/components/schemas/Id" } }] } } } });
    assert.equal(String(url), "https://service.example/v1/items/42");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer openapi-secret");
    called = true; return Response.json({ id: 42 });
  }) as typeof fetch;
  try {
    const tools = await resolveTools(["interno:openapi"]);
    assert.equal(tools.length, 1);
    assert.equal((tools[0].schema as { properties: { id: { type: string } } }).properties.id.type, "string");
    assert.ok(!JSON.stringify(tools).includes("openapi-secret"));
    assert.deepEqual(JSON.parse(await tools[0].call({ id: "42" })), { id: 42 });
    assert.ok(called);
    await assert.rejects(() => tools[0].call({ id: ".." }), /inválido/);
    await assert.rejects(() => tools[0].call({}), /Informe id/);
  } finally { globalThis.fetch = fetch0; }
});

test("Browserless e Slack negociam MCP, listam e chamam ferramentas com credencial privada", async () => {
  salvarCampos({ TOOL_BROWSERLESS_TOKEN: "browser-token", TOOL_SLACK_TOKEN: "slack-token" });
  const fetch0 = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (url, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    const message = JSON.parse(String(init?.body)); methods.push(message.method);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), String(url).includes("browserless") ? "Bearer browser-token" : "Bearer slack-token");
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result: unknown = {};
    if (message.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    if (message.method === "tools/list") result = { tools: [{ name: "search", description: "Buscar", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] };
    if (message.method === "tools/call") { assert.equal(message.params.name, "search"); result = { content: [{ type: "text", text: "Encontrado" }] }; }
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  }) as typeof fetch;
  try {
    const tools = await resolveTools(["interno:browserless", "interno:slack"]);
    assert.deepEqual(tools.map((t) => t.name), ["browserless_search", "slack_search"]);
    assert.match(await tools[0].call({ q: "site" }), /Encontrado/);
    assert.match(await tools[1].call({ q: "mensagem" }), /Encontrado/);
    assert.ok(methods.includes("notifications/initialized") && methods.includes("tools/call"));
  } finally { globalThis.fetch = fetch0; }
});

test("E2B executa em sandbox remoto e sempre encerra o ambiente", async (t) => {
  salvarCampos({ TOOL_E2B_KEY: "e2b-test-key" });
  const { Sandbox } = await import("@e2b/code-interpreter");
  let killed = 0;
  t.mock.method(Sandbox, "create", async (options: { apiKey: string }) => {
    assert.equal(options.apiKey, "e2b-test-key");
    return { runCode: async (code: string) => { if (code === "fail") throw new Error("exec failure"); return { results: [{ text: "42" }], logs: { stdout: [], stderr: [] }, error: null }; }, kill: async () => { killed++; } };
  });
  assert.deepEqual(JSON.parse(await callTool("interno:e2b", { codigo: "print(42)" })).resultados, ["42"]);
  await assert.rejects(() => callTool("interno:e2b", { codigo: "fail" }), /exec failure/);
  assert.equal(killed, 2);
});

test("E2B: gráficos exibidos viram anexos da resposta, sem base64 para o modelo", async (t) => {
  salvarCampos({ TOOL_E2B_KEY: "e2b-test-key" });
  const sharp = (await import("sharp")).default;
  const png = (await sharp({ create: { width: 4, height: 3, channels: 3, background: "#4f46e5" } }).png().toBuffer()).toString("base64");
  const { Sandbox } = await import("@e2b/code-interpreter");
  t.mock.method(Sandbox, "create", async () => ({
    runCode: async () => ({ results: [{ text: "<PIL.Image.Image image mode=RGBA>", png }, { text: "<Figure size 1000x550 with 1 Axes>", png }, { text: "42" }], logs: { stdout: [], stderr: [] }, error: null }),
    kill: async () => {},
  }));
  const outside = JSON.parse(await callTool("interno:e2b", { codigo: "plt.show()" }));
  assert.deepEqual(outside.resultados, ["[imagem exibida para a pessoa]", "[imagem exibida para a pessoa]", "42"]);
  assert.match(outside.imagens, /bloco Agente/);
  const { createTenantFlow } = await import("./tenant-flows");
  const { toolRunScope } = await import("./replicate-tool");
  const flow = await createTenantFlow("Gráficos");
  const trace = { nodeId: "a", type: "tool" } as import("./flow-types").Trace;
  const run = { flowId: flow.id } as import("./flow-types").Run;
  const output = await toolRunScope.run({ run, nodeId: "a", signal: new AbortController().signal, trace }, () => callTool("interno:e2b", { codigo: "plt.show()" }));
  assert.doesNotMatch(output, /iVBOR/, "o base64 não vai para o modelo");
  assert.match(JSON.parse(output).imagens, /1 imagem\(ns\) gerada/);
  assert.deepEqual(trace.images?.map((image) => [image.kind, image.mime]), [["image", "image/png"]], "imagens repetidas são guardadas uma vez");
});
