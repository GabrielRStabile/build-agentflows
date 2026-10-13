import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { extractText, getDocumentProxy } from "unpdf";
import { FlowError } from "./flow-store";
import { MAX_FILE_BYTES, type Attachment } from "./attachment-types";
export type StoredAttachment = Attachment & { flowId: string; text?: string };
export async function uploadForm(req: Request) {
  // Limite real dos bytes, inclusive quando Content-Length não está presente.
  const reader = req.body?.getReader();
  if (!reader) throw new FlowError("Escolha um arquivo para anexar.");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FILE_BYTES + 64 * 1024) { await reader.cancel(); throw new FlowError("Cada arquivo pode ter até 10 MB.", 413); }
    chunks.push(value);
  }
  try {
    return await new Response(Buffer.concat(chunks), { headers: { "Content-Type": req.headers.get("content-type") || "" } }).formData();
  } catch { throw new FlowError("Envie o arquivo pelo botão de anexar."); }
}
// Generated videos only: uploads never accept them. MP4 has "ftyp" at offset 4; WebM starts with the EBML header.
export function videoFormat(bytes: Buffer) {
  if (bytes.subarray(4, 8).toString("latin1") === "ftyp" && bytes.subarray(8, 10).toString("latin1") !== "qt") return "mp4";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "webm";
}
export async function prepareAttachment(file: File, generated = false) {
  if (!file.size || file.size > MAX_FILE_BYTES) throw new FlowError("Escolha um arquivo não vazio de até 10 MB.");
  const name = file.name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f]/g, "").slice(0, 180) || "anexo";
  const ext = name.split(".").pop()?.toLowerCase();
  const bytes = Buffer.from(await file.arrayBuffer());
  let mime: string, text: string | undefined;
  let kind: Attachment["kind"] = "document";
  const imageFormats: Record<string, string> = { png: "png", jpg: "jpeg", jpeg: "jpeg", webp: "webp" };
  if (generated && ext && ["mp4", "webm"].includes(ext)) {
    if (videoFormat(bytes) !== ext) throw new FlowError("O provedor não retornou um vídeo MP4 ou WebM válido.", 502);
    mime = `video/${ext}`; kind = "video";
  } else if (ext && imageFormats[ext]) {
    try {
      const image = sharp(bytes, { limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      if (metadata.format !== imageFormats[ext] || (metadata.pages || 1) > 1) throw new Error();
      await image.stats();
      mime = `image/${metadata.format}`; kind = "image";
    } catch { throw new FlowError("Imagem inválida ou muito grande. Use PNG, JPG ou WebP estático com até 40 megapixels."); }
  } else if (ext === "pdf") {
    if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new FlowError("O arquivo não é um PDF válido.");
    try {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      try {
        if (pdf.numPages > 100) throw new FlowError("Use um PDF com até 100 páginas.");
        text = (await extractText(pdf, { mergePages: true })).text;
      } finally { await pdf.loadingTask.destroy(); }
    } catch (e) { if (e instanceof FlowError) throw e; throw new FlowError("Não foi possível ler o PDF. Envie um documento sem senha ou copie o texto."); }
    if (!text?.trim()) throw new FlowError("Este PDF não tem texto extraível. Envie as páginas como imagens para um modelo com suporte a imagens.");
    mime = "application/pdf";
  } else if (ext && ["txt", "md", "csv", "json"].includes(ext)) {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new FlowError("Salve o documento como texto UTF-8 e envie novamente."); }
    if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new FlowError("O arquivo contém dados binários. Use um documento de texto.");
    mime = ext === "json" ? "application/json" : ext === "csv" ? "text/csv" : "text/plain";
  } else throw new FlowError("Formato não aceito. Use PNG, JPG, WebP, PDF, TXT, MD, CSV ou JSON.");
  if (kind === "document" && !text?.trim()) throw new FlowError("O documento está vazio.");
  if (text && text.length > 60000) throw new FlowError("O documento excede 60 mil caracteres. Divida-o em arquivos menores.");
  const attachment: Attachment = { id: randomUUID(), name, mime, size: file.size, kind, ...(text ? { textLength: text.length } : {}) };
  return { attachment, bytes, text };
}
