import { addTokenUsage, tokenUsage, type TokenUsage } from "./token-usage";
import { providerFailure, fetchWithRateLimitRetry } from "./ai-provider-error";
import { interpretarFalha } from "./ai";
import type { AgentTool } from "./chatgpt";
type Msg =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] }
  | { role: "assistant"; content: string | null; tool_calls?: Call[]; reasoning_details?: unknown }
  | { role: "tool"; tool_call_id: string; content: string };
type Call = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export async function runChatCompletion({
  key,
  url,
  parameters = {},
  system,
  prompt,
  model,
  tools = [],
  images = [],
  history: previous = [],
  signal,
  onText,
  onUsage,
  fetcher = fetch,
}: {
  key: string;
  url: string;
  parameters?: Record<string, unknown>;
  system: string;
  prompt: string;
  model?: string;
  tools?: AgentTool[];
  images?: string[];
  /** Turnos anteriores da conversa (pessoa e assistente), enviados com seus papéis antes da mensagem atual. */
  history?: { role: "user" | "assistant"; content: string }[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onUsage?: (usage: TokenUsage) => void;
  fetcher?: typeof fetch;
}): Promise<string> {
  const history: Msg[] = [
    { role: "system", content: system },
    ...previous.map((turn): Msg => ({ role: turn.role, content: turn.content })),
    { role: "user", content: images.length ? [{ type: "text", text: prompt }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))] : prompt },
  ];
  let consumed: TokenUsage | undefined;
  let missingUsage = false;
  for (let round = 0; round < 12; round++) {
    if (signal?.aborted) throw new Error("Execução cancelada.");
    const { response: res, detail } = await fetchWithRateLimitRetry(() => fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/startse/build-agentflows",
        "X-Title": "Build Agentflows",
      },
      body: JSON.stringify({
        model,
        messages: history,
        ...parameters,
        ...(tools.length
          ? {
              tools: tools.map((t) => ({
                type: "function",
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.schema,
                },
              })),
            }
          : {}),
      }),
      signal,
      redirect: "error",
    }), signal);
    if (!res.ok) throw url.startsWith("https://openrouter.ai/") ? interpretarFalha(res, detail) : providerFailure(res.status, detail);
    const data = await res.json();
    const usage = tokenUsage(data?.usage, "openrouter");
    if (usage) { consumed = addTokenUsage(consumed, usage); consumed.partial = missingUsage || undefined; onUsage?.(consumed); }
    else { missingUsage = true; if (consumed) { consumed.partial = true; onUsage?.(consumed); } }
    const choice = data?.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw new Error("O modelo devolveu uma resposta vazia. Tente novamente.");
    const text = String(msg.content || "");
    if (text) onText?.(text);
    if (choice.finish_reason !== "tool_calls" || !msg.tool_calls?.length)
      return text;
    history.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls, ...(msg.reasoning_details ? { reasoning_details: msg.reasoning_details } : {}) });
    for (const call of msg.tool_calls as Call[]) {
      signal?.throwIfAborted();
      const tool = tools.find((t) => t.name === call.function.name);
      let result: string;
      try {
        if (!tool) throw new Error("Ferramenta não autorizada.");
        const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        result = await tool.call(args);
      } catch (err) {
        result = JSON.stringify({ erro: err instanceof Error ? err.message : "Falha na ferramenta." });
      }
      history.push({ role: "tool", tool_call_id: call.id, content: String(result).slice(0, 30000) });
    }
  }
  throw new Error("O agente excedeu o limite de chamadas de ferramentas.");
}
