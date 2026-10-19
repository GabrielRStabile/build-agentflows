// Execução de um LLM/Agente pelo OpenRouter (mais de 500 modelos), com o mesmo contrato de
// ferramentas do ChatGPT (lib/chatgpt.ts). A chave vem da conexão em um clique (OAuth PKCE) ou
// colada em Credenciais; o modelo é escolhido bloco a bloco como "openrouter:<provedor/modelo>".
import { runChatCompletion } from "./chat-completion";
import { toolConfig } from "./tool-config-context";
import { publicModelCache } from "./public-model-cache";
export const PREFIX = "openrouter:";
export const GENERATOR_MODEL = "openai/gpt-4.1-mini";
export function openRouterKey() {
  return toolConfig("OPENROUTER_API_KEY") || "";
}
export function isOpenRouterModel(model?: string) {
  return !!model && model.startsWith(PREFIX);
}
export type ModelOption = { id: string; nome: string; provedor: string; inputModalities: string[]; parameters: string[]; contextLength?: number; maxOutputTokens?: number };
export const listModels = publicModelCache(async (): Promise<ModelOption[]> => {
  const r = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(20000), redirect: "error" });
  if (!r.ok) throw new Error("O OpenRouter não devolveu a lista de modelos.");
  const data = (await r.json()) as { data?: { id: string; name?: string; architecture?: { input_modalities?: string[]; output_modalities?: string[] }; supported_parameters?: string[]; context_length?: number; top_provider?: { max_completion_tokens?: number } }[] };
  if (!Array.isArray(data.data) || !data.data.length) throw new Error("O catálogo do OpenRouter está indisponível.");
  // Decision models (output "decisions", no text) are left out: they only answer closed questions in the Decision block.
  const modelos = data.data.filter(m => typeof m.id === "string" && m.id.includes("/") && (!Array.isArray(m.architecture?.output_modalities) || m.architecture.output_modalities.includes("text"))).map(m => ({
    id: m.id, nome: m.name || m.id, provedor: m.id.split("/")[0],
    inputModalities: m.architecture?.input_modalities || ["text"],
    parameters: m.supported_parameters || [], contextLength: m.context_length,
    maxOutputTokens: m.top_provider?.max_completion_tokens,
  })).sort((a, b) => a.nome.localeCompare(b.nome));
  if (!modelos.length) throw new Error("O catálogo do OpenRouter está indisponível.");
  return modelos;
});
export async function runOpenRouter(options: Omit<Parameters<typeof runChatCompletion>[0], "key" | "url" | "parameters"> & { apiKey?: string; settings?: { temperature?: number; maxTokens?: number } }) {
  const key = options.apiKey || openRouterKey();
  if (!key) throw new Error("Conecte o OpenRouter em Credenciais para usar este modelo.");
  const id = options.model?.startsWith(PREFIX) ? options.model.slice(PREFIX.length) : options.model || GENERATOR_MODEL;
  const settings = options.settings || {};
  const selected = options.images?.length || settings.temperature !== undefined || settings.maxTokens !== undefined
    ? (await listModels()).find(m => m.id === id) : undefined;
  if (options.images?.length && (id === "openrouter/auto" || !selected?.inputModalities.includes("image"))) throw new Error("Escolha um modelo OpenRouter com suporte a imagens no bloco.");
  if (settings.temperature !== undefined && !selected?.parameters.includes("temperature")) throw new Error("Este modelo não aceita temperatura personalizada.");
  if (settings.maxTokens && selected?.maxOutputTokens && settings.maxTokens > selected.maxOutputTokens) throw new Error("O limite de tokens excede o máximo deste modelo.");
  return runChatCompletion({ ...options, key, model: id, url: "https://openrouter.ai/api/v1/chat/completions", parameters: {
    max_tokens: settings.maxTokens || 4000, ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
  } });
}
