import nodeTest from "node:test";
import { createTenantTestContext } from "../scripts/tenant-test-context";
const tenant = await createTenantTestContext();
function test(name: string, action: () => void | Promise<void>) { nodeTest(name, () => tenant.asTenant(action)); }
nodeTest.after(tenant.close);
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Graph } from "./flow-types";
const dir = mkdtempSync(join(tmpdir(), "agentflows-attachments-"));
process.env.DATA_DIR = dir;
const { saveAttachment, resolveAttachments, attachmentContext, uploadForm, getAttachment } = await import("./attachment-service");
const { createTenantFlow: createFlow, saveTenantFlow: saveFlow, listTenantRuns: listRuns } = await import("./tenant-flows");
const { imageIssues } = await import("./model-capabilities");
const { block, template } = await import("./flow-types");
const { startRun } = await import("./flow-runtime");
const { chatGPT } = await import("./chatgpt");
const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: "#8075dd" } }).png().toBuffer();
const picture = () => new File([new Uint8Array(png)], "foto.png", { type: "image/png" });
nodeTest.after(() => rmSync(dir, { recursive: true, force: true }));
async function flow(graph: Graph = template()) { const f = await createFlow("Anexos"); return saveFlow(f.id, { name: f.name, description: "", graph }); }
function pdf(text: string) {
  const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let body = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  return body + `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("") + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
}
test("lê texto/PDF e valida a imagem real; histórico contém só metadados", async () => {
  const f = await flow();
  const doc = await saveAttachment(f.id, new File(["receita,total\nsetembro,42"], "dados.csv"));
  const image = await saveAttachment(f.id, picture());
  const document = await saveAttachment(f.id, new File([pdf("Relatorio com receita 42")], "relatorio.pdf"));
  const metadata = await resolveAttachments(f.id, [doc.id, image.id, document.id]);
  assert.equal(metadata.length, 3);
  assert.ok(metadata.every((a) => !("text" in a) && !("flowId" in a)));
  const context = await attachmentContext(f.id, metadata);
  assert.match(context.text, /setembro,42/);
  assert.match(context.text, /Relatorio com receita 42/);
  assert.deepEqual(context.images, [`data:image/png;base64,${png.toString("base64")}`]);
});
test("planilhas XLS/XLSX viram CSV por aba, HTML vira texto visível e JPEG é aceito", async () => {
  const XLSX = await import("xlsx");
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["mês", "receita"], ["setembro", 42], ["outubro", { f: "B2*2", v: 84 }]]), "Vendas");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["meta"], [100]]), "Metas");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), "Vazia");
  const f = await flow();
  const files = [
    new File([new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }))], "vendas.xlsx"),
    new File([new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "biff8" }))], "vendas.xls"),
    new File(["<html><head><title>t</title><style>p{}</style></head><body><h1>Relatório</h1><p>Receita <b>42</b></p><script>alert(1)</script><table><tr><td>a</td><td>b</td></tr></table></body></html>"], "pagina.html"),
    new File([new Uint8Array(await sharp(png).jpeg().toBuffer())], "foto.jpeg"),
  ];
  const saved = [];
  for (const file of files) saved.push(await saveAttachment(f.id, file));
  assert.deepEqual(saved.map((a) => [a.kind, a.mime]), [
    ["document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], ["document", "application/vnd.ms-excel"], ["document", "text/html"], ["image", "image/jpeg"],
  ]);
  const context = await attachmentContext(f.id, await resolveAttachments(f.id, saved.map((a) => a.id)));
  for (const kind of ["xlsx", "xls"]) assert.match(context.text, new RegExp(`vendas\\.${kind}[\\s\\S]*## Planilha: Vendas\\nmês,receita\\nsetembro,42\\noutubro,84\\n*## Planilha: Metas\\nmeta\\n100`));
  assert.doesNotMatch(context.text, /Planilha: Vazia|alert|p\{\}/);
  assert.match(context.text, /Relatório\n+Receita 42\n+a\tb/);
  assert.equal(context.images.length, 1);
  await assert.rejects(() => saveAttachment(f.id, new File(["mês,receita"], "falsa.xlsx")), /planilha XLSX válida/);
  await assert.rejects(() => saveAttachment(f.id, new File([new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }))], "trocada.xls")), /planilha XLS válida/);
  await assert.rejects(() => saveAttachment(f.id, new File(["<script>x</script>"], "vazia.html")), /vazio/);
});
test("DOCX, PPTX e formatos de texto (CSS, XML, YAML, SQL) são aceitos; DOC antigo tem orientação", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const types = (...parts: [string, string][]) => strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${parts.map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join("")}</Types>`);
  const rels = (main: string) => strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`);
  const docx = zipSync({
    "[Content_Types].xml": types(["word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"]), "_rels/.rels": rels("word/document.xml"),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Contrato com receita 42</w:t></w:r></w:p></w:body></w:document>`),
  });
  const pptx = zipSync({
    "[Content_Types].xml": types(["ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"], ["ppt/slides/slide1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"]), "_rels/.rels": rels("ppt/presentation.xml"),
    "ppt/presentation.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`),
    "ppt/slides/slide1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide de metas 2027</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
  });
  const f = await flow();
  const saved = [];
  for (const file of [new File([docx], "contrato.docx"), new File([pptx], "metas.pptx"), new File(["body { color: red; }"], "estilo.css"), new File(["<pedido><total>42</total></pedido>"], "pedido.xml"), new File(["meta: 100\n"], "config.yml"), new File(["SELECT total FROM vendas;"], "consulta.sql")])
    saved.push(await saveAttachment(f.id, file));
  assert.deepEqual(saved.map((a) => a.mime), ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "text/css", "application/xml", "application/yaml", "application/sql"]);
  const context = await attachmentContext(f.id, await resolveAttachments(f.id, saved.slice(0, 5).map((a) => a.id)));
  for (const text of ["Contrato com receita 42", "Slide de metas 2027", "color: red", "<total>42</total>", "meta: 100"]) assert.ok(context.text.includes(text), text);
  await assert.rejects(() => saveAttachment(f.id, new File(["texto"], "falso.docx")), /DOCX válido/);
  await assert.rejects(() => saveAttachment(f.id, new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])], "antigo.doc")), /DOC antigo.*DOCX ou PDF/);
});
test("recusa conteúdo disfarçado, arquivo inválido/vazio, texto binário e limites", async () => {
  const f = await flow();
  await assert.rejects(() => saveAttachment(f.id, new File(["texto"], "foto.png")), /Imagem inválida/);
  await assert.rejects(() => saveAttachment(f.id, new File(["texto"], "falso.pdf")), /PDF válido/);
  await assert.rejects(() => saveAttachment(f.id, new File([""], "vazio.txt")), /não vazio/);
  await assert.rejects(() => saveAttachment(f.id, new File(["\0dados"], "binario.txt")), /binários/);
  await assert.rejects(() => saveAttachment(f.id, new File(["x".repeat(60001)], "grande.txt")), /60 mil/);
  await assert.rejects(() => saveAttachment(f.id, new File([new Uint8Array(10 * 1024 * 1024 + 1)], "grande.png")), /10 MB/);
  await assert.rejects(() => saveAttachment(f.id, new File(["<svg/>"], "vetor.svg")), /Formato/);
  await assert.rejects(() => uploadForm(new Request("http://local", { method: "POST", body: new Uint8Array(11 * 1024 * 1024) })), /10 MB/);
});
test("anexos pertencem ao fluxo; IDs, duplicação, quantidade e texto total são validados", async () => {
  const f = await flow(), other = await flow();
  const a = await saveAttachment(f.id, new File(["a".repeat(60000)], "a.txt"));
  const b = await saveAttachment(f.id, new File(["b".repeat(50000)], "b.txt"));
  await assert.rejects(() => resolveAttachments(other.id, [a.id]), /outro fluxo/);
  await assert.rejects(() => resolveAttachments(f.id, ["../../app.sqlite"]), /não encontrado/);
  await assert.rejects(() => resolveAttachments(f.id, [a.id, a.id]), /diferentes/);
  await assert.rejects(() => resolveAttachments(f.id, Array.from({ length: 6 }, (_, i) => String(i))), /até 5/);
  await assert.rejects(() => resolveAttachments(f.id, [a.id, b.id]), /100 mil/);
});
test("uploads abandonados expiram sem remover arquivos usados pelo histórico", async () => {
  const f = await flow();
  const unused = await saveAttachment(f.id, picture()), used = await saveAttachment(f.id, picture());
  await tenant.db.query("UPDATE attachments SET created_at=now()-interval '2 days' WHERE user_id=$1", [tenant.owner]);
  await tenant.db.query("UPDATE attachments SET used=true WHERE user_id=$1 AND id=$2", [tenant.owner, used.id]);
  await saveAttachment(f.id, picture());
  await assert.rejects(() => getAttachment(unused.id), /expirado/);
  assert.equal((await getAttachment(used.id)).id, used.id);
});
test("modelos de todos os blocos alcançáveis são checados, sem trocar modelo automaticamente", () => {
  const g = template();
  const vision = { id: "vision", name: "Visão", inputModalities: ["text", "image"], isDefault: true };
  const text = { id: "text", name: "Texto", inputModalities: ["text"] };
  assert.deepEqual(imageIssues(g, [vision]), []);
  g.nodes[1].data.config.model = "text";
  assert.match(imageIssues(g, [vision, text])[0].reason, /não aceita/);
  g.nodes[1].data.config.model = "openrouter:openrouter/auto";
  assert.match(imageIssues(g, [vision])[0].reason, /específico/);
  g.nodes[1].data.config.model = "desconhecido";
  assert.match(imageIssues(g, [vision])[0].reason, /confirmar/);
  g.nodes[1].data.config.model = "vision";
  const orphan = block("llm", "orphan", 0, 0); orphan.data.config.model = "text";
  g.nodes.push(orphan);
  assert.deepEqual(imageIssues(g, [vision, text]), []);
});
test("imagens incompatíveis param antes de efeitos externos; documentos funcionam em modelo textual", async () => {
  const bridge = chatGPT();
  bridge.account = async () => ({ account: { type: "chatgpt", email: "fixture@example.com", planType: "plus" }, login: null, error: null });
  bridge.models = async () => [{ id: "text", name: "Texto", inputModalities: ["text"], isDefault: true }];
  const g = template();
  const http = block("http", "externo", 0, 0); http.data.config.url = "https://example.com";
  g.nodes.push(http); g.edges[0].target = http.id; g.edges.push({ id: "http-ai", source: http.id, target: g.nodes[1].id });
  const f = await flow(g), image = await saveAttachment(f.id, picture());
  const fetch0 = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("{}"); };
  try {
    await assert.rejects(() => startRun(f.id, "Leia", false, false, [image.id]), /não aceita imagens/);
    assert.equal(calls, 0); assert.equal((await listRuns(f.id)).length, 0);
  } finally { globalThis.fetch = fetch0; }
  const second = await flow(), doc = await saveAttachment(second.id, new File(["Receita: 42"], "dados.txt"));
  bridge.run = async (args) => { assert.match(args.prompt, /Receita: 42/); assert.deepEqual(args.images, []); return "42"; };
  const r = await startRun(second.id, "Leia", false, false, [doc.id]);
  assert.equal(r.status, "completed"); assert.equal(r.attachments?.[0].name, "dados.txt");
  assert.doesNotMatch(JSON.stringify(r), /data:image|Receita: 42/);
  await assert.rejects(() => startRun(second.id, "Leia", false, true, [doc.id]), /execução real/);
});
test("cada agente recebe os documentos e imagens originais após a saída anterior", async () => {
  const bridge = chatGPT();
  bridge.models = async () => [{ id: "vision", name: "Visão", inputModalities: ["text", "image"], isDefault: true }];
  const g = template(), second = block("llm", "segundo", 0, 0);
  g.nodes.push(second); g.edges[1].target = second.id; g.edges.push({ id: "segundo-fim", source: second.id, target: g.nodes[2].id });
  const f = await flow(g), img = await saveAttachment(f.id, picture()), doc = await saveAttachment(f.id, new File(["Receita: 42"], "dados.txt"));
  const prompts: string[] = [];
  bridge.run = async (args) => { assert.match(args.prompt, /Receita: 42/); assert.equal(args.images?.[0], `data:image/png;base64,${png.toString("base64")}`); assert.equal(args.imageDetail, "high", "em branco, imagens vão em alta qualidade"); prompts.push(args.prompt); return "Primeira análise"; };
  const r = await startRun(f.id, "Analise", false, false, [img.id, doc.id]);
  assert.equal(r.status, "completed"); assert.equal(prompts.length, 2); assert.match(prompts[1], /Primeira análise/);
});
