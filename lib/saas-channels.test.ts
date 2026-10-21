import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createTenantTestContext } from "../scripts/tenant-test-context";
import { hashToken, randomToken } from "./saas-security";
import { withTenantSession } from "./tenant-context";
import { channelKey } from "./channel-auth";
import { block, type Graph } from "./flow-types";
import { createTenantFlow, getTenantRun, publishTenantFlow, cancelTenantRun } from "./tenant-flows";
import { claimJob, enqueueRun, enqueueResume, recoverExpiredJobs } from "./saas-jobs";
import { runClaimedJob } from "./saas-worker";
import { getConfig, setConfig } from "./store";
import { salvarCampos } from "./conexoes";
import * as whatsapp from "../app/webhook/whatsapp/route";
import * as elevenlabs from "../app/webhook/elevenlabs/route";
import * as connections from "../app/api/conexoes/route";

function graph(approval: boolean): Graph {
  const start = block("start", "start", 0, 0), end = block("end", "end", 200, 0);
  end.data.config.text = "Recebido: {{input}}";
  return approval ? { nodes: [start, block("approval", "approval", 100, 0), end], edges: [{ id: "1", source: "start", target: "approval" }, { id: "2", source: "approval", sourceHandle: "yes", target: "end" }, { id: "3", source: "approval", sourceHandle: "no", target: "end" }] } : { nodes: [start, end], edges: [{ id: "1", source: "start", target: "end" }] };
}
async function setup(t: TestContext, approval = false) {
  const x = await createTenantTestContext(); t.after(x.close);
  const other = randomUUID(), tokenB = randomToken();
  await x.db.query("INSERT INTO users(id,email,name,email_verified_at,beta_status) VALUES($1,$2,'Other',now(),'approved')", [other, `${other}@example.com`]);
  await x.db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hashToken(tokenB), other]);
  const asB = <T>(fn: () => T | Promise<T>) => withTenantSession(x.db, tokenB, fn);
  const configure = async () => {
    const flow = await createTenantFlow("Canal", false, { name: "Canal", description: "", graph: graph(approval) });
    salvarCampos({ WHATSAPP_PROVEDOR: "zapi", ZAPI_INSTANCE_ID: "inst", ZAPI_TOKEN: "secret-token", ZAPI_CLIENT_TOKEN: "client-secret", WHATSAPP_FLOW_ID: flow.id, ELEVENLABS_FLOW_ID: flow.id, ELEVENLABS_AGENT_ID: "agent", ELEVENLABS_WEBHOOK_SECRET: "hmac-secret" }, { provedor: "zapi", versao: "2026-09-20" });
    return { flow, wa: channelKey("whatsapp"), el: channelKey("elevenlabs") };
  };
  const a = await x.asTenant(configure), b = await asB(configure);
  const post = (data: unknown = zapi(), key = a.wa, headers: Record<string, string> = {}) => x.connect(() => whatsapp.POST(new Request(`https://app.example.com/webhook/whatsapp?chave=${key}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(data) })));
  const call = (data: unknown, key = a.el, secret = "hmac-secret", seconds = Math.floor(Date.now() / 1000)) => {
    const raw = JSON.stringify(data), sig = createHmac("sha256", secret).update(`${seconds}.${raw}`).digest("hex");
    return x.connect(() => elevenlabs.POST(new Request(`https://app.example.com/webhook/elevenlabs?chave=${key}`, { method: "POST", body: raw, headers: { "elevenlabs-signature": `t=${seconds},v0=${sig}` } })));
  };
  const calls: { url: string; init?: RequestInit }[] = [], original = globalThis.fetch;
  globalThis.fetch = (async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ messageId: "sent" }); }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const jobs = async () => (await x.db.query<{ id: string; user_id: string; run_id: string; status: string }>("SELECT * FROM jobs ORDER BY created_at,id")).rows;
  const drain = async (preferred?: string) => { const job = await claimJob(x.db, preferred); assert.ok(job); return { job, result: await runClaimedJob(x.db, job) }; };
  return { ...x, other, asB, a, b, post, call, calls, jobs, drain };
}
const zapi = (messageId = "z-1") => ({ type: "ReceivedCallback", instanceId: "inst", messageId, phone: "5511999990000", text: { message: "Olá" } });
const callData = (id = "conv-1") => ({ type: "post_call_transcription", data: { agent_id: "agent", conversation_id: id, transcript: [{ role: "user", message: "Olá" }], conversation_initiation_client_data: { dynamic_variables: { user_id: "untrusted-owner" } } } });

test("WhatsApp autentica por tenant, persiste antes do 200 e deduplica avisos concorrentes", async t => {
  const x = await setup(t);
  assert.equal((await x.post(zapi(), x.a.wa.replace(x.owner, x.other))).status, 401);
  assert.equal((await x.post(zapi(), "legacy-global-key")).status, 401);
  assert.equal((await x.post({ ...zapi(), instanceId: "another-account" })).status, 403);
  const challenge = await x.connect(() => whatsapp.GET(new Request(`https://app.example.com/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${x.a.wa}&hub.challenge=abc`)));
  assert.equal(await challenge.text(), "abc");
  const results = await Promise.all([x.post(), x.post(), x.post()]);
  assert.deepEqual(results.map(r => r.status), [200, 200, 200]);
  assert.equal((await x.jobs()).length, 1); assert.equal(x.calls.length, 0);
  const raw = JSON.stringify((await x.db.query("SELECT * FROM channel_events")).rows);
  assert.ok(!raw.includes("5511999990000") && !raw.includes("secret-token"));
  assert.ok(!JSON.stringify((await x.db.query("SELECT * FROM credentials")).rows).includes(x.a.wa));
  const runId = (await x.jobs())[0].run_id;
  await assert.rejects(() => x.asB(() => getTenantRun(runId)), /não encontrada/);
  assert.equal((await x.drain()).result.ok, true);
  assert.equal(x.calls.length, 1); assert.equal(JSON.parse(String(x.calls[0].init?.body)).message, "Recebido: Olá");
  assert.equal((await x.post()).status, 200); assert.equal((await x.jobs()).length, 1);
  assert.equal((await x.asTenant(() => getTenantRun(runId))).trace.at(-1)?.status, "completed");
  assert.equal((await x.post(zapi(), x.b.wa)).status, 200); // The same provider ID belongs to a different tenant.
  assert.equal((await x.jobs()).length, 2);
});

test("canais respeitam a mesma cota, duplicatas continuam aceitas e fila cheia não perde eventos", async t => {
  const x = await setup(t);
  for (let i = 0; i < 10; i++) assert.equal((await x.post(zapi(`z-${i}`))).status, 200);
  assert.equal((await x.post(zapi("z-0"))).status, 200);
  assert.equal((await x.post(zapi("overflow"))).status, 429);
  assert.equal((await x.db.query("SELECT * FROM channel_events")).rows.length, 10);
  assert.equal((await x.post(zapi(), x.b.wa)).status, 200);
  const a = await claimJob(x.db, (await x.jobs())[0].id), b = await claimJob(x.db);
  assert.ok(a && b); assert.notEqual(a.user_id, b.user_id); assert.equal(await claimJob(x.db), undefined);
  await runClaimedJob(x.db, a); await runClaimedJob(x.db, b);
  assert.equal((await x.post(zapi("overflow"))).status, 200);
});

test("aprovação envia aviso e depois resposta final uma vez por etapa, dentro da fila", async t => {
  const x = await setup(t, true); await x.post();
  const first = await x.drain(), runId = first.job.run_id!;
  assert.match(JSON.parse(String(x.calls[0].init?.body)).message, /em análise/);
  assert.equal((await x.asTenant(() => getTenantRun(runId))).status, "waiting");
  const resumed = await x.asTenant(() => enqueueResume(runId, "yes"));
  assert.equal((await x.drain(resumed.job.id)).result.ok, true);
  assert.equal(x.calls.length, 2); assert.equal(JSON.parse(String(x.calls[1].init?.body)).message, "Recebido: Olá");
  await x.post(); assert.equal(x.calls.length, 2);
  assert.deepEqual((await x.db.query("SELECT status FROM channel_deliveries")).rows.map(r => r.status), ["sent", "sent"]);
});

test("rotação de conexão, cancelamento e suspensão impedem respostas pendentes", async t => {
  const x = await setup(t); await x.post();
  await x.asTenant(() => setConfig("ZAPI_TOKEN", "changed"));
  assert.equal((await x.drain()).result.ok, true); assert.equal(x.calls.length, 0);
  assert.equal((await x.db.query("SELECT status FROM channel_deliveries")).rows[0].status, "cancelled");
  await x.post(zapi("z-2")); const queued = (await x.jobs()).find(j => j.status === "queued")!;
  await x.asTenant(() => cancelTenantRun(queued.run_id));
  assert.equal((await x.db.query("SELECT status FROM channel_deliveries WHERE job_id=$1", [queued.id])).rows[0].status, "cancelled");
  await x.db.query("UPDATE users SET beta_status='blocked' WHERE id=$1", [x.owner]);
  assert.equal((await x.post(zapi("z-3"))).status, 403); assert.equal(await claimJob(x.db), undefined);
});

test("falha de rede e queda do worker ficam visíveis sem reenviar mensagens", async t => {
  const x = await setup(t); await x.post();
  globalThis.fetch = async () => { throw new Error("fixture-secret should not leak"); };
  const failed = await x.drain(); assert.equal(failed.result.ok, false);
  assert.equal((await x.db.query("SELECT status FROM channel_deliveries")).rows[0].status, "uncertain");
  const run = await x.asTenant(() => getTenantRun(failed.job.run_id!));
  assert.match(run.trace.at(-1)!.output, /sem confirmação/); assert.ok(!JSON.stringify(run).includes("fixture-secret"));
  await x.post(); assert.equal((await x.jobs()).length, 1); assert.equal(await claimJob(x.db), undefined);
  await x.post(zapi("crash")); const crashed = await claimJob(x.db); assert.ok(crashed);
  await x.db.query("UPDATE channel_deliveries SET status='sending' WHERE job_id=$1", [crashed.id]);
  await x.db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [crashed.id]);
  assert.equal(await recoverExpiredJobs(x.db), 1);
  assert.equal((await x.db.query("SELECT status FROM channel_deliveries WHERE job_id=$1", [crashed.id])).rows[0].status, "uncertain");
  assert.match((await x.asTenant(() => getTenantRun(crashed.run_id!))).trace.at(-1)!.output, /sem confirmação/);
  assert.equal(await claimJob(x.db), undefined);
});

test("ElevenLabs exige chave, assinatura, agente e ID; transcrição usa fila e deduplicação", async t => {
  const x = await setup(t);
  assert.equal((await x.call(callData(), x.a.el, "wrong")).status, 401);
  assert.equal((await x.call(callData(), x.a.el, "hmac-secret", Math.floor(Date.now() / 1000) - 3600)).status, 401);
  assert.equal((await x.call(callData(), x.b.el, "wrong")).status, 401);
  assert.equal((await x.call({ ...callData(), data: { agent_id: "other", conversation_id: "id" } })).status, 403);
  assert.equal((await x.call({ ...callData(), data: { agent_id: "agent" } })).status, 400);
  assert.equal((await x.call(callData())).status, 200); assert.equal((await x.call(callData())).status, 200);
  assert.equal((await x.jobs()).length, 1); assert.equal((await x.jobs())[0].user_id, x.owner);
  assert.equal((await x.drain()).result.ok, true); assert.equal(x.calls.length, 0);
  assert.match((await x.asTenant(async () => getTenantRun((await x.jobs())[0].run_id))).output, /Pessoa: Olá/);
  assert.equal((await x.db.query("SELECT * FROM channel_deliveries")).rows.length, 0);
});

test("Meta valida assinatura e número e processa todas as mensagens de um lote", async t => {
  const x = await setup(t);
  await x.asTenant(() => salvarCampos({ WHATSAPP_PROVEDOR: "meta", WHATSAPP_PHONE_NUMBER_ID: "phone-id", WHATSAPP_TOKEN: "meta-token", WHATSAPP_APP_SECRET: "meta-secret" }));
  const body = { entry: [{ changes: [{ value: { metadata: { phone_number_id: "phone-id" }, messages: ["m-1", "m-2"].map(id => ({ id, from: "5511999990000", type: "text", text: { body: "Olá" } })) } }] }] };
  const signature = (b: unknown) => ({ "x-hub-signature-256": "sha256=" + createHmac("sha256", "meta-secret").update(JSON.stringify(b)).digest("hex") });
  assert.equal((await x.post(body)).status, 401);
  assert.equal((await x.post(body, x.a.wa, signature(body))).status, 200);
  assert.equal((await x.post(body, x.a.wa, signature(body))).status, 200); assert.equal((await x.jobs()).length, 2);
  body.entry[0].changes[0].value.metadata.phone_number_id = "other";
  assert.equal((await x.post(body, x.a.wa, signature(body))).status, 403);
  await x.drain(); assert.equal(new Headers(x.calls[0].init?.headers).get("authorization"), "Bearer meta-token");
});

test("webhooks limitam corpos, IDs, origens de fluxo e configuração cruzada", async t => {
  const x = await setup(t);
  assert.equal((await x.post({ ...zapi(), messageId: "" })).status, 400);
  assert.equal((await x.post({ ...zapi(), text: { message: "x".repeat(300001) } })).status, 413);
  const malformed = await x.connect(() => whatsapp.POST(new Request(`https://app.example.com/webhook/whatsapp?chave=${x.a.wa}`, { method: "POST", body: "{" })));
  assert.equal(malformed.status, 400);
  await x.asTenant(() => publishTenantFlow(x.a.flow.id, false)); assert.equal((await x.post()).status, 409);
  const cross = await x.connect(() => connections.PUT(x.request("/api/conexoes", { method: "PUT", body: JSON.stringify({ campos: { ELEVENLABS_FLOW_ID: x.b.flow.id } }) })));
  assert.equal(cross.status, 404); assert.equal(await x.asTenant(() => getConfig("ELEVENLABS_FLOW_ID")), x.a.flow.id);
  await x.asTenant(() => setConfig("WHATSAPP_FLOW_ID", x.b.flow.id)); assert.equal((await x.post()).status, 404);
  assert.equal((await x.jobs()).length, 0);
});

test("um fluxo normal não recebe recibos nem resposta automática de canal", async t => {
  const x = await setup(t); await x.asTenant(() => enqueueRun(x.a.flow.id, "Normal", true));
  assert.equal((await x.drain()).result.ok, true); assert.equal(x.calls.length, 0);
  assert.equal((await x.db.query("SELECT * FROM channel_deliveries")).rows.length, 0);
});

test("cancelamento conserva a cota enquanto o envio ainda está em andamento", async t => {
  const x = await setup(t, true); await x.post(); await x.post(zapi("next"));
  const job = await claimJob(x.db); assert.ok(job);
  const shutdown = new AbortController();
  let entered!: () => void, release!: () => void;
  const sending = new Promise<void>(r => { entered = r; });
  const pending = new Promise<void>(r => { release = r; });
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url, init) => { signal = init?.signal; entered(); await pending; throw new Error("Aborted fixture"); };
  const worker = runClaimedJob(x.db, job, shutdown.signal);
  try {
    await sending;
    await x.asTenant(() => cancelTenantRun(job.run_id!)); shutdown.abort();
    assert.equal(signal?.aborted, true);
    assert.equal(await claimJob(x.db), undefined);
  } finally { release(); await worker; }
  assert.equal((await worker).ok, false);
  assert.equal((await x.db.query("SELECT status FROM channel_deliveries WHERE job_id=$1", [job.id])).rows[0].status, "uncertain");
  assert.ok(await claimJob(x.db));
});

test("ZapperHub usa ID do evento, mantém aceite obrigatório e bloqueia destinos internos", async t => {
  const x = await setup(t);
  await x.asTenant(() => salvarCampos({ WHATSAPP_PROVEDOR: "zapperhub", ZAPPERHUB_KEY: "private-key" }, { provedor: "zapperhub", versao: "2026-09-20" }));
  const event = { event: { Info: { ID: "wuz-1", Sender: "5511999990000@s.whatsapp.net" }, Message: { conversation: "Oi" } } };
  assert.equal((await x.post(event)).status, 200); assert.equal((await x.post(event)).status, 200);
  assert.equal((await x.drain()).result.ok, true); assert.equal(x.calls.length, 1);
  assert.equal(x.calls[0].url, "https://api.zapperapi.com/chat/send/text");
  await x.asTenant(() => setConfig("WHATSAPP_ACEITE", null));
  assert.equal((await x.post(event)).status, 403);
  await x.asTenant(() => salvarCampos({ ZAPPERHUB_URL: "https://127.0.0.1" }, { provedor: "zapperhub", versao: "2026-09-20" }));
  event.event.Info.ID = "wuz-2"; assert.equal((await x.post(event)).status, 200);
  assert.equal((await x.drain()).result.ok, false); assert.equal(x.calls.length, 1);
});

test("banco recusa recibo associado ao job ou à execução de outro usuário", async t => {
  const x = await setup(t); await x.post(); await x.post(zapi(), x.b.wa);
  const jobs = await x.jobs(), a = jobs.find(j => j.user_id === x.owner)!, b = jobs.find(j => j.user_id === x.other)!;
  await assert.rejects(() => x.db.query("UPDATE channel_deliveries SET run_id=$2 WHERE job_id=$1", [a.id, b.run_id]), /foreign key/);
  await assert.rejects(() => x.db.query("UPDATE channel_deliveries SET user_id=$2 WHERE job_id=$1", [a.id, x.other]), /foreign key/);
  const expired = await claimJob(x.db, a.id); assert.ok(expired);
  await x.db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [a.id]);
  assert.equal(await recoverExpiredJobs(x.db), 1);
  assert.equal((await x.db.query("SELECT status FROM channel_deliveries WHERE job_id=$1", [a.id])).rows[0].status, "cancelled");
  assert.equal(x.calls.length, 0);
});

const zapiDe = (messageId: string, phone: string, senderName: string, message: string) => ({ ...zapi(messageId), phone, senderName, text: { message } });
test("WhatsApp separa a conversa por remetente e só entrega o número ao fluxo que declara as variáveis", async t => {
  const x = await setup(t);
  const lastRun = async () => x.asTenant(async () => getTenantRun((await x.jobs()).at(-1)!.run_id));
  await x.post(zapiDe("s-1", "5511999990000", "Ana", "Olá")); await x.drain();
  assert.ok(!JSON.stringify(await lastRun()).includes("5511999990000"));
  const flow = await x.asTenant(async () => {
    const g = graph(false), start = g.nodes.find(n => n.id === "start")!, end = g.nodes.find(n => n.id === "end")!;
    start.data.config.state = JSON.stringify({ whatsapp_telefone: "", whatsapp_nome: "" });
    end.data.config.text = "{{fluxo.whatsapp_nome}} ({{fluxo.whatsapp_telefone}}): {{input}}";
    const created = await createTenantFlow("Remetente", false, { name: "Remetente", description: "", graph: g });
    setConfig("WHATSAPP_FLOW_ID", created.id);
    return created;
  });
  const message = () => JSON.parse(String(x.calls.at(-1)?.init?.body)).message;
  await x.post(zapiDe("s-2", "5511999990000", "Ana", "Primeira")); await x.drain();
  const ana1 = await lastRun();
  assert.equal(ana1.flowId, flow.id); assert.equal(message(), "Ana (5511999990000): Primeira");
  await x.post(zapiDe("s-3", "5511888880000", "Bruno", "Sou outro")); await x.drain();
  const bruno = await lastRun();
  assert.equal(message(), "Bruno (5511888880000): Sou outro"); assert.equal(bruno.conversation, undefined);
  await x.post(zapiDe("s-4", "5511999990000", "Ana", "Segunda")); await x.drain();
  const ana2 = await lastRun();
  assert.equal(message(), "Ana (5511999990000): Segunda");
  assert.equal(ana2.session, ana1.session); assert.notEqual(ana2.session, bruno.session);
  assert.ok(ana1.session && !ana1.session.includes("5511999990000"));
  assert.deepEqual(ana2.conversation, [{ input: "Primeira", output: "Ana (5511999990000): Primeira" }]);
});
