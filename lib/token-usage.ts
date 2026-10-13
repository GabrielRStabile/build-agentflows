export type TokenUsage = { input: number; output: number; total: number; cachedInput?: number; reasoning?: number; partial?: boolean; cost?: number };
function count(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
export function tokenUsage(value: unknown, provider: "chatgpt" | "openrouter"): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const input = count(provider === "chatgpt" ? v.inputTokens : v.prompt_tokens);
  const output = count(provider === "chatgpt" ? v.outputTokens : v.completion_tokens);
  if (input === undefined || output === undefined) return undefined;
  const details = v.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  const completion = v.completion_tokens_details as { reasoning_tokens?: unknown } | undefined;
  return { input, output, total: count(provider === "chatgpt" ? v.totalTokens : v.total_tokens) ?? input + output,
    cachedInput: count(provider === "chatgpt" ? v.cachedInputTokens : details?.cached_tokens),
    reasoning: count(provider === "chatgpt" ? v.reasoningOutputTokens : completion?.reasoning_tokens),
    // OpenRouter reports the amount charged in credits (US dollars). Other providers leave it undefined.
    ...(provider === "openrouter" && count(v.cost) !== undefined ? { cost: count(v.cost) } : {}) };
}
export function addTokenUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (!a) return { ...b };
  return { input: a.input + b.input, output: a.output + b.output, total: a.total + b.total,
    cachedInput: a.cachedInput === undefined && b.cachedInput === undefined ? undefined : (a.cachedInput || 0) + (b.cachedInput || 0),
    reasoning: a.reasoning === undefined && b.reasoning === undefined ? undefined : (a.reasoning || 0) + (b.reasoning || 0), partial: a.partial || b.partial || undefined,
    ...(a.cost === undefined && b.cost === undefined ? {} : { cost: (a.cost || 0) + (b.cost || 0) }) };
}
// Cost appears only when a provider or tool reported it; nothing is estimated.
export function traceCost(trace: { cost?: number; usage?: TokenUsage }) { return trace.cost ?? trace.usage?.cost; }
export function runCost(traces: { cost?: number; usage?: TokenUsage }[]) {
  const known = traces.map(traceCost).filter((cost): cost is number => cost !== undefined);
  return known.length ? known.reduce((total, cost) => total + cost, 0) : undefined;
}
export function formatCost(cost: number) {
  return "US$ " + cost.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: cost < 0.01 ? 6 : 4 });
}
