import { aiProvider, modelProviderId, modelSettings, openaiReasoningModel, toolsRequireNoReasoning } from "./ai-providers";
import { modelCredentialKey } from "./ai-credentials";
import { runChatCompletion } from "./chat-completion";
import { runOpenRouter } from "./openrouter";
import { runAnthropic } from "./anthropic";

export async function runProviderModel(config: Record<string, string>, options: Omit<Parameters<typeof runChatCompletion>[0], "key" | "url" | "parameters">) {
  const provider = modelProviderId(config.model);
  if (provider === "chatgpt") throw new Error("Selecione um fornecedor de API.");
  const key = modelCredentialKey(provider, config.modelCredentialId);
  const settings = modelSettings(config);
  if (provider === "openrouter") return runOpenRouter({ ...options, apiKey: key, settings });
  const p = aiProvider(provider)!;
  const model = config.model.slice(provider.length + 1);
  if (!model || !p.url) throw new Error("Selecione um modelo de texto válido.");
  if (provider === "anthropic") return runAnthropic({ ...options, model, key, settings });
  const reasoning = provider === "openai" && openaiReasoningModel(model);
  if (reasoning && settings.temperature !== undefined) throw new Error("Remova a temperatura personalizada deste modelo de raciocínio.");
  let effort = reasoning ? settings.reasoningEffort : undefined;
  // Chat Completions only accepts tools on these models without reasoning; without an explicit choice the engine adapts.
  if (reasoning && options.tools?.length && toolsRequireNoReasoning(model)) {
    if (effort && effort !== "none") throw new Error(`O modelo ${model} só usa ferramentas com esforço de raciocínio "none" na API da OpenAI. Ajuste o parâmetro no bloco ou retire as ferramentas.`);
    effort = "none";
  }
  return runChatCompletion({ ...options, model, key, url: `${p.url}/chat/completions`, parameters: {
    [provider === "openai" ? "max_completion_tokens" : "max_tokens"]: settings.maxTokens || 4000,
    ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
  } });
}
