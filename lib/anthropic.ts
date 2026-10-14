import { addTokenUsage, type TokenUsage } from "./token-usage";
import { providerFailure } from "./ai-provider-error";
import type { runChatCompletion } from "./chat-completion";

type Content = { type: string; text?: string; id?: string; name?: string; input?: unknown; [key: string]: unknown };
export async function runAnthropic({ key, model, system, prompt, images = [], tools = [], history = [], signal, onText, onUsage, fetcher = fetch, settings = {} }:
  Omit<Parameters<typeof runChatCompletion>[0], "url" | "parameters"> & { settings?: { temperature?: number; maxTokens?: number } }) {
  if (settings.temperature !== undefined && (settings.temperature > 1 || /(?:opus|sonnet)-[5-9]/.test(model || ""))) throw new Error("Este modelo Claude não aceita a temperatura configurada.");
  // A conversa precisa começar pela pessoa: um turno inicial do assistente vira texto da mensagem atual.
  const leading = history[0]?.role === "assistant" ? history[0] : undefined;
  const messages: { role: string; content: Content[] }[] = [...history.slice(leading ? 1 : 0).map((turn) => ({ role: turn.role, content: [{ type: "text", text: turn.content }] })), { role: "user", content: [
    { type: "text", text: leading ? `Sua resposta anterior:\n${leading.content}\n\n${prompt}` : prompt },
    ...images.map(url => {
      const data = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(url);
      if (!data) throw new Error("Formato de imagem não suportado pelo Claude.");
      return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
    }),
  ] }];
  let consumed: TokenUsage | undefined, missing = false;
  for (let round = 0; round < 12; round++) {
    signal?.throwIfAborted();
    const response = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, signal, redirect: "error",
      body: JSON.stringify({ model, system, messages, max_tokens: settings.maxTokens || 4000,
        ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
        ...(tools.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema })) } : {}),
      }),
    });
    if (!response.ok) throw providerFailure(response.status);
    const data = await response.json() as { content?: Content[]; stop_reason?: string; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
    if (!data.content?.length) throw new Error("O modelo devolveu uma resposta vazia.");
    if (data.usage) {
      const u = data.usage, input = u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      consumed = addTokenUsage(consumed, { input, output: u.output_tokens, total: input + u.output_tokens, cachedInput: u.cache_read_input_tokens });
      consumed.partial = missing || undefined; onUsage?.(consumed);
    } else { missing = true; if (consumed) { consumed.partial = true; onUsage?.(consumed); } }
    const text = data.content.filter(c => c.type === "text").map(c => c.text || "").join("\n");
    if (text) onText?.(text);
    const calls = data.content.filter(c => c.type === "tool_use");
    if (data.stop_reason !== "tool_use" || !calls.length) return text;
    messages.push({ role: "assistant", content: data.content });
    const results: Content[] = [];
    for (const call of calls) {
      signal?.throwIfAborted();
      try {
        const tool = tools.find(t => t.name === call.name);
        if (!tool) throw new Error("Ferramenta não autorizada.");
        results.push({ type: "tool_result", tool_use_id: call.id, content: String(await tool.call(call.input)).slice(0, 30000) });
      } catch (error) { results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: error instanceof Error ? error.message : "Falha na ferramenta." }); }
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("O agente excedeu o limite de chamadas de ferramentas.");
}
