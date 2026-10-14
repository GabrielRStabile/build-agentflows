// Credencial OpenAI compartilhada pelo ambiente (Coolify): contas que entraram por convite a veem
// durante as horas seguintes ao resgate, como "<nome> (free tier)" para modelos (ai_openai) e como
// "StartSe OpenAI Embedding API" para embeddings das bases de conhecimento (embedding_openai). A chave fica só em
// process.env e é lida no momento da chamada; nunca é copiada para o banco nem devolvida ao navegador.
import { aiCredentialProvider } from "./ai-providers";
import { embeddingCredentialProvider, embeddingCredentialKey, embeddingCredentialUrl } from "./embedding-credentials";
import { EMBEDDING_PROVIDERS } from "./knowledge-providers";
import { FlowError } from "./flow-store";
import { currentTenant } from "./tenant-context";
import { formatCredentialExpiry } from "./credential-expiry";

export const SHARED_OPENAI_ID = "compartilhada:openai";
export const SHARED_OPENAI_EMBEDDING_ID = "compartilhada:openai-embeddings";
export const SHARED_OPENAI_PROVIDER = aiCredentialProvider("openai");
export const SHARED_OPENAI_KEY = "OPENAI_API_KEY";
const OPENAI_EMBEDDING_URL = EMBEDDING_PROVIDERS.find((p) => p.id === "openai")!.url;
/** As duas faces da mesma chave: cada uma com o provedor e o campo que o catálogo de credenciais espera. */
export const SHARED_CREDENTIALS = [
  { id: SHARED_OPENAI_ID, provider: SHARED_OPENAI_PROVIDER, key: SHARED_OPENAI_KEY, values: {} as Record<string, string> },
  { id: SHARED_OPENAI_EMBEDDING_ID, provider: embeddingCredentialProvider("openai"), key: embeddingCredentialKey("openai"), values: { [embeddingCredentialUrl("openai")]: OPENAI_EMBEDDING_URL } },
] as const;
export type SharedCredentialEntry = typeof SHARED_CREDENTIALS[number];
const DEFAULT_NAME = "StartSe OpenAI API";
const DEFAULT_EMBEDDING_NAME = "StartSe OpenAI Embedding API";
const DEFAULT_HOURS = 72;

export type SharedCredentialSettings = { key: string; name: string; embeddingName: string; hours: number };
export type SharedCredentialStatus = SharedCredentialSettings & {
  /** Instante (ISO) em que a conta perde o acesso; null quando a conta não entrou por convite. */
  expiresAt: string | null;
  /** true enquanto a conta pode listar e usar a credencial. */
  active: boolean;
};

/** Lê as variáveis de ambiente; null quando a chave não está configurada. */
export function sharedOpenAiSettings(env: Record<string, string | undefined> = process.env): SharedCredentialSettings | null {
  const key = env.OPENAI_CHAVE_COMPARTILHADA?.trim();
  if (!key) return null;
  const hours = Number(env.OPENAI_CHAVE_COMPARTILHADA_HORAS);
  const name = env.OPENAI_CHAVE_COMPARTILHADA_NOME?.trim().slice(0, 80) || DEFAULT_NAME;
  const embeddingName = env.OPENAI_CHAVE_COMPARTILHADA_NOME_EMBEDDINGS?.trim().slice(0, 80) || DEFAULT_EMBEDDING_NAME;
  return { key, name: `${name} (free tier)`, embeddingName, hours: Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_HOURS };
}

/** Nome exibido de cada face da credencial: a de embeddings tem nome próprio, sem "(free tier)". */
export const sharedCredentialName = (entry: Pick<SharedCredentialEntry, "id">, settings: SharedCredentialSettings) =>
  entry.id === SHARED_OPENAI_EMBEDDING_ID ? settings.embeddingName : settings.name;

export function sharedExpiry(invitedAt: Date | string | null | undefined, hours: number): Date | null {
  if (!invitedAt) return null;
  const start = new Date(invitedAt);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + hours * 3_600_000);
}

/** Situação da credencial compartilhada para a conta do contexto atual; null quando o ambiente não a oferece. */
export function sharedOpenAiCredential(now = new Date()): SharedCredentialStatus | null {
  const settings = sharedOpenAiSettings();
  if (!settings) return null;
  const expiry = sharedExpiry(currentTenant().user.invited_at, settings.hours);
  return { ...settings, expiresAt: expiry?.toISOString() ?? null, active: !!expiry && expiry.getTime() > now.getTime() };
}

export const sharedCredentialEntry = (id: string) => SHARED_CREDENTIALS.find((entry) => entry.id === id);
export const isSharedCredentialId = (id: string) => !!sharedCredentialEntry(id);

/** Chave para uso no servidor; recusa com explicação quando a conta não tem (mais) acesso. */
export function resolveSharedCredential(id: string, provider: string, now = new Date()): { entry: SharedCredentialEntry; key: string } {
  const entry = sharedCredentialEntry(id);
  if (!entry || entry.provider !== provider) throw new FlowError("A credencial não pertence ao fornecedor selecionado.");
  const shared = sharedOpenAiCredential(now);
  if (!shared) throw new FlowError("A credencial compartilhada da OpenAI não está mais disponível. Cadastre sua própria chave da OpenAI.", 409);
  const name = sharedCredentialName(entry, shared);
  if (!shared.expiresAt) throw new FlowError(`A credencial ${name} é oferecida apenas a contas que entraram por convite. Cadastre sua própria chave da OpenAI.`, 409);
  if (!shared.active) throw new FlowError(`O período gratuito da credencial ${name} terminou em ${formatCredentialExpiry(shared.expiresAt)}. Cadastre sua própria chave da OpenAI.`, 409);
  return { entry, key: shared.key };
}
export function resolveSharedOpenAiKey(provider: string, key: string, now = new Date()): string {
  const entry = SHARED_CREDENTIALS.find((e) => e.provider === provider);
  if (!entry || entry.key !== key) throw new FlowError("A credencial não pertence ao fornecedor selecionado.");
  return resolveSharedCredential(entry.id, provider, now).key;
}
