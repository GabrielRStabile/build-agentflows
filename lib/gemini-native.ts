import { addTokenUsage, type TokenUsage } from "./token-usage";
import { providerFailure, fetchWithRateLimitRetry } from "./ai-provider-error";
import type { AgentTool } from "./chatgpt";
import type { BuiltinTool } from "./ai-providers";
import type { BuiltinCall } from "./openai-responses";

type Part = {
  text?: string; thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
  functionCall?: { id?: string; name?: string; args?: unknown };
  executableCode?: { language?: string; code?: string };
  codeExecutionResult?: { outcome?: string; output?: string };
  [key: string]: unknown;
};
type Content = { role: "user" | "model"; parts: Part[] };
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta";
const RESOLUTION = { low: "MEDIA_RESOLUTION_LOW", high: "MEDIA_RESOLUTION_HIGH" } as const;

/** Tokens do generateContent (usageMetadata), no formato comum do app; os de raciocínio contam como saída. */
export function geminiUsage(value: unknown): TokenUsage | undefined {
  const v = value as { promptTokenCount?: unknown; candidatesTokenCount?: unknown; totalTokenCount?: unknown; cachedContentTokenCount?: unknown; thoughtsTokenCount?: unknown } | undefined;
  const n = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined;
  const input = n(v?.promptTokenCount);
  if (input === undefined) return undefined;
  const reasoning = n(v?.thoughtsTokenCount), output = (n(v?.candidatesTokenCount) || 0) + (reasoning || 0);
  return { input, output, total: n(v?.totalTokenCount) ?? input + output, cachedInput: n(v?.cachedContentTokenCount), reasoning };
}

// Ferramentas nativas do Gemini só existem na API generateContent; o endpoint compatível com OpenAI não as oferece.
export async function runGeminiNative({
  key, model, builtins, system, prompt, history = [], images = [], imageDetail, tools = [], settings = {}, signal, onText, onUsage, onBuiltin, fetcher = fetch,
}: {
  key: string;
  model: string;
  builtins: BuiltinTool[];
  system: string;
  prompt: string;
  history?: { role: "user" | "assistant"; content: string }[];
  images?: string[];
  imageDetail?: "low" | "high" | "auto" | "original";
  tools?: AgentTool[];
  settings?: { temperature?: number; maxTokens?: number };
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onUsage?: (usage: TokenUsage) => void;
  onBuiltin?: (call: BuiltinCall) => Promise<void>;
  fetcher?: typeof fetch;
}): Promise<string> {
  // A conversa precisa começar pela pessoa: um turno inicial do assistente vira texto da mensagem atual.
  const leading = history[0]?.role === "assistant" ? history[0] : undefined;
  const contents: Content[] = [
    ...history.slice(leading ? 1 : 0).map((turn): Content => ({ role: turn.role === "assistant" ? "model" : "user", parts: [{ text: turn.content }] })),
    { role: "user", parts: [
      { text: leading ? `Sua resposta anterior:\n${leading.content}\n\n${prompt}` : prompt },
      ...images.map((url) => {
        const data = /^data:([^;]+);base64,(.+)$/.exec(url);
        if (!data) throw new Error("Formato de imagem não suportado pelo Gemini.");
        return { inlineData: { mimeType: data[1], data: data[2] } };
      }),
    ] },
  ];
  const declared = [
    ...(tools.length ? [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.schema })) }] : []),
    ...builtins.map((id) => ({ [id]: {} })),
  ];
  const resolution = imageDetail === "low" || imageDetail === "high" ? RESOLUTION[imageDetail] : undefined;
  let consumed: TokenUsage | undefined, missing = false;
  for (let round = 0; round < 12; round++) {
    signal?.throwIfAborted();
    const { response, detail } = await fetchWithRateLimitRetry(() => fetcher(`${GEMINI_URL}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, signal, redirect: "error",
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] }, contents, tools: declared,
        generationConfig: { maxOutputTokens: settings.maxTokens || 4000, ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}), ...(resolution && images.length ? { mediaResolution: resolution } : {}) },
      }),
    }), signal);
    if (!response.ok) throw providerFailure(response.status, detail);
    const data = await response.json() as {
      candidates?: { content?: { parts?: Part[] }; finishReason?: string; groundingMetadata?: { webSearchQueries?: string[]; groundingChunks?: { web?: { uri?: string; title?: string } }[] }; urlContextMetadata?: { urlMetadata?: { retrievedUrl?: string; urlRetrievalStatus?: string }[] } }[];
      usageMetadata?: unknown; promptFeedback?: { blockReason?: string };
    };
    const usage = geminiUsage(data.usageMetadata);
    if (usage) { consumed = addTokenUsage(consumed, usage); consumed.partial = missing || undefined; onUsage?.(consumed); }
    else { missing = true; if (consumed) { consumed.partial = true; onUsage?.(consumed); } }
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error(`O Gemini não devolveu resposta${data.promptFeedback?.blockReason ? ` (bloqueio: ${data.promptFeedback.blockReason})` : ""}.`);
    const parts = candidate.content?.parts || [];
    // Código e resultado vêm em partes separadas e em ordem: cada execução vira um registro.
    let code: string | undefined;
    for (const part of parts) {
      if (part.executableCode) code = part.executableCode.code || "";
      else if (part.codeExecutionResult) {
        await onBuiltin?.({ tool: "code_execution", input: code || "", output: part.codeExecutionResult.output || `Resultado: ${part.codeExecutionResult.outcome || "sem saída"}`, images: [] });
        code = undefined;
      } else if (part.inlineData?.data && /^image\/(png|jpeg|webp)$/.test(part.inlineData.mimeType || "")) {
        await onBuiltin?.({ tool: "code_execution", input: "Imagem gerada pelo código", output: "1 imagem gerada.", images: [Buffer.from(part.inlineData.data, "base64")] });
      }
    }
    const grounding = candidate.groundingMetadata;
    if (grounding?.webSearchQueries?.length) {
      const sources = (grounding.groundingChunks || []).map((chunk) => chunk.web ? [chunk.web.title, chunk.web.uri].filter(Boolean).join(" · ") : "").filter(Boolean);
      await onBuiltin?.({ tool: "google_search", input: grounding.webSearchQueries.join("\n"), output: sources.join("\n") || "Sem fontes informadas.", images: [] });
    }
    const pages = candidate.urlContextMetadata?.urlMetadata || [];
    if (pages.length) await onBuiltin?.({ tool: "url_context", input: pages.map((page) => page.retrievedUrl || "").join("\n"), output: pages.map((page) => `${page.retrievedUrl}: ${page.urlRetrievalStatus || "sem status"}`).join("\n"), images: [] });
    const text = parts.filter((part) => typeof part.text === "string" && !part.thought).map((part) => part.text).join("");
    if (text) onText?.(text);
    const calls = parts.filter((part) => part.functionCall);
    if (!calls.length) {
      if (!text && candidate.finishReason && candidate.finishReason !== "STOP") throw new Error(`O Gemini interrompeu a resposta (${candidate.finishReason}). Aumente o máximo de tokens de saída ou simplifique o pedido.`);
      return text;
    }
    // O turno do modelo volta inteiro (com assinaturas de raciocínio), seguido das respostas das funções.
    contents.push({ role: "model", parts });
    const replies: Part[] = [];
    for (const { functionCall: call } of calls) {
      signal?.throwIfAborted();
      const tool = tools.find((t) => t.name === call!.name);
      let result: string;
      try {
        if (!tool) throw new Error("Ferramenta não autorizada.");
        result = await tool.call(call!.args ?? {});
      } catch (err) {
        result = JSON.stringify({ erro: err instanceof Error ? err.message : "Falha na ferramenta." });
      }
      replies.push({ functionResponse: { ...(call!.id ? { id: call!.id } : {}), name: call!.name, response: { result: String(result).slice(0, 30000) } } });
    }
    contents.push({ role: "user", parts: replies });
  }
  throw new Error("O agente excedeu o limite de chamadas de ferramentas.");
}
