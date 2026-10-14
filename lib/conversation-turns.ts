// Turnos de uma conversa (pessoa e assistente), compartilhados pela memória e pelos provedores.
export type ConversationTurn = { role: "user" | "assistant"; content: string };
// Forma textual da troca, para provedores que só recebem texto da pessoa e para o registro da etapa.
export function transcript(turns: ConversationTurn[], prompt: string) {
  if (!turns.length) return prompt;
  return [...turns.map((turn) => (turn.role === "user" ? "Pessoa: " : "Assistente: ") + turn.content), "Pessoa: " + prompt].join("\n\n");
}
