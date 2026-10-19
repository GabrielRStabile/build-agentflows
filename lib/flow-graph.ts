import { conditionCriteria, FALLBACK_HANDLE } from "./flow-conditions";
import { decisionOutputs } from "./flow-decisions";
import type { Graph, Kind, Link } from "./flow-types";
export type Output = { id: string | null; label: string };
// Saídas de cada tipo de bloco, na ordem em que aparecem no lado direito.
export function outputs(kind: Kind, config: Record<string, string> = {}): Output[] {
  if (kind === "condition") {
    const criteria = conditionCriteria(config);
    return [...criteria.map((row, index) => ({ id: row.id, label: String(index + 1) })), { id: FALLBACK_HANDLE, label: String(criteria.length + 1) }];
  }
  if (kind === "decision") return decisionOutputs(config);
  if (kind === "approval")
    return [
      { id: "yes", label: "Aprovar" },
      { id: "no", label: "Rejeitar" },
    ];
  // Repetir volta ao bloco escolhido em config.target e termina no limite: sem setas de saída.
  if (kind === "loop" || kind === "end") return [];
  return [{ id: null, label: "" }];
}
export function outputLabel(kind: Kind, handle?: string | null, config: Record<string, string> = {}) {
  return outputs(kind, config).find((o) => o.id === (handle || null))?.label || "";
}
export type Candidate = {
  source: string;
  target: string;
  sourceHandle?: string | null;
};
// Blocos que o Repetir pode escolher como destino: qualquer um, exceto ele mesmo, Início e Resposta.
export function loopTargets(g: Graph, loopId: string) {
  return g.nodes.filter((n) => n.id !== loopId && n.data.kind !== "start" && n.data.kind !== "end");
}
// Fluxos anteriores a 0.25.0 ligavam o Repetir por setas (saídas "repeat" e "done").
// A seta Repetir vira o destino escolhido; a seta Concluir deixa de existir, porque o bloco encerra no limite.
export function upgradeGraph(g: Graph): Graph {
  const loops = new Map(g.nodes.filter((n) => n?.data?.kind === "loop").map((n) => [n.id, n]));
  if (!loops.size || !g.edges.some((e) => loops.has(e?.source) && (e.sourceHandle === "repeat" || e.sourceHandle === "done"))) return g;
  const targets = new Map<string, string>();
  const edges = g.edges.filter((e) => {
    if (!loops.has(e?.source) || (e.sourceHandle !== "repeat" && e.sourceHandle !== "done")) return true;
    if (e.sourceHandle === "repeat") targets.set(e.source, e.target);
    return false;
  });
  const nodes = g.nodes.map((n) => {
    const target = targets.get(n.id);
    if (!target || n.data.config.target) return n;
    return { ...n, data: { ...n.data, config: { ...n.data.config, target } } };
  });
  return { ...g, nodes, edges };
}
// Existe caminho de `from` até `to` pelas conexões?
function reaches(g: Graph, from: string, to: string) {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of g.edges)
      if (e.source === id) queue.push(e.target);
  }
  return false;
}
// Motivo pelo qual a conexão não pode ser feita, ou null quando é válida.
export function connectionProblem(g: Graph, c: Candidate): string | null {
  if (c.source === c.target)
    return "Conecte blocos diferentes. Para voltar a uma etapa, use Repetir.";
  const source = g.nodes.find((n) => n.id === c.source),
    target = g.nodes.find((n) => n.id === c.target);
  if (!source || !target) return "Bloco não encontrado.";
  if (target.data.kind === "start") return "O Início não recebe conexões.";
  const handle = c.sourceHandle || null;
  if (!outputs(source.data.kind, source.data.config).some((o) => o.id === handle))
    return source.data.kind === "condition" ? "Esta saída não existe mais. Confira os critérios do bloco." : source.data.kind === "decision" ? "Esta saída não existe mais. Confira as opções da primeira pergunta." : source.data.kind === "loop" ? "Repetir não tem saída: escolha dentro dele o bloco para onde voltar." : "A Resposta encerra o fluxo e não tem saída.";
  if (
    g.edges.some(
      (e) => e.source === c.source && (e.sourceHandle || null) === handle,
    )
  )
    return "Esta saída já está conectada. Remova a conexão atual ou use uma Condição para ramificar.";
  if (reaches(g, c.target, c.source))
    return "Essa conexão criaria um ciclo. Para repetir etapas, use o bloco Repetir.";
  return null;
}
export function edgeId(c: Candidate) {
  return `${c.source}-${c.sourceHandle || "out"}-${c.target}`;
}
export function connect(g: Graph, c: Candidate): Graph {
  const edge: Link = { id: edgeId(c), source: c.source, target: c.target };
  if (c.sourceHandle) edge.sourceHandle = c.sourceHandle;
  return { ...g, edges: [...g.edges, edge] };
}
// Organiza os blocos em colunas pela distância do Início (usado por fluxos gerados por IA).
export function layout(g: Graph): Graph {
  const start = g.nodes.find((n) => n.data.kind === "start") || g.nodes[0];
  if (!start) return g;
  const depth = new Map<string, number>([[start.id, 0]]);
  const queue = [start.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of g.edges)
      if (e.source === id && !depth.has(e.target)) {
        depth.set(e.target, depth.get(id)! + 1);
        queue.push(e.target);
      }
  }
  let orphan = Math.max(0, ...depth.values()) + 1;
  for (const n of g.nodes) if (!depth.has(n.id)) depth.set(n.id, orphan++);
  const rows = new Map<number, number>();
  return {
    ...g,
    nodes: g.nodes.map((n) => {
      const d = depth.get(n.id)!;
      const row = rows.get(d) || 0;
      rows.set(d, row + 1);
      return { ...n, position: { x: 60 + d * 340, y: 80 + row * 170 } };
    }),
  };
}
