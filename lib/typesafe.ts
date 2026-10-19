import { providerFailure, fetchWithRateLimitRetry } from "./ai-provider-error";
import type { TokenUsage } from "./token-usage";
import { DECISION_FALLBACK, type DecisionQuestion } from "./flow-decisions";

export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
/** Resposta normalizada de uma pergunta: a opção escolhida (ou nenhuma) e as probabilidades por opção. */
export type DecisionAnswer = {
  question: string;
  optionId: string;
  value: string;
  confidence?: number;
  probabilities: { value: string; probability: number }[];
  score?: number;
};
type JevAnswer = { type?: string; noul?: unknown; choice?: unknown; score?: unknown; probabilities?: Record<string, unknown>; confidence?: unknown };
const probability = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;

// Cada tipo vira a pergunta equivalente do Jev: noul (sim/não), choice (mapa opção → descrição) e score (níveis em ordem).
export function jevQuestion(q: DecisionQuestion, instructions: string) {
  if (q.type === "yesno") {
    const [yes, no] = q.options;
    return { type: "noul", instructions, ...(yes.description.trim() || no.description.trim() ? { criteria: { true: yes.description.trim() || "Sim", false: no.description.trim() || "Não" } } : {}) };
  }
  if (q.type === "score") return { type: "score", instructions, criteria: q.options.map((o) => o.description.trim() ? `${o.value.trim()}: ${o.description.trim()}` : o.value.trim()) };
  return { type: "choice", instructions, criteria: Object.fromEntries(q.options.map((o) => [o.value.trim(), o.description.trim()])) };
}
export function jevAnswer(q: DecisionQuestion, raw: JevAnswer | undefined): DecisionAnswer {
  const none = { question: q.name, optionId: DECISION_FALLBACK, value: "", probabilities: [] };
  if (!raw || typeof raw !== "object") return none;
  if (q.type === "yesno") {
    const p = probability(raw.noul);
    if (p === undefined) return none;
    const yes = p >= 0.5;
    return { question: q.name, optionId: yes ? "true" : "false", value: q.options[yes ? 0 : 1].value, confidence: Math.max(p, 1 - p),
      probabilities: [{ value: q.options[0].value, probability: p }, { value: q.options[1].value, probability: 1 - p }] };
  }
  if (q.type === "score") {
    const probabilities = q.options.map((o, i) => ({ value: o.value, probability: probability(raw.probabilities?.[String(i)]) ?? 0 }));
    const score = typeof raw.score === "number" && Number.isFinite(raw.score) ? raw.score : undefined;
    // O nível é o mais provável; sem probabilidades, o mais próximo da nota média.
    let index = probabilities.some((p) => p.probability > 0) ? probabilities.reduce((best, p, i) => p.probability > probabilities[best].probability ? i : best, 0) : score === undefined ? -1 : Math.round(score);
    if (index < 0 || index >= q.options.length) index = -1;
    if (index < 0) return { ...none, probabilities, score };
    return { question: q.name, optionId: q.options[index].id, value: q.options[index].value, confidence: probability(raw.confidence) ?? probabilities[index].probability, probabilities, score };
  }
  const chosen = q.options.find((o) => o.value.trim() === raw.choice);
  const probabilities = q.options.map((o) => ({ value: o.value, probability: probability(raw.probabilities?.[o.value.trim()]) ?? 0 }));
  if (!chosen) return { ...none, probabilities };
  return { question: q.name, optionId: chosen.id, value: chosen.value, confidence: probability(raw.confidence) ?? probabilities.find((p) => p.value === chosen.value)?.probability, probabilities };
}

/** Chama o endpoint de decisão do Jev com todas as perguntas de uma vez; o Jev não gera texto livre. */
export async function runJev({ key, model, state, questions, signal, fetcher = fetch }: {
  key: string; model: string; state: string; questions: { question: DecisionQuestion; instructions: string }[];
  signal?: AbortSignal; fetcher?: typeof fetch;
}): Promise<{ answers: DecisionAnswer[]; model?: string; usage?: TokenUsage }> {
  const { response, detail } = await fetchWithRateLimitRetry(() => fetcher(TYPESAFE_URL, {
    method: "POST", signal, redirect: "error",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, state, questions: Object.fromEntries(questions.map(({ question, instructions }) => [question.name, jevQuestion(question, instructions)])) }),
  }), signal);
  if (!response.ok) throw providerFailure(response.status, detail);
  const data = await response.json() as { model?: unknown; answers?: Record<string, JevAnswer>; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
  if (!data.answers || typeof data.answers !== "object") throw new Error("O Jev não devolveu respostas.");
  const input = typeof data.usage?.input_tokens === "number" ? data.usage.input_tokens : undefined;
  const output = typeof data.usage?.output_tokens === "number" ? data.usage.output_tokens : 0;
  return {
    answers: questions.map(({ question }) => jevAnswer(question, data.answers![question.name])),
    model: typeof data.model === "string" ? data.model : undefined,
    usage: input === undefined ? undefined : { input, output, total: input + output },
  };
}
