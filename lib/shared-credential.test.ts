import nodeTest from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTenantTestContext } from "../scripts/tenant-test-context";
import { hashToken } from "./saas-security";

const testTenant = await createTenantTestContext();
nodeTest.after(testTenant.close);
process.env.OPENAI_CHAVE_COMPARTILHADA = "sk-compartilhada-ambiente";
delete process.env.OPENAI_CHAVE_COMPARTILHADA_NOME; delete process.env.OPENAI_CHAVE_COMPARTILHADA_HORAS;
const { listToolCredentials, getToolCredential, saveToolCredential, deleteToolCredential, withToolCredential, resolveEmbeddingCredential } = await import("./tool-credential-store");
const { modelCredentialKey } = await import("./ai-credentials");
const { SHARED_OPENAI_ID, SHARED_OPENAI_EMBEDDING_ID, sharedOpenAiSettings } = await import("./shared-credential");
const { createKnowledgeBase, updateKnowledgeBase, indexKnowledgeConfig, defaultIndexConfig } = await import("./tenant-knowledge");
const { DEFAULT_INDEX } = await import("./knowledge-types");
const { toolConfig } = await import("./tool-config-context");
const { GET } = await import("../app/api/tool-credentials/route");
const { PUT, DELETE } = await import("../app/api/tool-credentials/[id]/route");

const inviteId = randomUUID();
await testTenant.db.query("INSERT INTO invites(id,code_hash,max_uses,uses) VALUES ($1,$2,1,1)", [inviteId, hashToken("turma-outubro")]);
const redeemedAt = (hoursAgo: number) => testTenant.db.query("UPDATE invite_redemptions SET redeemed_at=now()-$2*interval '1 hour' WHERE user_id=$1", [testTenant.owner, hoursAgo]);

nodeTest("conta liberada sem convite não vê a credencial compartilhada", async () => {
  await testTenant.asTenant(() => {
    assert.equal(listToolCredentials().some(c => c.id === SHARED_OPENAI_ID), false);
    assert.throws(() => modelCredentialKey("openai", SHARED_OPENAI_ID), /apenas a contas que entraram por convite/);
  });
});

nodeTest("conta convidada vê a credencial (free tier) por 72 horas e o motor usa a chave do ambiente", async () => {
  await testTenant.db.query("INSERT INTO invite_redemptions(user_id,invite_id) VALUES ($1,$2)", [testTenant.owner, inviteId]);
  await redeemedAt(1);
  await testTenant.asTenant(async () => {
    const [first] = listToolCredentials();
    assert.equal(first.id, SHARED_OPENAI_ID);
    assert.equal(first.name, "StartSe OpenAI API (free tier)");
    assert.equal(first.provider, "ai_openai");
    assert.equal(first.readOnly, true);
    assert.ok(first.expiresAt);
    const remaining = new Date(first.expiresAt!).getTime() - Date.now();
    assert.ok(remaining > 70 * 3_600_000 && remaining < 72 * 3_600_000, `restam ${remaining} ms`);
    assert.equal(first.fields[0].valor, undefined);
    assert.ok(!JSON.stringify(listToolCredentials()).includes("sk-compartilhada"));
    assert.equal(listToolCredentials("ai_openai")[0].id, SHARED_OPENAI_ID);
    assert.equal(listToolCredentials("ai_anthropic").some(c => c.id === SHARED_OPENAI_ID), false);
    assert.equal(getToolCredential(SHARED_OPENAI_ID).name, first.name);
    assert.equal(modelCredentialKey("openai", SHARED_OPENAI_ID), "sk-compartilhada-ambiente");
    assert.throws(() => modelCredentialKey("anthropic", SHARED_OPENAI_ID), /não pertence ao fornecedor/);
    assert.equal(withToolCredential(SHARED_OPENAI_ID, "ai_openai", () => toolConfig("OPENAI_API_KEY")), "sk-compartilhada-ambiente");
  });
  const listed = await testTenant.connect(() => GET(testTenant.request("/api/tool-credentials?provider=ai_openai")));
  const body = await listed.json() as { id: string; expiresAt?: string }[];
  assert.equal(body[0].id, SHARED_OPENAI_ID);
  assert.ok(!JSON.stringify(body).includes("sk-compartilhada"));
});

nodeTest("a mesma chave vale para embeddings OpenAI e é o padrão da base de conhecimento nova", async () => {
  await testTenant.asTenant(async () => {
    const [embedding] = listToolCredentials("embedding_openai");
    assert.equal(embedding.id, SHARED_OPENAI_EMBEDDING_ID);
    assert.equal(embedding.name, "StartSe OpenAI API (free tier)");
    assert.equal(embedding.readOnly, true);
    assert.equal(embedding.fields.find(f => f.chave === "EMBEDDING_OPENAI_URL")?.valor, "https://api.openai.com/v1");
    assert.equal(listToolCredentials("embedding_gemini").some(c => c.readOnly), false);
    assert.deepEqual(listToolCredentials().filter(c => c.readOnly).map(c => c.id), [SHARED_OPENAI_ID, SHARED_OPENAI_EMBEDDING_ID]);
    assert.deepEqual(resolveEmbeddingCredential(SHARED_OPENAI_EMBEDDING_ID, "openai"), { apiKey: "sk-compartilhada-ambiente", url: "https://api.openai.com/v1" });
    assert.throws(() => resolveEmbeddingCredential(SHARED_OPENAI_EMBEDDING_ID, "gemini"), /não pertence/);
    assert.throws(() => resolveEmbeddingCredential(SHARED_OPENAI_ID, "openai"), /não pertence/);
    // Fluxo básico: embeddings OpenAI com a credencial compartilhada, Faiss e registro interno.
    const base = await createKnowledgeBase({ name: "Base padrão" });
    assert.equal(base.config.embeddings.credentialId, SHARED_OPENAI_EMBEDDING_ID);
    assert.equal(base.config.embeddings.configured, true);
    assert.equal(base.config.embeddings.model, DEFAULT_INDEX.embeddings.model);
    assert.equal(base.config.vectorStore.provider, "faiss");
    assert.equal(base.config.recordManager.provider, "internal");
    // Salvar a configuração padrão passa pela validação sem linha em credentials, e a indexação recebe a chave do ambiente.
    const saved = await updateKnowledgeBase(base.id, { config: base.config });
    assert.equal(saved.config.embeddings.credentialId, SHARED_OPENAI_EMBEDDING_ID);
    assert.equal((await indexKnowledgeConfig(base.id)).embeddings.apiKey, "sk-compartilhada-ambiente");
    assert.ok(!JSON.stringify(saved).includes("sk-compartilhada"));
  });
});

nodeTest("a credencial compartilhada não pode ser editada nem excluída", async () => {
  await testTenant.asTenant(async () => {
    assert.throws(() => saveToolCredential({ name: "Minha", fields: { OPENAI_API_KEY: "x" } }, SHARED_OPENAI_ID), /oferecida pelo ambiente/);
    assert.throws(() => deleteToolCredential(SHARED_OPENAI_ID), /oferecida pelo ambiente/);
    // A conta continua podendo cadastrar uma credencial própria com o mesmo serviço.
    const own = saveToolCredential({ name: "Minha OpenAI", provider: "ai_openai", fields: { OPENAI_API_KEY: "sk-propria" } });
    assert.deepEqual(listToolCredentials("ai_openai").map(c => c.id), [SHARED_OPENAI_ID, own.id]);
    assert.equal(modelCredentialKey("openai", own.id), "sk-propria");
  });
  const context = { params: Promise.resolve({ id: SHARED_OPENAI_ID }) };
  assert.equal((await testTenant.connect(() => PUT(testTenant.request(`/api/tool-credentials/${SHARED_OPENAI_ID}`, { method: "PUT", body: JSON.stringify({ name: "Minha", fields: {} }) }), context))).status, 403);
  assert.equal((await testTenant.connect(() => DELETE(testTenant.request(`/api/tool-credentials/${SHARED_OPENAI_ID}`, { method: "DELETE" }), context))).status, 403);
});

nodeTest("depois do prazo a credencial some da lista e as execuções recusam com a data", async () => {
  await redeemedAt(73);
  await testTenant.asTenant(() => {
    assert.equal(listToolCredentials().some(c => c.id === SHARED_OPENAI_ID), false);
    assert.throws(() => getToolCredential(SHARED_OPENAI_ID), /não está mais disponível/);
    assert.throws(() => modelCredentialKey("openai", SHARED_OPENAI_ID), /período gratuito .* terminou em \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}/);
    assert.equal(defaultIndexConfig().embeddings.credentialId, undefined);
    assert.throws(() => resolveEmbeddingCredential(SHARED_OPENAI_EMBEDDING_ID, "openai"), /período gratuito/);
  });
  process.env.OPENAI_CHAVE_COMPARTILHADA_HORAS = "96";
  await testTenant.asTenant(() => { assert.equal(modelCredentialKey("openai", SHARED_OPENAI_ID), "sk-compartilhada-ambiente"); });
  delete process.env.OPENAI_CHAVE_COMPARTILHADA_HORAS;
});

nodeTest("sem a variável no ambiente nada é oferecido e os blocos que a escolheram explicam o motivo", async () => {
  await redeemedAt(1);
  const key = process.env.OPENAI_CHAVE_COMPARTILHADA;
  delete process.env.OPENAI_CHAVE_COMPARTILHADA;
  try {
    assert.equal(sharedOpenAiSettings(), null);
    await testTenant.asTenant(() => {
      assert.equal(listToolCredentials().some(c => c.id === SHARED_OPENAI_ID), false);
      assert.throws(() => modelCredentialKey("openai", SHARED_OPENAI_ID), /não está mais disponível/);
    });
  } finally { process.env.OPENAI_CHAVE_COMPARTILHADA = key; }
  assert.deepEqual(sharedOpenAiSettings({ OPENAI_CHAVE_COMPARTILHADA: " sk ", OPENAI_CHAVE_COMPARTILHADA_NOME: "Turma 12", OPENAI_CHAVE_COMPARTILHADA_HORAS: "0" }), { key: "sk", name: "Turma 12 (free tier)", hours: 72 });
});
