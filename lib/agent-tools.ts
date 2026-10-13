import { REPLICATE_MODEL } from "./media-models";
// O bloco guarda apenas o identificador da credencial; segredos ficam no servidor.
export type ToolCard = { id: string; kind: "tool" | "mcp"; target: string; credentialId?: string; params?: Record<string, string> };
function validActions(value: string) {
  try { const actions: unknown = JSON.parse(value); return Array.isArray(actions) && actions.length <= 100 && actions.every((action) => typeof action === "string" && action.length <= 128); } catch { return false; }
}
export function validateToolCards(encoded: string) {
  if (!encoded) return;
  let cards: unknown;
  try { cards = JSON.parse(encoded); } catch { throw new Error("Confira as ferramentas deste agente."); }
  if (!Array.isArray(cards) || cards.length > 100 || cards.some((card) => !card || typeof card.id !== "string" || !card.id || !["tool", "mcp"].includes(card.kind) || typeof card.target !== "string" ||
    (card.params !== undefined && (!card.params || typeof card.params !== "object" || Array.isArray(card.params) || Object.entries(card.params).some(([key, value]) => !["flowId", "description", "timezone", "actions", "app", "connectedAccountId", "model"].includes(key) || typeof value !== "string" || value.length > 10000))) ||
    (card.params?.actions !== undefined && !validActions(card.params.actions)) ||
    (card.credentialId !== undefined && (card.kind !== "tool" || typeof card.credentialId !== "string" || !/^[a-f0-9-]{36}$/.test(card.credentialId))))) throw new Error("Confira as ferramentas e as credenciais selecionadas neste agente.");
  if ((cards as ToolCard[]).some((card) => card.target === "interno:replicate" && card.params?.model && !REPLICATE_MODEL.test(card.params.model)))
    throw new Error("Informe o modelo da Replicate no formato empresa/modelo, em letras minúsculas. Ex.: google/nano-banana.");
}
export function selectedTools(value: string): string[] {
  return [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))];
}
export function belongsToCard(tool: string, card: ToolCard) {
  return !!card.target && (card.kind === "tool" ? tool === card.target : tool.startsWith(`mcp:${card.target}:`));
}
export function readToolCards(value: string, encoded = ""): ToolCard[] {
  const cards: ToolCard[] = [];
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (Array.isArray(parsed)) for (const c of parsed) {
      if (!c || typeof c.id !== "string" || !c.id || !["tool", "mcp"].includes(c.kind) || typeof c.target !== "string") continue;
      if (cards.some((p) => p.id === c.id || (c.target && p.kind === c.kind && p.target === c.target))) continue;
      cards.push({ id: c.id, kind: c.kind, target: c.target, ...(c.params && typeof c.params === "object" && !Array.isArray(c.params) ? { params: Object.fromEntries(Object.entries(c.params).filter(([, value]) => typeof value === "string")) as Record<string, string> } : {}), ...(c.kind === "tool" && typeof c.credentialId === "string" && c.credentialId ? { credentialId: c.credentialId } : {}) });
    }
  } catch {}
  // Agrupa as ações selecionadas por ferramenta e servidor, sem mudar permissões.
  for (const id of selectedTools(value)) {
    const kind = id.startsWith("mcp:") ? "mcp" : "tool";
    const target = kind === "mcp" ? id.split(":")[1] : id;
    if (!cards.some((c) => c.kind === kind && c.target === target)) {
      let key = `saved-${kind}-${target}`;
      while (cards.some((c) => c.id === key)) key += "-";
      cards.push({ id: key, kind, target });
    }
  }
  return cards;
}
export function replaceToolCard(selected: string[], cards: ToolCard[], id: string, target: string | null) {
  const card = cards.find((c) => c.id === id);
  if (!card || card.target === target) return { selected, cards };
  if (target && cards.some((c) => c.id !== id && c.kind === card.kind && c.target === target)) return { selected, cards };
  const next = selected.filter((t) => !belongsToCard(t, card));
  if (target && card.kind === "tool") next.push(target);
  return {
    selected: [...new Set(next)],
    cards: target === null ? cards.filter((c) => c.id !== id) : cards.map((c) => c.id === id ? { id: c.id, kind: c.kind, target } : c),
  };
}
