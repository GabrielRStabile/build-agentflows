import nodeTest, { type TestContext } from "node:test";
import { createTenantTestContext } from "../scripts/tenant-test-context";
const testTenant = await createTenantTestContext();
function test(name: string, action: (t: TestContext) => unknown | Promise<unknown>) { return nodeTest(name, async t => { await testTenant.asTenant(() => action(t)); }); }
nodeTest.after(testTenant.close);
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "agentflows-memory-"));
process.env.DATA_DIR = dir;
const { createFlow, saveFlow, getFlow, getRun, validateGraph } = await import("./flow-service");
const { prepareRun, execute, startRun } = await import("./flow-runtime");
const { block } = await import("./flow-types");
const { memoryMessages, memoryPrompt, transcript } = await import("./flow-memory");
const { tenantConversationHistory: conversationHistory } = await import("./conversation");
const { chatGPT } = await import("./chatgpt");
const bridge = await testTenant.asTenant(chatGPT);
bridge.account = async () => ({ account: { type: "chatgpt", email: "fixture@example.com", planType: "plus" }, login: null, error: null });
nodeTest.after(() => rmSync(dir, { recursive: true, force: true }));

async function flow() {
  const created = (await createFlow("Memória"));
  const nodes = [block("start", "inicio", 0, 0), block("agent", "a", 0, 0), block("llm", "b", 0, 0), block("agent", "c", 0, 0)];
  return (await saveFlow(created.id, { ...created, graph: { nodes, edges: nodes.slice(1).map((node, i) => ({ id: `e${i}`, source: nodes[i].id, target: node.id })) } }));
}
const noSummary = async () => { throw new Error("Não deveria resumir"); };

test("Agente e LLM novos e antigos recebem a conversa e todas as respostas anteriores por padrão", async () => {
  const f = (await flow());
  assert.equal(f.graph.nodes[1].data.config.memoryType, "allMessages");
  assert.equal(f.graph.nodes[2].data.config.memoryType, "allMessages");
  delete f.graph.nodes[2].data.config.memoryType;
  (await saveFlow(f.id, f));
  const prompts: string[] = [];
  bridge.run = async ({ prompt }) => { prompts.push(prompt); return ["Resultado exclusivo A", "Resultado exclusivo B", "Conclusão C"][prompts.length - 1]; };
  const run = await prepareRun(f.id, "Pedido original", false, false);
  run.conversation = [{ input: "Pergunta passada", output: "Resposta passada" }];
  const result = await execute(run);
  assert.equal(result.status, "completed");
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) {
    assert.match(prompt, /Pedido original/);
    assert.match(prompt, /Pergunta passada/);
    assert.match(prompt, /Resposta passada/);
  }
  assert.match(prompts[1], /Resultado exclusivo A/);
  assert.match(prompts[2], /Resultado exclusivo A/);
  assert.match(prompts[2], /Resultado exclusivo B/);
  assert.equal((prompts[1].match(/Resultado exclusivo A/g) || []).length, 1);
  assert.equal((prompts[2].match(/Resultado exclusivo B/g) || []).length, 1);
  assert.equal((await getRun(result.id)).trace.filter((entry) => entry.type === "step").length, 4);
});

test("Mensagem preenchida vira a pergunta seguinte, depois da conversa e do resultado anterior", async () => {
  const f = await flow();
  const [, a, b, c] = f.graph.nodes;
  a.data.config.prompt = "Classifique o pedido";
  b.data.config.prompt = "Agora traduza para o inglês";
  c.data.config.prompt = "Confira {{last}}";
  await saveFlow(f.id, f);
  const calls: { prompt: string; history?: { role: string; content: string }[] }[] = [];
  bridge.run = async ({ prompt, history }) => { calls.push({ prompt, history }); return ["Entendido", "Primeira resposta", "First answer", "Ok"][calls.length - 1]; };
  const run = await prepareRun(f.id, "Pedido original", false, false);
  run.conversation = [{ input: "Pergunta passada", output: "Resposta passada" }];
  const result = await execute(run);
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 4, "o primeiro bloco faz duas interações; os demais, uma");
  // A, primeira interação: a conversa (com a memória anterior) recebe uma resposta real.
  assert.deepEqual(calls[0].history, []);
  assert.match(calls[0].prompt, /Pergunta passada/);
  assert.match(calls[0].prompt, /Pedido original$/);
  // A, segunda interação: a Mensagem chega depois dessa resposta, como pergunta seguinte.
  assert.deepEqual(calls[1].history, [{ role: "user", content: calls[0].prompt }, { role: "assistant", content: "Entendido" }]);
  assert.equal(calls[1].prompt, "Classifique o pedido");
  // B: a conversa é a pergunta da pessoa, a resposta de A a primeira resposta e a Mensagem a seguinte.
  assert.deepEqual(calls[2].history, [{ role: "user", content: "Pedido original" }, { role: "assistant", content: "Primeira resposta" }]);
  assert.match(calls[2].prompt, /Agora traduza para o inglês$/);
  assert.doesNotMatch(calls[2].prompt, /Primeira resposta|Pedido original/, "turnos enviados não se repetem na memória");
  assert.match(calls[2].prompt, /Pergunta passada/, "conversas anteriores continuam na memória");
  // C: o resultado anterior citado na Mensagem não vira turno nem abre nova interação.
  assert.deepEqual(calls[3].history, [{ role: "user", content: "Pedido original" }]);
  assert.equal(calls[3].prompt.split("First answer").length - 1, 1);
  const trace = (await getRun(result.id)).trace.filter((entry) => entry.type === "step");
  assert.equal(trace[1].input, "Usuário: Pedido original\n\nAssistente: Entendido\n\nUsuário: Classifique o pedido");
  assert.match(trace[1].memory ?? "", /Pergunta passada/, "a memória fica separada da entrada no registro");
  assert.doesNotMatch(trace[1].input ?? "", /Memória da conversa|Pergunta passada/);
  assert.equal(trace[1].output, "Primeira resposta");
  assert.match(trace[2].input ?? "", /^Usuário: Pedido original\n\nAssistente: Primeira resposta\n\nUsuário: /);
  assert.equal(transcript([], "Só a mensagem"), "Só a mensagem");
});

test("primeiro bloco com Mensagem: responde à conversa e recebe a Mensagem em seguida; a Entrada mostra as duas interações", async () => {
  const f = await flow();
  const supervisor = f.graph.nodes[1];
  supervisor.data.label = "Supervisor";
  supervisor.data.config.system = "Você é o supervisor.";
  supervisor.data.config.prompt = "Padronize a resposta apenas como o nome do próximo agente a agir.";
  await saveFlow(f.id, f);
  const calls: { prompt: string; history?: { role: string; content: string }[] }[] = [];
  bridge.run = async ({ prompt, history }) => { calls.push({ prompt, history }); return ["Entendido o pedido.", "ESCRITOR"][calls.length - 1]; };
  const result = await startRun(f.id, "HIC", false, false);
  assert.equal(result.status, "completed");
  assert.deepEqual(calls[0], { prompt: "HIC", history: [] });
  assert.deepEqual(calls[1], { prompt: "Padronize a resposta apenas como o nome do próximo agente a agir.", history: [{ role: "user", content: "HIC" }, { role: "assistant", content: "Entendido o pedido." }] });
  const step = (await getRun(result.id)).trace.find((entry) => entry.nodeId === supervisor.id)!;
  assert.equal(step.input, "Usuário: HIC\n\nAssistente: Entendido o pedido.\n\nUsuário: Padronize a resposta apenas como o nome do próximo agente a agir.");
  assert.equal(step.memory, undefined, "sem conversas anteriores não há memória a mostrar");
  assert.deepEqual(step.turns, [{ role: "user", content: "HIC" }, { role: "assistant", content: "Entendido o pedido." }, { role: "user", content: "Padronize a resposta apenas como o nome do próximo agente a agir." }]);
  assert.equal(step.notes, undefined);
  assert.equal(step.output, "ESCRITOR");
  assert.equal(step.instructions, "Você é o supervisor.");
});

test("memória desligada isola o contexto do bloco, mas sua resposta continua disponível aos próximos", async () => {
  const f = (await flow());
  f.graph.nodes[2].data.config.memoryEnabled = "false";
  f.graph.nodes[2].data.config.prompt = "Tarefa independente";
  (await saveFlow(f.id, f));
  assert.equal((await getFlow(f.id)).graph.nodes[2].data.config.memoryEnabled, "false");
  const prompts: string[] = [];
  bridge.run = async ({ prompt, history }) => { prompts.push(prompt); assert.deepEqual(history, []); return "Resposta " + prompts.length; };
  const result = await startRun(f.id, "Pedido original", false, false);
  assert.equal(result.status, "completed");
  assert.equal(prompts[1], "Tarefa independente");
  assert.match(prompts[2], /Pedido original/);
  assert.match(prompts[2], /Resposta 1/);
  assert.match(prompts[2], /Resposta 2/);
});

test("janela limita mensagens anteriores sem cortar mensagem da etapa, instruções ou referências", async () => {
  const f = (await flow());
  f.graph.nodes[2].data.config = { ...f.graph.nodes[2].data.config, memoryType: "windowSize", memoryWindowSize: "1", system: "Regra importante", prompt: "Revise {{last}}" };
  (await saveFlow(f.id, f));
  const calls: { prompt: string; system: string }[] = [];
  bridge.run = async ({ prompt, system }) => { calls.push({ prompt, system }); return "Resposta " + calls.length; };
  const result = await startRun(f.id, "Mensagem antiga", false, false);
  assert.equal(result.status, "completed");
  assert.doesNotMatch(calls[1].prompt, /Mensagem antiga/);
  assert.match(calls[1].prompt, /Resposta 1/);
  assert.ok(calls[1].prompt.endsWith("Revise Resposta 1"));
  assert.equal(calls[1].system, "Regra importante");
});

test("resumo usa o mesmo modelo, sem ferramentas, e não substitui as respostas armazenadas", async () => {
  const f = (await flow());
  f.graph.nodes[2].data.config.memoryType = "conversationSummary";
  f.graph.nodes[2].data.config.model = "modelo-do-resumo";
  (await saveFlow(f.id, f));
  const calls: Parameters<typeof bridge.run>[0][] = [];
  bridge.run = async (args) => {
    calls.push(args);
    if (args.system.startsWith("Resuma o histórico")) return "Resumo preparado";
    return "Resposta " + calls.length;
  };
  const result = await startRun(f.id, "Fato a resumir", false, false);
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 4);
  assert.equal(calls[1].model, "modelo-do-resumo");
  assert.deepEqual(calls[1].tools, []);
  assert.equal(calls[1].webSearch, false);
  assert.ok(calls[1].signal);
  assert.equal(calls[1].onText, undefined);
  assert.match(calls[2].prompt, /Resumo preparado/);
  assert.doesNotMatch(calls[2].prompt, /Fato a resumir/);
  assert.ok(calls[2].prompt.endsWith("Resposta 1"));
  assert.match(calls[3].prompt, /Fato a resumir/);
  assert.doesNotMatch(calls[3].prompt, /Resumo preparado/);
});

test("resumo com recentes só resume o excesso, preserva a ordem e mantém a mensagem atual", async () => {
  const run = await prepareRun((await flow()).id, "Mensagem atual", false, false);
  run.conversation = [{ input: "Antiga " + "x".repeat(1000), output: "Recente" }];
  let summarized = "";
  const prompt = await memoryPrompt(run, { memoryType: "conversationSummaryBuffer", memoryMaxTokens: "100" }, run.input, async (history) => { summarized = history; return "Resumo antigo"; });
  assert.match(summarized, /Antiga/);
  assert.doesNotMatch(summarized, /Recente|Mensagem atual/);
  assert.match(prompt, /Resumo antigo/);
  assert.match(prompt, /Recente/);
  assert.doesNotMatch(prompt, /x{100}/);
  assert.ok(prompt.endsWith("Mensagem atual"));
  run.conversation = [{ input: "Curta", output: "Também curta" }];
  assert.match(await memoryPrompt(run, { memoryType: "conversationSummaryBuffer", memoryMaxTokens: "100" }, run.input, noSummary), /Também curta/);
  run.conversation = [];
  assert.equal(await memoryPrompt(run, { memoryType: "conversationSummary" }, run.input, noSummary), "Mensagem atual");
});

test("a resposta de abertura do bloco com Mensagem entra na memória dos próximos; a Mensagem não", async () => {
  const f = await flow();
  const [supervisor, escritor] = [f.graph.nodes[1], f.graph.nodes[2]];
  supervisor.data.label = "Supervisor";
  supervisor.data.config.prompt = "Padronize a resposta apenas como o nome do próximo agente a agir.";
  escritor.data.label = "Escritor";
  await saveFlow(f.id, f);
  const calls: { prompt: string; history?: { role: string; content: string }[] }[] = [];
  const answers = ["Próximo agente: Escritor. Atividade: elaborar um texto sobre o futuro do trabalho.", "ESCRITOR", "Texto escrito.", "Revisado."];
  bridge.run = async ({ prompt, history }) => { calls.push({ prompt, history }); return answers[calls.length - 1]; };
  const result = await startRun(f.id, "O futuro do trabalho", false, false);
  assert.equal(result.status, "completed");
  const run = await getRun(result.id);
  const step = run.trace.find((entry) => entry.nodeId === supervisor.id)!;
  assert.equal(step.opening, answers[0]);
  assert.equal(step.output, "ESCRITOR");
  const next = run.trace.find((entry) => entry.nodeId === escritor.id)!;
  assert.deepEqual(JSON.parse(next.memory!), { mensagens: [
    { role: "user", content: "O futuro do trabalho" },
    { role: "assistant", content: answers[0], name: "Supervisor" },
  ] });
  assert.match(calls[2].prompt, /Atividade: elaborar um texto/);
  assert.doesNotMatch(calls[2].prompt, /Padronize a resposta/);
  assert.match(calls[2].prompt, /Mensagem desta etapa:\nESCRITOR$/);
  assert.deepEqual(memoryMessages(run).map((m) => m.content), ["O futuro do trabalho", answers[0], "ESCRITOR", "Texto escrito.", "Revisado."]);
});

test("depois de Repetir, o resultado anterior fica na memória com o nome do bloco e a etapa recebe a conversa", async () => {
  const created = await createFlow("Repetição");
  const nodes = [block("start", "inicio", 0, 0), block("agent", "Supervisor", 0, 0), block("loop", "volta", 0, 0)];
  nodes[2].data.config = { target: nodes[1].id, limit: "1", limitMessage: "" };
  const graph = { nodes, edges: [{ id: "e0", source: nodes[0].id, target: nodes[1].id }, { id: "e1", source: nodes[1].id, target: nodes[2].id }] };
  const f = await saveFlow(created.id, { ...created, graph });
  // Mensagem em branco: a segunda passagem recebe o assunto, e a primeira resposta vai na memória, com autor.
  let calls: { prompt: string; history?: { role: string; content: string }[] }[] = [];
  bridge.run = async ({ prompt, history }) => { calls.push({ prompt, history }); return ["ESCRITOR", "REVISOR"][calls.length - 1]; };
  let result = await execute(await prepareRun(f.id, "o futuro do trabalho", false, false));
  assert.equal(result.status, "completed");
  assert.equal(result.output, "REVISOR");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].prompt, "o futuro do trabalho");
  assert.match(calls[1].prompt, /Mensagem desta etapa:\no futuro do trabalho$/);
  assert.match(calls[1].prompt, /"content":"ESCRITOR","name":"Agente"/, "a resposta da primeira passagem está na memória, com o nome do bloco");
  assert.equal(calls[1].prompt.split("o futuro do trabalho").length - 1, 1, "a conversa não se repete na memória");
  let steps = (await getRun(result.id)).trace.filter((entry) => entry.type === "step" && entry.nodeId === nodes[1].id);
  assert.equal(steps[1].input, "o futuro do trabalho");
  assert.match(steps[1].memory ?? "", /ESCRITOR/);
  // Mensagem preenchida: a segunda passagem recebe só a Mensagem, sem turno do assistente, e a memória inteira ao lado.
  nodes[1].data.config.prompt = "Decida o próximo agente";
  await saveFlow(f.id, { ...f, graph });
  calls = [];
  bridge.run = async ({ prompt, history }) => { calls.push({ prompt, history }); return ["Abertura", "ESCRITOR", "REVISOR"][calls.length - 1]; };
  result = await execute(await prepareRun(f.id, "o futuro do trabalho", false, false));
  assert.equal(result.output, "REVISOR");
  assert.equal(calls.length, 3, "abertura e Mensagem na primeira passagem; só a Mensagem na segunda");
  assert.deepEqual(calls[2].history, []);
  assert.match(calls[2].prompt, /Mensagem desta etapa:\nDecida o próximo agente$/);
  assert.match(calls[2].prompt, /"content":"o futuro do trabalho"/, "a conversa fica na memória");
  assert.match(calls[2].prompt, /"content":"Abertura","name":"Agente"/);
  assert.match(calls[2].prompt, /"content":"ESCRITOR","name":"Agente"/);
  steps = (await getRun(result.id)).trace.filter((entry) => entry.type === "step" && entry.nodeId === nodes[1].id);
  assert.equal(steps[1].input, "Decida o próximo agente");
  // Memória desligada: o contrato anterior continua, o resultado anterior chega como entrada.
  nodes[1].data.config.prompt = "";
  nodes[1].data.config.memoryEnabled = "false";
  await saveFlow(f.id, { ...f, graph });
  calls = [];
  bridge.run = async ({ prompt, history }) => { calls.push({ prompt, history }); return ["ESCRITOR", "REVISOR"][calls.length - 1]; };
  result = await execute(await prepareRun(f.id, "o futuro do trabalho", false, false));
  assert.equal(calls[1].prompt, "ESCRITOR");
});

test("memória preserva passagens repetidas e exclui chamadas internas de ferramentas", async () => {
  const run = await prepareRun((await flow()).id, "Pedido", false, false);
  const entry = { nodeId: "a", label: "Agente", output: "Primeira passagem", at: "", ms: 1 };
  run.trace = [entry, { ...entry, type: "tool", label: "Ferramenta: busca", output: "Detalhe interno" }, { ...entry, type: "step", output: "Segunda passagem" }];
  const messages = memoryMessages(run);
  assert.deepEqual(messages.map((m) => m.content), ["Pedido", "Primeira passagem", "Segunda passagem"]);
});

test("histórico aceita mais de seis interações e preserva textos longos", async () => {
  const f = (await flow());
  const input = "Pergunta " + "a".repeat(1200);
  const output = "Resposta " + "b".repeat(4500);
  bridge.run = async () => output;
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) ids.push((await startRun(f.id, input, false, false)).id);
  const history = (await conversationHistory(f.id, ids));
  assert.equal(history.length, 7);
  assert.equal(history[0].input, input);
  assert.equal(history[6].output, output);
});

test("salvamento rejeita tipos e limites inválidos; falhas no resumo não são ignoradas", async () => {
  for (const config of [{ memoryType: "inexistente" }, { memoryType: "windowSize", memoryWindowSize: "0" }, { memoryType: "windowSize", memoryWindowSize: "2.5" }, { memoryType: "conversationSummaryBuffer", memoryMaxTokens: "abc" }]) {
    const f = (await flow());
    Object.assign(f.graph.nodes[1].data.config, config);
    assert.throws(() => validateGraph(f.graph), /memória|mensagens|tokens/);
  }
  const f = (await flow());
  f.graph.nodes[2].data.config.memoryType = "conversationSummary";
  (await saveFlow(f.id, f));
  bridge.run = async ({ system }) => { if (system.startsWith("Resuma")) throw new Error("Provedor indisponível"); return "Resposta A"; };
  const result = await startRun(f.id, "Pedido", false, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Provedor indisponível");
  assert.equal(result.outputs.b, undefined);
});

nodeTest("chat conserva o nome entre mensagens e inicia sem histórico após limpar a conversa", async (t) => {
  const { POST } = await import("../app/api/flows/[id]/run/route");
  const { createTenantTestContext } = await import("../scripts/tenant-test-context");
  const { createTenantFlow, getTenantRun } = await import("./tenant-flows");
  const { claimJob } = await import("./saas-jobs");
  const { runClaimedJob } = await import("./saas-worker");
  const tenant = await createTenantTestContext();
  t.after(tenant.close);
  const nodes = [block("start", "inicio", 0, 0), block("agent", "a", 0, 0), block("llm", "b", 0, 0), block("agent", "c", 0, 0)];
  const f = await tenant.asTenant(() => createTenantFlow("Memória", false, {
    name: "Memória", description: "", graph: { nodes, edges: nodes.slice(1).map((node, i) => ({ id: `e${i}`, source: nodes[i].id, target: node.id })) },
  }));
  const prompts: string[] = [];
  const privateBridge = await tenant.asTenant(() => chatGPT());
  const originalAccount = privateBridge.account, originalRun = privateBridge.run;
  t.after(() => { privateBridge.account = originalAccount; privateBridge.run = originalRun; });
  privateBridge.account = bridge.account;
  privateBridge.run = async ({ prompt }) => { prompts.push(prompt); return "Resposta do agente"; };
  const send = async (input: string, conversationRunIds: string[]) => {
    const response = await tenant.connect(() => POST(tenant.request(`/api/flows/${f.id}/run`, {
      method: "POST", body: JSON.stringify({ input, conversationRunIds }),
    }), { params: Promise.resolve({ id: f.id }) }));
    assert.equal(response.status, 202);
    const queued = await response.json();
    const job = await claimJob(tenant.db);
    assert.ok(job);
    assert.equal(job.run_id, queued.id);
    assert.equal((await runClaimedJob(tenant.db, job)).ok, true);
    const completed = await tenant.asTenant(() => getTenantRun(queued.id));
    assert.equal(completed.status, "completed");
    return completed;
  };
  const first = await send("Meu nome é Rafael", []);
  prompts.length = 0;
  await send("Sabe meu nome?", [first.id]);
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) assert.match(prompt, /Meu nome é Rafael/);
  prompts.length = 0;
  await send("Nova conversa", []);
  for (const prompt of prompts) assert.doesNotMatch(prompt, /Rafael|Sabe meu nome/);
});

test("referências nas instruções ou na mensagem não duplicam o conteúdo enviado automaticamente", async () => {
  const f = await flow();
  const [, a, b, c] = f.graph.nodes;
  a.data.config.system = "Atenda o pedido: {{input}}. Repita para conferir: {{ input }}";
  b.data.config.system = "Revise {{nodes.a}} considerando {{input}}";
  c.data.config.prompt = "Pedido: {{input}}";
  await saveFlow(f.id, f);
  const calls: { system: string; prompt: string; history?: { role: string; content: string }[] }[] = [];
  bridge.run = async ({ system, prompt, history }) => { calls.push({ system, prompt, history }); return ["Rascunho exclusivo", "Revisão exclusiva", "Final"][calls.length - 1]; };
  const run = await prepareRun(f.id, "Pedido original", false, false);
  run.conversation = [{ input: "Pergunta passada", output: "Resposta passada" }];
  const result = await execute(run);
  assert.equal(result.status, "completed");
  const count = (call: { system: string; prompt: string }, text: string) => (call.system + "\n" + call.prompt).split(text).length - 1;
  // A: duas referências escritas pelo usuário; nada é acrescentado como mensagem ou memória.
  assert.equal(count(calls[0], "Pedido original"), 2);
  assert.equal(calls[0].prompt.endsWith("Siga as instruções."), true);
  assert.match(calls[0].prompt, /Pergunta passada/, "conversas anteriores continuam na memória");
  // B: a saída anterior (mensagem automática) e a entrada já estão nas instruções.
  assert.equal(count(calls[1], "Rascunho exclusivo"), 1);
  assert.equal(count(calls[1], "Pedido original"), 1);
  // C: a entrada citada na mensagem sai do histórico e da troca; a resposta anterior vira o turno do assistente.
  assert.equal(count(calls[2], "Pedido original"), 1);
  assert.deepEqual(calls[2].history, [{ role: "assistant", content: "Revisão exclusiva" }]);
  assert.doesNotMatch(calls[2].prompt, /Revisão exclusiva/);
});

test("aprovação não repete o resultado anterior já citado no texto de revisão", async () => {
  const created = await createFlow("Aprovação");
  for (const [text, expected] of [["Revise: {{last}}", "Revise: Pedido"], ["Revise com atenção", "Revise com atenção\n\nPedido"]]) {
    const nodes = [block("start", "inicio", 0, 0), block("approval", "ok", 0, 0), block("end", "fim", 0, 0), block("end", "recusa", 0, 0)];
    nodes[1].data.config.prompt = text;
    await saveFlow(created.id, { ...created, graph: { nodes, edges: [{ id: "e1", source: "inicio", target: "ok" }, { id: "e2", source: "ok", sourceHandle: "yes", target: "fim" }, { id: "e3", source: "ok", sourceHandle: "no", target: "recusa" }] } });
    const result = await execute(await prepareRun(created.id, "Pedido", false, false));
    assert.equal(result.status, "waiting");
    assert.equal(result.trace.at(-1)?.output, expected);
  }
});
