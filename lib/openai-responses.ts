import { addTokenUsage, type TokenUsage } from "./token-usage";
import { providerFailure, fetchWithRateLimitRetry } from "./ai-provider-error";
import type { AgentTool } from "./chatgpt";
import type { BuiltinTool } from "./ai-providers";

/** Ferramenta nativa executada pelo próprio fornecedor (OpenAI, Google); o motor só registra o que aconteceu. */
export type BuiltinCall = { tool: BuiltinTool; input: string; output: string; images: Buffer[] };
type Item = Record<string, unknown> & { type?: string };
const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

/** Tokens da Responses API (input_tokens/output_tokens), no formato comum do app. */
export function responsesUsage(value: unknown): TokenUsage | undefined {
  const v = value as { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown }; output_tokens_details?: { reasoning_tokens?: unknown } } | undefined;
  const n = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined;
  const input = n(v?.input_tokens), output = n(v?.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  return { input, output, total: n(v?.total_tokens) ?? input + output, cachedInput: n(v?.input_tokens_details?.cached_tokens), reasoning: n(v?.output_tokens_details?.reasoning_tokens) };
}

// Links "sandbox:/mnt/data/..." só existem no contêiner da OpenAI; os arquivos de imagem aparecem abaixo da resposta.
const withoutSandboxLinks = (text: string) => text.replace(/!?\[([^\]]*)\]\(sandbox:[^)]*\)/g, "$1");

export async function runOpenAIResponses({
  key, url, model, parameters = {}, builtins, system, prompt, history = [], images = [], imageDetail, tools = [], signal, onText, onUsage, onBuiltin, fetcher = fetch,
}: {
  key: string;
  url: string;
  model: string;
  parameters?: Record<string, unknown>;
  builtins: BuiltinTool[];
  system: string;
  prompt: string;
  history?: { role: "user" | "assistant"; content: string }[];
  images?: string[];
  imageDetail?: "low" | "high" | "auto" | "original";
  tools?: AgentTool[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onUsage?: (usage: TokenUsage) => void;
  onBuiltin?: (call: BuiltinCall) => Promise<void>;
  fetcher?: typeof fetch;
}): Promise<string> {
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const declared = [
    ...tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.schema, strict: false })),
    ...builtins.map((id) => id === "code_interpreter" ? { type: id, container: { type: "auto" } } : { type: id }),
  ];
  const include = [
    ...(builtins.includes("web_search") ? ["web_search_call.action.sources"] : []),
    ...(builtins.includes("code_interpreter") ? ["code_interpreter_call.outputs"] : []),
  ];
  let input: unknown[] = [
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: [{ type: "input_text", text: prompt }, ...images.map((image) => ({ type: "input_image", image_url: image, detail: imageDetail && imageDetail !== "original" ? imageDetail : "auto" }))] },
  ];
  let previous: string | undefined;
  let consumed: TokenUsage | undefined;
  let missingUsage = false;
  const downloaded = new Set<string>();
  // Arquivos citados pelo interpretador ficam no contêiner da OpenAI; só imagens são trazidas para a conversa.
  const containerImage = async (container: string, file: string) => {
    const res = await fetcher(`${url}/containers/${encodeURIComponent(container)}/files/${encodeURIComponent(file)}/content`, { headers, signal, redirect: "error" });
    if (!res.ok) throw providerFailure(res.status, await res.text().catch(() => ""));
    return Buffer.from(await res.arrayBuffer());
  };
  for (let round = 0; round < 12; round++) {
    if (signal?.aborted) throw new Error("Execução cancelada.");
    const { response: res, detail } = await fetchWithRateLimitRetry(() => fetcher(`${url}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, instructions: system, input, tools: declared, ...(include.length ? { include } : {}), ...(previous ? { previous_response_id: previous } : {}), ...parameters }),
      signal,
      redirect: "error",
    }), signal);
    if (!res.ok) throw providerFailure(res.status, detail);
    const data = await res.json() as { id?: string; status?: string; output?: Item[]; usage?: unknown; error?: { message?: string } | null; incomplete_details?: { reason?: string } | null };
    if (data.status === "failed") throw new Error("A OpenAI não concluiu a resposta" + (data.error?.message ? `: ${data.error.message}` : "."));
    const usage = responsesUsage(data.usage);
    if (usage) { consumed = addTokenUsage(consumed, usage); consumed.partial = missingUsage || undefined; onUsage?.(consumed); }
    else { missingUsage = true; if (consumed) { consumed.partial = true; onUsage?.(consumed); } }
    const output = Array.isArray(data.output) ? data.output : [];
    let text = "";
    const calls: Item[] = [];
    for (const item of output) {
      if (item.type === "message") {
        for (const part of (item.content as Item[] | undefined) || []) {
          if (part.type !== "output_text") continue;
          text += String(part.text || "");
          const files: Buffer[] = [];
          for (const note of (part.annotations as Item[] | undefined) || []) {
            if (note.type !== "container_file_citation" || !IMAGE_FILE.test(String(note.filename || "")) || downloaded.has(String(note.file_id))) continue;
            downloaded.add(String(note.file_id));
            files.push(await containerImage(String(note.container_id), String(note.file_id)));
          }
          if (files.length) await onBuiltin?.({ tool: "code_interpreter", input: "Arquivos gerados pelo código", output: `${files.length} imagem(ns) gerada(s).`, images: files });
        }
      } else if (item.type === "function_call") calls.push(item);
      else if (item.type === "web_search_call") {
        const action = (item.action || {}) as { type?: string; query?: string; url?: string; pattern?: string; sources?: { url?: string }[] };
        const sources = (action.sources || []).map((source) => source.url).filter(Boolean);
        await onBuiltin?.({ tool: "web_search", input: action.query || action.url || action.pattern || action.type || "Busca", output: sources.length ? sources.join("\n") : `Status: ${item.status || "concluída"}`, images: [] });
      } else if (item.type === "code_interpreter_call") {
        const outputs = (item.outputs as { type?: string; logs?: string; url?: string }[] | null | undefined) || [];
        const logs = outputs.filter((o) => o.type === "logs").map((o) => o.logs || "").join("\n");
        const files = outputs.filter((o) => o.type === "image" && o.url?.startsWith("data:image/")).map((o) => Buffer.from(o.url!.slice(o.url!.indexOf(",") + 1), "base64"));
        await onBuiltin?.({ tool: "code_interpreter", input: String(item.code || ""), output: logs || `Status: ${item.status || "concluído"}`, images: files });
      } else if (item.type === "image_generation_call") {
        const files = typeof item.result === "string" && item.result ? [Buffer.from(item.result, "base64")] : [];
        await onBuiltin?.({ tool: "image_generation", input: String(item.revised_prompt || "Geração de imagem"), output: files.length ? "Imagem gerada." : `Status: ${item.status || "sem imagem"}`, images: files });
      }
    }
    text = withoutSandboxLinks(text);
    if (text) onText?.(text);
    if (!calls.length) {
      if (!text && data.status === "incomplete") throw new Error(`A OpenAI interrompeu a resposta (${data.incomplete_details?.reason || "incompleta"}). Aumente o máximo de tokens de saída ou simplifique o pedido.`);
      return text;
    }
    const results = [];
    for (const call of calls) {
      signal?.throwIfAborted();
      const tool = tools.find((t) => t.name === call.name);
      let result: string;
      try {
        if (!tool) throw new Error("Ferramenta não autorizada.");
        result = await tool.call(call.arguments ? JSON.parse(String(call.arguments)) : {});
      } catch (err) {
        result = JSON.stringify({ erro: err instanceof Error ? err.message : "Falha na ferramenta." });
      }
      results.push({ type: "function_call_output", call_id: call.call_id, output: String(result).slice(0, 30000) });
    }
    // A resposta anterior fica guardada na OpenAI; a próxima volta envia só os resultados das ferramentas.
    previous = data.id;
    input = results;
  }
  throw new Error("O agente excedeu o limite de chamadas de ferramentas.");
}
