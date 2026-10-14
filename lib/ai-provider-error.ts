import { FlowError } from "./flow-store";
/** Extracts the provider's own explanation from an error body (OpenAI-style JSON `error.message` or plain text). */
export function providerDetail(body: string | undefined) {
  if (!body) return "";
  let text = body.trim();
  try {
    const data = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const inner = typeof data.error === "string" ? data.error : data.error?.message || data.message;
    if (inner) text = String(inner).trim();
  } catch { /* plain text */ }
  if (!text || text.startsWith("<")) return "";
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
export function providerFailure(status: number, body?: string) {
  const message = status === 401 || status === 403 ? "O fornecedor recusou a chave. Revise a conexão em Credenciais."
    : status === 402 ? "Sua conta no fornecedor está sem saldo para este modelo."
    : status === 429 ? "O fornecedor atingiu o limite de uso. Aguarde ou escolha outro modelo."
    : status === 404 ? "Este modelo não está disponível para a credencial selecionada."
    : status === 400 ? "O fornecedor recusou os parâmetros ou a mensagem. Revise as configurações do modelo."
    : "O fornecedor está indisponível. Tente novamente em alguns instantes.";
  const detail = providerDetail(body);
  return new FlowError(detail ? `${message} Resposta do fornecedor: ${detail}` : message, status >= 400 && status < 500 ? status : 502);
}
