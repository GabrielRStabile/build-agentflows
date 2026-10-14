import { AuthError } from "./saas-security";
import { FlowError } from "./flow-store";
import { limitedJson } from "./saas-http";
import { MAX_ATTACHMENTS, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "./attachment-types";

// Corpo da execução publicada: multipart/form-data (campo "input" e até cinco "file") ou JSON {"input"}.
// O multipart é o formato dos exemplos de Implantar; o JSON continua aceito pelas integrações antigas.
export async function integrationPayload(req: Request): Promise<{ input: unknown; files: File[] }> {
  const type = (req.headers.get("content-type") || "").toLowerCase();
  if (!type.startsWith("multipart/form-data")) return { input: (await limitedJson(req, 300000)).input, files: [] };
  const reader = req.body?.getReader();
  if (!reader) throw new AuthError("Envie o campo input no formulário.");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_TOTAL_BYTES + 64 * 1024) { await reader.cancel(); throw new FlowError("O envio pode ter até 20 MB no total.", 413); }
    chunks.push(value);
  }
  let form: FormData;
  try { form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": req.headers.get("content-type") || "" } }).formData(); }
  catch { throw new AuthError("Envie um formulário multipart/form-data válido."); }
  const files = form.getAll("file").filter((item): item is File => item instanceof File && item.size > 0);
  if (files.length > MAX_ATTACHMENTS) throw new FlowError(`Envie até ${MAX_ATTACHMENTS} arquivos no campo file.`);
  if (files.some((file) => file.size > MAX_FILE_BYTES)) throw new FlowError("Cada arquivo pode ter até 10 MB.", 413);
  if (files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) throw new FlowError("Os arquivos somam mais de 20 MB.", 413);
  const input = form.get("input");
  return { input: typeof input === "string" ? input : undefined, files };
}
