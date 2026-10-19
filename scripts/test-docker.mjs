// Isolated Compose smoke test. Never reads the application's .env or volumes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

const docker = process.env.DOCKER_BIN || "docker";
const project = `agentflows-test-${randomBytes(6).toString("hex")}`;
const image = process.env.AGENTFLOWS_TEST_IMAGE || `${project}:local`;
let browserPort;
if (process.env.PLAYWRIGHT_MODULE) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browserPort = server.address().port;
  await new Promise(resolve => server.close(resolve));
}
const origin = browserPort ? `http://127.0.0.1:${browserPort}` : "https://app.example.test";
const dir = await mkdtemp(path.join(tmpdir(), project));
const envFile = path.join(dir, "test.env"), override = path.join(dir, "compose.yml");
const env = { ...process.env, PATH: `${path.dirname(docker)}:${process.env.PATH}` };
// Compose interpolation must not inherit real credentials from the host.
for (const key of ["APP_URL", "CHAVE_MESTRA", "POSTGRES_PASSWORD", "REDIS_PASSWORD", "RESEND_API_KEY", "RESEND_FROM", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) delete env[key];
async function command(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(docker, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${args[0]} failed (${code}): ${stderr.slice(-5000)}${stdout.slice(-2000)}`)));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
const composeArgs = ["compose", "--env-file", envFile, "-p", project, "-f", path.resolve("docker-compose.coolify.yml"), "-f", override];
const compose = (...args) => command([...composeArgs, ...args]);
const inside = (source) => command([...composeArgs, "exec", "-T", "app", "node", "--import", "./scripts/gancho-ts.mjs", "--input-type=module", "-"], source);
const common = `
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { saasDatabase } from './lib/saas-db.ts';
const db = saasDatabase();
async function request(token, pathname, data, method, publicAccess = false) {
  const response = await fetch('http://127.0.0.1:10000' + pathname, {
    method: method || (data ? 'POST' : 'GET'),
    headers: { ...(publicAccess ? { authorization: 'Bearer ' + token } : { cookie: 'agentflows_session=' + token }), origin: process.env.APP_URL, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { status: response.status, body: await response.json() };
}
`;
try {
  await writeFile(envFile, `APP_URL=${origin}\nCHAVE_MESTRA=${randomBytes(32).toString("base64")}\nPOSTGRES_PASSWORD=${randomBytes(32).toString("hex")}\nREDIS_PASSWORD=${randomBytes(32).toString("hex")}\nRESEND_API_KEY=unused\nRESEND_FROM=test@example.com\nFILA_LIMITE_USUARIO=10\n`, { mode: 0o600 });
  await writeFile(override, `services:\n  app:\n    image: ${image}\n${browserPort ? `    ports:\n      - "127.0.0.1:${browserPort}:10000"\n` : ""}    environment:\n      RESEND_API_KEY: ""\n      RESEND_FROM: ""\n  worker:\n    image: ${image}\n    environment:\n      RESEND_API_KEY: ""\n      RESEND_FROM: ""\n`);
  if (!process.env.AGENTFLOWS_TEST_IMAGE) {
    console.log("Docker: compiling image...");
    await command(["build", "-t", image, "."]);
  }
  console.log("Docker: starting isolated app, PostgreSQL and Redis...");
  await compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "app");
  await inside(common + `
    import { randomUUID } from 'node:crypto';
    import { hashToken, randomToken, seal } from './lib/saas-security.ts';
    import { block } from './lib/flow-types.ts';
    const { default: { IndexFlatIP } } = await import('faiss-node');
    const index = new IndexFlatIP(2);
    index.add([1, 0]);
    assert.equal(index.search([1, 0], 1).labels[0], 0);
    const a = randomUUID(), b = randomUUID(), tokenA = randomToken(), tokenB = randomToken();
    for (const [id, token] of [[a, tokenA], [b, tokenB]]) {
      await db.query("INSERT INTO users(id,name,email,email_verified_at,beta_status) VALUES($1,'Docker test',$2,now(),'approved')", [id, id + '@example.com']);
      await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hashToken(token), id]);
    }
    const nodes = [block('start', 'start', 0, 0), block('end', 'end', 200, 0)];
    nodes[1].data.config.text = 'Worker completed';
    const flow = await request(tokenA, '/api/flows', { name: 'Docker flow', description: '', graph: { nodes, edges: [{ id: 'edge', source: 'start', target: 'end' }] } });
    assert.equal(flow.status, 200);
    // Grafo com LLM que o navegador cria (e apaga) para conferir o aviso que impede fechar o diálogo do bloco.
    const llmGraph = { nodes: [block('start', 'start', 0, 0), block('llm', 'llm', 260, 0), block('end', 'end', 520, 0)], edges: [{ id: 'e1', source: 'start', target: 'llm' }, { id: 'e2', source: 'llm', target: 'end' }] };
    // Grafo com Decisão: as opções padrão viram saídas, mais a Incerta.
    const decisionGraph = { nodes: [block('start', 'start', 0, 0), block('decision', 'triagem', 260, 0), block('end', 'suporte', 560, -120), block('end', 'comercial', 560, 0), block('end', 'duvida', 560, 120)],
      edges: [{ id: 'd1', source: 'start', target: 'triagem' }, { id: 'd2', source: 'triagem', target: 'suporte', sourceHandle: 'opt_suporte' }, { id: 'd3', source: 'triagem', target: 'comercial', sourceHandle: 'opt_comercial' }, { id: 'd4', source: 'triagem', target: 'duvida', sourceHandle: 'incerto' }] };
    assert.equal((await request(tokenB, '/api/flows/' + flow.body.id)).status, 404);
    assert.equal((await request('', '/api/flows')).status, 401);
    const configured = await request(tokenA, '/api/conexoes', { campos: { REPLICATE_API_TOKEN: 'container-private-replicate-token' } }, 'PUT');
    assert.equal(configured.status, 200);
    assert.ok(!JSON.stringify(configured.body).includes('container-private-replicate-token'));
    assert.equal((await request(tokenA, '/api/conexoes/media')).body.providers.find(item => item.id === 'replicate').conectado, true);
    assert.equal((await request(tokenB, '/api/conexoes/media')).body.providers.some(item => item.conectado), false);
    const { default: sharp } = await import('sharp');
    const { withTenantJob } = await import('./lib/tenant-context.ts');
    const { saveAttachment } = await import('./lib/attachment-service.ts');
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
    const image = await withTenantJob(db, a, () => saveAttachment(flow.body.id, new File([png], 'generated.png'), true));
    assert.equal((await request(tokenB, '/api/attachments/' + image.id)).status, 404);
    const runs = [];
    for (let i=0; i<10; i++) {
      const run = await request(tokenA, '/api/flows/' + flow.body.id + '/run', { input: 'Test ' + i, demo: true });
      assert.equal(run.status, 202); runs.push(run.body.id);
    }
    assert.equal((await request(tokenA, '/api/flows/' + flow.body.id + '/run', { input: 'Over quota', demo: true })).status, 429);
    assert.equal((await request(tokenB, '/api/runs/' + runs[0])).status, 404);
    await writeFile('/app/data/docker-test.json', JSON.stringify({ a, b, tokenA, tokenB, runs, flowId: flow.body.id, llmGraph, decisionGraph, imageId: image.id, png: png.toString('base64'), encrypted: seal('persisted-secret', 'docker-test') }), { mode: 0o600 });
    await db.close();
  `);
  console.log("Docker: checking two workers against the same queue...");
  await compose("up", "-d", "--no-build", "--scale", "worker=2", "--wait", "--wait-timeout", "180", "worker");
  await inside(common + `
    const fixture = JSON.parse(await readFile('/app/data/docker-test.json', 'utf8'));
    const deadline = Date.now() + 60000;
    let done = false;
    while (Date.now() < deadline) {
      const active = await db.query("SELECT count(*)::int count FROM jobs WHERE user_id=$1 AND status='running'", [fixture.a]);
      assert.ok(active.rows[0].count <= 1);
      const rows = (await db.query("SELECT status FROM jobs WHERE user_id=$1", [fixture.a])).rows;
      if (rows.length === 10 && rows.every(row => row.status === 'done')) { done = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(done, 'workers did not finish the persisted queue');
    for (const id of fixture.runs) assert.equal((await request(fixture.tokenA, '/api/runs/' + id)).body.status, 'completed');
    // Push channel: the web container's LISTEN connection receives the workers' NOTIFY and streams the run.
    async function stream(token, id) {
      const response = await fetch('http://127.0.0.1:10000/api/runs/' + id + '/events', { headers: { cookie: 'agentflows_session=' + token } });
      assert.equal(response.status, 200); assert.ok(response.headers.get('content-type').includes('text/event-stream'));
      const text = await response.text();
      return text.split(String.fromCharCode(10, 10)).filter(block => block && !block.startsWith(':')).map(block => ({ event: /^event: (.*)$/m.exec(block)[1], data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) }));
    }
    const finished = await stream(fixture.tokenA, fixture.runs[0]);
    assert.deepEqual(finished.map(f => f.event), ['run', 'end']); assert.equal(finished[0].data.status, 'completed');
    assert.equal((await fetch('http://127.0.0.1:10000/api/runs/' + fixture.runs[0] + '/events', { headers: { cookie: 'agentflows_session=' + fixture.tokenB } })).status, 200);
    assert.equal((await stream(fixture.tokenB, fixture.runs[0]))[0].event, 'error');
    const live = await request(fixture.tokenA, '/api/flows/' + fixture.flowId + '/run', { input: 'Streamed', demo: true });
    assert.equal(live.status, 202);
    const frames = await stream(fixture.tokenA, live.body.id);
    assert.ok(frames.length >= 2, 'stream produced ' + frames.length + ' frames');
    assert.equal(frames.at(-1).event, 'end'); assert.equal(frames.at(-1).data.reason, 'done');
    assert.equal(frames.at(-2).event, 'run'); assert.equal(frames.at(-2).data.status, 'completed'); assert.equal(frames.at(-2).data.output, 'Worker completed');
    await db.close();
  `);
  console.log("Docker: checking encrypted ChatGPT session and native process isolation...");
  await inside(common + `
    import { randomUUID } from 'node:crypto';
    import { spawn } from 'node:child_process';
    import { statfsSync, existsSync } from 'node:fs';
    import { withTenantJob } from './lib/tenant-context.ts';
    import { ChatGPTBridge } from './lib/chatgpt.ts';
    import { readChatSession } from './lib/chatgpt-session.ts';
    const fixture = JSON.parse(await readFile('/app/data/docker-test.json', 'utf8'));
    const chatOwner = randomUUID();
    await db.query("INSERT INTO users(id,name,email,email_verified_at,beta_status) VALUES($1,'Chat fixture',$2,now(),'approved')", [chatOwner, chatOwner + '@example.com']);
    fixture.chatOwner = chatOwner;
    await writeFile('/app/data/docker-test.json', JSON.stringify(fixture), { mode: 0o600 });
    assert.equal(Number(statfsSync('/tmp').type), 0x01021994);
    const directories = [];
    const bridge = await withTenantJob(db, chatOwner, () => new ChatGPTBridge(options => {
      directories.push(options.env.CODEX_HOME);
      return spawn(process.execPath, ['/app/scripts/fixtures/codex-protocol.mjs'], { ...options, stdio: 'pipe' });
    }));
    try {
      await withTenantJob(db, chatOwner, () => bridge.beginLogin());
      for (let i=0; i<100; i++) {
        const saved = await withTenantJob(db, chatOwner, readChatSession);
        if (saved.state.account && !saved.busy) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal((await withTenantJob(db, chatOwner, () => bridge.account())).account.email, 'test@example.com');
      assert.equal(await withTenantJob(db, chatOwner, () => bridge.run({ system: '', prompt: 'Hello' })), 'Olá mundo');
      assert.ok(directories.every(directory => !existsSync(directory)));
      assert.ok(!JSON.stringify((await db.query('SELECT * FROM chatgpt_sessions')).rows).includes('fixture-refresh'));
      assert.equal((await withTenantJob(db, fixture.b, readChatSession)).state.auth, null);
    } finally { await bridge.close(); }
    // Start the actual installed Codex in an empty account, without real credentials.
    const native = await withTenantJob(db, fixture.b, () => new ChatGPTBridge());
    try { await withTenantJob(db, fixture.b, () => assert.rejects(native.usage(), /Conecte sua conta/)); }
    finally { await native.close(); }
    await db.close();
  `);
  console.log("Docker: checking public chat tickets and shared worker...");
  await inside(common + `
    const fixture = JSON.parse(await readFile('/app/data/docker-test.json', 'utf8'));
    const settings = await request(fixture.tokenA, '/api/flows/' + fixture.flowId + '/embed', { enabled: true, origins: ['https://customer.example'], title: 'Docker chat', welcome: 'Welcome', maxMinutes: 15, maxCommands: 3 }, 'PUT');
    assert.equal(settings.status, 200);
    assert.equal((await request(fixture.tokenB, '/api/flows/' + fixture.flowId + '/embed')).status, 404);
    const key = (await request(fixture.tokenA, '/api/flows/' + fixture.flowId + '/embed', { action: 'rotate' })).body.key;
    const ticket = await request(key, '/api/embed/token', { flowId: fixture.flowId, subject: 'visitor', origin: 'https://customer.example' }, 'POST', true);
    assert.equal(ticket.status, 200);
    const token = ticket.body.token;
    const session = await request(token, '/api/embed/session', { action: 'connect', origin: 'https://customer.example', tabId: 'docker-tab-12345678', capabilities: [] }, 'POST', true);
    assert.equal(session.status, 200);
    const data = { action: 'message', sessionId: session.body.sessionId, requestId: 'docker-request-12345678', input: 'Public conversation', attachments: [] };
    const sent = await request(token, '/api/embed/session', data, 'POST', true); assert.equal(sent.status, 200);
    assert.equal((await request(token, '/api/embed/session', data, 'POST', true)).body.runId, sent.body.runId);
    let completed = false;
    for (let i=0; i<150; i++) {
      const snapshot = await request(token, '/api/embed/session?id=' + session.body.sessionId, undefined, 'GET', true);
      if (snapshot.body.turns?.[0]?.status === 'completed') { assert.equal(snapshot.body.turns[0].output, 'Worker completed'); completed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(completed);
    fixture.embed = { token, sessionId: session.body.sessionId };
    await writeFile('/app/data/docker-test.json', JSON.stringify(fixture), { mode: 0o600 });
    await db.close();
  `);
  console.log("Docker: checking tenant MCP and queued flow webhook...");
  await inside(common + `
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
    const fixture = JSON.parse(await readFile('/app/data/docker-test.json', 'utf8'));
    const codeA = (await request(fixture.tokenA, '/api/mcp/token', {}, 'POST')).body.codigo;
    const codeB = (await request(fixture.tokenB, '/api/mcp/token', {}, 'POST')).body.codigo;
    assert.equal((await fetch('http://127.0.0.1:10000/mcp')).status, 405);
    const client = new Client({ name: 'docker-test', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:10000/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + codeA } } }));
      assert.equal((await client.listTools()).tools.length, 4);
    } finally { await client.close(); }
    const call = (code, name, args = {}) => request(code, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, 'POST', true);
    const listed = await call(codeA, 'listar_fluxos');
    assert.equal(listed.status, 200);
    assert.deepEqual(JSON.parse(listed.body.result.content[0].text).map(f => f.id), [fixture.flowId]);
    assert.deepEqual(JSON.parse((await call(codeB, 'listar_fluxos')).body.result.content[0].text), []);
    assert.equal((await request(codeB, '/webhook/flows/' + fixture.flowId, { input: 'Forbidden' }, 'POST', true)).status, 404);
    // The published endpoint answers synchronously since 0.34.0; ?wait=0 keeps the queued contract under test.
    const accepted = await request(codeA, '/webhook/flows/' + fixture.flowId + '?wait=0', { input: 'Webhook' }, 'POST', true);
    assert.equal(accepted.status, 202); assert.equal(accepted.body.queued, true);
    const synchronous = await request(codeA, '/webhook/flows/' + fixture.flowId, { input: 'Webhook sync' }, 'POST', true);
    assert.equal(synchronous.status, 200); assert.equal(synchronous.body.status, 'completed'); assert.equal(synchronous.body.output, 'Worker completed');
    let completed = false;
    for (let i=0; i<25; i++) {
      const result = await request(codeA, '/webhook/flows/' + fixture.flowId + '?runId=' + accepted.body.id, undefined, 'GET', true);
      if (result.body.status === 'completed') { assert.equal(result.body.output, 'Worker completed'); completed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(completed);
    const run = await call(codeA, 'consultar_execucao', { id: accepted.body.id });
    assert.equal(JSON.parse(run.body.result.content[0].text).status, 'completed');
    assert.equal((await call(codeB, 'consultar_execucao', { id: accepted.body.id })).body.result.isError, true);
    fixture.integration = { codeA, runId: accepted.body.id };
    await writeFile('/app/data/docker-test.json', JSON.stringify(fixture), { mode: 0o600 });
    await db.close();
  `);
  console.log("Docker: checking tenant channel webhooks and durable deduplication...");
  await compose("stop", "worker");
  await inside(common + `
    import { createHmac } from 'node:crypto';
    import { withTenantJob } from './lib/tenant-context.ts';
    import { salvarCampos } from './lib/conexoes.ts';
    import { channelKey } from './lib/channel-auth.ts';
    import { setConfig } from './lib/store.ts';
    const fixture = JSON.parse(await readFile('/app/data/docker-test.json', 'utf8'));
    const keys = await withTenantJob(db, fixture.a, () => {
      salvarCampos({ WHATSAPP_PROVEDOR: 'zapi', ZAPI_INSTANCE_ID: 'fixture-instance', ZAPI_TOKEN: 'fixture-token', ZAPI_CLIENT_TOKEN: 'fixture-client', WHATSAPP_FLOW_ID: fixture.flowId, ELEVENLABS_FLOW_ID: fixture.flowId, ELEVENLABS_AGENT_ID: 'fixture-agent', ELEVENLABS_WEBHOOK_SECRET: 'fixture-hmac' }, { provedor: 'zapi', versao: '2026-09-20' });
      return { whatsapp: channelKey('whatsapp'), elevenlabs: channelKey('elevenlabs') };
    });
    const waBody = JSON.stringify({ type: 'ReceivedCallback', instanceId: 'fixture-instance', messageId: 'docker-message', phone: '5511999990000', text: { message: 'Docker WhatsApp' } });
    const callBody = JSON.stringify({ type: 'post_call_transcription', data: { agent_id: 'fixture-agent', conversation_id: 'docker-call', transcript: [{ role: 'user', message: 'Docker ElevenLabs' }] } });
    const seconds = Math.floor(Date.now() / 1000);
    const signature = 't=' + seconds + ',v0=' + createHmac('sha256', 'fixture-hmac').update(seconds + '.' + callBody).digest('hex');
    const send = (channel, key, body, headers = {}) => fetch('http://127.0.0.1:10000/webhook/' + channel + '?chave=' + key, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
    assert.equal((await send('whatsapp', keys.whatsapp.replace(fixture.a, fixture.b), waBody)).status, 401);
    assert.equal((await send('elevenlabs', keys.elevenlabs, callBody)).status, 401);
    for (let i=0; i<2; i++) {
      assert.equal((await send('whatsapp', keys.whatsapp, waBody)).status, 200);
      assert.equal((await send('elevenlabs', keys.elevenlabs, callBody, { 'elevenlabs-signature': signature })).status, 200);
    }
    const events = (await db.query('SELECT * FROM channel_events WHERE user_id=$1', [fixture.a])).rows;
    assert.equal(events.length, 2);
    assert.ok(!JSON.stringify(events).includes('5511999990000'));
    for (const event of events) assert.equal((await request(fixture.tokenB, '/api/runs/' + event.run_id)).status, 404);
    // Rotate before restarting either worker. No outbound provider request is permitted in this fixture.
    await withTenantJob(db, fixture.a, () => setConfig('ZAPI_TOKEN', 'rotated-fixture-token'));
    fixture.channels = { keys, waBody, callBody, events };
    await writeFile('/app/data/docker-test.json', JSON.stringify(fixture), { mode: 0o600 });
    await db.close();
  `);
  await compose("up", "-d", "--no-build", "--scale", "worker=2", "--wait", "--wait-timeout", "180", "worker");
  await inside(common + `
    const fixture = JSON.parse(await readFile('/app/data/docker-test.json', 'utf8'));
    let completed = false;
    for (let i=0; i<40; i++) {
      const jobs = (await db.query("SELECT status FROM jobs WHERE user_id=$1 AND run_id=ANY($2::text[])", [fixture.a, fixture.channels.events.map(e => e.run_id)])).rows;
      if (jobs.length === 2 && jobs.every(j => j.status === 'done')) { completed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(completed);
    assert.deepEqual((await db.query('SELECT status FROM channel_deliveries WHERE user_id=$1', [fixture.a])).rows.map(d => d.status), ['cancelled']);
    for (const event of fixture.channels.events) assert.equal((await request(fixture.tokenA, '/api/runs/' + event.run_id)).body.output, 'Worker completed');
    await db.close();
  `);
  if (browserPort) {
    const fixture = JSON.parse(await inside("import { readFile } from 'node:fs/promises'; process.stdout.write(await readFile('/app/data/docker-test.json', 'utf8'));"));
    const { verifyEmbedBrowser } = await import("./test-embed-browser.mjs");
    await verifyEmbedBrowser(origin, fixture);
  }
  console.log("Docker: restarting PostgreSQL under live app and workers...");
  await compose("restart", "postgres");
  await compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "postgres");
  await inside(common + `
    const fixture = JSON.parse(await readFile('/app/data/docker-test.json', 'utf8'));
    // The app's LISTEN connection and the workers reconnect on their own; no notice is required for the stream
    // to progress (periodic re-read), and the queue in PostgreSQL still drives the run to completion.
    let queued;
    for (let attempt = 0; attempt < 30; attempt++) {
      queued = await request(fixture.tokenA, '/api/flows/' + fixture.flowId + '/run', { input: 'After database restart', demo: true });
      if (queued.status === 202) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(queued.status, 202);
    const started = Date.now();
    const response = await fetch('http://127.0.0.1:10000/api/runs/' + queued.body.id + '/events', { headers: { cookie: 'agentflows_session=' + fixture.tokenA } });
    assert.equal(response.status, 200);
    const blocks = (await response.text()).split(String.fromCharCode(10, 10)).filter(block => block && !block.startsWith(':'));
    const frames = blocks.map(block => ({ event: /^event: (.*)$/m.exec(block)[1], data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) }));
    assert.equal(frames.at(-1).event, 'end'); assert.equal(frames.at(-1).data.reason, 'done');
    assert.equal(frames.at(-2).data.status, 'completed');
    assert.ok(Date.now() - started < 60000, 'stream finished after database restart');
    await db.close();
  `);
  console.log("Docker: recreating containers while retaining volumes...");
  await compose("down");
  await compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "180");
  await inside(common + `
    import { unseal } from './lib/saas-security.ts';
    import { withTenantJob } from './lib/tenant-context.ts';
    import { readChatSession } from './lib/chatgpt-session.ts';
    const fixture = JSON.parse(await readFile('/app/data/docker-test.json', 'utf8'));
    assert.equal((await withTenantJob(db, fixture.chatOwner, readChatSession)).state.account.email, 'test@example.com');
    assert.equal((await withTenantJob(db, fixture.b, readChatSession)).state.auth, null);
    const repeated = await fetch('http://127.0.0.1:10000/webhook/whatsapp?chave=' + fixture.channels.keys.whatsapp, { method: 'POST', headers: { 'content-type': 'application/json' }, body: fixture.channels.waBody });
    assert.equal(repeated.status, 200);
    assert.equal((await db.query('SELECT * FROM channel_events WHERE user_id=$1', [fixture.a])).rows.length, 2);
    assert.equal((await db.query('SELECT status FROM channel_deliveries WHERE user_id=$1', [fixture.a])).rows[0].status, 'cancelled');
    assert.equal(unseal(fixture.encrypted, 'docker-test'), 'persisted-secret');
    assert.equal((await request(fixture.tokenA, '/api/flows/' + fixture.flowId)).status, 200);
    assert.equal((await request(fixture.tokenB, '/api/flows/' + fixture.flowId)).status, 404);
    assert.equal((await request(fixture.tokenA, '/api/conexoes/media')).body.providers.find(item => item.id === 'replicate').conectado, true);
    assert.equal((await request(fixture.tokenB, '/api/conexoes/media')).body.providers.some(item => item.conectado), false);
    const image = await fetch('http://127.0.0.1:10000/api/attachments/' + fixture.imageId, { headers: { cookie: 'agentflows_session=' + fixture.tokenA } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('cache-control'), 'private, no-store');
    assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'), fixture.png);
    assert.equal((await request(fixture.tokenB, '/api/attachments/' + fixture.imageId)).status, 404);
    for (const id of fixture.runs) assert.equal((await request(fixture.tokenA, '/api/runs/' + id)).body.status, 'completed');
    const snapshot = await request(fixture.embed.token, '/api/embed/session?id=' + fixture.embed.sessionId, undefined, 'GET', true);
    assert.equal(snapshot.body.turns[0].output, 'Worker completed');
    const integration = await request(fixture.integration.codeA, '/webhook/flows/' + fixture.flowId + '?runId=' + fixture.integration.runId, undefined, 'GET', true);
    assert.equal(integration.body.status, 'completed');
    assert.ok((await db.query("SELECT count(*)::int count FROM jobs WHERE status='done'")).rows[0].count >= 12);
    await db.close();
  `);
  const status = (await compose("ps", "--format", "json")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(status.length, 4);
  assert.ok(status.every((service) => service.Health === "healthy"));
  console.log("Docker passed: authenticated API, private media credentials/images, tenant channels, deduplication, isolation, queue capacity, two workers, push stream, database restart, recreate and volumes.");
} finally {
  try { await compose("down", "--volumes", "--remove-orphans"); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
