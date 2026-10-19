// Bloco Decisão: perguntas fechadas respondidas por um modelo de decisão (Jev pelo OpenRouter ou Decisions API da OpenAI).
// Puro: usado pelo editor, pela validação do grafo e pelo motor.
export type DecisionType = "choice" | "yesno" | "score";
export type DecisionOption = { id: string; value: string; description: string };
export type DecisionQuestion = { id: string; name: string; type: DecisionType; instructions: string; options: DecisionOption[]; variable?: string };
export const DECISION_TYPES: [DecisionType, string][] = [["choice", "Escolha entre opções"], ["yesno", "Sim ou não"], ["score", "Nota em níveis"]];
/** Modelos de decisão por fornecedor: o Jev e o GPT-6 Luna pelo OpenRouter, ou o GPT-6 Luna direto na OpenAI. */
export const DECISION_MODELS = [
  { id: "openrouter:~typesafe/jev-latest", name: "Jev (versão mais recente)", provider: "openrouter" },
  { id: "openrouter:typesafe/jev-1.14", name: "Jev 1.14", provider: "openrouter" },
  { id: "openrouter:typesafe/jev-1.13", name: "Jev 1.13", provider: "openrouter" },
  { id: "openrouter:openai/gpt-6-luna-decisions", name: "GPT-6 Luna Decisions", provider: "openrouter" },
  { id: "openai:gpt-6-luna", name: "GPT-6 Luna (Decisions API)", provider: "openai" },
] as const;
export type DecisionProvider = (typeof DECISION_MODELS)[number]["provider"];
export const DECISION_PROVIDERS: { id: DecisionProvider; name: string }[] = [{ id: "openrouter", name: "OpenRouter" }, { id: "openai", name: "OpenAI" }];
export const DEFAULT_DECISION_MODEL = DECISION_MODELS[0].id;
export const decisionProvider = (model = ""): DecisionProvider | undefined => DECISION_MODELS.find((m) => m.id === model)?.provider;
/** Modelos que só respondem perguntas fechadas: o Agente e o LLM os recusam. O GPT-6 Luna direto na OpenAI também conversa. */
export const decisionOnlyModel = (model = "") => /^openrouter:~?typesafe\//.test(model) || /^openrouter:[^:]*-decisions?$/.test(model);
/** Marca a resposta que não corresponde a uma opção (recusa, valor fora da lista): vira null no resultado. */
export const DECISION_FALLBACK = "incerto";
export const YES_NO: DecisionOption[] = [{ id: "true", value: "Sim", description: "" }, { id: "false", value: "Não", description: "" }];
export const MAX_DECISION_QUESTIONS = 20;
const NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,60}$/;
const OPTION_ID = /^[a-zA-Z0-9_-]{1,80}$/;
export function defaultDecisionQuestions(): DecisionQuestion[] {
  return [{
    id: "q_categoria", name: "categoria", type: "choice", instructions: "Qual equipe deve cuidar desta solicitação?",
    options: [
      { id: "opt_suporte", value: "suporte", description: "Dúvidas de uso, erros e problemas com o produto" },
      { id: "opt_comercial", value: "comercial", description: "Preços, planos, upgrades e novas contratações" },
    ],
  }];
}
export function decisionQuestions(config: Record<string, string>): DecisionQuestion[] {
  let rows: unknown;
  try { rows = JSON.parse(config.questions || "[]"); } catch { throw new Error("Confira as perguntas da decisão."); }
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_DECISION_QUESTIONS) throw new Error(`Use de 1 a ${MAX_DECISION_QUESTIONS} perguntas na decisão.`);
  const questions = rows as DecisionQuestion[];
  for (const [index, q] of questions.entries()) {
    const label = `pergunta ${index + 1}`;
    if (!q || typeof q !== "object" || typeof q.id !== "string" || !OPTION_ID.test(q.id)) throw new Error(`Confira a ${label} da decisão.`);
    if (typeof q.name !== "string" || !NAME.test(q.name)) throw new Error(`Dê um nome à ${label}: comece com uma letra, sem espaços ou acentos.`);
    if (!DECISION_TYPES.some(([type]) => type === q.type)) throw new Error(`Escolha o tipo da ${label}.`);
    if (typeof q.instructions !== "string" || !q.instructions.trim() || q.instructions.length > 4000) throw new Error(`Escreva a pergunta “${q.name}”.`);
    if (q.variable !== undefined && (typeof q.variable !== "string" || (q.variable && !NAME.test(q.variable)))) throw new Error(`Confira a variável da pergunta “${q.name}”.`);
    const options = q.options;
    const limits = q.type === "choice" ? [2, 255] : q.type === "score" ? [2, 10] : [2, 2];
    if (!Array.isArray(options) || options.length < limits[0] || options.length > limits[1])
      throw new Error(q.type === "score" ? `A pergunta “${q.name}” precisa de 2 a 10 níveis.` : `A pergunta “${q.name}” precisa de ${limits[0]} a ${limits[1]} opções.`);
    if (options.some((o) => !o || typeof o.id !== "string" || !OPTION_ID.test(o.id) || o.id === DECISION_FALLBACK || typeof o.value !== "string" || !o.value.trim() || o.value.length > 200 || typeof o.description !== "string" || o.description.length > 2000))
      throw new Error(`Preencha todas as opções da pergunta “${q.name}”.`);
    if (q.type === "yesno" && (options[0].id !== "true" || options[1].id !== "false")) throw new Error(`Confira as opções da pergunta “${q.name}”.`);
    if (new Set(options.map((o) => o.id)).size !== options.length || new Set(options.map((o) => o.value.trim().toLocaleLowerCase())).size !== options.length)
      throw new Error(`Use opções diferentes entre si na pergunta “${q.name}”.`);
  }
  if (new Set(questions.map((q) => q.id)).size !== questions.length || new Set(questions.map((q) => q.name.toLowerCase())).size !== questions.length)
    throw new Error("Use nomes diferentes para cada pergunta da decisão.");
  const variables = questions.map((q) => q.variable).filter(Boolean);
  if (new Set(variables).size !== variables.length) throw new Error("Cada variável recebe a resposta de uma pergunta só.");
  return questions;
}
/** Confiança mínima em porcentagem (0 a 100); abaixo dela a resposta vira null. Em branco, vale qualquer resposta. */
export function decisionMinConfidence(config: Record<string, string>): number | undefined {
  const raw = config.minConfidence?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("A confiança mínima deve estar entre 0 e 100.");
  return n;
}
export function validateDecisionConfig(config: Record<string, string>) {
  if (!decisionProvider(config.model)) throw new Error("Escolha um modelo de decisão da lista.");
  if (!config.input?.trim()) throw new Error("Informe o conteúdo a avaliar na decisão.");
  decisionQuestions(config);
  decisionMinConfidence(config);
  if (config.outputFormat && !DECISION_FORMATS.some(([id]) => id === config.outputFormat)) throw new Error("Escolha o formato do resultado da decisão.");
}
/** Formato do resultado: só as respostas ({"categoria": "suporte"}) ou completo, com confiança e probabilidades. */
export const DECISION_FORMATS: [string, string][] = [["answers", "Só as respostas"], ["full", "Completo, com confiança e probabilidades"]];
export const decisionFormat = (config: Record<string, string>) => config.outputFormat === "full" ? "full" : "answers";
