import { chatGPT } from "./chatgpt";
import { GENERATOR_MODEL, openRouterKey, runOpenRouter } from "./openrouter";
import { FlowError, validateGraph } from "./flow-store";
import { BLOCKS, block, type Graph, type Kind } from "./flow-types";
import { layout, outputs } from "./flow-graph";
export type Generated = { name: string; description: string; graph: Graph; summary?: string };
export type GenerationPhase = "interpreting" | "planning" | "creating" | "repairing";
export type GenerationEvent = { phase: GenerationPhase } | { result: Generated } | { error: string };
// A Decisão depende de uma credencial TypeSafe escolhida pela pessoa; o gerador não a cria.
type GeneratedKind = Exclude<Kind, "decision">;
const KINDS = (Object.keys(BLOCKS) as Kind[]).filter((k): k is GeneratedKind => k !== "decision");
// Campos de configuração aceitos por tipo, para o modelo preencher além dos blocos e conexões.
const FIELDS: Record<GeneratedKind, string> = {
  start: "state (JSON com valores de texto, opcional)",
  llm: "system (instruções), prompt (opcional: em branco o bloco recebe a conversa ou o resultado da etapa anterior; use {{input}}, {{last}}, {{nodes.id}}, {{fluxo.nome}} só quando precisar combinar textos)",
  agent:
    "system (instruções), prompt (opcional, mesma regra do llm), stateUpdates (JSON de lista de {key, value}, atualiza variáveis definidas no início depois da resposta; value aceita {{nodes.id}} da própria etapa), tools (ids separados por vírgula entre interno:data_hora, interno:calculadora, interno:ler_pagina, interno:executar_fluxo; só se o pedido precisar)",
  condition:
    'criteria (lista de critérios: [{"id":"criterion_1","value":"{{last}}","operator":"contains","compare":"urgente"}]). Operadores: equals, contains, notEquals, notContains, greater, greaterOrEqual, less, lessOrEqual, empty, notEmpty',
  state: "key (nome da variável, letras e números), value (ex.: {{last}})",
  http: "url (endereço fixo https), method (GET | POST | PUT | PATCH | DELETE), body (JSON)",
  tool: "tool (nome da ferramenta), args (JSON)",
  approval: "prompt (o que a pessoa deve revisar)",
  whatsapp: "to (número com DDI e DDD; use {{fluxo.telefone}} ou o número fixo), text (mensagem; use {{last}})",
  call: "to (telefone com DDI e DDD), context (o que o agente de voz deve saber e fazer; use {{last}})",
  loop: "target (id do bloco para onde voltar), limit (número de 1 a 20), limitMessage (mensagem entregue quando o limite chega sem concluir; opcional)",
  end: "text (resposta final; use {{last}} ou {{nodes.id}})",
};
export const GENERATOR_SYSTEM = `Você desenha fluxos de agentes de IA para executivos. Responda somente com um JSON válido, sem comentários nem texto fora do JSON.

Tipos de bloco disponíveis (kind) e seus campos de config:
${KINDS.map((k) => `- ${k} (${BLOCKS[k].label}: ${BLOCKS[k].help}) → ${FIELDS[k]}`).join("\n")}

Saídas (handle) de cada tipo: condition tem uma saída para cada criteria.id e a saída final "no" para nenhum critério atendido; approval tem "yes" e "no"; loop e end não têm saída (loop volta ao bloco target até limit e então encerra com limitMessage); os demais têm uma única saída (handle omitido).

Regras:
- Exatamente um bloco start, com nome Início. end é opcional: agent e llm sem saída entregam a resposta final.
- Todo bloco precisa ser alcançável a partir do start e chegar a um end ou agent/llm terminal.
- Condições avaliam critérios em ordem, seguem o primeiro atendido e usam "no" caso nenhum seja atendido. Cada critério tem id único, diferente de "no", e a condição deve ter pelo menos um critério.
- Cada saída recebe exatamente uma conexão, exceto agent/llm terminal, que não tem conexão de saída.
- Nenhuma conexão pode voltar a um bloco anterior. Para repetir etapas, termine o caminho em um loop com target apontando para o bloco a refazer (normalmente após uma condition que verifica o resultado).
- Use de 2 a 10 blocos. Prefira agent para tarefas com raciocínio. Não use http nem tool sem o pedido mencionar um serviço ou ferramenta.
- Textos em português do Brasil, claros e sem jargão técnico. Instruções (system) completas e específicas para o caso.
- Agente e LLM aceitam memoryEnabled ("true" por padrão; "false" desliga o histórico automático) e memoryType: allMessages (padrão, histórico da conversa e respostas dos agentes anteriores), windowSize (memoryWindowSize: número de mensagens anteriores, padrão "20"), conversationSummary (resumo por IA) ou conversationSummaryBuffer (resumo das antigas e mensagens recentes, memoryMaxTokens: limite aproximado, padrão "2000"). Esses campos são strings. A mensagem da etapa continua sendo enviada em todos os modos. Preserve a memória padrão, salvo pedido explícito para mudar.
- Referências aceitas nos textos: {{input}}, {{last}}, {{nodes.id}}, {{fluxo.variável}} e {{currentDateTime}} (data e hora atuais no horário de Brasília; use quando o pedido depender de prazos ou datas).
- ids curtos em minúsculas sem espaços (ex.: "inicio", "analista", "resposta").

Formato:
{"name": "Nome do fluxo", "description": "Uma frase", "nodes": [{"id": "inicio", "kind": "start", "label": "Início", "config": {}}], "edges": [{"source": "inicio", "target": "analista"}, {"source": "cond", "target": "x", "handle": "criterion_1"}]}`;
type Raw = {
  name?: unknown;
  description?: unknown;
  nodes?: unknown;
  edges?: unknown;
};
function text(v: unknown, max: number) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
// Converte a resposta do modelo em um grafo executável do produto.
export function parseGenerated(answer: string): Generated {
  const match = answer.match(/```(?:json)?\s*([\s\S]*?)```/) || [
    null,
    answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1),
  ];
  let raw: Raw;
  try {
    raw = JSON.parse(match[1] || "");
  } catch {
    throw new FlowError("A resposta do ChatGPT não veio no formato esperado.");
  }
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges))
    throw new FlowError("A resposta do ChatGPT não trouxe blocos e conexões.");
  const nodes = raw.nodes.map((n: Record<string, unknown>, i: number) => {
    const kind = String(n.kind) as GeneratedKind;
    if (!KINDS.includes(kind))
      throw new FlowError(`Tipo de bloco desconhecido: ${String(n.kind)}.`);
    const id =
      text(n.id, 80).replace(/[^a-zA-Z0-9_-]/g, "_") || `${kind}_${i + 1}`;
    const b = block(kind, id, 0, 0);
    b.data.label = text(n.label, 100) || BLOCKS[kind].label;
    const config =
      n.config && typeof n.config === "object" && !Array.isArray(n.config)
        ? (n.config as Record<string, unknown>)
        : {};
    for (const [k, v] of Object.entries(config))
      if (Object.hasOwn(b.data.config, k) || (kind === "condition" && k === "criteria") || k === "tools" || k === "model" || (["agent", "llm"].includes(kind) && k === "stateUpdates"))
        b.data.config[k] =
          typeof v === "string" ? v.slice(0, 20000) : JSON.stringify(v);
    return b;
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = raw.edges
    .map((e: Record<string, unknown>) => {
      const source = text(e.source, 80),
        target = text(e.target, 80);
      const node = nodes.find((n) => n.id === source);
      const kind = node?.data.kind;
      // Repetir não tem saída: uma seta "repeat" vira o destino e as demais são descartadas.
      if (kind === "loop") {
        if (text(e.handle ?? e.sourceHandle, 20) === "repeat" && !node!.data.config.target) node!.data.config.target = target;
        return null;
      }
      // Saída única: qualquer handle informado é ignorado; ramificação: handle obrigatório.
      const handle =
        kind && outputs(kind, node?.data.config).length > 1
          ? text(e.handle ?? e.sourceHandle, 20)
          : null;
      return { source, target, handle };
    })
    .filter((e): e is { source: string; target: string; handle: string | null } => !!e && ids.has(e.source) && ids.has(e.target))
    .map((e, i) => ({
      id: `g${i + 1}`,
      source: e.source,
      target: e.target,
      ...(e.handle ? { sourceHandle: e.handle } : {}),
    }));
  const graph = validateGraph(layout({ nodes, edges }), true);
  return {
    name: text(raw.name, 100) || "Fluxo gerado",
    description: text(raw.description, 1000),
    graph,
  };
}
// Pede ao ChatGPT um fluxo completo e tenta uma correção quando a primeira resposta é inválida.
// ChatGPT quando conectado; senão o OpenRouter com um modelo econômico.
export async function defaultRunner(signal?: AbortSignal) {
  if ((await chatGPT().account()).account)
    return (system: string, prompt: string) => chatGPT().run({ system, prompt, signal });
  if (openRouterKey())
    return (system: string, prompt: string) =>
      runOpenRouter({ system, prompt, model: GENERATOR_MODEL, signal });
  throw new FlowError("Conecte o ChatGPT ou o OpenRouter para gerar fluxos.", 409);
}
export async function generateFlow(
  request: unknown,
  run?: (system: string, prompt: string) => Promise<string>,
  onProgress?: (phase: GenerationPhase) => void,
  signal?: AbortSignal,
): Promise<Generated> {
  onProgress?.("interpreting");
  if (typeof request !== "string" || !request.trim() || request.length > 4000)
    throw new FlowError("Descreva o fluxo em até 4 mil caracteres.");
  run ??= await defaultRunner(signal);
  onProgress?.("planning");
  const answer = await run(GENERATOR_SYSTEM, request.trim());
  onProgress?.("creating");
  try {
    return parseGenerated(answer);
  } catch (first) {
    const reason =
      first instanceof Error ? first.message : "resposta inválida";
    onProgress?.("repairing");
    const retry = await run(
      GENERATOR_SYSTEM,
      `${request.trim()}\n\nA resposta anterior foi recusada: ${reason}\nResposta anterior:\n${answer.slice(0, 6000)}\n\nCorrija e responda somente com o JSON.`,
    );
    onProgress?.("creating");
    return parseGenerated(retry);
  }
}
