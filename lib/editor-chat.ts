// Conversa de teste do editor guardada neste navegador por fluxo: só os ids das execuções.
// Ausência da chave e lista vazia (conversa limpa) não restauram nada.
const LIMIT = 200;
type Store = Pick<Storage, "getItem" | "setItem">;
export function editorChatKey(flowId: string) {
  return "agentflows-chat:" + flowId;
}
export function readEditorChat(store: Store, flowId: string): string[] {
  try {
    const value: unknown = JSON.parse(store.getItem(editorChatKey(flowId)) || "[]");
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((id): id is string => typeof id === "string" && !!id))].slice(-LIMIT);
  } catch {
    return [];
  }
}
export function writeEditorChat(store: Store, flowId: string, ids: string[]) {
  try {
    store.setItem(editorChatKey(flowId), JSON.stringify(ids.slice(-LIMIT)));
  } catch {
    // Armazenamento indisponível (janela privada ou cota): a conversa segue só na memória.
  }
}
