import { FlowError } from "./flow-store";
/** Extracts the provider's own explanation from an error body (OpenAI-style JSON `error.message` or plain text). */
export function providerDetail(body: string | undefined) {
  if (!body) return "";
  let text = body.trim();
  try {
    // The Gemini OpenAI-compatible endpoint wraps the error in an array.
    const parsed = JSON.parse(text) as unknown;
    const data = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: { message?: string } | string; message?: string };
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
  // Gemini's OpenAI-compatible endpoint cannot return generated images; only the native API (image models) does.
  if (status === 400 && /Unhandled generated data mime type: image\//i.test(detail)) return new FlowError("O modelo do Google respondeu com uma imagem, que esta forma de chamada não entrega. Para gerar imagens, escolha um modelo de imagem do Gemini (nome com \"image\").", 400);
  return new FlowError(detail ? `${message} Resposta do fornecedor: ${detail}` : message, status >= 400 && status < 500 ? status : 502);
}

/** Espera máxima aceita quando o fornecedor pede para tentar de novo (limite por minuto dos planos gratuitos). */
export const RATE_LIMIT_MAX_WAIT_MS = 60_000;
export const RATE_LIMIT_ATTEMPTS = 3;
/** Quanto o fornecedor pede para esperar antes de repetir: cabeçalho Retry-After ou "try again in 11.5s" / "1m2s" no corpo. */
export function retryAfterMs(headers: Headers, body: string): number | undefined {
  const header = headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  const match = /try again in\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s)\s*)+)/i.exec(providerDetail(body));
  if (!match) return undefined;
  let total = 0;
  for (const [, value, unit] of match[1].matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g))
    total += Number(value) * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1);
  return total;
}
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
  function abort() { clearTimeout(timer); reject(new Error("Execução cancelada.")); }
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
});
/**
 * Faz a chamada e repete quando o fornecedor responde 429 informando quanto esperar (até RATE_LIMIT_ATTEMPTS
 * tentativas e RATE_LIMIT_MAX_WAIT_MS por espera). Nunca troca de modelo ou fornecedor. Em falha, devolve o
 * corpo já lido para a mensagem de erro; em sucesso, o corpo fica por ler.
 */
export async function fetchWithRateLimitRetry(request: () => Promise<Response>, signal?: AbortSignal, onWait?: (ms: number) => void): Promise<{ response: Response; detail: string }> {
  for (let attempt = 1; ; attempt++) {
    const response = await request();
    if (response.ok) return { response, detail: "" };
    const detail = await response.text().catch(() => "");
    const wait = response.status === 429 ? retryAfterMs(response.headers, detail) : undefined;
    if (wait === undefined || wait > RATE_LIMIT_MAX_WAIT_MS || attempt >= RATE_LIMIT_ATTEMPTS) return { response, detail };
    onWait?.(wait);
    await sleep(wait, signal);
  }
}
