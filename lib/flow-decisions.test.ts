import test from "node:test";
import assert from "node:assert/strict";
import { createTenantTestContext, commitTestConfig } from "../scripts/tenant-test-context";
import { saveToolCredential } from "./tool-credential-store";
import { decisionOnlyModel, decisionQuestions, validateDecisionConfig, DECISION_FALLBACK, YES_NO, type DecisionQuestion } from "./flow-decisions";
import { decisionAnswer, decisionResult, openAIQuestion, openRouterQuestion, runDecision, OPENAI_DECISIONS_URL, OPENROUTER_DECISIONS_URL } from "./decision-models";
import { block, type Graph } from "./flow-types";
import { outputs, upgradeGraph } from "./flow-graph";
import { validateGraph } from "./flow-store";
import { createFlow, saveFlow } from "./flow-service";
import { startRun } from "./flow-runtime";
import { runProviderModel } from "./ai-runtime";
import { GENERATOR_SYSTEM } from "./flow-generator";

const area: DecisionQuestion = { id: "q1", name: "area", type: "choice", instructions: "Qual equipe atende?", variable: "area", options: [
  { id: "opt_fin", value: "financeiro", description: "Pagamentos e reembolsos" },
  { id: "opt_tec", value: "tecnico", description: "" },
] };
const urgent: DecisionQuestion = { id: "q2", name: "urgente", type: "yesno", instructions: "É urgente?", options: [{ ...YES_NO[0], description: "Prazo explícito" }, { ...YES_NO[1] }] };
const mood: DecisionQuestion = { id: "q3", name: "humor", type: "score", instructions: "Quão irritado?", options: [
  { id: "l0", value: "Calmo", description: "" }, { id: "l1", value: "Frustrado", description: "Reclama" }, { id: "l2", value: "Furioso", description: "" },
] };
const config = (questions: DecisionQuestion[], extra: Record<string, string> = {}) => ({ model: "openrouter:~typesafe/jev-latest", input: "{{input}}", questions: JSON.stringify(questions), ...extra });

test("decisão valida as perguntas e tem uma saída só", () => {
  assert.deepEqual(outputs("decision", config([area, urgent])), [{ id: null, label: "" }]);
  assert.throws(() => validateDecisionConfig(config([area], { outputFormat: "xml" })), /formato do resultado/);
  validateDecisionConfig(config([area, urgent, mood], { minConfidence: "70" }));
  assert.throws(() => validateDecisionConfig({ ...config([area]), model: "openai:gpt-6-luna-mini" }), /modelo de decisão/);
  assert.throws(() => validateDecisionConfig({ ...config([area]), model: "typesafe:jev-latest" }), /modelo de decisão/, "TypeSafe direto saiu da lista");
  validateDecisionConfig({ ...config([area]), model: "openai:gpt-6-luna" });
  assert.throws(() => validateDecisionConfig(config([area], { minConfidence: "120" })), /entre 0 e 100/);
  assert.throws(() => decisionQuestions(config([])), /de 1 a 20/);
  assert.throws(() => decisionQuestions(config([{ ...area, name: "1 área" }])), /comece com uma letra/);
  assert.throws(() => decisionQuestions(config([{ ...area, options: [area.options[0]] }])), /2 a 255 opções/);
  assert.throws(() => decisionQuestions(config([{ ...area, options: [area.options[0], { ...area.options[1], value: "Financeiro" }] }])), /opções diferentes/);
  assert.throws(() => decisionQuestions(config([{ ...area, options: [area.options[0], { ...area.options[1], value: " " }] }])), /Preencha todas/);
  assert.throws(() => decisionQuestions(config([{ ...mood, options: Array.from({ length: 11 }, (_, i) => ({ id: `l${i}`, value: `N${i}`, description: "" })) }])), /2 a 10 níveis/);
  assert.throws(() => decisionQuestions(config([area, { ...urgent, name: "AREA" }])), /nomes diferentes/);
  assert.throws(() => decisionQuestions(config([area, { ...urgent, variable: "area" }])), /uma pergunta só/);
});

test("OpenRouter: perguntas viram noul, choice e score e as respostas são normalizadas", () => {
  assert.deepEqual(openRouterQuestion(area, "Qual?"), { type: "choice", instructions: "Qual?", criteria: { financeiro: "Pagamentos e reembolsos", tecnico: "" } });
  assert.deepEqual(openRouterQuestion(urgent, "É?"), { type: "noul", instructions: "É?", criteria: { true: "Prazo explícito", false: "Não" } });
  assert.deepEqual(openRouterQuestion({ ...urgent, options: YES_NO }, "É?"), { type: "noul", instructions: "É?" }, "sem descrições, o critério fica com o modelo");
  assert.deepEqual(openRouterQuestion(mood, "Quão?").criteria, ["Calmo", "Frustrado: Reclama", "Furioso"]);
  const choice = decisionAnswer(area, { type: "choice", choice: "tecnico", probabilities: { financeiro: 0.2, tecnico: 0.8 }, confidence: 0.7 });
  assert.deepEqual(choice, { question: "area", optionId: "opt_tec", value: "tecnico", confidence: 0.7, probabilities: [{ value: "financeiro", probability: 0.2 }, { value: "tecnico", probability: 0.8 }] });
  assert.equal(decisionAnswer(area, { type: "choice", choice: "vendas" }).optionId, DECISION_FALLBACK, "opção fora da lista vai para Incerta");
  assert.deepEqual(decisionAnswer(urgent, { type: "noul", noul: 0.2 }), { question: "urgente", optionId: "false", value: "Não", confidence: 0.8, probabilities: [{ value: "Sim", probability: 0.2 }, { value: "Não", probability: 0.8 }] });
  const score = decisionAnswer(mood, { type: "score", score: 1.05, probabilities: { 0: 0, 1: 0.95, 2: 0.05 }, confidence: 0.92 });
  assert.equal(score.value, "Frustrado"); assert.equal(score.score, 1.05); assert.equal(score.confidence, 0.92);
  assert.equal(decisionAnswer(mood, { type: "score", score: 1.8 }).value, "Furioso", "sem probabilidades, usa a nota mais próxima");
  assert.equal(decisionAnswer(urgent, undefined).optionId, DECISION_FALLBACK);
});

test("OpenRouter: envia todas as perguntas numa chamada com a chave e explica recusas", async () => {
  const bodies: Record<string, unknown>[] = [];
  const result = await runDecision({ key: "segredo", model: "openrouter:~typesafe/jev-latest", state: "Pagamento falhou", questions: [{ question: area, instructions: "Qual?" }, { question: urgent, instructions: "É?" }],
    fetcher: async (url, init) => {
      assert.equal(String(url), OPENROUTER_DECISIONS_URL);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer segredo");
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ model: "typesafe/jev-1.14-20261001", answers: { area: { type: "choice", choice: "financeiro", probabilities: { financeiro: 0.9, tecnico: 0.1 }, confidence: 0.85 }, urgente: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 40, output_tokens: 3, cost: 0.0000017 } });
    } });
  assert.deepEqual(Object.keys(bodies[0]), ["model", "state", "questions"]);
  assert.equal(bodies[0].model, "~typesafe/jev-latest");
  assert.deepEqual(Object.keys(bodies[0].questions as object), ["area", "urgente"]);
  assert.deepEqual(result.answers.map((a) => a.value), ["financeiro", "Sim"]);
  assert.deepEqual(result.usage, { input: 40, output: 3, total: 43, cost: 0.0000017 });
  await assert.rejects(runDecision({ key: "k", model: "openrouter:typesafe/jev-1.13", state: "x", questions: [{ question: area, instructions: "Qual?" }],
    fetcher: async () => Response.json({ error: { code: 400, message: "questions.area.criteria: field required" } }, { status: 400 }) }), /recusou os parâmetros/);
});

test("OpenAI: Decisions API com perguntas em lista, respostas por nome e recusa", async () => {
  assert.deepEqual(openAIQuestion(area, "Qual?"), { type: "choice", name: "area", instructions: "Qual?", choices: [{ value: "financeiro", description: "Pagamentos e reembolsos" }, { value: "tecnico" }] });
  assert.deepEqual(openAIQuestion(urgent, "É?"), { type: "predicate", name: "urgente", instructions: "É?\nSim quando: Prazo explícito" });
  assert.deepEqual(openAIQuestion(mood, "Quão?"), { type: "score", name: "humor", instructions: "Quão?", levels: [{ label: "Calmo" }, { label: "Frustrado", description: "Reclama" }, { label: "Furioso" }] });
  const bodies: Record<string, unknown>[] = [];
  const result = await runDecision({ key: "sk", model: "openai:gpt-6-luna", state: "Fui cobrado duas vezes", questions: [{ question: area, instructions: "Qual?" }, { question: urgent, instructions: "É?" }, { question: mood, instructions: "Quão?" }],
    fetcher: async (url, init) => {
      assert.equal(String(url), OPENAI_DECISIONS_URL);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk");
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ answers: [
        { type: "score", name: "humor", score: 1.1, probabilities: [{ value: 0, label: "Calmo", probability: 0.1 }, { value: 1, label: "Frustrado", probability: 0.7 }, { value: 2, label: "Furioso", probability: 0.2 }], confidence: 0.55 },
        { type: "choice", name: "area", choice: "financeiro", probabilities: [{ value: "financeiro", probability: 0.95 }, { value: "tecnico", probability: 0.05 }], confidence: 0.93 },
        { type: "refusal", name: "urgente" },
      ], usage: { input_tokens: 25, output_tokens: 0 } });
    } });
  assert.deepEqual(Object.keys(bodies[0]), ["model", "input", "questions"]);
  assert.equal(bodies[0].model, "gpt-6-luna");
  assert.equal(bodies[0].input, "Fui cobrado duas vezes");
  assert.deepEqual((bodies[0].questions as { name: string }[]).map((q) => q.name), ["area", "urgente", "humor"]);
  assert.deepEqual(result.answers.map((a) => a.value), ["financeiro", "", "Frustrado"], "a ordem segue as perguntas; recusa não escolhe opção");
  assert.equal(result.answers[1].optionId, DECISION_FALLBACK);
  assert.deepEqual(result.answers[0].probabilities, [{ value: "financeiro", probability: 0.95 }, { value: "tecnico", probability: 0.05 }]);
  assert.equal(result.answers[2].confidence, 0.55);
  assert.deepEqual(result.usage, { input: 25, output: 0, total: 25 });
  assert.equal(decisionAnswer(urgent, { type: "predicate", name: "urgente", probability: 0.3 }).value, "Não");
});

test("resultado em JSON tipado por pergunta, com null abaixo da confiança mínima", () => {
  const answers = [
    decisionAnswer(area, { type: "choice", choice: "financeiro", probabilities: { financeiro: 0.85, tecnico: 0.15 }, confidence: 0.8 }),
    decisionAnswer(urgent, { type: "noul", noul: 0.9 }),
    decisionAnswer(mood, { type: "score", score: 1.1, probabilities: { 0: 0.1, 1: 0.7, 2: 0.2 }, confidence: 0.55 }),
  ];
  assert.deepEqual(decisionResult([area, urgent, mood], answers, undefined, "answers"), { result: { area: "financeiro", urgente: true, humor: 1.1 }, values: { area: "financeiro", urgente: "true", humor: "1.1" } });
  assert.deepEqual(decisionResult([area, urgent, mood], answers, 60, "answers").result, { area: "financeiro", urgente: true, humor: null }, "nota com 55% de confiança fica null");
  assert.deepEqual(decisionResult([area, urgent, mood], answers, 60, "full").result, {
    area: { answer: "financeiro", confidence: 0.8, probabilities: { financeiro: 0.85, tecnico: 0.15 } },
    urgente: { answer: true, probability: 0.9 },
    humor: { answer: null, level: null, confidence: 0.55, probabilities: { Calmo: 0.1, Frustrado: 0.7, Furioso: 0.2 } },
  });
  const refused = decisionAnswer(area, { type: "refusal" });
  assert.equal(refused.optionId, DECISION_FALLBACK);
  assert.deepEqual(decisionResult([area], [refused], undefined, "answers"), { result: { area: null }, values: {} });
  assert.equal(decisionResult([mood], [decisionAnswer(mood, { type: "score", probabilities: { 0: 0, 1: 0.5, 2: 0.5 } })], undefined, "answers").result.humor, 1.5, "sem nota, usa a média ponderada dos níveis");
});

test("fluxos antigos da Decisão ficam com a conexão da primeira opção", () => {
  const decision = block("decision", "triagem", 0, 0); decision.data.config = config([area]);
  const graph: Graph = { nodes: [block("start", "inicio", 0, 0), decision, block("end", "fin", 0, 0), block("end", "tec", 0, 0), block("end", "duvida", 0, 0)], edges: [
    { id: "a", source: "inicio", target: "triagem" },
    { id: "c", source: "triagem", target: "tec", sourceHandle: "opt_tec" },
    { id: "b", source: "triagem", target: "fin", sourceHandle: "opt_fin" },
    { id: "d", source: "triagem", target: "duvida", sourceHandle: DECISION_FALLBACK },
  ] };
  const upgraded = upgradeGraph(graph);
  assert.deepEqual(upgraded.edges.map((e) => [e.id, e.sourceHandle]), [["a", undefined], ["b", undefined]]);
  assert.equal(upgradeGraph(upgraded), upgraded, "migração idempotente");
});

test("motor devolve o JSON, guarda variáveis e a Decisão pode encerrar o fluxo", async (t) => {
  const tenant = await createTenantTestContext(); t.after(tenant.close);
  await tenant.asTenant(async () => {
    const c = saveToolCredential({ name: "OpenRouter", provider: "ai_openrouter", fields: { OPENROUTER_API_KEY: "chave-jev" } }); await commitTestConfig();
    const start = block("start", "inicio", 0, 0); start.data.config.state = JSON.stringify({ area: "", urgente: "" });
    const decision = block("decision", "triagem", 300, 0);
    decision.data.config = { ...config([{ ...area }, { ...urgent, variable: "urgente" }], { minConfidence: "60" }), modelCredentialId: c.id };
    const route = block("condition", "rota", 600, 0);
    route.data.config = { criteria: JSON.stringify([{ id: "fin", value: "{{fluxo.area}}", operator: "equals", compare: "financeiro" }]) };
    const fin = block("end", "fin", 900, 0), other = block("end", "outro", 900, 150);
    fin.data.config.text = "Financeiro (urgente: {{fluxo.urgente}}) | {{last}}";
    other.data.config.text = "Outro: {{fluxo.area}}";
    const graph: Graph = { nodes: [start, decision, route, fin, other], edges: [
      { id: "a", source: "inicio", target: "triagem" },
      { id: "b", source: "triagem", target: "rota" },
      { id: "c", source: "rota", target: "fin", sourceHandle: "fin" },
      { id: "d", source: "rota", target: "outro", sourceHandle: "no" },
    ] };
    validateGraph(graph, true);
    const missing = structuredClone(graph); missing.nodes[0].data.config.state = "{}";
    assert.throws(() => validateGraph(missing, true), /variável que não existe no Início/);
    const f = await createFlow("Triagem"); await saveFlow(f.id, { ...f, graph });
    let confidence = 0.85;
    const requests: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
      assert.equal(String(url), OPENROUTER_DECISIONS_URL);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer chave-jev");
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ answers: { area: { type: "choice", choice: "financeiro", probabilities: { financeiro: confidence, tecnico: 1 - confidence }, confidence }, urgente: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 30, output_tokens: 2, cost: 0.000001 } });
    });
    const run = await startRun(f.id, "Meu pagamento falhou", false, false);
    assert.equal(run.status, "completed", run.error);
    assert.equal(requests[0].model, "~typesafe/jev-latest");
    assert.equal(requests[0].state, "Meu pagamento falhou");
    assert.equal(run.output, 'Financeiro (urgente: true) | {\n  "area": "financeiro",\n  "urgente": true\n}', "{{Etapa anterior}} depois da Decisão é o JSON");
    const step = run.trace.find((trace) => trace.nodeId === "triagem")!;
    assert.match(step.notes || "", /Probabilidades\narea: financeiro 85% · tecnico 15% \(confiança 85%\)/);
    assert.deepEqual(step.usage, { input: 30, output: 2, total: 32, cost: 0.000001 });
    confidence = 0.55;
    const unsure = await startRun(f.id, "Oi", false, false);
    assert.equal(unsure.output, "Outro: ", "abaixo da confiança mínima a resposta fica null e a variável não muda");
    assert.match(unsure.trace.find((trace) => trace.nodeId === "triagem")!.notes || "", /abaixo de 60% de confiança: area/);
    // Sem nada depois, a Decisão encerra o fluxo e entrega o JSON.
    const alone: Graph = { nodes: [start, decision], edges: [{ id: "a", source: "inicio", target: "triagem" }] };
    validateGraph(alone, true);
    await saveFlow(f.id, { ...f, graph: alone });
    confidence = 0.9;
    const final = await startRun(f.id, "Pagamento", false, false);
    assert.equal(final.status, "completed", final.error);
    assert.deepEqual(JSON.parse(final.output), { area: "financeiro", urgente: true });
  });
});

test("modelos só de decisão ficam fora do Agente, do LLM e do gerador de fluxos", async () => {
  await assert.rejects(runProviderModel({ model: "openrouter:~typesafe/jev-latest" }, { system: "s", prompt: "p" }), /bloco Decisão/);
  assert.ok(decisionOnlyModel("openrouter:typesafe/jev-1.14") && decisionOnlyModel("openrouter:openai/gpt-6-luna-decisions"));
  assert.ok(!decisionOnlyModel("openai:gpt-6-luna") && !decisionOnlyModel("openrouter:openai/gpt-6-luna"), "o GPT-6 Luna de conversa continua no Agente");
  assert.doesNotMatch(GENERATOR_SYSTEM, /- decision/);
});
