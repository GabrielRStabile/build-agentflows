import { aiProvider, modelProviderId } from "./ai-providers";
import { embeddingCredentialProvider, embeddingCredentialKey, embeddingCredentialUrl } from "./embedding-credentials";
import { knowledgeUrl } from "./knowledge-http";
import type { IndexConfig } from "./knowledge-types";
import { randomUUID } from "node:crypto";
import { getConfig, setConfig, configTransaction } from "./store";
import { currentTenant } from "./tenant-context";
import { FlowError } from "./flow-store";
import { TOOL_CREDENTIALS, TOOL_CREDENTIAL_LABELS, type Credential } from "./tool-credentials";
import { withToolConfig } from "./tool-config-context";
import { readToolCards } from "./agent-tools";
import { isSharedCredentialId, resolveSharedCredential, sharedCredentialEntry, sharedCredentialName, sharedOpenAiCredential, SHARED_CREDENTIALS } from "./shared-credential";

export type SavedToolCredential = {
  id: string; name: string; provider: string; providerLabel: string;
  configured: boolean; fields: Credential[];
  /** Credencial oferecida pelo ambiente: não pode ser editada nem excluída pela conta. */
  readOnly?: boolean;
  /** Instante (ISO) em que a credencial compartilhada deixa de valer para esta conta. */
  expiresAt?: string;
};
type Row = { id: string; name: string; provider: string };
const TENANT_INDEX = "TOOL_CREDENTIAL_INDEX";
function tenantRows(): Row[] { return JSON.parse(getConfig(TENANT_INDEX) || "[]"); }
const secretKey = (id: string) => `TOOL_ACCOUNT_${id}`;
function schema(provider: string) {
  if (!Object.hasOwn(TOOL_CREDENTIALS, provider)) throw new FlowError("Escolha um serviço válido para a credencial.");
  return TOOL_CREDENTIALS[provider];
}
function row(id: string): Row {
  const r = tenantRows().find((row) => row.id === id);
  if (!r) throw new FlowError("Esta credencial não existe mais. Escolha outra no agente.", 404);
  return r;
}
function values(r: Row): Record<string, string> {
  const saved = getConfig(secretKey(r.id));
  if (!saved) throw new FlowError("Não foi possível abrir esta credencial. Edite a conexão antes de usar.");
  return JSON.parse(saved);
}
function configured(provider: string, data: Record<string, string>) {
  if (provider === "google_workspace" || provider === "microsoft") {
    const p = provider === "microsoft" ? "TOOL_MICROSOFT" : "TOOL_GOOGLE";
    return !!(data[`${p}_TOKEN`] || (data[`${p}_REFRESH_TOKEN`] && data[`${p}_CLIENT_ID`]));
  }
  return schema(provider).filter((field) => !field.optional).every((field) => !!data[field.chave]?.trim());
}
function summary(r: Row): SavedToolCredential {
  let data: Record<string, string> = {};
  try { data = values(r); } catch { /* Mostra conexão pendente, sem expor dados. */ }
  return { ...r, providerLabel: TOOL_CREDENTIAL_LABELS[r.provider] || r.provider,
    configured: configured(r.provider, data),
    fields: schema(r.provider).map((field) => ({ ...field, definido: !!data[field.chave], valor: field.secret ? undefined : data[field.chave] || "" })),
  };
}
// As credenciais compartilhadas do ambiente aparecem primeiro, só enquanto a conta tem acesso a elas.
function sharedSummaries(provider?: string): SavedToolCredential[] {
  const shared = sharedOpenAiCredential();
  if (!shared?.active || !shared.expiresAt) return [];
  return SHARED_CREDENTIALS.filter((entry) => !provider || entry.provider === provider).map((entry) => ({
    id: entry.id, name: sharedCredentialName(entry, shared), provider: entry.provider, providerLabel: TOOL_CREDENTIAL_LABELS[entry.provider] || entry.provider,
    configured: true, readOnly: true, expiresAt: shared.expiresAt!,
    fields: schema(entry.provider).map((field) => ({ ...field, definido: true, valor: field.secret ? undefined : (entry.values as Record<string, string>)[field.chave] || "" })),
  }));
}
const sharedRefusal = () => new FlowError("Esta credencial é oferecida pelo ambiente e não pode ser alterada. Cadastre uma credencial própria.", 403);
export function listToolCredentials(provider?: string): SavedToolCredential[] {
  if (provider) schema(provider);
  const rows = tenantRows().sort((a, b) => a.name.localeCompare(b.name));
  return [...sharedSummaries(provider), ...rows.filter((r) => !provider || r.provider === provider).map(summary)];
}
export function getToolCredential(id: string) {
  if (isSharedCredentialId(id)) {
    const shared = sharedSummaries().find((c) => c.id === id);
    if (!shared) throw new FlowError("Esta credencial não está mais disponível para a sua conta. Escolha outra.", 404);
    return shared;
  }
  return summary(row(id));
}
export function resolveCredentialKey(id: string, provider: string, key: string) {
  if (isSharedCredentialId(id)) {
    const shared = resolveSharedCredential(id, provider);
    if (shared.entry.key !== key) throw new FlowError("A credencial não pertence ao fornecedor selecionado.");
    return shared.key;
  }
  const r = row(id);
  if (r.provider !== provider || !schema(provider).some(field => field.chave === key)) throw new FlowError("A credencial não pertence ao fornecedor selecionado.");
  const value = values(r)[key];
  if (!value) throw new FlowError("Revise a chave de acesso da credencial.", 409);
  return value;
}
export function saveToolCredential(input: unknown, id?: string): SavedToolCredential {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new FlowError("Preencha os dados da credencial.");
  const body = input as { name?: unknown; provider?: unknown; fields?: unknown };
  if (id && isSharedCredentialId(id)) throw sharedRefusal();
  const existing = id ? row(id) : undefined;
  const provider = existing?.provider || body.provider;
  if (typeof provider !== "string") throw new FlowError("Escolha o serviço da credencial.");
  const fields = schema(provider);
  if (existing && body.provider !== undefined && body.provider !== provider) throw new FlowError("O serviço de uma credencial não pode ser alterado.");
  const name = body.name;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) throw new FlowError("Dê um nome à conexão, com até 100 caracteres.");
  if (!body.fields || typeof body.fields !== "object" || Array.isArray(body.fields)) throw new FlowError("Preencha os campos da conexão.");
  const entries = Object.entries(body.fields);
  if (entries.some(([key, value]) => !fields.some((f) => f.chave === key) || (value !== null && (typeof value !== "string" || value.length > 12000)))) throw new FlowError("Há campos inválidos na credencial.");
  let data: Record<string, string> = Object.fromEntries(fields.filter(f => f.defaultValue).map(f => [f.chave, f.defaultValue!]));
  if (existing) { try { data = values(existing); } catch { /* Permite corrigir credencial perdida. */ } }
  for (const [key, value] of entries) {
    const field = fields.find((f) => f.chave === key)!;
    if (value === null || (!field.secret && value === "")) delete data[key];
    else if (typeof value === "string" && value.trim()) data[key] = value.trim();
  }
  if (provider.startsWith("embedding_")) {
    const urlField = fields.find(f => f.chave.endsWith("_URL"))!;
    const url = data[urlField.chave];
    if (!url || url.length > 2000) throw new FlowError("Informe o endereço do serviço de embeddings.");
    knowledgeUrl(url);
    data[urlField.chave] = url.replace(/\/$/, "");
  }
  if (!configured(provider, data)) throw new FlowError("Preencha os campos obrigatórios para salvar a conexão.");
  const saved = { id: existing?.id || randomUUID(), name: name.trim(), provider };
  configTransaction(() => {
    const rows = tenantRows();
    if (rows.some((r) => r.id !== saved.id && r.provider === provider && r.name.toLowerCase() === saved.name.toLowerCase())) throw new FlowError("Já existe uma conexão com esse nome neste serviço. Escolha outro nome.");
    if (!existing && rows.length >= 200) throw new FlowError("Use até 200 credenciais por conta.", 413);
    setConfig(TENANT_INDEX, JSON.stringify([...rows.filter((r) => r.id !== saved.id), saved]));
    setConfig(secretKey(saved.id), JSON.stringify(data));
    const ai = provider.startsWith("ai_") ? aiProvider(provider.slice(3)) : undefined;
    if (ai) {
      const defaultKey = `AI_DEFAULT_${ai.id.toUpperCase()}_CREDENTIAL`;
      if (!getConfig(defaultKey) && !getConfig(ai.key)) setConfig(defaultKey, saved.id);
      if (getConfig(defaultKey) === saved.id) setConfig(ai.key, data[ai.key]);
    }
  });
  return summary(saved);
}

export function deleteToolCredential(id: string) {
  if (isSharedCredentialId(id)) throw sharedRefusal();
  const deleted = row(id);
  const defaultAi = deleted.provider.startsWith("ai_") ? aiProvider(deleted.provider.slice(3)) : undefined;
  const isDefault = defaultAi && getConfig(`AI_DEFAULT_${defaultAi.id.toUpperCase()}_CREDENTIAL`) === id;
  const { user, config } = currentTenant();
  // This check runs under the same user lock as flow writes and config commit.
  // The route cannot return success before the guard and deletion have committed.
  configTransaction(() => {
    config.guards.push(async (sql) => {
      const knowledge = await sql.query(`SELECT 1 FROM knowledge_bases WHERE user_id=$1 AND
        (body#>>'{config,embeddings,credentialId}'=$2 OR body#>>'{config,vectorStore,postgres,credentialId}'=$2 OR body#>>'{config,recordManager,postgres,credentialId}'=$2) LIMIT 1`, [user.id, id]);
      if (knowledge.rows.length) throw new FlowError("Esta credencial está em uso por uma base de conhecimento.", 409);
      const graphs = await sql.query<{ nodes: { data: { config: Record<string, string> } }[] }>(`SELECT body#>'{graph,nodes}' AS nodes FROM flows WHERE user_id=$1
        UNION ALL SELECT body#>'{published,nodes}' AS nodes FROM flows WHERE user_id=$1 AND body#>'{published,nodes}' IS NOT NULL
        UNION ALL SELECT body#>'{graph,nodes}' AS nodes FROM runs WHERE user_id=$1 AND status IN ('running','waiting')`, [user.id]);
      if (graphs.rows.some(({ nodes }) => nodes.some((node) => node.data.config.modelCredentialId === id || (isDefault && !node.data.config.modelCredentialId && modelProviderId(node.data.config.model) === defaultAi.id) || readToolCards(node.data.config.tools || "", node.data.config.toolCards).some((card) => card.credentialId === id)))) throw new FlowError("Esta credencial está em uso. Troque a conexão nos agentes ou finalize as execuções antes de excluir.", 409);
    });
    setConfig(TENANT_INDEX, JSON.stringify(tenantRows().filter((row) => row.id !== id)));
    setConfig(secretKey(id), null);
    const ai = deleted.provider.startsWith("ai_") ? aiProvider(deleted.provider.slice(3)) : undefined;
    if (ai && getConfig(`AI_DEFAULT_${ai.id.toUpperCase()}_CREDENTIAL`) === id) {
      setConfig(`AI_DEFAULT_${ai.id.toUpperCase()}_CREDENTIAL`, null);
      setConfig(ai.key, null);
    }
  });
  return;
}
export function withToolCredential<T>(id: string | undefined, provider: string | undefined, action: () => T): T {
  if (!id) { currentTenant(); return action(); }
  if (isSharedCredentialId(id)) {
    const shared = resolveSharedCredential(id, provider || "");
    const values = { ...shared.entry.values, [shared.entry.key]: shared.key };
    return withToolConfig({ keys: new Set(Object.keys(values)), values, save: () => { /* Credencial do ambiente: nada a gravar. */ } }, action);
  }
  const r = row(id);
  if (!provider || r.provider !== provider) throw new FlowError("A credencial escolhida não pertence ao serviço desta ferramenta.");
  const data = values(r);
  const keys = new Set(schema(provider).map((f) => f.chave));
  if (provider === "google_workspace") keys.add("TOOL_GOOGLE_EXPIRES_AT");
  if (provider === "microsoft") keys.add("TOOL_MICROSOFT_EXPIRES_AT");
  return withToolConfig({ keys, values: data, save: (key, value) => {
    const latest = values(row(id));
    if (value) latest[key] = value; else delete latest[key];
    setConfig(secretKey(id), JSON.stringify(latest));
  } }, action);
}

// Apenas o servidor recebe a chave; o navegador usa o resumo sem segredos.
export function resolveEmbeddingCredential(id: string, provider: IndexConfig["embeddings"]["provider"]) {
  if (isSharedCredentialId(id)) {
    const shared = resolveSharedCredential(id, embeddingCredentialProvider(provider));
    return { apiKey: shared.key, url: (sharedCredentialEntry(id)!.values as Record<string, string>)[embeddingCredentialUrl(provider)] };
  }
  const r = row(id);
  if (r.provider !== embeddingCredentialProvider(provider)) throw new FlowError("A credencial não pertence ao provedor de embeddings escolhido.");
  const data = values(r);
  if (!configured(r.provider, data)) throw new FlowError("Revise a credencial do serviço de embeddings.");
  return { apiKey: data[embeddingCredentialKey(provider)] || undefined, url: data[embeddingCredentialUrl(provider)] };
}

export function resolvePostgresCredential(id: string) {
  const r = row(id);
  if (r.provider !== "knowledge_postgres" || !configured(r.provider, values(r))) throw new FlowError("Escolha uma credencial PostgreSQL válida para a base de conhecimento.");
  const data = values(r);
  return { user: data.KNOWLEDGE_POSTGRES_USER, password: data.KNOWLEDGE_POSTGRES_PASSWORD };
}
