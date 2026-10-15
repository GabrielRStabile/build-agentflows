import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { extractText, getDocumentProxy } from "unpdf";
import { load } from "cheerio";
import * as XLSX from "xlsx";
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
const SPREADSHEET_MIME: Record<string, string> = { xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
const MAX_SHEET_ROWS = 5000;
/** Every sheet as CSV under its name; formulas arrive as their last computed values. */
export function spreadsheetText(bytes: Buffer, ext: "xls" | "xlsx") {
  // XLSX is a ZIP (PK); XLS is an OLE compound file. Anything else is refused before parsing.
  const magic = ext === "xlsx" ? Buffer.from("504b0304", "hex") : Buffer.from("d0cf11e0a1b11ae1", "hex");
  if (!bytes.subarray(0, magic.length).equals(magic)) throw new FlowError(`O arquivo não é uma planilha ${ext.toUpperCase()} válida.`);
  let book: XLSX.WorkBook;
  try { book = XLSX.read(bytes, { type: "buffer", dense: true, sheetRows: MAX_SHEET_ROWS, cellHTML: false, cellFormula: false, bookVBA: false }); }
  catch { throw new FlowError("Não foi possível ler a planilha. Envie um arquivo sem senha ou exporte como CSV."); }
  const parts = book.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(book.Sheets[name], { blankrows: false }).replace(/^,+$/gm, "").trim();
    const full = book.Sheets[name]["!fullref"], rows = full ? XLSX.utils.decode_range(full).e.r + 1 : 0;
    const note = rows > MAX_SHEET_ROWS ? `\n[A aba tem ${rows} linhas; só as primeiras ${MAX_SHEET_ROWS} foram lidas.]` : "";
    return csv ? `## Planilha: ${name}\n${csv}${note}` : "";
  }).filter(Boolean);
  return parts.join("\n\n");
}
const OFFICE_MIME: Record<string, string> = { docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
/** Text of Word and PowerPoint (OOXML) files, the same parser as the knowledge base. */
export async function officeText(bytes: Buffer, ext: "docx" | "pptx") {
  if (!bytes.subarray(0, 4).equals(Buffer.from("504b0304", "hex"))) throw new FlowError(`O arquivo não é um ${ext.toUpperCase()} válido.`);
  try {
    const { OfficeParser } = await import("officeparser");
    return (await (await OfficeParser.parseOffice(bytes)).to("text")).value.trim();
  } catch { throw new FlowError(`Não foi possível ler o ${ext.toUpperCase()}. Envie um arquivo sem senha ou exporte como PDF.`); }
}
const TEXT_MIME: Record<string, string> = { txt: "text/plain", md: "text/plain", csv: "text/csv", json: "application/json", html: "text/html", htm: "text/html", css: "text/css", xml: "application/xml", yaml: "application/yaml", yml: "application/yaml", sql: "application/sql" };
/** Readable text of an HTML page: no scripts, styles or markup; blocks keep their line breaks. */
export function htmlText(html: string) {
  const $ = load(html);
  $("script, style, noscript, template, svg, iframe, object, head").remove();
  $("br").replaceWith("\n");
  $("p, div, section, article, li, tr, h1, h2, h3, h4, h5, h6, pre, blockquote, table, ul, ol").each((_, element) => { $(element).append("\n"); });
  $("td, th").each((_, element) => { $(element).append("\t"); });
  return $.root().text().replace(/[ \t\u00a0]+\n/g, "\n").replace(/[ \u00a0]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
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
  } else if (ext === "xls" || ext === "xlsx") {
    text = spreadsheetText(bytes, ext);
    if (!text) throw new FlowError("A planilha está vazia.");
    mime = SPREADSHEET_MIME[ext];
  } else if (ext === "docx" || ext === "pptx") {
    text = await officeText(bytes, ext);
    mime = OFFICE_MIME[ext];
  } else if (ext && Object.hasOwn(TEXT_MIME, ext)) {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new FlowError("Salve o documento como texto UTF-8 e envie novamente."); }
    if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new FlowError("O arquivo contém dados binários. Use um documento de texto.");
    if (ext === "html" || ext === "htm") text = htmlText(text);
    mime = TEXT_MIME[ext];
  } else throw new FlowError(ext === "doc" ? "O formato DOC antigo não é aceito. Salve como DOCX ou PDF e envie novamente." : "Formato não aceito. Use PNG, JPG, WebP, PDF, TXT, MD, CSV, JSON, XLS, XLSX, DOCX, PPTX, HTML, CSS, XML, YAML ou SQL.");
  if (kind === "document" && !text?.trim()) throw new FlowError("O documento está vazio.");
  if (text && text.length > 60000) throw new FlowError("O documento excede 60 mil caracteres. Divida-o em arquivos menores.");
  const attachment: Attachment = { id: randomUUID(), name, mime, size: file.size, kind, ...(text ? { textLength: text.length } : {}) };
  return { attachment, bytes, text };
}
