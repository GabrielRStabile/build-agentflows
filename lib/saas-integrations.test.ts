import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTenantTestContext } from "../scripts/tenant-test-context";
import { hashToken, randomToken } from "./saas-security";
import { withTenantSession } from "./tenant-context";
import { block, type Graph } from "./flow-types";
import { createTenantFlow, getTenantRun, publishTenantFlow } from "./tenant-flows";
import { codigoAtivo, gerarCodigo } from "./mcp";
import { httpAccess, saveHttpAccess } from "./http-access";
import { claimJob, enqueueRun } from "./saas-jobs";
import { runClaimedJob } from "./saas-worker";
import * as tokenApi from "../app/api/mcp/token/route";
import * as webhook from "../app/webhook/flows/[id]/route";
import * as mcp from "../app/mcp/route";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function graph(approval = false): Graph {
  const start = block("start", "start", 0, 0), end = block("end", "end", 200, 0);
  end.data.config.text = "Concluído";
  return approval ? { nodes: [start, block("approval", "approval", 100, 0), end], edges: [{ id: "a", source: "start", target: "approval" }, { id: "b", source: "approval", sourceHandle: "yes", target: "end" }, { id: "c", source: "approval", sourceHandle: "no", target: "end" }] } : { nodes: [start, end], edges: [{ id: "a", source: "start", target: "end" }] };
}
function external(code: string, data?: unknown, path = "/mcp", headers: Record<string, string> = {}) {
  return new Request("https://app.example.com" + path, { method: data === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${code}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
}
async function setup(t: TestContext, approval = false) {
  const x = await createTenantTestContext(); t.after(x.close);
  const other = randomUUID(), tokenB = randomToken();
  await x.db.query("INSERT INTO users(id,email,name,email_verified_at,beta_status) VALUES($1,$2,'Other',now(),'approved')", [other, `${other}@example.com`]);
  await x.db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hashToken(tokenB), other]);
  const asB = <T>(fn: () => T | Promise<T>) => withTenantSession(x.db, tokenB, fn);
  const flow = await x.asTenant(() => createTenantFlow("A", false, { name: "A", description: "", graph: graph(approval) }));
  const flowB = await asB(() => createTenantFlow("B", false, { name: "B", description: "", graph: graph() }));
  const codeA = (await (await x.connect(() => tokenApi.POST(x.request("/api/mcp/token", { method: "POST" })))).json()).codigo as string;
  const codeB = await asB(gerarCodigo);
  const rpc = (code: string, name: string, args: Record<string, unknown> = {}) => x.connect(() => mcp.POST(external(code, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })));
  const post = (code = codeA, id = flow.id) => x.connect(() => webhook.POST(external(code, { input: "Olá" }, `/webhook/flows/${id}`), { params: Promise.resolve({ id }) }));
  return { ...x, other, tokenB, asB, flow, flowB, codeA, codeB, rpc, post,
    drain: async () => { const job = await claimJob(x.db); assert.ok(job); assert.equal((await runClaimedJob(x.db, job)).ok, true); },
  };
}
const toolData = (body: { result: { content: { text: string }[] } }) => JSON.parse(body.result.content[0].text);

test("código de integração exige sessão, fica cifrado e rotação/revogação só afetam o dono", async t => {
  const x = await setup(t);
  assert.equal((await x.connect(() => tokenApi.GET(external(x.codeA, undefined, "/api/mcp/token")))).status, 401);
  assert.equal((await x.connect(() => tokenApi.POST(new Request("https://app.example.com/api/mcp/token", { method: "POST", headers: { cookie: `agentflows_session=${x.token}`, origin: "https://evil.example" } })))).status, 403);
  const status = await (await x.connect(() => tokenApi.GET(x.request("/api/mcp/token")))).json();
  assert.equal(status.ativo, true); assert.ok(!JSON.stringify(status).includes(x.codeA));
  assert.ok(!JSON.stringify((await x.db.query("SELECT * FROM credentials")).rows).includes(x.codeA));
  const changed = await x.asTenant(gerarCodigo);
  assert.equal((await x.rpc(x.codeA, "listar_fluxos")).status, 401);
  assert.equal((await x.rpc(changed, "listar_fluxos")).status, 200);
  await x.connect(() => tokenApi.DELETE(x.request("/api/mcp/token", { method: "DELETE" })));
  assert.equal((await x.rpc(changed, "listar_fluxos")).status, 401);
  assert.equal((await x.rpc(x.codeB, "listar_fluxos")).status, 200);
  assert.throws(codigoAtivo, /Contexto/);
});

test("MCP lista somente publicados do dono e recusa IDs cruzados e prefixos forjados", async t => {
  const x = await setup(t);
  assert.deepEqual(toolData(await (await x.rpc(x.codeA, "listar_fluxos")).json()).map((f: { id: string }) => f.id), [x.flow.id]);
  assert.equal((await x.post(x.codeB)).status, 404);
  const denied = await (await x.rpc(x.codeB, "executar_fluxo", { id: x.flow.id, input: "Olá" })).json();
  assert.equal(denied.result.isError, true);
  assert.equal((await x.rpc(x.codeA.replace(x.owner, x.other), "listar_fluxos")).status, 401);
  assert.equal((await x.rpc("legacy-global-token", "listar_fluxos")).status, 401);
  await x.asTenant(() => publishTenantFlow(x.flow.id, false));
  assert.deepEqual(toolData(await (await x.rpc(x.codeA, "listar_fluxos")).json()), []);
  assert.notEqual((await x.post()).status, 202);
  assert.equal((await x.db.query("SELECT id FROM jobs")).rows.length, 0);
});

test("webhook retorna 202, worker executa e consulta valida conta e fluxo", async t => {
  const x = await setup(t), response = await x.post();
  assert.equal(response.status, 202); assert.match(response.headers.get("cache-control")!, /no-store/);
  const accepted = await response.json(); assert.equal(accepted.queued, true); assert.equal(accepted.status, "running");
  assert.equal((await x.asTenant(() => getTenantRun(accepted.id))).trace.length, 0);
  await x.drain();
  const read = (code: string, id = x.flow.id) => x.connect(() => webhook.GET(external(code, undefined, `/webhook/flows/${id}?runId=${accepted.id}`), { params: Promise.resolve({ id }) }));
  const result = await (await read(x.codeA)).json(); assert.equal(result.status, "completed"); assert.equal(result.queued, false);
  assert.equal((await read(x.codeB)).status, 404);
  const another = await x.asTenant(() => createTenantFlow("Another", false, { name: "Another", description: "", graph: graph() }));
  assert.equal((await read(x.codeA, another.id)).status, 404);
  assert.equal((await (await x.rpc(x.codeB, "consultar_execucao", { id: accepted.id })).json()).result.isError, true);
});

test("acesso HTTP público por padrão dispensa a chave; com autenticação, exige a chave da conta", async t => {
  const x = await setup(t);
  const anonymous = (data?: unknown, path = `/webhook/flows/${x.flow.id}`) => new Request("https://app.example.com" + path, { method: data === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
  const post = (id = x.flow.id) => x.connect(() => webhook.POST(anonymous({ input: "Olá" }, `/webhook/flows/${id}`), { params: Promise.resolve({ id }) }));
  // Padrão: público. O POST sem Authorization enfileira e o GET sem chave consulta a execução.
  assert.equal((await x.asTenant(() => httpAccess(x.flow.id))), "publico");
  const response = await post(); assert.equal(response.status, 202);
  const accepted = await response.json(); assert.equal(accepted.queued, true);
  await x.drain();
  const read = (id = x.flow.id, runId = accepted.id) => x.connect(() => webhook.GET(anonymous(undefined, `/webhook/flows/${id}?runId=${runId}`), { params: Promise.resolve({ id }) }));
  assert.equal((await (await read()).json()).status, "completed");
  // A execução de outro fluxo e o fluxo de outra conta não respondem pelo endereço público errado.
  assert.equal((await read(x.flowB.id)).status, 404);
  assert.equal((await post(randomUUID())).status, 404);
  // Fluxo não publicado não responde ao público.
  const draft = await x.asTenant(() => createTenantFlow("Rascunho"));
  assert.equal(draft.published, null);
  assert.equal((await post(draft.id)).status, 404);
  // Com autenticação: a chamada anônima recebe 401 e a chave continua funcionando.
  assert.equal(await x.asTenant(() => saveHttpAccess(x.flow.id, "autenticado")), "autenticado");
  await x.asTenant(() => assert.rejects(saveHttpAccess(x.flow.id, "aberto"), /público e com autenticação/));
  const denied = await post(); assert.equal(denied.status, 401);
  assert.match((await denied.json()).error, /chave de acesso/);
  assert.equal((await read()).status, 401);
  assert.equal((await x.post()).status, 202);
  // O outro dono não lê nem altera o acesso deste fluxo.
  await x.asB(() => assert.rejects(httpAccess(x.flow.id)));
  await x.asB(() => assert.rejects(saveHttpAccess(x.flow.id, "publico")));
  assert.equal(await x.asTenant(() => saveHttpAccess(x.flow.id, "publico")), "publico");
  assert.equal((await post()).status, 202);
});

test("MCP enfileira aprovação uma vez e consulta progresso pelo mesmo worker", async t => {
  const x = await setup(t, true);
  const accepted = toolData(await (await x.rpc(x.codeA, "executar_fluxo", { id: x.flow.id, input: "Aprovar" })).json());
  assert.equal(accepted.queued, true);
  await x.drain();
  assert.equal(toolData(await (await x.rpc(x.codeA, "consultar_execucao", { id: accepted.id })).json()).status, "waiting");
  assert.equal((await (await x.rpc(x.codeB, "responder_aprovacao", { id: accepted.id, decision: "yes" })).json()).result.isError, true);
  const results = await Promise.all([1, 2].map(() => x.rpc(x.codeA, "responder_aprovacao", { id: accepted.id, decision: "yes" }).then(r => r.json())));
  assert.equal(results.filter(r => !r.result.isError).length, 1);
  await x.drain();
  assert.equal(toolData(await (await x.rpc(x.codeA, "consultar_execucao", { id: accepted.id })).json()).status, "completed");
});

test("integrações compartilham backlog e concorrência com execuções privadas", async t => {
  const x = await setup(t);
  await x.asTenant(() => enqueueRun(x.flow.id, "Privado", true));
  for (let i = 0; i < 9; i++) assert.equal((await x.post()).status, 202);
  assert.equal((await x.post()).status, 429);
  assert.equal((await x.db.query("SELECT id FROM runs WHERE user_id=$1", [x.owner])).rows.length, 10);
  assert.equal((await x.post(x.codeB, x.flowB.id)).status, 202);
  const jobs = await Promise.all([claimJob(x.db), claimJob(x.db), claimJob(x.db)]);
  assert.deepEqual(new Set(jobs.filter(Boolean).map(j => j!.user_id)), new Set([x.owner, x.other]));
  assert.equal(jobs.filter(Boolean).length, 2);
});

test("limite de integração é persistido por usuário e não reinicia ao trocar o código", async t => {
  const x = await setup(t);
  for (let i = 0; i < 60; i++) assert.equal((await x.rpc(x.codeA, "listar_fluxos")).status, 200);
  const changed = await x.asTenant(gerarCodigo);
  const response = await x.rpc(changed, "listar_fluxos");
  assert.equal(response.status, 429); assert.ok(Number(response.headers.get("retry-after")) > 0);
  assert.equal((await x.rpc(x.codeB, "listar_fluxos")).status, 200);
});

test("origem, limite de corpo e suspensão bloqueiam chamadas públicas", async t => {
  const x = await setup(t);
  assert.equal((await x.connect(() => mcp.POST(external(x.codeA, {}, "/mcp", { origin: "https://evil.example" })))).status, 403);
  assert.equal((await x.connect(() => mcp.POST(external(x.codeA, { large: "x".repeat(300001) })))).status, 413);
  assert.equal((await x.connect(() => mcp.POST(external(x.codeA, { jsonrpc: "2.0", id: 1, method: 10 })))).status, 400);
  await x.db.query("UPDATE users SET beta_status='blocked' WHERE id=$1", [x.owner]);
  assert.equal((await x.post()).status, 403);
  assert.equal((await x.rpc(x.codeA, "listar_fluxos")).status, 403);
  await x.db.query("UPDATE users SET beta_status='approved',email_verified_at=NULL WHERE id=$1", [x.owner]);
  assert.equal((await x.post()).status, 403);
});

test("cliente MCP oficial negocia protocolo, lista ferramentas e consulta execução", async t => {
  const x = await setup(t);
  const client = new Client({ name: "tenant-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://app.example.com/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${x.codeA}` } },
    fetch: async (url, init) => { const request = new Request(url, init); return x.connect(() => request.method === "POST" ? mcp.POST(request) : mcp.GET()); },
  });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 4);
  const result = await client.callTool({ name: "executar_fluxo", arguments: { id: x.flow.id, input: "SDK" } });
  assert.equal(result.isError, undefined);
  const accepted = JSON.parse((result.content as { text: string }[])[0].text);
  assert.equal(accepted.queued, true);
  await x.drain();
  const done = await client.callTool({ name: "consultar_execucao", arguments: { id: accepted.id } });
  assert.equal(JSON.parse((done.content as { text: string }[])[0].text).status, "completed");
});
