import nodeTest, { type TestContext } from "node:test";
import { createTenantTestContext } from "../scripts/tenant-test-context";
const testTenant = await createTenantTestContext();
function test(name: string, action: (t: TestContext) => unknown | Promise<unknown>) { return nodeTest(name, async t => { await testTenant.asTenant(() => action(t)); }); }
nodeTest.after(testTenant.close);
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "agentflows-test-"));
process.env.DATA_DIR = dir;
const store = await import("./flow-service");
const { enqueueRun, claimJob, recoverExpiredJobs } = await import("./saas-jobs");
const runtime = await import("./flow-runtime");
const { setConfig } = await import("./store");
const { block, template } = await import("./flow-types");
const { chatGPT } = await import("./chatgpt");
const bridge = await testTenant.asTenant(chatGPT);
bridge.account = async () => ({
  account: { type: "chatgpt", email: "teste@example.com", planType: "plus" },
  login: null,
  error: null,
});
bridge.run = async () => "Resposta ChatGPT simulada no teste";
nodeTest.after(() => rmSync(dir, { recursive: true, force: true }));
async function flow(graph = template()) {
  const f = (await store.createFlow("Teste"));
  return (await store.saveFlow(f.id, { name: f.name, description: "", graph }));
}
test("primeiro salvamento cria o fluxo completo e falhas não deixam registros", async () => {
  const count = (await store.listFlows()).length;
  await assert.rejects(async () => (await store.createSavedFlow({ name: "", description: "", graph: template() })));
  await assert.rejects(async () => (await store.createSavedFlow({ name: "Inválido", description: "", graph: { nodes: null, edges: [] } })));
  assert.equal((await store.listFlows()).length, count);
  const graph = { nodes: [block("start", "inicio", 0, 0)], edges: [] };
  const saved = (await store.createSavedFlow({ name: " Meu fluxo ", description: "", graph }));
  assert.equal(saved.name, "Meu fluxo");
  assert.equal(saved.graph.nodes.length, 1);
  assert.deepEqual((await store.getFlow(saved.id)).graph, graph);
  assert.deepEqual(saved.published, saved.graph);
  assert.equal((await store.listFlows()).length, count + 1);
  (await store.deleteFlow(saved.id));
});
test("testes e integrações executam o último fluxo salvo como v1", async () => {
  const f = (await flow());
  assert.ok(f.published, "Salvar também publica o fluxo");
  const g = template();
  g.nodes[2].data.config.text = "Atualizado";
  (await store.saveFlow(f.id, { name: "Editado", description: "", graph: g }));
  const r = await runtime.startRun(f.id, "Olá", true, true);
  assert.equal(r.status, "completed");
  assert.equal(r.version, 1);
  assert.equal(r.output, "Atualizado");
  assert.equal(r.trace.length, 3);
  const draft = await runtime.startRun(f.id, "Olá", false, true);
  assert.equal(draft.output, "Atualizado");
  assert.equal(draft.version, 1);
  assert.equal((await store.publishFlow(f.id)).version, 1);
  (await store.publishFlow(f.id, false));
  await assert.rejects(() => runtime.startRun(f.id, "Olá", true), /Salve/);
});
test("grafo inválido recusa IDs repetidos, conexões incompletas e blocos órfãos", () => {
  const g = template();
  g.nodes.push(g.nodes[0]);
  assert.throws(() => store.validateGraph(g), /inválido/);
  const b = template();
  b.edges = [];
  assert.throws(() => store.validateGraph(b, true), /Conecte/);
  const c = template();
  c.nodes.push(block("end", "orfao", 0, 0));
  assert.throws(() => store.validateGraph(c, true), /conectados/);
  const d = template();
  d.nodes[0].data.config.state = "[]";
  assert.throws(() => store.validateGraph(d, true), /estado inicial/);
});
test("condição respeita saídas e estado compartilhado", async () => {
  const start = block("start", "start", 0, 0),
    state = block("state", "save", 0, 0),
    condition = block("condition", "check", 0, 0),
    yes = block("end", "yes", 0, 0),
    no = block("end", "no", 0, 0);
  state.data.config = { key: "assunto", value: "{{input}}" };
  condition.data.config.value = "{{state.assunto}}";
  yes.data.config.text = "Prioritário: {{nodes.save}}";
  no.data.config.text = "Normal";
  const f = (await flow({
    nodes: [start, state, condition, yes, no],
    edges: [
      { id: "1", source: "start", target: "save" },
      { id: "2", source: "save", target: "check" },
      { id: "3", source: "check", target: "yes", sourceHandle: "yes" },
      { id: "4", source: "check", target: "no", sourceHandle: "no" },
    ],
  }));
  assert.equal(
    (await runtime.startRun(f.id, "urgente", false, true)).output,
    "Prioritário: urgente",
  );
  assert.equal(
    (await runtime.startRun(f.id, "olá", false, true)).output,
    "Normal",
  );
});
test("aprovação persiste e só uma decisão pode retomar o checkpoint", async () => {
  const g = template();
  g.nodes[1] = block("approval", "analista", 0, 0);
  g.edges[1].sourceHandle = "yes";
  g.nodes.push(block("end", "rejeitada", 0, 0));
  g.nodes[3].data.config.text = "Não aprovado";
  g.edges.push({
    id: "no",
    source: "analista",
    target: "rejeitada",
    sourceHandle: "no",
  });
  const f = (await flow(g));
  const r = await runtime.startRun(f.id, "Revisar", false, true);
  assert.equal(r.status, "waiting");
  await recoverExpiredJobs(testTenant.db);
  assert.equal((await store.getRun(r.id)).status, "waiting");
  await assert.rejects(async () => (await store.deleteFlow(f.id)), /pendentes/);
  const resumed = await runtime.resumeRun(r.id, "no");
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.output, "Não aprovado");
  await assert.rejects(() => runtime.resumeRun(r.id, "yes"), /já foi recebida/);
  const again = await runtime.startRun(f.id, "Revisar", false, true);
  assert.equal((await runtime.cancelRun(again.id)).status, "cancelled");
  await assert.rejects(() => runtime.resumeRun(again.id, "yes"), /já foi recebida/);
});
test("repetição volta ao bloco escolhido até o limite e encerra com a mensagem do limite", async () => {
  const a = block("start", "s", 0, 0),
    v = block("state", "v", 0, 0),
    l = block("loop", "l", 0, 0);
  v.data.config = { key: "a", value: "{{last}}!" };
  l.data.config = { target: "v", limit: "3", limitMessage: "Parei em {{last}} após o limite." };
  const f = (await flow({
    nodes: [a, v, l],
    edges: [
      { id: "a", source: "s", target: "v" },
      { id: "b", source: "v", target: "l" },
    ],
  }));
  const r = await runtime.startRun(f.id, "x", false, true);
  assert.equal(r.status, "completed");
  assert.equal(r.output, "Parei em x!!!! após o limite.");
  assert.equal(r.visits.l, 4);
  assert.equal(r.visits.v, 4);
  // Sem mensagem, o resultado anterior é entregue como resposta.
  l.data.config = { target: "v", limit: "1", limitMessage: "" };
  const quiet = await runtime.startRun((await flow({ nodes: [a, v, l], edges: [{ id: "a", source: "s", target: "v" }, { id: "b", source: "v", target: "l" }] })).id, "y", false, true);
  assert.equal(quiet.output, "y!!");
  // Destino obrigatório e válido na execução (o rascunho pode ser salvo incompleto).
  for (const target of ["", "s", "l"]) {
    l.data.config = { target, limit: "2", limitMessage: "" };
    const draft = await flow({ nodes: [a, v, l], edges: [{ id: "a", source: "s", target: "v" }, { id: "b", source: "v", target: "l" }] });
    await assert.rejects(() => runtime.startRun(draft.id, "z", false, true), /bloco para onde voltar/);
  }
});
test("fluxo antigo com setas Repetir/Concluir continua executando pelo destino migrado", async () => {
  const a = block("start", "s", 0, 0),
    l = block("loop", "l", 0, 0),
    v = block("state", "v", 0, 0),
    e = block("end", "e", 0, 0);
  v.data.config = { key: "a", value: "{{last}}!" };
  l.data.config = { limit: "3" };
  const f = (await flow({
    nodes: [a, l, v, e],
    edges: [
      { id: "a", source: "s", target: "l" },
      { id: "b", source: "l", target: "v", sourceHandle: "repeat" },
      { id: "c", source: "v", target: "l" },
      { id: "d", source: "l", target: "e", sourceHandle: "done" },
    ],
  }));
  assert.equal(f.graph.nodes.find((n) => n.id === "l")?.data.config.target, "v");
  assert.ok(!f.graph.edges.some((edge) => edge.sourceHandle));
  // O bloco que vinha depois de Concluir ficou solto: o editor pede para reconectar ou remover.
  await assert.rejects(() => runtime.startRun(f.id, "x", false, true), /conectados ao Início/);
  const trimmed = (await flow({ ...f.graph, nodes: f.graph.nodes.filter((n) => n.id !== "e") }));
  const r = await runtime.startRun(trimmed.id, "x", false, true);
  assert.equal(r.status, "completed");
  assert.equal(r.output, "x!!!");
  assert.equal(r.visits.l, 4);
});
test("referência ausente falha com diagnóstico e mantém etapas", async () => {
  const g = template();
  g.nodes[2].data.config.text = "{{state.ausente}}";
  const f = (await flow(g));
  const r = await runtime.startRun(f.id, "x", false, true);
  assert.equal(r.status, "failed");
  assert.match(r.error!, /não tem valor/);
  assert.equal(r.trace.length, 2);
});
test("OpenRouter só vale para blocos que escolhem um modelo dele; sem fallback", async () => {
  const account = bridge.account,
    run = bridge.run,
    fetch0 = globalThis.fetch;
  bridge.account = async () => ({ account: null, login: null, error: null });
  bridge.run = async () => {
    throw new Error("Conecte sua conta ChatGPT para executar este agente.");
  };
  setConfig("OPENROUTER_API_KEY", null);
  try {
    const f = (await flow());
    await assert.rejects(
      () => runtime.startRun(f.id, "Olá"),
      /Conecte o ChatGPT/,
    );
    setConfig("OPENROUTER_API_KEY", "sk-or-teste");
    // Bloco em "Automático · ChatGPT" continua exigindo o ChatGPT: nada de cair para outro provedor.
    await assert.rejects(() => runtime.startRun(f.id, "Olá"), /Conecte o ChatGPT/);
    // Bloco com modelo do OpenRouter roda por ele.
    const g = template();
    g.nodes[1].data.config.model = "openrouter:openai/gpt-4.1-mini";
    const f2 = (await flow(g));
    let chamado = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      chamado = String(url) + " " + JSON.parse(String(init?.body)).model;
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "Via OpenRouter" } }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const r2 = await runtime.startRun(f2.id, "Olá");
    assert.equal(r2.status, "completed");
    assert.equal(r2.output, "Via OpenRouter");
    assert.match(chamado, /openrouter\.ai.* openai\/gpt-4\.1-mini$/);
    assert.equal((await runtime.startRun(f.id, "Olá", false, true)).demo, true);
  } finally {
    bridge.account = account;
    bridge.run = run;
    globalThis.fetch = fetch0;
    setConfig("OPENROUTER_API_KEY", null);
  }
});
test("simulação explícita nunca usa ChatGPT ou ferramentas externas", async () => {
  const fetch = globalThis.fetch,
    run = bridge.run;
  globalThis.fetch = async () => {
    throw Error("Não deve chamar");
  };
  bridge.run = async () => {
    throw Error("Não deve chamar");
  };
  try {
    const g = template();
    g.nodes[1] = block("http", "analista", 0, 0);
    g.nodes[1].data.config.url = "https://example.com";
    const r = await runtime.startRun((await flow(g)).id, "Olá", false, true);
    assert.equal(r.status, "completed");
    assert.match(r.output, /Demonstração/);
  } finally {
    globalThis.fetch = fetch;
    bridge.run = run;
  }
});
test("agente ChatGPT recebe somente ferramentas autorizadas e registra chamadas e texto", async () => {
  const fetch = globalThis.fetch,
    run = bridge.run;
  const server = (await import("./conexoes")).adicionarServidorMCP("Ferramentas", "https://tools.example/mcp", "test-code");
  globalThis.fetch = async (_, init) => {
    const b = JSON.parse(init?.body as string);
    return Response.json({
      result:
        b.method === "tools/list"
          ? {
              tools: [
                {
                  name: "buscar",
                  description: "Busca informações",
                  inputSchema: { type: "object", properties: {} },
                },
                { name: "nao_autorizada" },
              ],
            }
          : { content: [{ type: "text", text: "Encontrado" }] },
    });
  };
  bridge.run = async (options) => {
    assert.deepEqual(
      options.tools!.map((t) => t.name),
      ["buscar"],
    );
    const result = await options.tools![0].call({ query: "x" });
    assert.match(result, /Encontrado/);
    options.onText?.("Resposta parcial");
    return "Resposta final baseada na ferramenta";
  };
  try {
    const g = template();
    g.nodes[1].data.config.tools = `mcp:${server.prefixo}:buscar`;
    const r = await runtime.startRun((await flow(g)).id, "Pesquisar");
    assert.equal(r.status, "completed");
    assert.equal(r.demo, false);
    assert.match(r.output, /Resposta final/);
    assert.ok(r.trace.some((t) => t.label === "Ferramenta: buscar"));
  } finally {
    globalThis.fetch = fetch;
    bridge.run = run;
  }
});
test("falhas ChatGPT não caem para outro provedor nem para demonstração", async () => {
  const run = bridge.run;
  bridge.run = async () => {
    throw Error("Limite da assinatura atingido");
  };
  try {
    const r = await runtime.startRun((await flow()).id, "Pesquisar");
    assert.equal(r.status, "failed");
    assert.equal(r.demo, false);
    assert.match(r.error!, /Limite da assinatura/);
  } finally {
    bridge.run = run;
  }
});
test("cancelamento interrompe o agente e impede próximas etapas", async () => {
  const run = bridge.run;
  let began!: () => void;
  const ready = new Promise<void>((r) => (began = r));
  bridge.run = async (options) =>
    new Promise((_, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => reject(Error("Cancelado")),
        { once: true },
      );
      began();
    });
  try {
    const f = (await flow());
    const pending = runtime.startRun(f.id, "Pesquisar");
    await ready;
    const r = (await store.listRuns(f.id))[0];
    await runtime.cancelRun(r.id);
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.ok(!result.trace.some((t) => t.nodeId === "resposta"));
  } finally {
    bridge.run = run;
  }
});
test("modelos de exemplo possuem grafos executáveis", async () => {
  const { PRESETS, preset } = await import("./flow-presets");
  for (const p of PRESETS) {
    store.validateGraph(preset(p.id), true);
    const r = await runtime.startRun(
      (await flow(preset(p.id))).id,
      "urgente",
      false,
      true,
    );
    assert.ok(["completed", "waiting"].includes(r.status));
  }
});
test("reinício interrompe apenas o job cujo lease expirou", async () => {
  const f = await flow();
  const queued = await enqueueRun(f.id, "x", false, true);
  const job = await claimJob(testTenant.db, queued.job.id);
  assert.ok(job);
  assert.equal(await recoverExpiredJobs(testTenant.db), 0);
  await testTenant.db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
  assert.equal(await recoverExpiredJobs(testTenant.db), 1);
  assert.equal((await store.getRun(queued.run.id)).status, "failed");
});

test("LLM sem mensagem recebe a conversa e depois o resultado anterior", async () => {
  const g = template();
  g.nodes[1].data.config.prompt = "";
  const segundo = block("llm", "revisor", 0, 0);
  segundo.data.config.prompt = "";
  g.nodes.splice(2, 0, segundo);
  g.edges = [
    { id: "1", source: "inicio", target: "analista" },
    { id: "2", source: "analista", target: "revisor" },
    { id: "3", source: "revisor", target: "resposta" },
  ];
  const f = (await flow(g));
  const r = await runtime.startRun(f.id, "Pedido atrasado", false, true);
  assert.equal(r.status, "completed");
  assert.match(r.trace[1].output, /Entrada analisada: Pedido atrasado/);
  assert.match(r.trace[2].output, /Entrada analisada: \[Demonstração\] Agente/);
  const c = { prompt: "Contexto: {{input}}" };
  assert.equal(runtime.message(c, r), "Contexto: Pedido atrasado");
});

test("Mensagem personaliza a chamada da etapa sem iteração extra; last inclui o resultado anterior", async () => {
  const original = bridge.run;
  const prompts: string[] = [];
  const turns: { role: string; content: string }[][] = [];
  bridge.run = async ({ prompt, history }) => { prompts.push(prompt); turns.push(history || []); return prompts.length === 1 ? "Resposta anterior" : "Resposta revisada"; };
  try {
    const graph = template();
    graph.nodes[1].data.config.prompt = "Analise: {{input}}";
    const review = block("llm", "revisor", 0, 0);
    review.data.config.prompt = "Revise: {{last}}";
    graph.nodes.splice(2, 0, review);
    graph.edges = [
      { id: "1", source: "inicio", target: "analista" },
      { id: "2", source: "analista", target: "revisor" },
      { id: "3", source: "revisor", target: "resposta" },
    ];
    const result = await runtime.startRun((await flow(graph)).id, "Meu pedido", false, false);
    assert.equal(result.status, "completed");
    assert.equal(prompts.length, 2, "Memória completa não faz chamada extra");
    assert.ok(prompts[0].endsWith("Analise: Meu pedido"));
    assert.ok(prompts[1].endsWith("Revise: Resposta anterior"));
    // A conversa vai como mensagem da pessoa, não como dado de contexto; o resultado citado não vira turno.
    assert.deepEqual(turns[0], []);
    assert.deepEqual(turns[1], [{ role: "user", content: "Meu pedido" }]);
    assert.doesNotMatch(prompts[1], /Meu pedido/);
    assert.equal(runtime.message({ prompt: "Mensagem independente" }, result), "Mensagem independente");
  } finally { bridge.run = original; }
});

test("dois agentes reutilizam a mesma ferramenta com seleção independente e sem credenciais no fluxo", async () => {
  const original = bridge.run;
  const seen: string[][] = [];
  bridge.run = async ({ tools = [] }) => {
    seen.push(tools.map((t) => t.name));
    const calc = tools.find((t) => t.name === "calculadora")!;
    return calc.call({ expressao: "6 * 7" });
  };
  try {
    const start = block("start", "start", 0, 0), one = block("agent", "one", 0, 0), two = block("agent", "two", 0, 0), end = block("end", "end", 0, 0);
    one.data.config.tools = "interno:calculadora,interno:data_hora";
    two.data.config.tools = "interno:calculadora";
    end.data.config.text = "{{last}}";
    const f = (await flow({ nodes: [start, one, two, end], edges: [{ id: "1", source: "start", target: "one" }, { id: "2", source: "one", target: "two" }, { id: "3", source: "two", target: "end" }] }));
    const run = await runtime.startRun(f.id, "Calcule", false, false);
    assert.equal(run.status, "completed");
    assert.equal(run.output, "42");
    assert.deepEqual(seen, [["calculadora", "data_hora"], ["calculadora"]]);
    assert.equal(run.trace.filter((t) => t.label === "Ferramenta: calculadora").length, 2);
  } finally { bridge.run = original; }
});

test("Agente e LLM terminais entregam a resposta e atualizam variáveis compartilhadas", async () => {
  for (const kind of ["agent", "llm"] as const) {
    const start = block("start", "inicio", 0, 0), first = block(kind, "primeiro", 0, 0), last = block(kind, "ultimo", 0, 0);
    start.data.label = "Não pode renomear";
    start.data.config.state = JSON.stringify({ Resumo: "", Anterior: "inicial" });
    first.data.config.stateUpdates = JSON.stringify([{ key: "Resumo", value: "{{nodes.primeiro}}" }, { key: "Anterior", value: "{{fluxo.Resumo}}" }]);
    last.data.config.prompt = "Resumo recebido: {{fluxo.Resumo}}";
    last.data.config.stateUpdates = JSON.stringify([{ key: "Resumo", value: "{{last}}" }]);
    const f = (await flow({ nodes: [start, first, last], edges: [{ id: "a", source: "inicio", target: "primeiro" }, { id: "b", source: "primeiro", target: "ultimo" }] }));
    assert.equal(f.graph.nodes[0].data.label, "Início");
    (await store.publishFlow(f.id));
    const r = await runtime.startRun(f.id, "Olá", true, true);
    assert.equal(r.status, "completed");
    assert.match(r.output, /Resumo recebido:/);
    assert.equal(r.state.Resumo, r.output);
    assert.equal(r.state.Anterior, ""); // assignments read the same pre-update state
    assert.equal(runtime.interpolate("{{state.Resumo}}", r), r.output);
    // Data e hora atuais, em português e no horário de Brasília, resolvidas na hora da interpolação.
    assert.match(runtime.interpolate("Hoje: {{currentDateTime}}", r), /^Hoje: [^,]+, \d{1,2} de [a-zç]+ de \d{4} às \d{2}:\d{2} \(horário de Brasília\)$/);
  }
});
test("recusa variáveis desconhecidas, atualizações duplicadas e agentes desconectados", () => {
  const g = template();
  g.nodes[0].data.config.state = '{"Resumo":""}';
  g.nodes[1].data.config.stateUpdates = '[{"key":"Ausente","value":"x"}]';
  assert.throws(() => store.validateGraph(g, true), /variáveis/);
  g.nodes[1].data.config.stateUpdates = '[{"key":"Resumo","value":"x"},{"key":"Resumo","value":"y"}]';
  assert.throws(() => store.validateGraph(g, true), /repetições/);
  delete g.nodes[1].data.config.stateUpdates;
  g.nodes.push(block("agent", "solto", 0, 0));
  assert.throws(() => store.validateGraph(g, true), /conectados/);
});
test("novo fluxo começa somente com Início e salvar preserva o canvas", async () => {
  const f = (await store.createFlow());
  assert.deepEqual(f.graph.nodes.map((n) => n.data.kind), ["start"]);
  assert.deepEqual(f.graph.edges, []);
  f.graph.nodes[0].position = { x: 123, y: -456 };
  const expected = structuredClone(f.graph);
  (await store.saveFlow(f.id, { name: "Meu fluxo", description: "", graph: f.graph }));
  assert.deepEqual((await store.getFlow(f.id)).graph, expected);
  assert.deepEqual(f.graph, expected);
});


test("Agente e LLM pesquisam na web sem configuração, inclusive em fluxos antigos", async () => {
  const original = bridge.run;
  const searches: (boolean | undefined)[] = [];
  bridge.run = async (options) => {
    searches.push(options.webSearch);
    return "Resposta";
  };
  try {
    for (const kind of ["agent", "llm"] as const) {
      for (const legacy of [undefined, "false"]) {
        const start = block("start", "start", 0, 0);
        const model = block(kind, "model", 200, 0);
        if (legacy !== undefined) model.data.config.webSearch = legacy;
        const f = (await flow({ nodes: [start, model], edges: [{ id: "edge", source: "start", target: "model" }] }));
        const run = await runtime.startRun(f.id, "Pesquise", false, false);
        assert.equal(run.status, "completed");
      }
    }
    assert.deepEqual(searches, [true, true, true, true]);
  } finally {
    bridge.run = original;
  }
});


test("salvar rejeita dados corrompidos sem substituir a configuração em uso", async () => {
  const f = (await flow());
  const invalid = template();
  invalid.edges[0].target = "bloco-inexistente";
  await assert.rejects(async () => (await store.saveFlow(f.id, { name: "Inválido", description: "", graph: invalid })), /conexão inválida/);
  assert.deepEqual((await store.getFlow(f.id)), f);
});

test("Início sozinho pode ser salvo e reaberto; somente o teste no chat é bloqueado", async () => {
  const graph = { nodes: [block("start", "inicio", 120, 80)], edges: [] };
  const f = (await store.createSavedFlow({ name: "Em construção", description: "", graph }));
  (await store.saveFlow(f.id, { ...f, graph }));
  assert.deepEqual((await store.getFlow(f.id)).graph, graph);
  await assert.rejects(runtime.startRun(f.id, "Olá", false, true), /apenas o bloco Início.*Adicione e conecte/);
  assert.deepEqual((await store.getFlow(f.id)).graph, graph);
});

test("conexões incompletas não impedem salvar, mas impedem executar", async () => {
  const graph = template();
  graph.edges = [];
  const f = (await store.createSavedFlow({ name: "Em construção", description: "", graph }));
  assert.deepEqual((await store.getFlow(f.id)).graph, graph);
  await assert.rejects(runtime.startRun(f.id, "Olá", false, true), /Conecte/);
});

test("salvar atualiza a v1 sem alterar a execução que já aguarda aprovação", async () => {
  const g = template();
  g.nodes[1] = block("approval", "analista", 0, 0);
  g.edges[1].sourceHandle = "yes";
  g.nodes[2].data.config.text = "Antes";
  g.nodes.push(block("end", "no", 0, 0));
  g.edges.push({ id: "no", source: "analista", target: "no", sourceHandle: "no" });
  const f = (await flow(g));
  const pending = await runtime.startRun(f.id, "Revisar", true, true);
  assert.equal(pending.status, "waiting");
  g.nodes[2].data.config.text = "Depois";
  const saved = (await store.saveFlow(f.id, { name: f.name, description: "", graph: g }));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.published, saved.graph);
  assert.equal((await runtime.resumeRun(pending.id, "yes")).output, "Antes");
  const next = await runtime.startRun(f.id, "Revisar", true, true);
  assert.equal((await runtime.resumeRun(next.id, "yes")).output, "Depois");
});

test("fluxos existentes usam v1 e o grafo salvo, preservando a API antiga de publicação", async () => {
  const f = (await flow());
  const oldPublished = structuredClone(f.graph);
  f.graph.nodes[2].data.config.text = "Conteúdo salvo";
  await testTenant.db.query("UPDATE flows SET body=$3 WHERE user_id=$1 AND id=$2", [testTenant.owner, f.id, JSON.stringify({ ...f, version: 8, published: oldPublished })]);
  assert.equal((await store.getFlow(f.id)).version, 1);
  assert.deepEqual((await store.getFlow(f.id)).published, f.graph);
  assert.equal((await store.listFlows()).find(item => item.id === f.id)?.version, 1);
  const run = await runtime.startRun(f.id, "Olá", true, true);
  assert.equal(run.output, "Conteúdo salvo");
  assert.equal(run.version, 1);
  assert.equal((await store.publishFlow(f.id)).version, 1);
});

test("chamadas de ferramenta registram início, duração e falha mesmo quando o modelo segue respondendo", async () => {
  const original = bridge.run, fetch0 = globalThis.fetch;
  const graph = template(); graph.nodes[1].data.config.tools = "interno:ler_pagina,interno:calculadora";
  const f = await flow(graph);
  globalThis.fetch = async () => {
    const running = (await store.listRuns(f.id))[0];
    assert.equal(running.trace.find(entry => entry.type === "tool")?.status, "running");
    return new Response("Falha do serviço", { status: 503 });
  };
  bridge.run = async ({ tools = [], webSearch }) => {
    assert.equal(webSearch, false);
    await assert.rejects(tools.find(t => t.name === "ler_pagina")!.call({ url: "https://example.com" }), /503/);
    const failed = (await store.listRuns(f.id))[0].trace.find(entry => entry.type === "tool")!;
    assert.equal(failed.status, "failed"); assert.ok(failed.ms >= 0);
    return tools.find(t => t.name === "calculadora")!.call({ expressao: "6*7" });
  };
  try {
    const run = await runtime.startRun(f.id, "Calcule");
    assert.equal(run.status, "completed"); assert.equal(run.output, "42");
    assert.deepEqual(run.trace.filter(entry => entry.type === "tool").map(entry => entry.status), ["failed", "completed"]);
  } finally { bridge.run = original; globalThis.fetch = fetch0; }
});

test("detalhes somam resumo e resposta sem duplicar notificações cumulativas e preservam falhas", async () => {
  const original = bridge.run;
  const graph = template();
  Object.assign(graph.nodes[1].data.config, { memoryType: "conversationSummary", prompt: "Analise com cuidado", system: "Instrução registrada" });
  let calls = 0;
  bridge.run = async ({ onUsage }) => {
    calls++;
    onUsage?.({ input: 10, output: 2, total: 12 });
    onUsage?.({ input: 20, output: 5, total: 25 });
    return calls % 2 ? "Resumo da memória" : "Resposta final";
  };
  try {
    const f = (await flow(graph));
    // A conversa atual vai como turno da pessoa; o resumo cobre a conversa anterior.
    const previous = await runtime.startRun(f.id, "Pergunta passada");
    calls = 0;
    const run = await runtime.startRun(f.id, "Olá", false, false, undefined, [previous.id]);
    const trace = run.trace.find((entry) => entry.nodeId === "analista")!;
    assert.equal(calls, 2);
    assert.deepEqual((await store.getRun(run.id)).trace.find((entry) => entry.nodeId === "analista")!.usage, { input: 40, output: 10, total: 50 });
    assert.match(trace.input!, /Resumo da memória/);
    assert.match(trace.input!, /Analise com cuidado/);
    assert.equal(trace.instructions, "Instrução registrada");
    assert.equal(trace.output, "Resposta final");
    calls = 0;
    bridge.run = async ({ onUsage }) => {
      if (++calls === 1) return "Resumo sem telemetria";
      onUsage?.({ input: 20, output: 5, total: 25 });
      throw new Error("Falha após consumo");
    };
    const failed = await runtime.startRun(f.id, "Outra pergunta", false, false, undefined, [previous.id]);
    const entry = failed.trace.find((item) => item.nodeId === "analista")!;
    assert.equal(failed.status, "failed");
    assert.equal(entry.status, "failed");
    assert.equal(entry.usage?.total, 25);
    assert.equal(entry.usage?.partial, true);
    assert.match(entry.output, /Falha após consumo/);
  } finally { bridge.run = original; }
});

test("cancelar a execução encerra o registro da ferramenta em andamento", async () => {
  const original = bridge.run, fetch0 = globalThis.fetch;
  const graph = template(); graph.nodes[1].data.config.tools = "interno:ler_pagina";
  const f = (await flow(graph));
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const sending = new Promise<void>(resolve => { entered = resolve; });
  globalThis.fetch = async () => { entered(); await barrier; return new Response("Resultado tardio"); };
  bridge.run = async ({ tools = [] }) => {
    const pending = tools[0].call({ url: "https://example.com" });
    await sending;
    const run = (await store.listRuns()).find((r) => r.flowId === f.id)!;
    await runtime.cancelRun(run.id);
    release();
    return pending;
  };
  try {
    const run = await runtime.startRun(f.id, "Leia");
    assert.equal(run.status, "cancelled");
    const trace = run.trace.find((entry) => entry.type === "tool")!;
    assert.equal(trace.status, "failed");
    assert.match(trace.output, /cancelada/);
  } finally { release(); bridge.run = original; globalThis.fetch = fetch0; }
});
