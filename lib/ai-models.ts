import { aiProvider, geminiImageModel, type AiProvider, type AiModel } from "./ai-providers";
import { modelCredentialKey } from "./ai-credentials";
import { listModels } from "./openrouter";
import { MEDIA_MODELS } from "./media-models";
import { providerFailure } from "./ai-provider-error";

export async function providerModels(provider: AiProvider, credentialId?: string, fetcher = fetch): Promise<AiModel[]> {
  if (provider === "openrouter") return (await listModels()).map(m => ({ ...m, id: `openrouter:${m.id}`, name: m.nome }));
  // Replicate models are typed by name in the LLM block; there is no listed catalogue.
  if (provider === "replicate") return [];
  const media = MEDIA_MODELS.filter(m => m.provider === provider);
  if (media.length) return media.map(m => ({ ...m, parameters: [] }));
  const p = aiProvider(provider)!;
  const key = modelCredentialKey(provider, credentialId);
  const headers: Record<string, string> = provider === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${key}` };
  const models: AiModel[] = [];
  let after = "";
  do {
    const url = `${p.url}/models${provider === "anthropic" ? `?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}` : ""}`;
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(20000), redirect: "error" });
    if (!response.ok) throw providerFailure(response.status, await response.text().catch(() => ""));
    const data = await response.json() as { data?: { id: string; display_name?: string; name?: string; active?: boolean; context_window?: number; max_input_tokens?: number; max_tokens?: number; capabilities?: { image_input?: { supported?: boolean } } }[]; has_more?: boolean; last_id?: string };
    if (!Array.isArray(data.data)) throw new Error("O fornecedor não retornou um catálogo válido.");
    for (const m of data.data) {
      if (!m.id || m.active === false) continue;
      if (provider === "google") m.id = m.id.replace(/^models\//, "");
      // The OpenAI /models endpoint also lists embedding, speech and image endpoints.
      if (provider === "openai" && (!/^(gpt-|o[1-9]|chatgpt-)/.test(m.id) || /audio|realtime|transcribe|tts|image|search|instruct|codex/.test(m.id))) continue;
      // Gemini image models ("Nano Banana") stay: they answer through the native API with the images saved as media.
      if (provider === "google" && (!m.id.startsWith("gemini-") || /embedding|live|tts|robotics/.test(m.id))) continue;
      if (provider === "groq" && /whisper|tts|guard|orpheus/.test(m.id)) continue;
      const reasoning = provider === "openai" && /^(o[1-9]|gpt-[5-9])/.test(m.id);
      // Be conservative for unrecognized models; parameters remain optional.
      const temperature = !reasoning && !(provider === "anthropic" && /(?:opus|sonnet)-[5-9]/.test(m.id));
      const vision = (provider === "anthropic" && m.capabilities?.image_input?.supported !== false) || provider === "google" || (provider === "openai" && /^(gpt-4o|gpt-4\.[1-9]|gpt-[5-9]|o[3-9])/.test(m.id)) || (provider === "groq" && /llama-4/.test(m.id));
      models.push({ id: `${provider}:${m.id}`, name: m.display_name || m.name || m.id, inputModalities: vision ? ["text", "image"] : ["text"], ...(geminiImageModel(`${provider}:${m.id}`) ? { outputModalities: ["text", "image"] } : {}), parameters: ["max_tokens", ...(temperature ? ["temperature"] : []), ...(reasoning ? ["reasoning_effort"] : [])], contextLength: m.max_input_tokens || m.context_window, maxOutputTokens: m.max_tokens || undefined });
    }
    const next = data.has_more && data.last_id ? data.last_id : "";
    if (next === after) break;
    after = next;
  } while (provider === "anthropic" && after);
  return models.sort((a, b) => a.name.localeCompare(b.name));
}
