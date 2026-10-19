import { modelSettings } from "./ai-providers";
import { conditionCriteria, COMPARISONS } from "./flow-conditions";
import { decisionQuestions, validateDecisionConfig } from "./flow-decisions";
import { memorySettings } from "./memory-settings";
import { validateMediaConfig } from "./media-models";
import { knowledgeSettings } from "./knowledge-settings";
import { validateToolCards } from "./agent-tools";
import { outputs, upgradeGraph } from "./flow-graph";
import {
  BLOCKS,
  type Flow,
  type Graph,
} from "./flow-types";
export class FlowError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
export function validateGraph(value: unknown, executable = false): Graph {
  if (!value || typeof value !== "object")
    throw new FlowError("O fluxo precisa de blocos e conexões.");
  const raw = value as Graph;
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges))
    throw new FlowError("Use até 60 blocos e 120 conexões por fluxo.");
  const g = upgradeGraph(raw);
  if (
    g.nodes.length > 60 ||
    g.edges.length > 120 ||
    JSON.stringify(g).length > 250000
  )
    throw new FlowError("Use até 60 blocos e 120 conexões por fluxo.");
  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (
      !n ||
      typeof n.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(n.id) ||
      ids.has(n.id) ||
      !n.data ||
      !Object.hasOwn(BLOCKS, n.data.kind) ||
      typeof n.data.label !== "string" ||
      n.data.label.length > 100 ||
      !n.position ||
      !Number.isFinite(n.position.x) ||
      !Number.isFinite(n.position.y) ||
      !n.data.config ||
      Array.isArray(n.data.config) ||
      typeof n.data.config !== "object" ||
      Object.values(n.data.config).some(
        (v) => typeof v !== "string" || v.length > 20000,
      )
    )
      throw new FlowError(
        "Há um bloco inválido ou repetido. Confira o arquivo importado.",
      );
    if (n.data.kind === "condition") {
      try { conditionCriteria(n.data.config); } catch (error) { throw new FlowError((error as Error).message); }
    }
    if (n.data.kind === "decision") {
      try { validateDecisionConfig(n.data.config); } catch (error) { throw new FlowError((error as Error).message); }
    }
    if (n.data.kind === "agent" || n.data.kind === "llm") {
      try { memorySettings(n.data.config); } catch (error) { throw new FlowError((error as Error).message); }
      try { modelSettings(n.data.config); validateMediaConfig(n.data.config); } catch (error) { throw new FlowError((error as Error).message); }
      try { knowledgeSettings(n.data.config); } catch (error) { throw new FlowError((error as Error).message); }
    }
    if (n.data.kind === "agent") {
      try { validateToolCards(n.data.config.toolCards); } catch (error) { throw new FlowError((error as Error).message); }
    }
    ids.add(n.id);
  }
  const edges = new Set<string>();
  for (const e of g.edges) {
    if (
      !e ||
      typeof e.id !== "string" ||
      edges.has(e.id) ||
      !ids.has(e.source) ||
      !ids.has(e.target) ||
      (e.sourceHandle != null &&
        !outputs(g.nodes.find((n) => n.id === e.source)!.data.kind, g.nodes.find((n) => n.id === e.source)!.data.config).some((o) => o.id === e.sourceHandle))
    )
      throw new FlowError("Há uma conexão inválida.");
    edges.add(e.id);
  }
  if (executable) {
    if (g.nodes.length === 1 && g.nodes[0].data.kind === "start" && g.edges.length === 0)
      throw new FlowError("Este fluxo tem apenas o bloco Início. Adicione e conecte um Agente ou outro bloco para testar no chat.");
    const starts = g.nodes.filter((n) => n.data.kind === "start");
    if (starts.length !== 1)
      throw new FlowError(
        "Use exatamente um Início.",
      );
    for (const n of g.nodes) {
      const out = g.edges.filter((e) => e.source === n.id);
      const k = n.data.kind;
      const handles = (k === "agent" || k === "llm" || k === "decision") && out.length === 0 ? [] : outputs(k, n.data.config).map((o) => o.id);
      if (
        out.length !== handles.length ||
        handles.some(
          (h) => out.filter((e) => (e.sourceHandle || null) === h).length !== 1,
        )
      )
        throw new FlowError(
          `Conecte todas as saídas de “${n.data.label}”, uma vez cada.`,
        );
      if (k === "start" && g.edges.some((e) => e.target === n.id))
        throw new FlowError("O Início não pode receber conexões.");
      const c = n.data.config;
      if (k === "state" && !/^[a-zA-Z][a-zA-Z0-9_]{0,60}$/.test(c.key || ""))
        throw new FlowError("Dê um nome válido à variável de estado.");
      if (
        k === "loop" &&
        (!/^\d+$/.test(c.limit || "") || +c.limit < 1 || +c.limit > 20)
      )
        throw new FlowError("A repetição deve ter entre 1 e 20 passagens.");
      if (k === "loop") {
        const target = g.nodes.find((o) => o.id === c.target);
        if (!target || target.id === n.id || target.data.kind === "start" || target.data.kind === "end")
          throw new FlowError(`Escolha em “${n.data.label}” o bloco para onde voltar.`);
      }
      if (
        k === "condition" &&
        !conditionCriteria(c).every((row) => COMPARISONS.some(([operator]) => operator === row.operator))
      )
        throw new FlowError("Escolha uma comparação válida.");
      if (k === "http") {
        try {
          const u = new URL(c.url);
          if (
            !["https:", "http:"].includes(u.protocol) ||
            u.username ||
            u.password
          )
            throw 0;
        } catch {
          throw new FlowError(
            "Informe um endereço HTTP válido, sem credenciais.",
          );
        }
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(c.method))
          throw new FlowError("Método HTTP inválido.");
      }
      if (k === "tool" && !c.tool?.trim())
        throw new FlowError("Escolha a ferramenta a executar.");
      if ((k === "whatsapp" || k === "call") && !c.to?.trim())
        throw new FlowError(`Informe o número em “${n.data.label}”.`);
      if (k === "agent" || k === "llm") {
        try {
          const updates = JSON.parse(c.stateUpdates || "[]");
          const initial = JSON.parse(starts[0].data.config.state || "{}");
          if (!Array.isArray(updates) || updates.length > 50 || updates.some((u) => !u || typeof u.key !== "string" || !Object.hasOwn(initial, u.key) || typeof u.value !== "string") || new Set(updates.map((u) => u.key)).size !== updates.length) throw 0;
        } catch { throw new FlowError("Escolha variáveis definidas no Início para atualizar, sem repetições."); }
      }
      if (k === "decision") {
        let initial: Record<string, unknown> = {};
        try { initial = JSON.parse(starts[0].data.config.state || "{}"); } catch { /* validated with the Início block */ }
        const missing = decisionQuestions(c).find((q) => q.variable && !Object.hasOwn(initial, q.variable));
        if (missing) throw new FlowError(`A pergunta “${missing.name}” guarda a resposta em uma variável que não existe no Início.`);
      }
      if (k === "start") {
        try {
          const s = JSON.parse(c.state || "{}");
          if (
            !s ||
            Array.isArray(s) ||
            typeof s !== "object" ||
            Object.values(s).some((v) => typeof v !== "string")
          )
            throw 0;
        } catch {
          throw new FlowError(
            "O estado inicial deve ser um objeto com valores de texto.",
          );
        }
      }
    }
    const reachable = new Set<string>();
    function walk(id: string) {
      if (reachable.has(id)) return;
      reachable.add(id);
      g.edges.filter((e) => e.source === id).forEach((e) => walk(e.target));
      // Repetir alcança o bloco escolhido sem seta.
      const node = g.nodes.find((n) => n.id === id);
      if (node?.data.kind === "loop" && ids.has(node.data.config.target)) walk(node.data.config.target);
    }
    walk(starts[0].id);
    if (reachable.size !== g.nodes.length)
      throw new FlowError(
        "Todos os blocos precisam estar conectados ao Início.",
      );
    // Every block must have a route to an end. Repetir ends the flow when its limit is reached.
    const finishing = new Set(
      g.nodes.filter((n) => ["end", "agent", "llm", "decision", "loop"].includes(n.data.kind) && !g.edges.some((e) => e.source === n.id)).map((n) => n.id),
    );
    for (let i = 0; i < g.nodes.length; i++)
      g.edges.forEach((e) => {
        if (finishing.has(e.target)) finishing.add(e.source);
      });
    if (finishing.size !== g.nodes.length)
      throw new FlowError("Todo caminho precisa poder terminar em Agente, LLM, Decisão, Resposta ou Repetir.");
  }
  const result = structuredClone(g);
  for (const n of result.nodes) if (n.data.kind === "start") n.data.label = "Início";
  return result;
}
// Uma única configuração salva alimenta testes e integrações. Execuções em andamento
// preservam o grafo capturado ao iniciar; publicações antigas passam a usar o grafo salvo.
export function currentFlow(flow: Flow): Flow {
  return { ...flow, version: 1, published: flow.published ? structuredClone(flow.graph) : null };
}
export function normalizeFlowUpdate(f: Flow, data: unknown): Flow {
  if (!data || typeof data !== "object")
    throw new FlowError("Envie os dados do fluxo.");
  const b = data as Partial<Flow>;
  if (
    typeof b.name !== "string" ||
    !b.name.trim() ||
    b.name.length > 100 ||
    typeof b.description !== "string" ||
    b.description.length > 1000
  )
    throw new FlowError("Informe nome e descrição válidos.");
  f.name = b.name.trim();
  f.description = b.description;
  if (b.voiceId !== undefined) {
    if (typeof b.voiceId !== "string" || !/^[a-zA-Z0-9_-]{0,128}$/.test(b.voiceId)) throw new FlowError("Escolha uma voz válida para o fluxo.");
    f.voiceId = b.voiceId;
  }
  // Salvar preserva o trabalho em andamento; a execução valida conexões e configuração.
  f.graph = validateGraph(b.graph);
  f.published = structuredClone(f.graph);
  f.updatedAt = new Date().toISOString();
  return f;
}
