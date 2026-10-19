import { providerFailure, fetchWithRateLimitRetry } from "./ai-provider-error";
import type { TokenUsage } from "./token-usage";
import { DECISION_FALLBACK, decisionProvider, type DecisionQuestion } from "./flow-decisions";

// Dois fornecedores de modelos de decisão, cada um com seu contrato:
// OpenRouter (Jev e demais modelos de decisão, perguntas num mapa com criteria) e OpenAI (/v1/decisions, perguntas numa lista com name).
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const OPENAI_DECISIONS_URL = "https://api.openai.com/v1/decisions";
/** Resposta normalizada de uma pergunta: a opção escolhida (ou nenhuma) e as probabilidades por opção. */
export type DecisionAnswer = {
  question: string;
  optionId: string;
  value: string;
  confidence?: number;
  probabilities: { value: string; probability: number }[];
  score?: number;
};
type Asked = { question: DecisionQuestion; instructions: string };
type RawAnswer = { type?: string; name?: unknown; noul?: unknown; probability?: unknown; choice?: unknown; score?: unknown; probabilities?: unknown; confidence?: unknown };
const probability = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

// OpenRouter: noul (sim/não), choice (mapa opção → descrição) e score (níveis em ordem), no formato do Jev.
export function openRouterQuestion(q: DecisionQuestion, instructions: string) {
  if (q.type === "yesno") {
    const [yes, no] = q.options;
    return { type: "noul", instructions, ...(yes.description.trim() || no.description.trim() ? { criteria: { true: yes.description.trim() || "Sim", false: no.description.trim() || "Não" } } : {}) };
  }
  if (q.type === "score") return { type: "score", instructions, criteria: q.options.map((o) => o.description.trim() ? `${o.value.trim()}: ${o.description.trim()}` : o.value.trim()) };
  return { type: "choice", instructions, criteria: Object.fromEntries(q.options.map((o) => [o.value.trim(), o.description.trim()])) };
}
// OpenAI: predicate (as descrições de sim/não entram nas instruções), choice com choices e score com levels.
export function openAIQuestion(q: DecisionQuestion, instructions: string) {
  const describe = (o: { description: string }) => o.description.trim() ? { description: o.description.trim() } : {};
  if (q.type === "yesno") {
    const [yes, no] = q.options;
    const criteria = [yes.description.trim() && `Sim quando: ${yes.description.trim()}`, no.description.trim() && `Não quando: ${no.description.trim()}`].filter(Boolean);
    return { type: "predicate", name: q.name, instructions: [instructions, ...criteria].join("\n") };
  }
  if (q.type === "score") return { type: "score", name: q.name, instructions, levels: q.options.map((o) => ({ label: o.value.trim(), ...describe(o) })) };
  return { type: "choice", name: q.name, instructions, choices: q.options.map((o) => ({ value: o.value.trim(), ...describe(o) })) };
}

// Probabilidades chegam como mapa (OpenRouter: opção ou índice → número) ou lista (OpenAI: { value, label?, probability }).
function probabilityOf(raw: unknown, key: string, index?: number) {
  if (Array.isArray(raw)) {
    const item = raw.find((p) => p && typeof p === "object" && (index !== undefined ? p.value === index || p.label === key : p.value === key));
    return probability(item?.probability);
  }
  return raw && typeof raw === "object" ? probability((raw as Record<string, unknown>)[index !== undefined ? String(index) : key]) : undefined;
}
export function decisionAnswer(q: DecisionQuestion, raw: RawAnswer | undefined): DecisionAnswer {
  const none = { question: q.name, optionId: DECISION_FALLBACK, value: "", probabilities: [] };
  if (!raw || typeof raw !== "object" || raw.type === "refusal") return none;
  if (q.type === "yesno") {
    const p = probability(raw.noul ?? raw.probability);
    if (p === undefined) return none;
    const yes = p >= 0.5;
    return { question: q.name, optionId: yes ? "true" : "false", value: q.options[yes ? 0 : 1].value, confidence: Math.max(p, 1 - p),
      probabilities: [{ value: q.options[0].value, probability: p }, { value: q.options[1].value, probability: 1 - p }] };
  }
  if (q.type === "score") {
    const probabilities = q.options.map((o, i) => ({ value: o.value, probability: probabilityOf(raw.probabilities, o.value.trim(), i) ?? 0 }));
    const score = typeof raw.score === "number" && Number.isFinite(raw.score) ? raw.score : undefined;
    // O nível é o mais provável; sem probabilidades, o mais próximo da nota média.
    let index = probabilities.some((p) => p.probability > 0) ? probabilities.reduce((best, p, i) => p.probability > probabilities[best].probability ? i : best, 0) : score === undefined ? -1 : Math.round(score);
    if (index < 0 || index >= q.options.length) index = -1;
    if (index < 0) return { ...none, probabilities, score };
    return { question: q.name, optionId: q.options[index].id, value: q.options[index].value, confidence: probability(raw.confidence) ?? probabilities[index].probability, probabilities, score };
  }
  const chosen = q.options.find((o) => o.value.trim() === raw.choice);
  const probabilities = q.options.map((o) => ({ value: o.value, probability: probabilityOf(raw.probabilities, o.value.trim()) ?? 0 }));
  if (!chosen) return { ...none, probabilities };
  return { question: q.name, optionId: chosen.id, value: chosen.value, confidence: probability(raw.confidence) ?? probabilities.find((p) => p.value === chosen.value)?.probability, probabilities };
}

/** Envia todas as perguntas numa chamada ao fornecedor do modelo ("openrouter:…" ou "openai:…"); modelos de decisão não geram texto. */
export async function runDecision({ key, model, state, questions, signal, fetcher = fetch }: {
  key: string; model: string; state: string; questions: Asked[]; signal?: AbortSignal; fetcher?: typeof fetch;
}): Promise<{ answers: DecisionAnswer[]; model?: string; usage?: TokenUsage }> {
  const provider = decisionProvider(model);
  if (!provider) throw new Error("Escolha um modelo de decisão da lista.");
  const id = model.slice(provider.length + 1);
  const body = provider === "openai"
    ? { model: id, input: state, questions: questions.map(({ question, instructions }) => openAIQuestion(question, instructions)) }
    : { model: id, state, questions: Object.fromEntries(questions.map(({ question, instructions }) => [question.name, openRouterQuestion(question, instructions)])) };
  const { response, detail } = await fetchWithRateLimitRetry(() => fetcher(provider === "openai" ? OPENAI_DECISIONS_URL : OPENROUTER_DECISIONS_URL, {
    method: "POST", signal, redirect: "error",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  }), signal);
  if (!response.ok) throw providerFailure(response.status, detail);
  const data = await response.json() as { model?: unknown; answers?: unknown; usage?: Record<string, unknown> };
  // OpenRouter devolve um mapa por nome; a OpenAI, uma lista em que cada resposta repete o name da pergunta.
  const answers = Array.isArray(data.answers)
    ? Object.fromEntries((data.answers as RawAnswer[]).filter((a) => a && typeof a.name === "string").map((a) => [a.name as string, a]))
    : data.answers && typeof data.answers === "object" ? data.answers as Record<string, RawAnswer> : undefined;
  if (!answers) throw new Error("O modelo de decisão não devolveu respostas.");
  const input = count(data.usage?.input_tokens), output = count(data.usage?.output_tokens) ?? 0, cost = count(data.usage?.cost);
  return {
    answers: questions.map(({ question }) => decisionAnswer(question, answers[question.name])),
    model: typeof data.model === "string" ? data.model : undefined,
    usage: input === undefined ? undefined : { input, output, total: input + output, ...(cost !== undefined ? { cost } : {}) },
  };
}
