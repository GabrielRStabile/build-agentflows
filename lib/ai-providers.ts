// Public provider metadata. Secrets are stored by the existing credential manager.
export const AI_PROVIDERS = [
  { id: "openai", name: "OpenAI", key: "OPENAI_API_KEY", url: "https://api.openai.com/v1", link: "https://platform.openai.com/api-keys", icon: "/knowledge-icons/embeddings-openai.svg" },
  { id: "anthropic", name: "Anthropic", key: "ANTHROPIC_API_KEY", url: "https://api.anthropic.com/v1", link: "https://console.anthropic.com/settings/keys", icon: "/provider-icons/anthropic.svg" },
  { id: "google", name: "Google", key: "GEMINI_API_KEY", url: "https://generativelanguage.googleapis.com/v1beta/openai", link: "https://aistudio.google.com/apikey", icon: "/knowledge-icons/embeddings-gemini.svg" },
  { id: "openrouter", name: "OpenRouter", key: "OPENROUTER_API_KEY", url: "https://openrouter.ai/api/v1", link: "https://openrouter.ai/settings/keys", icon: "/provider-icons/openrouter.svg" },
  { id: "groq", name: "Groq", key: "GROQ_API_KEY", url: "https://api.groq.com/openai/v1", link: "https://console.groq.com/keys", icon: "/provider-icons/groq.svg" },
  // Modelo de decisão: só o bloco Decisão usa (não gera texto, então não aparece no Agente nem no LLM).
  { id: "replicate", name: "Replicate", key: "REPLICATE_API_TOKEN", url: "", link: "https://replicate.com/account/api-tokens", icon: "/provider-icons/replicate.svg" },
  { id: "higgsfield", name: "Higgsfield", key: "HIGGSFIELD_API_KEY", url: "", link: "https://cloud.higgsfield.ai/", icon: "/provider-icons/higgsfield.ico" },
  { id: "muapi", name: "MuAPI", key: "MUAPI_API_KEY", url: "", link: "https://muapi.ai/", icon: "/provider-icons/muapi.png" },
] as const;
export type AiProvider = typeof AI_PROVIDERS[number]["id"];
export const aiProvider = (id: string) => AI_PROVIDERS.find(p => p.id === id);
export const modelProviderId = (model = ""): AiProvider | "chatgpt" => aiProvider(model.split(":")[0])?.id || "chatgpt";
export const aiCredentialProvider = (id: string) => `ai_${id}`;
export const AI_CREDENTIAL_CATALOG = AI_PROVIDERS.map(p => ({ id: `credential:ai_${p.id}`, provider: aiCredentialProvider(p.id), name: `${p.name} · Modelos`, icon: p.icon }));
export type AiModel = { id: string; name: string; inputModalities: string[]; outputModalities?: string[]; parameters: string[]; contextLength?: number; maxOutputTokens?: number };
/** Gemini models that answer with images (gemini-*-image*, "Nano Banana"): only the native generateContent API returns them. */
export const geminiImageModel = (model = "") => /^google:gemini-[\w.-]*image/.test(model);
/** Native tools accepted by the Gemini image models (Google documents only search grounding for them). */
const GEMINI_IMAGE_BUILTINS: readonly string[] = ["google_search"];
/** Níveis aceitos pela OpenAI; cada modelo suporta um subconjunto e o fornecedor recusa os demais. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
/** OpenAI reasoning models: no temperature; accept reasoning_effort. */
export const openaiReasoningModel = (model: string) => /^(o[1-9]|gpt-[5-9])/.test(model);
/** Models whose Chat Completions endpoint only accepts function calling with reasoning_effort "none" (OpenAI model page). */
export const toolsRequireNoReasoning = (model: string) => /^gpt-6-luna/.test(model);
/** Image resolution sent to vision models. Blank means "high": uploaded images are usually read for data (tables, receipts, screenshots). */
export const IMAGE_DETAILS = ["high", "original", "auto", "low"] as const;
export type ImageDetail = typeof IMAGE_DETAILS[number];
/** "original" (no downscaling) is only offered by the ChatGPT App Server; APIs accept low, high and auto. */
export function imageDetail(config: Record<string, string>): ImageDetail {
  const value = (config.imageDetail?.trim() || "high") as ImageDetail;
  if (!IMAGE_DETAILS.includes(value)) throw new Error("A qualidade das imagens deve ser uma das opções da lista.");
  if (value === "original" && modelProviderId(config.model || "") !== "chatgpt") throw new Error("A qualidade original das imagens só está disponível com o ChatGPT por assinatura.");
  return value;
}
/** Ferramentas nativas executadas pelo próprio fornecedor, marcadas no bloco em config.builtinTools, separadas por vírgula. */
export const BUILTIN_TOOLS = {
  openai: [
    { id: "web_search", name: "Busca na web", description: "Pesquisa na internet informações atualizadas." },
    { id: "code_interpreter", name: "Interpretador de código", description: "Escreve e executa Python em um ambiente isolado da OpenAI." },
    { id: "image_generation", name: "Geração de imagens", description: "Cria imagens a partir de uma descrição em texto." },
  ],
  google: [
    { id: "url_context", name: "Contexto de URLs", description: "Lê o conteúdo dos endereços citados na conversa." },
    { id: "google_search", name: "Busca Google", description: "Pesquisa na web conteúdo em tempo real." },
    { id: "code_execution", name: "Execução de código", description: "Escreve e executa Python em um ambiente isolado do Google." },
  ],
} as const;
export type BuiltinProvider = keyof typeof BUILTIN_TOOLS;
export type BuiltinTool = typeof BUILTIN_TOOLS[BuiltinProvider][number]["id"];
export const builtinProvider = (model = "") => { const id = modelProviderId(model); return id in BUILTIN_TOOLS ? id as BuiltinProvider : undefined; };
/** Native tools the model can use: the provider's list, narrowed for the Gemini image models. */
export const builtinToolsFor = (model = ""): readonly { id: string; name: string; description: string }[] => {
  const provider = builtinProvider(model);
  if (!provider) return [];
  return geminiImageModel(model) ? BUILTIN_TOOLS[provider].filter(tool => GEMINI_IMAGE_BUILTINS.includes(tool.id)) : BUILTIN_TOOLS[provider];
};
export const builtinToolName = (id: string) => Object.values(BUILTIN_TOOLS).flat().find(tool => tool.id === id)?.name || id;
export function builtinTools(config: Record<string, string>): BuiltinTool[] {
  const ids = [...new Set((config.builtinTools || "").split(",").map(id => id.trim()).filter(Boolean))];
  if (!ids.length) return [];
  const provider = builtinProvider(config.model);
  if (!provider) throw new Error("Ferramentas nativas só funcionam com modelos da OpenAI ou do Google.");
  const offered: readonly { id: string }[] = builtinToolsFor(config.model);
  if (ids.some(id => !offered.some(tool => tool.id === id))) throw new Error(geminiImageModel(config.model) ? "Os modelos de imagem do Gemini aceitam apenas a Busca Google como ferramenta nativa." : `As ferramentas nativas devem ser opções da lista de ${aiProvider(provider)!.name}.`);
  return ids as BuiltinTool[];
}
export function modelSettings(config: Record<string, string>) {
  imageDetail(config);
  const result: { temperature?: number; maxTokens?: number; reasoningEffort?: ReasoningEffort; builtins: BuiltinTool[] } = { builtins: builtinTools(config) };
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
