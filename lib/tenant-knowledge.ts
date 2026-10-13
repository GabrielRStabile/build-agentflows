import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { currentTenant } from "./tenant-context";
import type { Sql } from "./saas-db";
import { seal, unseal } from "./saas-security";
import { FlowError } from "./flow-store";
import { DEFAULT_INDEX, type KnowledgeBase, type KnowledgeSource, type Chunk, type IndexConfig, type IndexRun } from "./knowledge-types";
import type { Graph } from "./flow-types";
import type { SourceFile } from "./knowledge-loaders";
import { knowledgeTitle, normalizeKnowledgeSource, type SourceInput } from "./knowledge-source-input";
import { validatedIndexConfig } from "./knowledge-config";
import { indexingConfigIdentity } from "./knowledge-retrieval";
import { resolveEmbeddingCredential } from "./tool-credential-store";
import { postgresConnectionString } from "./knowledge-postgres";
import { knowledgeBaseIds } from "./knowledge-settings";
import { assertJobLease, currentJobLease } from "./saas-job-context";
import { planLimits } from "./saas-plan";

const now = () => new Date().toISOString();
const leases = new AsyncLocalStorage<{ owner: string; baseId: string; token: string; active: boolean }>();
const missing = () => new FlowError("Esta base de conhecimento não existe mais.", 404);

async function readBase(sql: Sql, owner: string, id: string, lock = false): Promise<KnowledgeBase> {
  const { rows } = await sql.query<{ body: KnowledgeBase }>(`SELECT body FROM knowledge_bases WHERE user_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [owner, id]);
  if (!rows[0]) throw missing();
  return rows[0].body;
}
async function storeBase(sql: Sql, owner: string, base: KnowledgeBase) {
  await sql.query("UPDATE knowledge_bases SET body=$3,revision=revision+1 WHERE user_id=$1 AND id=$2", [owner, base.id, JSON.stringify(base)]);
}
async function checkLock(sql: Sql, owner: string, baseId: string, token?: string) {
  const { rows } = await sql.query<{ token: string }>("SELECT token FROM knowledge_locks WHERE user_id=$1 AND base_id=$2 AND expires_at>now()", [owner, baseId]);
  if (token ? rows[0]?.token !== token : !!rows.length) throw new FlowError("Há uma operação em andamento ou a autorização da operação expirou. Atualize a base antes de tentar novamente.", 409);
}
/** All writers lock owner then base; a lease fences delayed indexing/extraction writes. */
export async function mutateKnowledge<T>(baseId: string, action: (sql: Sql, owner: string, base: KnowledgeBase) => Promise<T>, token?: string) {
  const { db, user } = currentTenant();
  const lease = leases.getStore();
  if (lease?.owner === user.id && lease.baseId === baseId) {
    if (!lease.active) throw new FlowError("Operação de conhecimento encerrada.", 409);
    token ??= lease.token;
  }
  return db.transaction(async (sql) => {
    await assertJobLease(sql, user.id);
    await sql.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
    const base = await readBase(sql, user.id, baseId, true);
    await checkLock(sql, user.id, baseId, token);
    return action(sql, user.id, base);
  });
}
export async function withKnowledgeLock<T>(baseId: string, action: (token: string) => Promise<T>) {
  const { db, user } = currentTenant();
  const inherited = leases.getStore();
  if (inherited?.owner === user.id && inherited.baseId === baseId && inherited.active) {
    await mutateKnowledge(baseId, async () => {});
    return action(inherited.token);
  }
  const token = randomUUID();
  const job = currentJobLease();
  await mutateKnowledge(baseId, async (sql, owner, base) => {
    await recoverAbandoned(sql, owner, base);
    await sql.query(`INSERT INTO knowledge_locks(user_id,base_id,token,expires_at,job_id,job_token) VALUES($1,$2,$3,now()+interval '15 minutes',$4,$5)
      ON CONFLICT(user_id,base_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at,job_id=excluded.job_id,job_token=excluded.job_token`, [owner, baseId, token, job?.id || null, job?.token || null]);
  });
  const lease = { owner: user.id, baseId, token, active: true };
  try { return await leases.run(lease, () => action(token)); }
  finally {
    lease.active = false;
    await db.query("DELETE FROM knowledge_locks WHERE user_id=$1 AND base_id=$2 AND token=$3", [user.id, baseId, token]);
  }
}
export async function getKnowledgeBase(id: string) {
  const { db, user } = currentTenant();
  const base = await readBase(db, user.id, id);
  const active = await db.query("SELECT 1 FROM knowledge_locks WHERE user_id=$1 AND base_id=$2 AND expires_at>now()", [user.id, id]);
  if (active.rows.length) return base;
  if (base.status !== "indexing" && !(await db.query("SELECT 1 FROM knowledge_sources WHERE user_id=$1 AND base_id=$2 AND body->>'status'='processing' LIMIT 1", [user.id, id])).rows.length) return base;
  // Recheck under the same locks as the acquisition: reading cannot fail a newly started job.
  return db.transaction(async (sql) => {
    await sql.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
    const latest = await readBase(sql, user.id, id, true);
    if (!(await sql.query("SELECT 1 FROM knowledge_locks WHERE user_id=$1 AND base_id=$2 AND expires_at>now()", [user.id, id])).rows.length) await recoverAbandoned(sql, user.id, latest);
    return latest;
  });
}
async function recoverAbandoned(sql: Sql, owner: string, base: KnowledgeBase) {
  const error = "A operação foi interrompida. Tente novamente para continuar.";
  if (base.status === "indexing") { base.status = "failed"; base.error = error; await storeBase(sql, owner, base); }
  await sql.query("UPDATE knowledge_runs SET body=body || $3::jsonb WHERE user_id=$1 AND base_id=$2 AND body->>'status'='running'", [owner, base.id, JSON.stringify({ status: "failed", error, finishedAt: now() })]);
  await sql.query("UPDATE knowledge_sources SET body=body || $3::jsonb WHERE user_id=$1 AND base_id=$2 AND body->>'status'='processing'", [owner, base.id, JSON.stringify({ status: "failed", error, updatedAt: now() })]);
}
export async function listKnowledgeBases() {
  const { db, user } = currentTenant();
  const { rows } = await db.query<{ body: KnowledgeBase }>("SELECT body FROM knowledge_bases WHERE user_id=$1 ORDER BY body->>'updatedAt' DESC,id LIMIT 100", [user.id]);
  return rows.map((row) => row.body);
}
export async function createKnowledgeBase(input: { name?: unknown; description?: unknown }) {
  const { db, user } = currentTenant();
  const base: KnowledgeBase = { id: randomUUID(), name: knowledgeTitle(input.name, "O nome"), description: typeof input.description === "string" ? input.description.slice(0, 2000) : "",
    status: "empty", revision: 0, sources: 0, chunks: 0, indexedChunks: 0, config: structuredClone(DEFAULT_INDEX), updatedAt: now() };
  await db.transaction(async (sql) => {
    await sql.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
    if ((await sql.query<{ n: number }>("SELECT count(*)::int n FROM knowledge_bases WHERE user_id=$1", [user.id])).rows[0].n >= 100) throw new FlowError("Use até 100 bases por conta.", 413);
    await sql.query("INSERT INTO knowledge_bases(user_id,id,body) VALUES($1,$2,$3)", [user.id, base.id, JSON.stringify(base)]);
  });
  return base;
}
async function privateRecord(sql: Sql, owner: string, baseId: string, resourceId: string): Promise<Record<string, string>> {
  const { rows } = await sql.query<{ ciphertext: string }>("SELECT ciphertext FROM knowledge_private WHERE user_id=$1 AND base_id=$2 AND resource_id=$3", [owner, baseId, resourceId]);
  return rows[0] ? JSON.parse(unseal(rows[0].ciphertext, `knowledge:${owner}:${baseId}:${resourceId}`)) : {};
}
export async function putKnowledgePrivate(sql: Sql, owner: string, baseId: string, resourceId: string, value: Record<string, string>) {
  const ciphertext = seal(JSON.stringify(value), `knowledge:${owner}:${baseId}:${resourceId}`);
  // 20 MB of files become about 36 MB once encoded and sealed.
  if (Buffer.byteLength(ciphertext) > 40 * 1024 * 1024) throw new FlowError("Os dados da fonte excedem o limite permitido.", 413);
  await sql.query(`INSERT INTO knowledge_private(user_id,base_id,resource_id,ciphertext) VALUES($1,$2,$3,$4)
    ON CONFLICT(user_id,base_id,resource_id) DO UPDATE SET ciphertext=excluded.ciphertext`, [owner, baseId, resourceId, ciphertext]);
  const quota = await sql.query<{ bytes: number }>("SELECT coalesce(sum(octet_length(ciphertext)),0)::bigint bytes FROM knowledge_private WHERE user_id=$1", [owner]);
  if (Number(quota.rows[0].bytes) > 200 * 1024 * 1024) throw new FlowError("O espaço privado das fontes atingiu 200 MB. Exclua fontes antigas para liberar espaço.", 413);
}
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
/** Bytes of files uploaded to the owner's knowledge sources. Older sources are measured once and recorded. */
export async function knowledgeFileBytes(sql: Sql, owner: string, exceptSourceId?: string) {
  const { rows } = await sql.query<{ id: string; base_id: string; body: KnowledgeSource }>("SELECT id,base_id,body FROM knowledge_sources WHERE user_id=$1", [owner]);
  let total = 0;
  for (const { id, base_id, body } of rows) {
    if (id === exceptSourceId) continue;
    let bytes = body.fileBytes;
    if (typeof bytes !== "number") {
      bytes = body.fileNames?.length ? JSON.parse((await privateRecord(sql, owner, base_id, `source:${id}`)).files || "[]").reduce((n: number, f: SourceFile) => n + Buffer.byteLength(f.data, "base64"), 0) : 0;
      await sql.query("UPDATE knowledge_sources SET body=jsonb_set(body,'{fileBytes}',to_jsonb($4::bigint)) WHERE user_id=$1 AND base_id=$2 AND id=$3", [owner, base_id, id, bytes]);
    }
    total += bytes as number;
  }
  return total;
}
export async function getKnowledgePrivate(baseId: string, resourceId: string) {
  const { db, user } = currentTenant();
  await readBase(db, user.id, baseId);
  return privateRecord(db, user.id, baseId, resourceId);
}
async function credentialReferences(sql: Sql, owner: string, config: IndexConfig) {
  for (const id of [config.embeddings.credentialId, config.vectorStore.postgres?.credentialId, config.recordManager.postgres?.credentialId]) {
    if (id && !(await sql.query("SELECT 1 FROM credentials WHERE user_id=$1 AND key=$2", [owner, `TOOL_ACCOUNT_${id}`])).rows.length)
      throw new FlowError("Credencial não encontrada nesta conta.", 404);
  }
}
export async function updateKnowledgeBase(id: string, input: { name?: unknown; description?: unknown; config?: IndexConfig }) {
  return mutateKnowledge(id, async (sql, owner, base) => {
    if (input.name !== undefined) base.name = knowledgeTitle(input.name, "O nome");
    if (input.description !== undefined) {
      if (typeof input.description !== "string" || input.description.length > 2000) throw new FlowError("Use uma descrição de até 2.000 caracteres.");
      base.description = input.description;
    }
    if (input.config !== undefined) {
      const previous = indexingConfigIdentity(base.config);
      const result = validatedIndexConfig(input.config, base.config, await privateRecord(sql, owner, id, "base"));
      await credentialReferences(sql, owner, result.config);
      await putKnowledgePrivate(sql, owner, id, "base", result.secrets);
      base.config = result.config;
      if (previous !== indexingConfigIdentity(base.config) || input.config.embeddings.apiKey?.trim() || input.config.vectorStore.apiKey?.trim() || input.config.vectorStore.connectionString?.trim() || input.config.recordManager.connectionString?.trim()) {
        base.revision++; base.status = base.chunks ? "dirty" : "empty";
      }
    }
    base.updatedAt = now();
    await storeBase(sql, owner, base);
    return base;
  });
}
export async function indexKnowledgeConfig(id: string): Promise<IndexConfig> {
  const base = await getKnowledgeBase(id), secrets = await getKnowledgePrivate(id, "base");
  const saved = base.config.embeddings.credentialId ? resolveEmbeddingCredential(base.config.embeddings.credentialId, base.config.embeddings.provider) : undefined;
  if (saved && saved.url !== base.config.embeddings.url) throw new FlowError("O endereço da credencial foi alterado. Selecione a conexão novamente, salve e reindexe a base.");
  return { ...base.config,
    embeddings: { ...base.config.embeddings, apiKey: saved?.apiKey || secrets.embeddingKey },
    vectorStore: { ...base.config.vectorStore, apiKey: secrets.vectorKey, connectionString: base.config.vectorStore.postgres ? postgresConnectionString(base.config.vectorStore.postgres) : secrets.vectorConnection },
    recordManager: { ...base.config.recordManager, connectionString: base.config.recordManager.postgres ? postgresConnectionString(base.config.recordManager.postgres) : secrets.recordConnection } };
}
async function readSource(sql: Sql, owner: string, baseId: string, id: string): Promise<KnowledgeSource> {
  const { rows } = await sql.query<{ body: KnowledgeSource }>("SELECT body FROM knowledge_sources WHERE user_id=$1 AND base_id=$2 AND id=$3", [owner, baseId, id]);
  if (!rows[0]) throw new FlowError("Esta fonte não existe nesta base.", 404);
  return rows[0].body;
}
async function storeSource(sql: Sql, owner: string, source: KnowledgeSource) {
  await sql.query(`INSERT INTO knowledge_sources(user_id,base_id,id,body) VALUES($1,$2,$3,$4)
    ON CONFLICT(user_id,base_id,id) DO UPDATE SET body=excluded.body`, [owner, source.baseId, source.id, JSON.stringify(source)]);
}
async function touch(sql: Sql, owner: string, base: KnowledgeBase) {
  const counts = await sql.query<{ sources: number; chunks: number }>("SELECT count(*)::int sources,coalesce(sum((body->>'chunks')::int),0)::int chunks FROM knowledge_sources WHERE user_id=$1 AND base_id=$2", [owner, base.id]);
  Object.assign(base, counts.rows[0]); base.revision++; base.updatedAt = now(); delete base.error;
  base.status = base.chunks ? "dirty" : "empty";
  await storeBase(sql, owner, base);
}
export async function listKnowledgeSources(baseId: string) {
  const { db, user } = currentTenant(); await readBase(db, user.id, baseId);
  return (await db.query<{ body: KnowledgeSource }>("SELECT body FROM knowledge_sources WHERE user_id=$1 AND base_id=$2 ORDER BY body->>'updatedAt',id LIMIT 100", [user.id, baseId])).rows.map((r) => r.body);
}
export async function getKnowledgeSource(baseId: string, id: string) {
  const { db, user } = currentTenant(); return readSource(db, user.id, baseId, id);
}
export async function getKnowledgeSourcePrivate(baseId: string, id: string) {
  const source = await getKnowledgeSource(baseId, id), secrets = await getKnowledgePrivate(baseId, `source:${id}`);
  return { source, config: { ...source.config, ...JSON.parse(secrets.config || "{}") } as Record<string, string>, files: JSON.parse(secrets.files || "[]") as SourceFile[] };
}
export async function saveKnowledgeSource(baseId: string, input: SourceInput, files?: SourceFile[], id?: string) {
  return mutateKnowledge(baseId, async (sql, owner, base) => {
    const previous = id ? await readSource(sql, owner, baseId, id) : undefined;
    if (!previous && (await sql.query<{ n: number }>("SELECT count(*)::int n FROM knowledge_sources WHERE user_id=$1 AND base_id=$2", [owner, baseId])).rows[0].n >= 100) throw new FlowError("Use até 100 fontes por base.", 413);
    const result = normalizeKnowledgeSource(baseId, input, files, previous, previous ? await privateRecord(sql, owner, baseId, `source:${previous.id}`) : {});
    // The owner row is locked by mutateKnowledge, so concurrent uploads cannot exceed the quota.
    const limit = planLimits().storageMb * 1024 * 1024;
    const others = await knowledgeFileBytes(sql, owner, result.source.id);
    if (others + (result.source.fileBytes || 0) > limit)
      throw new FlowError(`Suas bases de conhecimento podem armazenar até ${planLimits().storageMb} MB em arquivos. Você já usa ${megabytes(others)} e este envio tem ${megabytes(result.source.fileBytes || 0)}. Exclua fontes antigas para liberar espaço.`, 413);
    await storeSource(sql, owner, result.source);
    await putKnowledgePrivate(sql, owner, baseId, `source:${result.source.id}`, result.secrets);
    await touch(sql, owner, base);
    return result.source;
  });
}
export async function saveKnowledgeSourceRecord(source: KnowledgeSource) {
  await mutateKnowledge(source.baseId, async (sql, owner) => { await readSource(sql, owner, source.baseId, source.id); await storeSource(sql, owner, source); });
}
export async function listKnowledgeChunks(baseId: string, sourceId?: string): Promise<Chunk[]> {
  const { db, user } = currentTenant(); await readBase(db, user.id, baseId);
  if (sourceId) await readSource(db, user.id, baseId, sourceId);
  return (await db.query<{ body: Chunk }>(`SELECT body FROM knowledge_chunks WHERE user_id=$1 AND base_id=$2${sourceId ? " AND source_id=$3" : ""} ORDER BY source_id,(body->>'ordinal')::int,id LIMIT 10000`, [user.id, baseId, ...(sourceId ? [sourceId] : [])])).rows.map((r) => r.body);
}
export async function replaceKnowledgeChunks(baseId: string, sourceId: string, chunks: Chunk[], token: string) {
  return mutateKnowledge(baseId, async (sql, owner, base) => {
    const source = await readSource(sql, owner, baseId, sourceId);
    const count = (await sql.query<{ n: number }>("SELECT count(*)::int n FROM knowledge_chunks WHERE user_id=$1 AND base_id=$2 AND source_id<>$3", [owner, baseId, sourceId])).rows[0].n;
    if (count + chunks.length > 10000) throw new FlowError("Esta base aceita até 10.000 fragmentos. Divida o conteúdo em mais bases.");
    if (chunks.some((chunk) => chunk.sourceId !== sourceId)) throw new FlowError("Fragmento pertence a outra fonte.");
    await sql.query("DELETE FROM knowledge_chunks WHERE user_id=$1 AND base_id=$2 AND source_id=$3", [owner, baseId, sourceId]);
    await sql.query(`INSERT INTO knowledge_chunks(user_id,base_id,source_id,id,body)
      SELECT $1,$2,$3,chunk->>'id',chunk FROM jsonb_array_elements($4::jsonb) chunk`, [owner, baseId, sourceId, JSON.stringify(chunks)]);
    source.status = "processed"; delete source.error; source.chunks = chunks.length;
    source.characters = chunks.reduce((sum, c) => sum + c.pageContent.length, 0); source.updatedAt = now();
    await storeSource(sql, owner, source); await touch(sql, owner, base); return source;
  }, token);
}
export async function editKnowledgeChunk(baseId: string, id: string, input: { pageContent: string; metadata: Record<string, unknown> } | null) {
  await mutateKnowledge(baseId, async (sql, owner, base) => {
    const { rows } = await sql.query<{ body: Chunk }>("SELECT body FROM knowledge_chunks WHERE user_id=$1 AND base_id=$2 AND id=$3", [owner, baseId, id]);
    const chunk = rows[0]?.body; if (!chunk) throw new FlowError("Fragmento não encontrado.", 404);
    if (input) {
      if (typeof input.pageContent !== "string" || !input.pageContent.trim() || input.pageContent.length > 8000 || !input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata) || JSON.stringify(input.metadata).length > 10000) throw new FlowError("Use texto de até 8.000 caracteres e metadados JSON de até 10 KB.");
      await sql.query("UPDATE knowledge_chunks SET body=$4 WHERE user_id=$1 AND base_id=$2 AND id=$3", [owner, baseId, id, JSON.stringify({ ...chunk, ...input })]);
    } else await sql.query("DELETE FROM knowledge_chunks WHERE user_id=$1 AND base_id=$2 AND id=$3", [owner, baseId, id]);
    const source = await readSource(sql, owner, baseId, chunk.sourceId);
    const counts = (await sql.query<{ chunks: number; characters: number }>("SELECT count(*)::int chunks,coalesce(sum(length(body->>'pageContent')),0)::int characters FROM knowledge_chunks WHERE user_id=$1 AND base_id=$2 AND source_id=$3", [owner, baseId, source.id])).rows[0];
    Object.assign(source, counts, { updatedAt: now() });
    await storeSource(sql, owner, source); await touch(sql, owner, base);
  });
}
export async function knowledgeBaseUsages(id: string, sql?: Sql) {
  const { db, user } = currentTenant(); sql ??= db;
  await readBase(sql, user.id, id);
  const { rows } = await sql.query<{ id: string; name: string; graph: Graph; published: Graph | null }>(`SELECT id,body->>'name' name,body->'graph' graph,body->'published' published FROM flows WHERE user_id=$1
    UNION ALL SELECT flow_id id,body->>'name' name,body->'graph' graph,NULL published FROM runs WHERE user_id=$1 AND status IN ('running','waiting')`, [user.id]);
  return rows.filter((r) => [r.graph, r.published].some((g) => g?.nodes.some((n) => ["agent", "llm"].includes(n.data.kind) && knowledgeBaseIds(n.data.config).includes(id)))).map(({ id, name }) => ({ id, name }));
}
export async function deleteKnowledgeSource(baseId: string, id: string, token?: string) {
  await mutateKnowledge(baseId, async (sql, owner, base) => {
    await readSource(sql, owner, baseId, id);
    await sql.query("DELETE FROM knowledge_sources WHERE user_id=$1 AND base_id=$2 AND id=$3", [owner, baseId, id]);
    await sql.query("DELETE FROM knowledge_vectors WHERE user_id=$1 AND base_id=$2 AND body#>>'{chunk,sourceId}'=$3", [owner, baseId, id]);
    await sql.query("DELETE FROM knowledge_private WHERE user_id=$1 AND base_id=$2 AND resource_id=$3", [owner, baseId, `source:${id}`]);
    await touch(sql, owner, base);
  }, token);
}
export async function deleteKnowledgeBaseRecords(id: string, token: string) {
  await mutateKnowledge(id, async (sql, owner) => {
    if ((await knowledgeBaseUsages(id, sql)).length) throw new FlowError("Esta base está vinculada a um fluxo ou execução ativa. Remova o vínculo antes de excluir.", 409);
    if ((await sql.query("SELECT 1 FROM knowledge_cleanup WHERE user_id=$1 AND base_id=$2 LIMIT 1", [owner, id])).rows.length) throw new FlowError("Conclua a limpeza dos índices antes de excluir.", 409);
    await sql.query("DELETE FROM knowledge_bases WHERE user_id=$1 AND id=$2", [owner, id]);
  }, token);
}
export async function saveKnowledgeBaseRecord(base: KnowledgeBase) { await mutateKnowledge(base.id, (sql, owner) => storeBase(sql, owner, base)); }
export async function saveKnowledgeRun(run: IndexRun) {
  await mutateKnowledge(run.baseId, async (sql, owner) => {
    await sql.query("INSERT INTO knowledge_runs(user_id,base_id,id,body) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,base_id,id) DO UPDATE SET body=excluded.body", [owner, run.baseId, run.id, JSON.stringify(run)]);
  });
}
export async function listKnowledgeRuns(baseId: string) {
  const { db, user } = currentTenant(); await readBase(db, user.id, baseId);
  return (await db.query<{ body: IndexRun }>("SELECT body FROM knowledge_runs WHERE user_id=$1 AND base_id=$2 ORDER BY body->>'startedAt' DESC,id LIMIT 20", [user.id, baseId])).rows.map((r) => r.body);
}
