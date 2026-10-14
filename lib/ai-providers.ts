// Public provider metadata. Secrets are stored by the existing credential manager.
export const AI_PROVIDERS = [
  { id: "openai", name: "OpenAI", key: "OPENAI_API_KEY", url: "https://api.openai.com/v1", link: "https://platform.openai.com/api-keys", icon: "/knowledge-icons/embeddings-openai.svg" },
  { id: "anthropic", name: "Anthropic", key: "ANTHROPIC_API_KEY", url: "https://api.anthropic.com/v1", link: "https://console.anthropic.com/settings/keys", icon: "/provider-icons/anthropic.svg" },
  { id: "google", name: "Google", key: "GEMINI_API_KEY", url: "https://generativelanguage.googleapis.com/v1beta/openai", link: "https://aistudio.google.com/apikey", icon: "/knowledge-icons/embeddings-gemini.svg" },
  { id: "openrouter", name: "OpenRouter", key: "OPENROUTER_API_KEY", url: "https://openrouter.ai/api/v1", link: "https://openrouter.ai/settings/keys", icon: "/provider-icons/openrouter.svg" },
  { id: "groq", name: "Groq", key: "GROQ_API_KEY", url: "https://api.groq.com/openai/v1", link: "https://console.groq.com/keys", icon: "/provider-icons/groq.svg" },
  { id: "replicate", name: "Replicate", key: "REPLICATE_API_TOKEN", url: "", link: "https://replicate.com/account/api-tokens", icon: "/provider-icons/replicate.svg" },
  { id: "higgsfield", name: "Higgsfield", key: "HIGGSFIELD_API_KEY", url: "", link: "https://cloud.higgsfield.ai/", icon: "/provider-icons/higgsfield.ico" },
  { id: "muapi", name: "MuAPI", key: "MUAPI_API_KEY", url: "", link: "https://muapi.ai/", icon: "/provider-icons/muapi.png" },
] as const;
export type AiProvider = typeof AI_PROVIDERS[number]["id"];
export const aiProvider = (id: string) => AI_PROVIDERS.find(p => p.id === id);
export const modelProviderId = (model = ""): AiProvider | "chatgpt" => aiProvider(model.split(":")[0])?.id || "chatgpt";
export const aiCredentialProvider = (id: string) => `ai_${id}`;
export const AI_CREDENTIAL_CATALOG = AI_PROVIDERS.map(p => ({ id: `credential:ai_${p.id}`, provider: aiCredentialProvider(p.id), name: `${p.name} · Modelos`, icon: p.icon }));
export type AiModel = { id: string; name: string; inputModalities: string[]; parameters: string[]; contextLength?: number; maxOutputTokens?: number };
/** Níveis aceitos pela OpenAI; cada modelo suporta um subconjunto e o fornecedor recusa os demais. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
/** OpenAI reasoning models: no temperature; accept reasoning_effort. */
export const openaiReasoningModel = (model: string) => /^(o[1-9]|gpt-[5-9])/.test(model);
/** Models whose Chat Completions endpoint only accepts function calling with reasoning_effort "none" (OpenAI model page). */
export const toolsRequireNoReasoning = (model: string) => /^gpt-6-luna/.test(model);
export function modelSettings(config: Record<string, string>) {
  const result: { temperature?: number; maxTokens?: number; reasoningEffort?: ReasoningEffort } = {};
  if (config.modelReasoningEffort?.trim()) {
    const effort = config.modelReasoningEffort.trim() as ReasoningEffort;
    if (!REASONING_EFFORTS.includes(effort)) throw new Error("O esforço de raciocínio deve ser um dos níveis da lista.");
    result.reasoningEffort = effort;
  }
  if (config.modelTemperature?.trim()) {
    const n = Number(config.modelTemperature);
    if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error("A temperatura deve estar entre 0 e 2.");
    result.temperature = n;
  }
  if (config.modelMaxTokens?.trim()) {
    const n = Number(config.modelMaxTokens);
    if (!Number.isSafeInteger(n) || n < 1 || n > 1000000) throw new Error("O limite de tokens deve ser um inteiro entre 1 e 1.000.000.");
    result.maxTokens = n;
  }
  return result;
}
