import { block, template, type Graph, type Kind } from "./flow-types";
// Cores dos blocos do Flowise Agentflows v2 (AGENTFLOW_ICONS), com o fundo suave derivado.
function style(color: string, group: string) {
  return {
    color,
    soft: `color-mix(in srgb, ${color} 14%, white)`,
    group,
  };
}
export const NODE_STYLE: Record<
  Kind,
  { color: string; soft: string; group: string }
> = {
  start: style("#7EE787", "Controle de fluxo"),
  llm: style("#64B5F6", "Agentes e IA"),
  agent: style("#4DD0E1", "Agentes e IA"),
  condition: style("#FFB938", "Controle de fluxo"),
  decision: style("#F06292", "Agentes e IA"),
  state: style("#E4B7FF", "Dados e integrações"),
  http: style("#FF7F7F", "Dados e integrações"),
  tool: style("#d4a373", "Dados e integrações"),
  approval: style("#6E6EFD", "Controle de fluxo"),
  loop: style("#FFA07A", "Controle de fluxo"),
  end: style("#4DDBBB", "Controle de fluxo"),
  whatsapp: style("#25D366", "Canais"),
  call: style("#F4A261", "Canais"),
};
// Ferramentas, WhatsApp e ligações vivem dentro do Agente e em Implantar; não entram na paleta.
export const PALETTE_HIDDEN: Kind[] = ["tool", "whatsapp", "call"];
export const PRESETS = [
  {
    id: "support",
    name: "Triagem de atendimento",
    description:
      "Analise solicitações e prepare uma resposta para cada cliente.",
    category: "Atendimento",
    kinds: ["start", "agent", "end"] as Kind[],
  },
  {
    id: "approval",
    name: "Conteúdo com aprovação",
    description: "Um agente escreve. Você revisa antes de liberar a resposta.",
    category: "Marketing",
    kinds: ["start", "agent", "approval", "end"] as Kind[],
  },
  {
    id: "routing",
    name: "Roteamento por prioridade",
    description:
      "Direcione solicitações urgentes para um agente especializado.",
    category: "Operações",
    kinds: ["start", "condition", "agent", "end"] as Kind[],
  },
];
export function preset(id: string): Graph {
  const g = template(true);
  if (id === "approval") {
    g.nodes[1].data.label = "Redator";
    g.nodes[1].data.config.system =
      "Escreva um texto claro e objetivo a partir do briefing recebido.";
    g.nodes[2].position.x = 980;
    g.nodes[2].data.config.text = "{{nodes.analista}}";
    g.nodes.push(
      block("approval", "revisao", 660, 160),
      block("end", "rejeitado", 980, 350),
    );
    g.nodes[3].data.label = "Revisar conteúdo";
    g.nodes[4].data.config.text =
      "Conteúdo não aprovado. Ajuste as instruções e teste novamente.";
    g.edges = [
      { id: "a", source: "inicio", target: "analista" },
      { id: "b", source: "analista", target: "revisao" },
      { id: "c", source: "revisao", target: "resposta", sourceHandle: "yes" },
      { id: "d", source: "revisao", target: "rejeitado", sourceHandle: "no" },
    ];
  }
  if (id === "routing") {
    g.nodes[1] = block("condition", "prioridade", 340, 180);
    g.nodes[2].position = { x: 980, y: 180 };
    const urgent = block("agent", "urgente", 650, 80),
      normal = block("agent", "normal", 650, 310);
    urgent.data.label = "Atendimento prioritário";
    normal.data.label = "Atendimento geral";
    urgent.data.config.system =
      "Prepare uma resposta para um cliente com uma solicitação urgente. Proponha os próximos passos.";
    g.nodes.push(urgent, normal);
    g.edges = [
      { id: "a", source: "inicio", target: "prioridade" },
      { id: "b", source: "prioridade", target: "urgente", sourceHandle: "yes" },
      { id: "c", source: "prioridade", target: "normal", sourceHandle: "no" },
      { id: "d", source: "urgente", target: "resposta" },
      { id: "e", source: "normal", target: "resposta" },
    ];
  }
  return g;
}
