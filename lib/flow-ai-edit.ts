import { block, type Graph, type Kind, BLOCKS } from "./flow-types";
import { FlowError, validateGraph } from "./flow-store";
import { layout, edgeId } from "./flow-graph";
import { defaultRunner, GENERATOR_SYSTEM, type Generated, type GenerationPhase } from "./flow-generator";

export type FlowContext = { name: string; description: string; graph: Graph };
export type FlowMessage = { role: "user" | "assistant"; content: string };
export type EditedFlow = Generated & { summary: string };
const EDIT_SYSTEM = `${GENERATOR_SYSTEM}

MODO EDIÇÃO: o formato de resposta anterior é substituído pelo formato abaixo.
Você conversa sobre um fluxo existente. Use o canvas enviado como fonte atual, inclusive alterações ainda não salvas. O histórico serve apenas para entender referências e preferências; nunca restaure uma versão antiga por causa dele.
Retorne apenas alterações pontuais solicitadas. Não reescreva nem remova blocos, modelos, ferramentas, critérios, variáveis ou conexões que não precisam mudar. Preserve IDs e IDs de critérios existentes. Não altere o nome do fluxo sem pedido explícito.
Se precisar esclarecer algo, retorne summary com a pergunta e listas vazias. O usuário poderá responder na próxima mensagem.
Cada adição deve ter um ID novo; atualizações devem usar IDs existentes. Não repita em additions blocos que já estão no canvas: para inserir uma etapa entre dois blocos, adicione só a nova e troque as conexões. Remover um bloco também remove suas conexões. Para substituir uma conexão, remova seu ID e adicione a nova. Não há posição no formato: o editor preserva a organização atual.
Responda com JSON:
{"summary":"Explique brevemente o que mudou ou faça uma pergunta", "updates":[{"id":"id_existente","label":"opcional","config":{"system":"somente os campos alterados"}}], "additions":[{"id":"novo_id","kind":"agent","label":"Nome","config":{}}], "removals":[], "connections":{"add":[{"source":"inicio","target":"novo_id","handle":null}],"remove":[]}, "name":"opcional, apenas se solicitado", "description":"opcional"}
Use listas vazias para operações não necessárias. Campos config são strings; criteria e stateUpdates podem ser listas JSON, state pode ser objeto JSON.
Use todas as regras de execução do produto acima. Se o canvas já estiver incompleto, preserve o trabalho em andamento e conecte apenas as partes envolvidas no pedido.`;

type NodeEdit = { id: string; label?: string; config?: Record<string, unknown> };
type Patch = { summary: string; updates?: NodeEdit[]; additions?: (NodeEdit & { kind: Kind })[]; removals?: string[]; connections?: { add?: { source: string; target: string; handle?: string | null }[]; remove?: string[] }; name?: string; description?: string };
export function validateFlowContext(value: unknown): FlowContext {
  if (!value || typeof value !== "object") throw new FlowError("Envie o fluxo atual para editar.");
  const context = value as FlowContext;
  if (typeof context.name !== "string" || context.name.length > 100 || typeof context.description !== "string" || context.description.length > 1000) throw new FlowError("Confira o contexto do fluxo.");
  return { name: context.name, description: context.description, graph: validateGraph(context.graph) };
}
export function validateFlowMessages(value: unknown): FlowMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12 || value.some((message) => !message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || message.content.length > 4000)) throw new FlowError("O histórico da conversa é inválido.");
  return value.map(({ role, content }) => ({ role, content }));
}
export function applyFlowPatch(context: FlowContext, answer: string): EditedFlow {
  let patch: Patch;
  try { patch = JSON.parse(answer.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] || answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1)); }
  catch { throw new FlowError("A IA não retornou ajustes válidos."); }
  if (!patch || typeof patch.summary !== "string" || !patch.summary.trim() || patch.summary.length > 4000) throw new FlowError("A IA não explicou os ajustes.");
  const { updates = [], additions = [], removals = [], connections = {} } = patch;
  if (!Array.isArray(updates) || !Array.isArray(additions) || !Array.isArray(removals) || !connections || typeof connections !== "object" || !Array.isArray(connections.add || []) || !Array.isArray(connections.remove || [])) throw new FlowError("Formato de ajustes inválido.");
  if (new Set(updates.map((n) => n?.id)).size !== updates.length || new Set(removals).size !== removals.length) throw new FlowError("A IA repetiu um ajuste de bloco.");
  const existing = new Map(context.graph.nodes.map((node) => [node.id, node]));
  for (const id of removals) if (!existing.has(id)) throw new FlowError("A IA tentou remover um bloco inexistente.");
  let nodes = structuredClone(context.graph.nodes).filter((node) => !removals.includes(node.id));
  const mergeConfig = (current: Record<string, string>, changes?: Record<string, unknown>) => {
    if (changes === undefined) return current;
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new FlowError("Configuração de bloco inválida.");
    return { ...current, ...Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)])) };
  };
  for (const update of updates) {
    const node = nodes.find((n) => n.id === update?.id);
    if (!node) throw new FlowError("A IA tentou editar um bloco inexistente.");
    if (update.label !== undefined) node.data.label = update.label;
    node.data.config = mergeConfig(node.data.config, update.config);
  }
  for (const addition of additions) {
    if (!addition || typeof addition.id !== "string" || !addition.id.trim()) throw new FlowError("A IA tentou adicionar um bloco sem ID.");
    if (!Object.hasOwn(BLOCKS, addition.kind)) throw new FlowError(`A IA tentou adicionar um bloco de tipo desconhecido: ${String(addition.kind)}.`);
    const current = nodes.find((n) => n.id === addition.id);
    // Ao inserir um bloco no meio do caminho, a IA costuma repetir em additions o bloco que ela religa; vira atualização.
    if (current && existing.has(current.id) && current.data.kind === addition.kind && !updates.some((u) => u.id === current.id)) {
      if (addition.label !== undefined) current.data.label = addition.label;
      current.data.config = mergeConfig(current.data.config, addition.config);
      continue;
    }
    if (current) throw new FlowError(`A IA tentou adicionar o bloco "${addition.id}", que já existe com outro tipo ou foi repetido.`);
    if (existing.has(addition.id)) throw new FlowError(`A IA removeu e adicionou o bloco "${addition.id}"; use um ID novo.`);
    const node = block(addition.kind, addition.id, 0, 0);
    if (addition.label !== undefined) node.data.label = addition.label;
    node.data.config = mergeConfig(node.data.config, addition.config);
    nodes.push(node);
  }
  const removedEdges = connections.remove || [];
  for (const id of removedEdges) if (!context.graph.edges.some((e) => e.id === id)) throw new FlowError("A IA tentou remover uma conexão inexistente.");
  const edges = structuredClone(context.graph.edges).filter((e) => !removedEdges.includes(e.id) && !removals.includes(e.source) && !removals.includes(e.target));
  for (const edge of connections.add || []) {
    if (!edge || typeof edge.source !== "string" || typeof edge.target !== "string") throw new FlowError("A IA propôs uma conexão inválida.");
    if (edges.some((e) => e.source === edge.source && (e.sourceHandle || null) === (edge.handle || null))) throw new FlowError("A IA propôs duas conexões na mesma saída.");
    const link = { source: edge.source, target: edge.target, ...(edge.handle ? { sourceHandle: edge.handle } : {}) };
    edges.push({ ...link, id: edgeId(link) });
  }
  const positioned = layout({ nodes: structuredClone(nodes), edges });
  const occupied = nodes.filter((n) => existing.has(n.id)).map((n) => n.position);
  nodes = nodes.map((node) => {
    if (existing.has(node.id)) return node;
    const position = { ...positioned.nodes.find((n) => n.id === node.id)!.position };
    while (occupied.some((p) => Math.abs(p.x - position.x) < 260 && Math.abs(p.y - position.y) < 150)) position.y += 180;
    occupied.push(position); return { ...node, position };
  });
  let wasExecutable = true;
  try { validateGraph(context.graph, true); } catch { wasExecutable = false; }
  const graph = validateGraph({ nodes, edges }, wasExecutable);
  const name = patch.name ?? context.name, description = patch.description ?? context.description;
  if (typeof name !== "string" || name.length > 100 || typeof description !== "string" || description.length > 1000) throw new FlowError("Nome ou descrição inválidos.");
  return { name, description, graph, summary: patch.summary.trim() };
}
export async function editFlow(prompt: unknown, context: FlowContext, history: FlowMessage[] = [], run?: (system: string, prompt: string) => Promise<string>, onProgress?: (phase: GenerationPhase) => void, signal?: AbortSignal): Promise<EditedFlow> {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) throw new FlowError("Descreva o ajuste em até 4 mil caracteres.");
  onProgress?.("interpreting");
  const current = validateFlowContext(context), messages = validateFlowMessages(history);
  const input = `Canvas atual (fonte de verdade):\n${JSON.stringify(current)}\nConversa anterior:\n${JSON.stringify(messages)}\nPedido atual:\n${prompt.trim()}`;
  run ??= await defaultRunner(signal); onProgress?.("planning");
  const answer = await run(EDIT_SYSTEM, input); onProgress?.("creating");
  try { return applyFlowPatch(current, answer); }
  catch (error) {
    onProgress?.("repairing");
    const retry = await run(EDIT_SYSTEM, `${input}\nO ajuste anterior foi recusado: ${(error as Error).message}\n${answer.slice(0, 12000)}\nCorrija os ajustes e retorne apenas JSON.`);
    onProgress?.("creating"); return applyFlowPatch(current, retry);
  }
}
