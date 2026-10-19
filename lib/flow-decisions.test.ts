import test from "node:test";
import assert from "node:assert/strict";
import { createTenantTestContext, commitTestConfig } from "../scripts/tenant-test-context";
import { saveToolCredential } from "./tool-credential-store";
import { decisionOutputs, decisionQuestions, validateDecisionConfig, DECISION_FALLBACK, YES_NO, type DecisionQuestion } from "./flow-decisions";
import { jevAnswer, jevQuestion, runJev, TYPESAFE_URL } from "./typesafe";
import { block, type Graph } from "./flow-types";
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
const config = (questions: DecisionQuestion[], extra: Record<string, string> = {}) => ({ model: "typesafe:jev-latest", input: "{{input}}", questions: JSON.stringify(questions), ...extra });

test("decisão valida as perguntas e cria uma saída por opção da primeira, mais a Incerta", () => {
  assert.deepEqual(decisionOutputs(config([area, urgent])), [{ id: "opt_fin", label: "financeiro" }, { id: "opt_tec", label: "tecnico" }, { id: DECISION_FALLBACK, label: "Incerta" }]);
  assert.deepEqual(decisionOutputs(config([urgent])).map((o) => o.id), ["true", "false", DECISION_FALLBACK]);
  validateDecisionConfig(config([area, urgent, mood], { minConfidence: "70" }));
  assert.throws(() => validateDecisionConfig({ ...config([area]), model: "openai:gpt-6-luna" }), /modelo Jev/);
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

test("Jev: perguntas viram noul, choice e score e as respostas são normalizadas", () => {
  assert.deepEqual(jevQuestion(area, "Qual?"), { type: "choice", instructions: "Qual?", criteria: { financeiro: "Pagamentos e reembolsos", tecnico: "" } });
  assert.deepEqual(jevQuestion(urgent, "É?"), { type: "noul", instructions: "É?", criteria: { true: "Prazo explícito", false: "Não" } });
  assert.deepEqual(jevQuestion({ ...urgent, options: YES_NO }, "É?"), { type: "noul", instructions: "É?" }, "sem descrições, o critério fica com o modelo");
  assert.deepEqual(jevQuestion(mood, "Quão?").criteria, ["Calmo", "Frustrado: Reclama", "Furioso"]);
  const choice = jevAnswer(area, { type: "choice", choice: "tecnico", probabilities: { financeiro: 0.2, tecnico: 0.8 }, confidence: 0.7 });
  assert.deepEqual(choice, { question: "area", optionId: "opt_tec", value: "tecnico", confidence: 0.7, probabilities: [{ value: "financeiro", probability: 0.2 }, { value: "tecnico", probability: 0.8 }] });
  assert.equal(jevAnswer(area, { type: "choice", choice: "vendas" }).optionId, DECISION_FALLBACK, "opção fora da lista vai para Incerta");
  assert.deepEqual(jevAnswer(urgent, { type: "noul", noul: 0.2 }), { question: "urgente", optionId: "false", value: "Não", confidence: 0.8, probabilities: [{ value: "Sim", probability: 0.2 }, { value: "Não", probability: 0.8 }] });
  const score = jevAnswer(mood, { type: "score", score: 1.05, probabilities: { 0: 0, 1: 0.95, 2: 0.05 }, confidence: 0.92 });
  assert.equal(score.value, "Frustrado"); assert.equal(score.score, 1.05); assert.equal(score.confidence, 0.92);
  assert.equal(jevAnswer(mood, { type: "score", score: 1.8 }).value, "Furioso", "sem probabilidades, usa a nota mais próxima");
  assert.equal(jevAnswer(urgent, undefined).optionId, DECISION_FALLBACK);
});

test("Jev: envia todas as perguntas numa chamada com a chave e explica recusas", async () => {
  const bodies: Record<string, unknown>[] = [];
  const result = await runJev({ key: "segredo", model: "jev-latest", state: "Pagamento falhou", questions: [{ question: area, instructions: "Qual?" }, { question: urgent, instructions: "É?" }],
    fetcher: async (url, init) => {
      assert.equal(String(url), TYPESAFE_URL);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer segredo");
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ model: "jev-1.13.0", answers: { area: { type: "choice", choice: "financeiro", probabilities: { financeiro: 0.9, tecnico: 0.1 }, confidence: 0.85 }, urgente: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 40, output_tokens: 3 } });
    } });
  assert.deepEqual(Object.keys(bodies[0]), ["model", "state", "questions"]);
  assert.deepEqual(Object.keys(bodies[0].questions as object), ["area", "urgente"]);
  assert.deepEqual(result.answers.map((a) => a.value), ["financeiro", "Sim"]);
  assert.deepEqual(result.usage, { input: 40, output: 3, total: 43 });
  await assert.rejects(runJev({ key: "k", model: "jev-latest", state: "x", questions: [{ question: area, instructions: "Qual?" }],
    fetcher: async () => Response.json({ detail: "questions.area.criteria: field required" }, { status: 422 }) }), /recusou os parâmetros/);
});

test("motor segue pela opção do Jev, guarda variáveis e mantém a etapa anterior", async (t) => {
  const tenant = await createTenantTestContext(); t.after(tenant.close);
  await tenant.asTenant(async () => {
    const c = saveToolCredential({ name: "TypeSafe", provider: "ai_typesafe", fields: { TYPESAFE_API_KEY: "chave-jev" } }); await commitTestConfig();
    const start = block("start", "inicio", 0, 0); start.data.config.state = JSON.stringify({ area: "" });
    const decision = block("decision", "triagem", 300, 0);
    decision.data.config = { ...config([area, urgent], { minConfidence: "60" }), modelCredentialId: c.id };
    const fin = block("end", "fin", 600, 0), tec = block("end", "tec", 600, 150), doubt = block("end", "duvida", 600, 300);
    fin.data.config.text = "Financeiro: {{fluxo.area}} | {{last}} | {{nodes.triagem}}";
    tec.data.config.text = "Técnico"; doubt.data.config.text = "Revisar: {{last}}";
    const graph: Graph = { nodes: [start, decision, fin, tec, doubt], edges: [
      { id: "a", source: "inicio", target: "triagem" },
      { id: "b", source: "triagem", target: "fin", sourceHandle: "opt_fin" },
      { id: "c", source: "triagem", target: "tec", sourceHandle: "opt_tec" },
      { id: "d", source: "triagem", target: "duvida", sourceHandle: DECISION_FALLBACK },
    ] };
    validateGraph(graph, true);
    assert.throws(() => validateGraph({ ...graph, edges: graph.edges.filter((e) => e.id !== "d") }, true), /Conecte todas as saídas/);
    const missing = structuredClone(graph); missing.nodes[0].data.config.state = "{}";
    assert.throws(() => validateGraph(missing, true), /variável que não existe no Início/);
    const f = await createFlow("Triagem"); await saveFlow(f.id, { ...f, graph });
    let confidence = 0.85;
    const requests: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
      assert.equal(String(url), TYPESAFE_URL);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer chave-jev");
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ answers: { area: { type: "choice", choice: "financeiro", probabilities: { financeiro: confidence, tecnico: 1 - confidence }, confidence }, urgente: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 30, output_tokens: 2 } });
    });
    const run = await startRun(f.id, "Meu pagamento falhou", false, false);
    assert.equal(run.status, "completed", run.error);
    assert.equal(requests[0].model, "jev-latest");
    assert.equal(requests[0].state, "Meu pagamento falhou");
    assert.equal(run.output, "Financeiro: financeiro | Meu pagamento falhou | area: financeiro (confiança 85%)\nurgente: Sim (confiança 90%)");
    const step = run.trace.find((trace) => trace.nodeId === "triagem")!;
    assert.match(step.notes || "", /Probabilidades\narea: financeiro 85% · tecnico 15%/);
    assert.deepEqual(step.usage, { input: 30, output: 2, total: 32 });
    confidence = 0.55;
    const unsure = await startRun(f.id, "Oi", false, false);
    assert.match(unsure.output, /^Revisar: Oi$/, "abaixo da confiança mínima segue pela saída Incerta");
    assert.match(unsure.trace.find((trace) => trace.nodeId === "triagem")!.output, /abaixo de 60%/);
  });
});

test("Jev fica fora do Agente, do LLM e do gerador de fluxos", async () => {
  await assert.rejects(runProviderModel({ model: "typesafe:jev-latest" }, { system: "s", prompt: "p" }), /bloco Decisão/);
  assert.doesNotMatch(GENERATOR_SYSTEM, /- decision/);
});
