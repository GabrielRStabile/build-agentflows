import { block, template, type Graph, type Kind } from "./flow-types";
import { PRESET_GRAPHS } from "./flow-presets-graphs";
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
  retriever: style("#b8bed1", "Agentes e IA"),
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
export type Preset = {
  id: string;
  name: string;
  /** Vira a descrição do fluxo criado a partir do modelo. */
  description: string;
  category: string;
  /** O que a pessoa informa na primeira mensagem. */
  input: string;
  /** Aparece em "Sugeridos para começar". */
  suggested?: boolean;
  /** Caminho principal do grafo: id do bloco e o que ele faz. Tipo e nome saem do próprio bloco. */
  steps: [string, string][];
};
export const PRESETS: Preset[] = [
  {
    id: "support",
    name: "Triagem de atendimento",
    description:
      "Analise solicitações e prepare uma resposta para cada cliente.",
    category: "Atendimento",
    input: "A solicitação do cliente.",
    steps: [["inicio", "Recebe a solicitação."], ["analista", "Classifica a prioridade e sugere a resposta."], ["resposta", "Entrega a resposta."]],
  },
  {
    id: "approval",
    name: "Conteúdo com aprovação",
    description: "Um agente escreve. Você revisa antes de liberar a resposta.",
    category: "Marketing",
    input: "O briefing do conteúdo.",
    steps: [["inicio", "Recebe o briefing."], ["analista", "Escreve um texto claro a partir do briefing."], ["revisao", "Você aprova ou devolve."], ["resposta", "Libera o texto aprovado."]],
  },
  {
    id: "routing",
    name: "Roteamento por prioridade",
    description:
      "Direcione solicitações urgentes para um agente especializado.",
    category: "Operações",
    input: "A solicitação a ser roteada.",
    steps: [["inicio", "Recebe a solicitação."], ["prioridade", "Confere se é urgente."], ["urgente", "Responde os urgentes e propõe próximos passos."], ["normal", "Responde os demais."], ["resposta", "Entrega a resposta."]],
  },
  {
    id: "rh-curriculos",
    name: "Triagem de currículos com aprovação",
    description: "Cole a descrição da vaga e o currículo: a Decisão avalia critérios fechados, o agente escreve a recomendação e o recrutador aprova antes de seguir.",
    category: "RH",
    input: "A descrição da vaga e o currículo.",
    suggested: true,
    steps: [["inicio", "Recebe a vaga e o currículo."], ["avaliacao", "Nota de 1 a 5, senioridade e encaminhamento."], ["recomendacao", "Escreve a recomendação, sem fatores discriminatórios."], ["revisao", "Você libera ou devolve para ajuste."], ["resposta", "Entrega a recomendação ao gestor."]],
  },
  {
    id: "financeiro-reembolso",
    name: "Análise de reembolso de despesas",
    description: "Cole a despesa e a política da empresa: um analista confere regras e um redator monta a resposta ao colaborador.",
    category: "Financeiro",
    input: "O pedido de reembolso e a política da empresa.",
    steps: [["inicio", "Recebe o pedido e a política."], ["analista", "Confere cada item e soma o total aprovado."], ["conferencia", "Você confirma a análise antes de avisar."], ["redator", "Escreve o e-mail ao colaborador."], ["resposta", "Entrega o e-mail pronto."]],
  },
  {
    id: "juridico-contrato",
    name: "Revisor de contrato em 2 etapas",
    description: "Cole o contrato: o primeiro agente extrai as cláusulas-chave e o segundo aponta riscos e sugere ajustes.",
    category: "Jurídico",
    input: "O texto do contrato.",
    steps: [["inicio", "Recebe o contrato."], ["extrator", "Lista partes, valores, prazos, multas e foro."], ["riscos", "Aponta até 6 riscos e sugere a redação."], ["resposta", "Entrega o parecer com a conclusão."]],
  },
  {
    id: "vendas-reuniao",
    name: "Preparação de reunião com cliente",
    description: "Informe empresa, contato e objetivo: um agente mapeia o cliente e outro monta o roteiro da reunião.",
    category: "Vendas",
    input: "Empresa, contato e objetivo da reunião.",
    steps: [["inicio", "Recebe o que você sabe do cliente."], ["mapeador", "Contexto, dores, decisores e objeções."], ["roteirista", "Perguntas, respostas às objeções e follow-up."], ["resposta", "Entrega o roteiro da reunião."]],
  },
  {
    id: "educacao-aula",
    name: "Plano de aula com atividade e quiz",
    description: "Informe tema, público e duração: um agente cria o plano e outro cria quiz com gabarito. A resposta entrega os dois juntos.",
    category: "Educação",
    input: "Tema, público e duração da aula.",
    steps: [["inicio", "Recebe o pedido do professor."], ["planejador", "Objetivos, roteiro por minuto e atividade."], ["avaliador", "5 questões de múltipla escolha com gabarito."], ["resposta", "Entrega o plano e o quiz juntos."]],
  },
  {
    id: "marketing-critico",
    name: "Redator e crítico com revisão automática",
    description: "Um redator escreve o post, um crítico confere critérios e o fluxo repete a escrita até aprovar (máximo 2 revisões).",
    category: "Marketing",
    input: "O briefing do post.",
    suggested: true,
    steps: [["inicio", "Recebe o briefing."], ["redator", "Escreve o post para o LinkedIn."], ["critico", "Confere 5 critérios e dá o veredito."], ["aprovado", "Aprovado vai para o fim; senão, volta."], ["revisar", "Reescreve até 2 vezes."], ["resposta", "Entrega a versão aprovada."]],
  },
  {
    id: "cs-feedback",
    name: "Análise de feedback e resposta",
    description: "Cole o feedback de um cliente: a Decisão classifica sentimento, tema e urgência e o agente escreve a resposta certa.",
    category: "Customer Success",
    input: "O feedback do cliente.",
    steps: [["inicio", "Recebe o feedback."], ["classificacao", "Sentimento, tema e urgência."], ["resposta_cliente", "Responde conforme o sentimento."], ["resposta", "Entrega a resposta e a nota para a equipe."]],
  },
  {
    id: "compras-fornecedores",
    name: "Comparador de propostas de fornecedores",
    description: "Cole as propostas: o agente compara e recomenda. Se houver risco alto, um humano precisa aprovar; senão segue direto.",
    category: "Compras",
    input: "As propostas dos fornecedores e, se houver, os seus critérios.",
    steps: [["inicio", "Recebe as propostas."], ["analise", "Compara, pontua e recomenda."], ["risco", "Risco baixo segue direto."], ["aprovacao", "Só quando o risco é alto."], ["resposta", "Entrega a recomendação."]],
  },
  {
    id: "gestao-reuniao",
    name: "Da reunião ao plano de ação",
    description: "Cole a transcrição de uma reunião: 3 agentes geram a ata, o plano de ação com responsáveis e o e-mail de follow-up.",
    category: "Gestão",
    input: "A transcrição da reunião.",
    suggested: true,
    steps: [["inicio", "Recebe a transcrição."], ["ata", "Escreve a ata."], ["acoes", "Lista ações com responsável e prazo."], ["followup", "Escreve o e-mail aos participantes."], ["resposta", "Entrega ata, plano e e-mail juntos."]],
  },
];
/** Passos do modelo com o tipo e o nome de cada bloco, para a biblioteca. */
export function presetSteps(p: Preset) {
  const nodes = preset(p.id).nodes;
  return p.steps.flatMap(([id, help]) => {
    const node = nodes.find((n) => n.id === id);
    return node ? [{ id, kind: node.data.kind, label: node.data.label, help }] : [];
  });
}
export function preset(id: string): Graph {
  if (PRESET_GRAPHS[id]) return structuredClone(PRESET_GRAPHS[id]);
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
