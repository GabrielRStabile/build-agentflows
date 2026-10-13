import type { KnowledgeReference } from "./knowledge-references";
import type { TokenUsage } from "./token-usage";
import type { Attachment } from "./attachment-types";
import { MEMORY_DEFAULTS } from "./memory-settings";
export const DEFAULT_SYSTEM = "Você é um assistente cuidadoso. Responda em português.";
export const BLOCKS = {
  start: {
    label: "Início",
    icon: "▷",
    help: "Recebe a entrada e prepara o estado.",
  },
  llm: {
    label: "LLM (Assistente)",
    icon: "✧",
    help: "Responde com um modelo de IA e consulta as bases de conhecimento configuradas.",
  },
  agent: {
    label: "Agente",
    icon: "◈",
    help: "Decide quais ferramentas usar para cumprir uma tarefa.",
  },
  condition: {
    label: "Condição",
    icon: "◇",
    help: "Escolhe o caminho pelo primeiro critério atendido.",
  },
  state: {
    label: "Atualizar estado",
    icon: "≡",
    help: "Guarda um valor para os próximos blocos.",
  },
  http: {
    label: "Requisição HTTP",
    icon: "↗",
    help: "Consulta ou envia dados para um serviço.",
  },
  tool: {
    label: "Ferramenta",
    icon: "⚒",
    help: "Executa uma ferramenta pronta ou de um servidor conectado.",
  },
  approval: {
    label: "Aprovação humana",
    icon: "✓",
    help: "Aguarda sua decisão antes de continuar.",
  },
  loop: {
    label: "Repetir",
    icon: "↻",
    help: "Repete um caminho com limite de passagens.",
  },
  whatsapp: {
    label: "Enviar WhatsApp",
    icon: "✆",
    help: "Envia uma mensagem pelo número conectado.",
  },
  call: {
    label: "Ligação por voz",
    icon: "☎",
    help: "Liga para um telefone com o agente de conversa.",
  },
  end: { label: "Resposta", icon: "□", help: "Entrega o resultado do fluxo." },
} as const;
export type Kind = keyof typeof BLOCKS;
// Nome curto usado nos blocos novos (Agente 0, LLM 1...), como no Flowise.
export function shortLabel(kind: Kind) {
  return kind === "llm" ? "LLM" : BLOCKS[kind].label;
}
export type Block = {
  id: string;
  type: "block";
  position: { x: number; y: number };
  selected?: boolean;
  data: { kind: Kind; label: string; config: Record<string, string> };
};
export type Link = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
};
export type Graph = { nodes: Block[]; edges: Link[] };
export type Flow = {
  id: string;
  name: string;
  description: string;
  voiceId?: string;
  graph: Graph;
  published: Graph | null;
  version: number;
  updatedAt: string;
};
export type Trace = {
  images?: Attachment[];
  // Media generations submitted by this step; the id lets the user check the job and billing with the provider.
  media?: { provider: string; model: string; requestId: string }[];
  // Amount charged in US dollars, only when the provider reports it (e.g. OpenRouter usage.cost).
  cost?: number;
  knowledge?: { chunks?: KnowledgeReference[]; baseId?: string; count: number; references: boolean; available?: { baseId: string; baseName: string; description: string }[]; bases?: { baseId: string; baseName: string; count: number; references: boolean }[] };
  type?: "step" | "tool";
  status?: "running" | "completed" | "failed";
  input?: string;
  instructions?: string;
  usage?: TokenUsage;
  nodeId: string;
  label: string;
  output: string;
  at: string;
  ms: number;
};
export type Run = {
  id: string;
  flowId: string;
  name: string;
  version: number;
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  demo: boolean;
  embedSessionId?: string;
  pageCommandId?: string;
  activeMs?: number;
  activeSegmentStartedAt?: number;
  maxActiveMs?: number;
  interrupted?: boolean;
  queued?: boolean;
  recoveryAttempts?: number;
  input: string;
  attachments?: Attachment[];
  mediaRequests?: (import("./media-provider").MediaRequest & { nodeId: string; at: string })[];
  conversation?: { input: string; output: string }[];
  output: string;
  error?: string;
  graph: Graph;
  next: string | null;
  state: Record<string, string>;
  outputs: Record<string, string>;
  visits: Record<string, number>;
  trace: Trace[];
  createdAt: string;
  updatedAt: string;
};
export function block(kind: Kind, id: string, x: number, y: number): Block {
  const config: Record<string, string> =
    kind === "start"
      ? { state: "{}" }
      : kind === "condition"
        ? { value: "{{input}}", operator: "contains", compare: "urgente" }
        : kind === "loop"
          ? { limit: "3" }
          : kind === "http"
            ? { url: "", method: "GET", body: "{{input}}" }
            : kind === "state"
              ? { key: "resultado", value: "{{last}}" }
              : kind === "tool"
                ? { tool: "", args: "{}" }
                : kind === "approval"
                  ? { prompt: "Revise o resultado antes de continuar." }
                  : kind === "whatsapp"
                    ? { to: "", text: "{{last}}" }
                    : kind === "call"
                      ? { to: "", context: "{{last}}" }
                  : kind === "end"
                    ? { text: "{{last}}" }
                    : {
                        system: DEFAULT_SYSTEM,
                        prompt: "",
                        model: "",
                        tools: "",
                        ...MEMORY_DEFAULTS,
                      };
  return {
    id,
    type: "block",
    position: { x, y },
    data: { kind, label: BLOCKS[kind].label, config },
  };
}
export function template(example = false): Graph {
  const nodes = [
    block("start", "inicio", 40, 160),
    block("agent", "analista", 340, 160),
    block("end", "resposta", 660, 160),
  ];
  if (example) {
    nodes[1].data.label = "Analista de atendimento";
    nodes[1].data.config.system =
      "Analise a solicitação. Classifique a prioridade e sugira uma resposta objetiva e acolhedora.";
  }
  return {
    nodes,
    edges: [
      { id: "e1", source: "inicio", target: "analista" },
      { id: "e2", source: "analista", target: "resposta" },
    ],
  };
}

export type RunSummary = Pick<Run, "id" | "flowId" | "name" | "status" | "demo" | "createdAt" | "input">;
export type RunPage = { items: RunSummary[]; page: number; pageSize: number; total: number; totalPages: number };
