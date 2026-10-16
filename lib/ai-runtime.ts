import { aiProvider, modelProviderId, modelSettings, openaiReasoningModel, toolsRequireNoReasoning } from "./ai-providers";
import { modelCredentialKey } from "./ai-credentials";
import { runChatCompletion } from "./chat-completion";
import { runOpenRouter } from "./openrouter";
import { runAnthropic } from "./anthropic";
import { runOpenAIResponses, type BuiltinCall } from "./openai-responses";
import { runGeminiNative } from "./gemini-native";

/** Models that already refused function calling without "none" in this process; later calls start with it. */
const toolsNeedNone = new Set<string>();
/** The provider asks for reasoning_effort "none" (e.g. "Function calling requires reasoning_effort 'none'"). */
export const requiresNoReasoning = (error: unknown) =>
  error instanceof Error && (error as { status?: number }).status === 400 && /reasoning_effort[^.]*\bnone\b/i.test(error.message);

export async function runProviderModel(config: Record<string, string>, options: Omit<Parameters<typeof runChatCompletion>[0], "key" | "url" | "parameters"> & {
  /** Presente só na conversa do bloco: ativa as ferramentas nativas marcadas (OpenAI, Google) e recebe o registro de cada uso. */
  onBuiltin?: (call: BuiltinCall) => Promise<void>;
}) {
  const provider = modelProviderId(config.model);
  if (provider === "chatgpt") throw new Error("Selecione um fornecedor de API.");
  const key = modelCredentialKey(provider, config.modelCredentialId);
  const settings = modelSettings(config);
  if (provider === "openrouter") return runOpenRouter({ ...options, apiKey: key, settings });
  const p = aiProvider(provider)!;
  const model = config.model.slice(provider.length + 1);
  if (!model || !p.url) throw new Error("Selecione um modelo de texto válido.");
  if (provider === "anthropic") return runAnthropic({ ...options, model, key, settings });
  const builtins = options.onBuiltin ? settings.builtins : [];
  // Ferramentas nativas do Gemini só existem na API generateContent; sem elas o bloco continua no endpoint compatível.
  if (provider === "google" && builtins.length) return runGeminiNative({ ...options, model, key, builtins, settings });
  const reasoning = provider === "openai" && openaiReasoningModel(model);
  if (reasoning && settings.temperature !== undefined) throw new Error("Remova a temperatura personalizada deste modelo de raciocínio.");
  // Ferramentas nativas só existem na Responses API; sem elas o bloco continua em Chat Completions.
  if (provider === "openai" && builtins.length) return runOpenAIResponses({ ...options, model, key, url: p.url, builtins, parameters: {
    max_output_tokens: settings.maxTokens || 4000,
    ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
    ...(reasoning && settings.reasoningEffort ? { reasoning: { effort: settings.reasoningEffort } } : {}),
  } });
  let effort = reasoning ? settings.reasoningEffort : undefined;
  // Chat Completions only accepts tools on these models without reasoning; without an explicit choice the engine adapts.
  const withTools = reasoning && !!options.tools?.length;
  if (withTools && (toolsRequireNoReasoning(model) || toolsNeedNone.has(model))) {
    if (effort && effort !== "none") throw new Error(`O modelo ${model} só usa ferramentas com esforço de raciocínio "none" na API da OpenAI. Ajuste o parâmetro no bloco ou retire as ferramentas.`);
    effort = "none";
  }
  const call = (level?: string) => runChatCompletion({ ...options, model, key, url: `${p.url}/chat/completions`, parameters: {
    [provider === "openai" ? "max_completion_tokens" : "max_tokens"]: settings.maxTokens || 4000,
    ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
    ...(level ? { reasoning_effort: level } : {}),
  } });
  if (!withTools || effort) return call(effort);
  // Blank field: the model's default, and "none" only when the provider says tools need it (the refusal comes before any tool runs).
  try { return await call(); }
  catch (error) {
    if (!requiresNoReasoning(error)) throw error;
    toolsNeedNone.add(model);
    return call("none");
  }
}
