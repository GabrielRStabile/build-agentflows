// Exportação genérica de fluxos: o arquivo compartilhado entre contas não leva identificadores que só
// existem na conta de origem (credenciais, bases de conhecimento, subfluxos, contas conectadas).
// Aplicado ao exportar e ao importar, para arquivos antigos também entrarem sem "não encontrada nesta conta".
import type { Graph } from "./flow-types";

/** Chaves do config de um bloco que apontam para registros da conta. */
export const ACCOUNT_CONFIG_KEYS = ["modelCredentialId", "knowledgeBases", "knowledgeBase"] as const;
/** Parâmetros de cartões de ferramenta que apontam para registros da conta. */
export const ACCOUNT_CARD_PARAMS = ["flowId", "connectedAccountId"] as const;

export function portableToolCards(encoded: string): string {
  let cards: unknown;
  try { cards = JSON.parse(encoded); } catch { return encoded; }
  if (!Array.isArray(cards)) return encoded;
  return JSON.stringify(cards.map((card) => {
    if (!card || typeof card !== "object") return card;
    const { credentialId: _credential, params, ...rest } = card as { credentialId?: string; params?: Record<string, unknown> };
    void _credential;
    const kept = params && typeof params === "object" && !Array.isArray(params)
      ? Object.fromEntries(Object.entries(params).filter(([key]) => !(ACCOUNT_CARD_PARAMS as readonly string[]).includes(key)))
      : undefined;
    return { ...rest, ...(kept && Object.keys(kept).length ? { params: kept } : {}) };
  }));
}

/** Cópia do grafo sem vínculos com a conta; as seleções voltam a ser feitas por quem importa. */
export function portableGraph(graph: Graph): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const config = { ...node.data.config };
      for (const key of ACCOUNT_CONFIG_KEYS) delete config[key];
      if (config.toolCards) config.toolCards = portableToolCards(config.toolCards);
      return { ...node, data: { ...node.data, config } };
    }),
  };
}
