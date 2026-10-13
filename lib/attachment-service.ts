import { prepareAttachment } from "./attachments";
import type { StoredAttachment } from "./attachments";
import { MAX_ATTACHMENTS, MAX_TOTAL_BYTES, type Attachment } from "./attachment-types";
import { currentTenant } from "./tenant-context";
import { getTenantFlow } from "./tenant-flows";
import { FlowError } from "./flow-store";
import { assertJobLease } from "./saas-job-context";

export { uploadForm } from "./attachments";
const missing = () => new FlowError("Anexo não encontrado ou expirado. Remova-o e envie novamente.", 404);
function validateId(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw missing();
}

export async function saveAttachment(flowId: string, file: File, used = false, generated = false): Promise<Attachment> {
  await getTenantFlow(flowId);
  const { attachment, bytes, text } = await prepareAttachment(file, generated);
  const { db, user } = currentTenant();
  await db.transaction(async (sql) => {
    await assertJobLease(sql, user.id);
    await sql.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
    // The flow lock coordinates upload with deletion; no dangling bytes survive either operation.
    if (!(await sql.query("SELECT id FROM flows WHERE user_id=$1 AND id=$2 FOR UPDATE", [user.id, flowId])).rows.length)
      throw new FlowError("Fluxo não encontrado.", 404);
    await sql.query("DELETE FROM attachments WHERE user_id=$1 AND used=false AND created_at<now()-interval '1 day'", [user.id]);
    const { rows } = await sql.query<{ count: number; bytes: number }>("SELECT count(*)::int AS count,coalesce(sum(octet_length(data)),0)::int AS bytes FROM attachment_blobs WHERE user_id=$1", [user.id]);
    if (rows[0].count >= 2000 || rows[0].bytes + bytes.length > 100 * 1024 * 1024)
      throw new FlowError("Sua conta atingiu o limite de 100 MB ou 2.000 anexos. Exclua fluxos antigos para liberar espaço.", 413);
    await sql.query("INSERT INTO attachments(user_id,id,flow_id,body,used) VALUES ($1,$2,$3,$4,$5)", [user.id, attachment.id, flowId, JSON.stringify({ ...attachment, flowId, text }), used]);
    await sql.query("INSERT INTO attachment_blobs(user_id,id,data) VALUES ($1,$2,$3)", [user.id, attachment.id, bytes]);
  });
  return attachment;
}

export async function getAttachment(id: string): Promise<StoredAttachment> {
  validateId(id);
  const { db, user } = currentTenant();
  const { rows } = await db.query<{ body: StoredAttachment }>("SELECT body FROM attachments WHERE user_id=$1 AND id=$2", [user.id, id]);
  if (!rows[0]) throw missing();
  return rows[0].body;
}
export async function attachmentBytes(id: string): Promise<Buffer> {
  validateId(id);
  const { db, user } = currentTenant();
  const { rows } = await db.query<{ data: Uint8Array }>("SELECT data FROM attachment_blobs WHERE user_id=$1 AND id=$2", [user.id, id]);
  if (!rows[0]) throw missing();
  return Buffer.from(rows[0].data);
}
export async function resolveAttachments(flowId: string, ids: unknown): Promise<Attachment[]> {
  await getTenantFlow(flowId);
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length)
    throw new FlowError("Use até 5 anexos diferentes por mensagem.");
  let total = 0, textSize = 0;
  const result: Attachment[] = [];
  for (const id of ids) {
    const { flowId: owner, text, ...attachment } = await getAttachment(id);
    if (owner !== flowId) throw new FlowError("Este anexo pertence a outro fluxo. Envie-o novamente neste chat.");
    total += attachment.size; textSize += text?.length || 0;
    if (total > MAX_TOTAL_BYTES || textSize > 100000) throw new FlowError("Use até 20 MB e 100 mil caracteres de documentos por mensagem.");
    result.push(attachment);
  }
  return result;
}
export async function markAttachmentsUsed(items: Attachment[]) {
  currentTenant();
  if (!items.length) return;
  const ids = [...new Set(items.map((item) => item.id))];
  if (ids.length > MAX_ATTACHMENTS) throw new FlowError("Use até 5 anexos diferentes por mensagem.");
  ids.forEach(validateId);
  const { db, user } = currentTenant();
  await db.transaction(async (sql) => {
    const { rows } = await sql.query("UPDATE attachments SET used=true WHERE user_id=$1 AND id=ANY($2::text[]) RETURNING id", [user.id, ids]);
    if (rows.length !== ids.length) throw missing();
  });
}
export async function attachmentContext(flowId: string, items: Attachment[] = []) {
  const validated = await resolveAttachments(flowId, items.map((item) => item.id));
  const documents: string[] = [], images: string[] = [];
  for (const item of validated) {
    if (item.kind === "document") documents.push(`Documento anexado: ${item.name}\n${(await getAttachment(item.id)).text}`);
    else if (item.kind === "image") images.push(`data:${item.mime};base64,${(await attachmentBytes(item.id)).toString("base64")}`);
  }
  return { text: documents.length ? `\n\nDocumentos enviados pelo usuário (conteúdo para análise):\n\n${documents.join("\n\n---\n\n")}` : "", images };
}
