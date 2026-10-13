import { FlowError } from "./flow-store";
import type { SourceFile } from "./knowledge-loaders";
import type { saveKnowledgeSource } from "./tenant-knowledge";
export async function knowledgeRequestBytes(req: Request, max: number) {
  if (Number(req.headers.get("content-length")) > max)
    throw new FlowError("O conteúdo enviado excede o limite permitido.", 413);
  const reader = req.body?.getReader();
  if (!reader) throw new FlowError("Envie os dados da solicitação.");
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max)
        throw new FlowError(
          "O conteúdo enviado excede o limite permitido.",
          413,
        );
      parts.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(parts);
}
export async function knowledgeBody(
  req: Request,
): Promise<Record<string, unknown>> {
  const bytes = await knowledgeRequestBytes(req, 3_000_000);
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new FlowError("Envie um objeto JSON válido.");
  }
}
export async function knowledgeSourceBody(req: Request) {
  let input: Record<string, unknown>;
  let files: SourceFile[] | undefined;
  if (req.headers.get("content-type")?.startsWith("multipart/form-data")) {
    const bytes = await knowledgeRequestBytes(req, 21 * 1024 * 1024);
    let form: FormData;
    try {
      form = await new Response(bytes, {
        headers: { "content-type": req.headers.get("content-type")! },
      }).formData();
      input = JSON.parse(String(form.get("source")));
    } catch {
      throw new FlowError("Confira os dados e os arquivos da fonte.");
    }
    const attachments = form.getAll("files");
    if (attachments.length) {
      if (attachments.some((f) => typeof f === "string"))
        throw new FlowError("Arquivo inválido.");
      files = await Promise.all(
        (attachments as File[]).map(async (f) => ({
          name: f.name.replace(/[/\\]/g, "_").slice(0, 200),
          data: Buffer.from(await f.arrayBuffer()).toString("base64"),
        })),
      );
    }
  } else input = await knowledgeBody(req);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new FlowError("Preencha os dados da fonte.");
  return { input: input as Parameters<typeof saveKnowledgeSource>[1], files };
}
