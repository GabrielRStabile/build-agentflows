import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createTestDatabase } from "../scripts/saas-test-db";
import { migrateDatabase } from "./db/migrate";
import { hashToken, randomToken } from "./saas-security";
import { withTenantSession } from "./tenant-context";
import * as store from "./knowledge-service";
import * as index from "./knowledge-index-service";
import { getKnowledgePrivate } from "./tenant-knowledge";
import { DEFAULT_INDEX, DEFAULT_SPLITTER } from "./knowledge-types";
import { saveToolCredential, deleteToolCredential } from "./tool-credential-store";
import { createTenantFlow, deleteTenantFlow } from "./tenant-flows";
import { portableGraph } from "./flow-portable";
import { template } from "./flow-types";
import { agentKnowledge } from "./knowledge-agent";

const testDb = await createTestDatabase();
const { db } = testDb;
const a = randomUUID(), b = randomUUID(), tokenA = randomToken(), tokenB = randomToken();
const asA = <T>(action: () => T | Promise<T>) => withTenantSession(db, tokenA, action);
const asB = <T>(action: () => T | Promise<T>) => withTenantSession(db, tokenB, action);
process.env.CHAVE_MESTRA = randomBytes(32).toString("base64");
const collections = new Map<string, { id: string; vector: number[] }[]>();
let failures = false, failDelete = false, embeddingCalls = 0;
const server = createServer(async (req, res) => {
  let raw = ""; for await (const part of req) raw += part;
  const body = raw ? JSON.parse(raw) : {};
  res.setHeader("Content-Type", "application/json");
  const send = (data: unknown) => res.end(JSON.stringify(data));
  if (req.url === "/v1/embeddings") {
    if (failures) { res.statusCode = 503; return send({ error: "private-upstream-secret" }); }
    embeddingCalls += body.input.length;
    return send({ data: body.input.map((text: string, index: number) => ({ index, embedding: [Number(text.includes("reembolso")), Number(text.includes("frete")), 0.1] })) });
  }
  const match = req.url?.match(/^\/collections\/([^/?]+)(.*)$/);
  if (match) {
    const [, name, action] = match;
    if (req.method === "DELETE") {
      if (failDelete) { res.statusCode = 503; return send({ error: "private-delete-secret" }); }
      const removed = collections.delete(name); if (!removed) res.statusCode = 404;
      return send({ result: removed });
    }
    if (action.startsWith("/points/query")) return send({ result: { points: (collections.get(name) || []).map((p) => ({ id: p.id, score: 1 })).slice(0, body.limit) } });
    if (action.startsWith("/points/delete")) { collections.set(name, (collections.get(name) || []).filter((p) => !body.points.includes(p.id))); return send({ result: true }); }
    if (action.startsWith("/points")) { collections.set(name, [...(collections.get(name) || []), ...body.points]); return send({ result: true }); }
    collections.set(name, []); return send({ result: true });
  }
  res.statusCode = 404; send({ error: "not found" });
});
let url = "";
test.before(async () => {
  await migrateDatabase(db); await migrateDatabase(db);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.after(async () => { server.close(); server.closeAllConnections(); await testDb.close(); });
test.beforeEach(async () => {
  await testDb.exec("TRUNCATE users CASCADE"); collections.clear(); failures = false; failDelete = false; embeddingCalls = 0;
  for (const [id, token] of [[a, tokenA], [b, tokenB]]) {
    await db.query("INSERT INTO users(id,name,email,email_verified_at,beta_status) VALUES($1,$2,$3,now(),'approved')", [id, id, `${id}@example.com`]);
    await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hashToken(token), id]);
  }
});
const sourceInput = (text = "Política de reembolso em sete dias.") => ({ name: "Política", loader: "plain", config: { text }, splitter: DEFAULT_SPLITTER, metadata: { department: "support" } });
async function base(name = "Private knowledge") {
  const created = await store.createKnowledgeBase({ name });
  return store.updateKnowledgeBase(created.id, { config: { ...structuredClone(DEFAULT_INDEX), embeddings: { provider: "openai", model: "test", url: `${url}/v1`, apiKey: "private-embedding-key" }, vectorStore: { provider: "qdrant", url, apiKey: "private-vector-key" } } });
}
async function prepared() {
  const created = await base();
  const source = await store.saveKnowledgeSource(created.id, sourceInput());
  await index.processKnowledgeSource(created.id, source.id);
  return { base: created, source };
}

test("conhecimento: CRUD e arquivos/segredos são privados, cifrados e vinculados ao recurso", async () => {
  const created = await asA(() => base());
  assert.ok(!JSON.stringify(created).includes("private-embedding-key"));
  const source = await asA(() => store.saveKnowledgeSource(created.id, { ...sourceInput(), loader: "text", config: {} }, [{ name: "internal.txt", data: Buffer.from("Private document").toString("base64") }]));
  await asB(async () => {
    assert.deepEqual(await store.listKnowledgeBases(), []);
    for (const action of [() => store.getKnowledgeBase(created.id), () => store.updateKnowledgeBase(created.id, { name: "stolen" }), () => store.listKnowledgeSources(created.id), () => store.getKnowledgeSourcePrivate(created.id, source.id), () => index.queryKnowledge(created.id, "secret"), () => index.deleteKnowledgeBase(created.id)])
      await assert.rejects(action(), (e: unknown) => (e as { status: number }).status === 404);
  });
  const privateRows = (await db.query<{ resource_id: string; ciphertext: string }>("SELECT resource_id,ciphertext FROM knowledge_private WHERE user_id=$1", [a])).rows;
  assert.ok(privateRows.every((row) => !row.ciphertext.includes("Private document") && !row.ciphertext.includes("private-embedding-key")));
  await asA(async () => {
    assert.equal((await store.getKnowledgeSourcePrivate(created.id, source.id)).files[0].name, "internal.txt");
    const other = await store.createKnowledgeBase({ name: "Other" });
    await db.query("INSERT INTO knowledge_private(user_id,base_id,resource_id,ciphertext) VALUES($1,$2,'base',$3)", [a, other.id, privateRows.find((r) => r.resource_id === "base")!.ciphertext]);
    await assert.rejects(getKnowledgePrivate(other.id, "base"));
  });
});

test("extração, edição e remoção de fragmentos atualizam contagens sem cruzar conta/base", async () => {
  const { base: created, source } = await asA(prepared);
  const chunks = await asA(() => store.listKnowledgeChunks(created.id, source.id));
  assert.equal(chunks.length, 1);
  await assert.rejects(asB(() => store.editKnowledgeChunk(created.id, chunks[0].id, null)), /não existe/);
  await asA(async () => {
    await store.editKnowledgeChunk(created.id, chunks[0].id, { pageContent: "Frete grátis", metadata: {} });
    assert.equal((await store.getKnowledgeSource(created.id, source.id)).characters, 12);
    assert.equal((await store.getKnowledgeBase(created.id)).chunks, 1);
    const other = await store.createKnowledgeBase({ name: "Another" });
    await assert.rejects(store.getKnowledgeSource(other.id, source.id), /não existe/);
    await store.editKnowledgeChunk(created.id, chunks[0].id, null);
    assert.equal((await store.getKnowledgeBase(created.id)).chunks, 0);
  });
});

test("travas impedem alterações concorrentes e tokens expirados; leitura recupera operação abandonada", async () => {
  const { base: created, source } = await asA(prepared);
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const loaded = new Promise<void>((resolve) => { ready = resolve; });
  const active = asA(() => store.withKnowledgeLock(created.id, async (token) => {
    const stored = await store.getKnowledgeSource(created.id, source.id); stored.status = "processing";
    await store.saveKnowledgeSourceRecord(stored); ready(); await gate;
    await assert.rejects(store.replaceKnowledgeChunks(created.id, source.id, [], token), /expirou/);
  }));
  await loaded;
  await assert.rejects(asA(() => store.updateKnowledgeBase(created.id, { name: "race" })), /andamento/);
  await db.query("UPDATE knowledge_locks SET expires_at=now()-interval '1 second' WHERE user_id=$1", [a]);
  const replacementToken = randomUUID();
  await db.query("UPDATE knowledge_locks SET token=$2,expires_at=now()+interval '1 minute' WHERE user_id=$1", [a, replacementToken]);
  release(); await active;
  assert.equal((await db.query("SELECT token FROM knowledge_locks WHERE user_id=$1", [a])).rows[0].token, replacementToken, "finalizar operação antiga não remove a trava nova");
  await db.query("DELETE FROM knowledge_locks WHERE user_id=$1", [a]);
  await asA(async () => { await store.getKnowledgeBase(created.id); assert.equal((await store.getKnowledgeSource(created.id, source.id)).status, "failed"); });
});

test("indexação e consulta remota, ferramentas do agente e limpeza preservam namespaces A/B", async () => {
  const one = await asA(prepared), two = await asB(prepared);
  await asA(() => index.indexKnowledge(one.base.id)); await asB(() => index.indexKnowledge(two.base.id));
  assert.equal(collections.size, 2);
  await asA(async () => {
    const hits = await index.queryKnowledge(one.base.id, "reembolso");
    assert.equal(hits[0].sourceId, one.source.id);
    const tools = await agentKnowledge({ knowledgeBase: one.base.id }, new AbortController().signal);
    assert.match(await tools.tools[0].call({ consulta: "reembolso" }), /sete dias/);
    await assert.rejects(index.queryKnowledge(two.base.id, "reembolso"), /não existe/);
    await index.deleteKnowledgeBase(one.base.id);
  });
  assert.equal(collections.size, 1);
  assert.equal((await db.query("SELECT * FROM knowledge_private WHERE user_id=$1", [a])).rows.length, 0);
  await asB(async () => assert.equal((await index.queryKnowledge(two.base.id, "reembolso"))[0].sourceId, two.source.id));
});

test("reindexação preserva fragmentos retidos; falha externa não publica índice parcial nem perde limpeza", async () => {
  const { base: created, source } = await asA(prepared);
  await asA(async () => {
    await index.indexKnowledge(created.id);
    const config = (await store.getKnowledgeBase(created.id)).config;
    config.recordManager.cleanup = "none";
    await store.updateKnowledgeBase(created.id, { config });
    const [chunk] = await store.listKnowledgeChunks(created.id, source.id);
    await store.editKnowledgeChunk(created.id, chunk.id, { pageContent: "Política de frete", metadata: {} });
    failDelete = true;
    const result = await index.indexKnowledge(created.id);
    assert.equal(result.base.indexedChunks, 2, "versão anterior retida apesar da edição do mesmo chunk");
    assert.equal(result.run.reused, 1);
    assert.equal(embeddingCalls, 2, "fragmento retido não gera uma segunda cobrança de embedding");
    assert.equal(await index.cleanupPending(created.id), 1);
    failDelete = false;
    await store.withKnowledgeLock(created.id, () => index.cleanupKnowledge(created.id));
    assert.equal(await index.cleanupPending(created.id), 0);
    const published = (await db.query<{ generation: string }>("SELECT generation FROM knowledge_indexes WHERE user_id=$1 AND base_id=$2", [a, created.id])).rows[0].generation;
    await store.editKnowledgeChunk(created.id, chunk.id, { pageContent: "Nova regra diferente", metadata: {} });
    failures = true;
    await assert.rejects(index.indexKnowledge(created.id), (error: unknown) => !String(error).includes("private-upstream-secret"));
    assert.equal((await db.query("SELECT generation FROM knowledge_indexes WHERE user_id=$1 AND base_id=$2", [a, created.id])).rows[0].generation, published);
    assert.equal((await store.getKnowledgeBase(created.id)).status, "failed");
  });
});

test("remover fonte limpa vetores e segredos somente dessa fonte; base restante pode ser reindexada", async () => {
  const { base: created, source } = await asA(prepared);
  await asA(async () => {
    const second = await store.saveKnowledgeSource(created.id, sourceInput("Frete para todo o Brasil"));
    await index.processKnowledgeSource(created.id, second.id);
    await index.indexKnowledge(created.id);
    await index.removeKnowledgeSource(created.id, source.id);
    await assert.rejects(store.getKnowledgeSource(created.id, source.id), /não existe/);
    assert.equal((await store.getKnowledgeBase(created.id)).sources, 1);
    assert.equal((await store.listKnowledgeChunks(created.id)).length, 1);
    assert.equal((await db.query("SELECT 1 FROM knowledge_private WHERE user_id=$1 AND base_id=$2 AND resource_id=$3", [a, created.id, `source:${source.id}`])).rows.length, 0);
    const vectors = (await db.query<{ source: string }>("SELECT body#>>'{chunk,sourceId}' source FROM knowledge_vectors WHERE user_id=$1 AND base_id=$2", [a, created.id])).rows;
    assert.deepEqual(vectors.map((r) => r.source), [second.id]);
    await index.indexKnowledge(created.id);
    assert.equal((await index.queryKnowledge(created.id, "frete"))[0].sourceId, second.id);
  });
});

test("credenciais e vínculos em fluxos impedem exclusão enquanto usados por conhecimento", async () => {
  const credential = await asA(() => saveToolCredential({ name: "Embedding", provider: "embedding_openai", fields: { EMBEDDING_OPENAI_KEY: "secret", EMBEDDING_OPENAI_URL: `${url}/v1` } }));
  const created = await asA(() => store.createKnowledgeBase({ name: "Bound" }));
  const config = { ...structuredClone(DEFAULT_INDEX), embeddings: { provider: "openai" as const, model: "test", url: `${url}/v1`, credentialId: credential.id } };
  await asA(() => store.updateKnowledgeBase(created.id, { config }));
  await assert.rejects(asA(() => deleteToolCredential(credential.id)), /em uso/);
  const foreign = await asB(() => store.createKnowledgeBase({ name: "Other" }));
  await assert.rejects(asB(() => store.updateKnowledgeBase(foreign.id, { config })), /não existe/);
  const graph = template(); graph.nodes[1].data.config.knowledgeBase = created.id;
  const flow = await asA(() => createTenantFlow("Bound", false, { name: "Bound", description: "", graph }));
  await assert.rejects(asA(() => index.deleteKnowledgeBase(created.id)), /vinculada/);
  await asA(async () => { await deleteTenantFlow(flow.id); await index.deleteKnowledgeBase(created.id); deleteToolCredential(credential.id); });
});

test("fluxo exportado por uma conta entra em outra depois de portableGraph (sem credenciais, bases e subfluxos)", async () => {
  const credential = await asA(() => saveToolCredential({ name: "Replicate", provider: "ai_replicate", fields: { REPLICATE_API_TOKEN: "secret" } }));
  const base = await asA(() => store.createKnowledgeBase({ name: "Base da conta A" }));
  const graph = template();
  const agent = graph.nodes[1].data.config;
  agent.tools = "interno:replicate";
  agent.toolCards = JSON.stringify([{ id: "c1", kind: "tool", target: "interno:replicate", credentialId: credential.id, params: { model: "google/nano-banana" } }]);
  agent.knowledgeBases = JSON.stringify([{ baseId: base.id, description: "Consultar sobre a conta A", references: false }]);
  const saved = { name: "Compartilhado", description: "", graph };
  const original = await asA(() => createTenantFlow("Compartilhado", false, saved));
  // O arquivo bruto (com os ids da conta A) é recusado na conta B: foi o erro visto na importação.
  await assert.rejects(asB(() => createTenantFlow("Compartilhado", false, saved)), /não encontrada nesta conta/);
  // O arquivo genérico entra; a conta B escolhe depois as próprias credenciais e bases.
  const imported = await asB(() => createTenantFlow("Compartilhado", false, { ...saved, graph: portableGraph(graph) }));
  const config = imported.graph.nodes[1].data.config;
  assert.equal(config.tools, "interno:replicate");
  assert.equal(JSON.parse(config.toolCards)[0].credentialId, undefined);
  assert.equal(JSON.parse(config.toolCards)[0].params.model, "google/nano-banana");
  assert.equal(config.knowledgeBases, undefined);
  await asB(() => deleteTenantFlow(imported.id));
  await asA(async () => { await deleteTenantFlow(original.id); await index.deleteKnowledgeBase(base.id); await deleteToolCredential(credential.id); });
});
