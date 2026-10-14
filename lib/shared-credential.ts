// Credencial OpenAI compartilhada pelo ambiente (Coolify): contas que entraram por convite a veem
// como "<nome> (free tier)" durante as horas seguintes ao resgate. A chave fica só em process.env e é
// lida no momento da chamada; nunca é copiada para o banco de cada conta nem devolvida ao navegador.
import { aiCredentialProvider } from "./ai-providers";
import { FlowError } from "./flow-store";
import { currentTenant } from "./tenant-context";
import { formatCredentialExpiry } from "./credential-expiry";

export const SHARED_OPENAI_ID = "compartilhada:openai";
export const SHARED_OPENAI_PROVIDER = aiCredentialProvider("openai");
export const SHARED_OPENAI_KEY = "OPENAI_API_KEY";
const DEFAULT_NAME = "StartSe OpenAI API";
const DEFAULT_HOURS = 72;

export type SharedCredentialSettings = { key: string; name: string; hours: number };
export type SharedCredentialStatus = SharedCredentialSettings & {
  id: string; provider: string;
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
  return { key, name: `${name} (free tier)`, hours: Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_HOURS };
}

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
  return { ...settings, id: SHARED_OPENAI_ID, provider: SHARED_OPENAI_PROVIDER, expiresAt: expiry?.toISOString() ?? null, active: !!expiry && expiry.getTime() > now.getTime() };
}

export const isSharedCredentialId = (id: string) => id === SHARED_OPENAI_ID;

/** Chave para uso no servidor; recusa com explicação quando a conta não tem (mais) acesso. */
export function resolveSharedOpenAiKey(provider: string, key: string, now = new Date()): string {
  if (provider !== SHARED_OPENAI_PROVIDER || key !== SHARED_OPENAI_KEY) throw new FlowError("A credencial não pertence ao fornecedor selecionado.");
  const shared = sharedOpenAiCredential(now);
  if (!shared) throw new FlowError("A credencial compartilhada da OpenAI não está mais disponível. Cadastre sua própria chave da OpenAI no bloco.", 409);
  if (!shared.expiresAt) throw new FlowError(`A credencial ${shared.name} é oferecida apenas a contas que entraram por convite. Cadastre sua própria chave da OpenAI no bloco.`, 409);
  if (!shared.active) throw new FlowError(`O período gratuito da credencial ${shared.name} terminou em ${formatCredentialExpiry(shared.expiresAt)}. Cadastre sua própria chave da OpenAI no bloco.`, 409);
  return shared.key;
}
