import { getConfig } from "./store";
import type { PosLigacao } from "./elevenlabs";
import { enviarMensagem, type Recebida } from "./whatsapp";
import { whatsappConfigurado, provedorWhatsApp } from "./conexoes";
import { buildRun } from "./flow-runtime";
import { currentTenant } from "./tenant-context";
import { capacity, insertJob, queueLock, type Job } from "./saas-jobs";
import { consumeMonthlyRun } from "./saas-plan";
import { persistTenantRun } from "./tenant-flows";
import { notifyJob } from "./saas-queue";
import { hashToken, seal, unseal, AuthError } from "./saas-security";
import { FlowError } from "./flow-store";
import { loadConfigState } from "./tenant-config-state";
import { consumeRateLimit } from "./saas-rate-limit";
import { sessionHistoryIds } from "./integration-session";
import { assertJobLease, currentJobLease } from "./saas-job-context";
import type { Channel } from "./channel-auth";
import type { Sql } from "./saas-db";
import type { Run } from "./flow-types";

const keys = (channel: Channel) => channel === "whatsapp"
  ? ["WHATSAPP_PROVEDOR", "WHATSAPP_FLOW_ID", "WHATSAPP_WEBHOOK_CHAVE", "WHATSAPP_ACEITE", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "ZAPI_INSTANCE_ID", "ZAPI_TOKEN", "ZAPI_CLIENT_TOKEN", "ZAPPERHUB_URL", "ZAPPERHUB_KEY"]
  : ["ELEVENLABS_FLOW_ID", "ELEVENLABS_WEBHOOK_CHAVE", "ELEVENLABS_WEBHOOK_SECRET", "ELEVENLABS_AGENT_ID"];
const fingerprint = (channel: Channel, read: (key: string) => string | undefined = getConfig) => hashToken(JSON.stringify(keys(channel).map(key => [key, read(key) || ""])));
export function textoDaLigacao(l: PosLigacao) {
  return [l.telefone ? `Telefone: ${l.telefone}` : "", l.resumo ? `Resumo: ${l.resumo}` : "",
    l.variaveis.contexto ? `Contexto da ligação: ${l.variaveis.contexto}` : "", "", "Transcrição:", l.transcricao || "(sem falas registradas)"]
    .filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== "")).join("\n").trim();
}
type Conversa = { session: string; remetente: NonNullable<Run["remetente"]> };
const VARIAVEIS_DO_REMETENTE = ["whatsapp_telefone", "whatsapp_nome"];
function pedeRemetente(run: Run) {
  const start = run.graph.nodes.find(n => n.data.kind === "start");
  try {
    const state = JSON.parse(start?.data.config.state || "{}") as Record<string, unknown>;
    return VARIAVEIS_DO_REMETENTE.some(key => Object.hasOwn(state, key));
  } catch {
    return false;
  }
}
async function enqueueEvent(channel: Channel, identity: string[], input: string, recipient?: string, conversa?: Conversa) {
  const { db, user } = currentTenant();
  const flowId = getConfig(`${channel.toUpperCase()}_FLOW_ID`);
  if (!flowId) return null;
  const key = hashToken(JSON.stringify([channel, ...identity]));
  const binding = fingerprint(channel);
  const previous = (await db.query<{ run_id: string }>("SELECT run_id FROM channel_events WHERE user_id=$1 AND event_key=$2", [user.id, key])).rows[0];
  if (previous) return { runId: previous.run_id, duplicate: true };
  // Build before opening the transaction: graph and credential reads use the request's connection.
  // As execuções concluídas do mesmo remetente viram o histórico, como na sessão da integração HTTP.
  const history = conversa ? await sessionHistoryIds(flowId, conversa.session) : undefined;
  const run = await buildRun(flowId, input, true, undefined, undefined, history, undefined, undefined, conversa?.session);
  if (conversa && pedeRemetente(run)) run.remetente = conversa.remetente;
  run.queued = true;
  const result = await db.transaction(async sql => {
    await queueLock(sql);
    const duplicate = (await sql.query<{ run_id: string }>("SELECT run_id FROM channel_events WHERE user_id=$1 AND event_key=$2", [user.id, key])).rows[0];
    if (duplicate) return { runId: duplicate.run_id, duplicate: true };
    await capacity(sql, user.id);
    await consumeMonthlyRun(sql, user.id);
    const fresh = await loadConfigState(sql, user.id);
    if (fingerprint(channel, k => fresh.values.get(k)) !== binding) throw new AuthError("A conexão mudou. Reenvie o aviso.", 409);
    await consumeRateLimit(sql, `channel-execute:user:${user.id}`, 20, 60);
    await persistTenantRun(sql, user.id, run);
    const reply = recipient ? seal(JSON.stringify({ recipient, binding }), `channel-reply:${user.id}:${run.id}`) : null;
    await sql.query("INSERT INTO channel_events(user_id,event_key,run_id,channel,reply_ciphertext) VALUES($1,$2,$3,$4,$5)", [user.id, key, run.id, channel, reply]);
    const job = await insertJob(sql, { user_id: user.id, kind: "run", resource_id: run.id, run_id: run.id, base_id: null, source_id: null });
    return { runId: run.id, duplicate: false, jobId: job.id };
  });
  if ("jobId" in result && result.jobId) await notifyJob(result.jobId);
  return result;
}
export async function processarLigacao(l: PosLigacao) {
  if (!l.conversationId || l.conversationId.length > 256) throw new FlowError("Ligação sem identificador válido.");
  if (!l.agentId || l.agentId !== getConfig("ELEVENLABS_AGENT_ID")) throw new AuthError("Agente de ligação não autorizado.", 403);
  return enqueueEvent("elevenlabs", [l.agentId, l.conversationId], textoDaLigacao(l));
}
export async function processarWhatsApp(m: Recebida) {
  if (!whatsappConfigurado() || m.provedor !== provedorWhatsApp()) throw new AuthError("Provedor de WhatsApp não autorizado.", 403);
  const account = m.provedor === "zapi" ? getConfig("ZAPI_INSTANCE_ID") : m.provedor === "meta" ? getConfig("WHATSAPP_PHONE_NUMBER_ID") : getConfig("ZAPPERHUB_URL") || "https://api.zapperapi.com";
  if ((m.provedor === "meta" || m.provedor === "zapi") && (!m.conta || m.conta !== account)) throw new AuthError("Número de WhatsApp não autorizado.", 403);
  if (!m.id || m.id.length > 256 || !/^\d{10,15}$/.test(m.de)) throw new FlowError("Mensagem sem identificador ou remetente válido.");
  // A sessão é o hash da conta e do número: liga a conversa sem gravar o telefone em claro.
  const session = `whatsapp:${hashToken(JSON.stringify([m.provedor, account || "", m.de]))}`;
  return enqueueEvent("whatsapp", [m.provedor, account || "", m.de, m.id], m.texto, m.de, { session, remetente: { telefone: m.de, nome: m.nome || "" } });
}

/** Persist a visible receipt in the same transaction as the delivery state. */
async function deliveryTrace(sql: Sql, owner: string, runId: string, jobId: string, status: "running" | "completed" | "failed", output: string) {
  const row = (await sql.query<{ body: Run }>("SELECT body FROM runs WHERE user_id=$1 AND id=$2 FOR UPDATE", [owner, runId])).rows[0];
  if (!row) return;
  const run = row.body, nodeId = `channel:${jobId}`, previous = run.trace.find(t => t.nodeId === nodeId);
  const at = previous?.at || new Date().toISOString();
  const trace = { type: "tool" as const, nodeId, label: "Resposta pelo WhatsApp", status, output, at, ms: Date.now() - Date.parse(at) };
  if (previous) Object.assign(previous, trace); else run.trace.push(trace);
  run.updatedAt = new Date().toISOString();
  await sql.query("UPDATE runs SET body=$3 WHERE user_id=$1 AND id=$2", [owner, runId, JSON.stringify(run)]);
}
/** Called with the job lock held, including crash/cancellation recovery. Never replays a POST. */
export async function settleChannelDelivery(sql: Sql, job: Pick<Job, "id" | "user_id" | "run_id">) {
  const rows = (await sql.query<{ status: string }>("SELECT status FROM channel_deliveries WHERE user_id=$1 AND job_id=$2 AND status IN ('pending','sending') FOR UPDATE", [job.user_id, job.id])).rows;
  if (!rows.length) return;
  const uncertain = rows[0].status === "sending";
  await sql.query("UPDATE channel_deliveries SET status=$3,updated_at=now() WHERE user_id=$1 AND job_id=$2", [job.user_id, job.id, uncertain ? "uncertain" : "cancelled"]);
  await deliveryTrace(sql, job.user_id, job.run_id!, job.id, "failed", uncertain ? "Envio sem confirmação. Confira no provedor antes de reenviar." : "Resposta não enviada: a tarefa foi interrompida ou cancelada.");
}
export async function deliverChannelReply(run: Run) {
  const { db, user } = currentTenant(), lease = currentJobLease();
  if (!lease || lease.owner !== user.id) throw new AuthError("Resposta exige um worker autorizado.", 403);
  const message = run.status === "completed" ? run.output : run.status === "waiting" ? "Recebi sua mensagem. Ela está em análise e voltamos em breve." : run.status === "failed" ? "Não consegui concluir agora. Tente novamente em instantes." : "";
  const reply = await db.transaction(async sql => {
    await assertJobLease(sql, user.id);
    const row = (await sql.query<{ reply_ciphertext: string }>(`SELECT e.reply_ciphertext FROM channel_deliveries d JOIN channel_events e ON e.user_id=d.user_id AND e.run_id=d.run_id
      WHERE d.user_id=$1 AND d.job_id=$2 AND d.run_id=$3 AND d.status='pending' FOR UPDATE OF d`, [user.id, lease.id, run.id])).rows[0];
    if (!row) return;
    await sql.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
    const saved = JSON.parse(unseal(row.reply_ciphertext, `channel-reply:${user.id}:${run.id}`)) as { recipient: string; binding: string };
    const fresh = await loadConfigState(sql, user.id);
    if (!message.trim() || saved.binding !== fingerprint("whatsapp", key => fresh.values.get(key)) || saved.binding !== fingerprint("whatsapp")) {
      await sql.query("UPDATE channel_deliveries SET status='cancelled',updated_at=now() WHERE user_id=$1 AND job_id=$2", [user.id, lease.id]);
      await deliveryTrace(sql, user.id, run.id, lease.id, "failed", "Resposta não enviada: a conexão mudou ou o fluxo terminou sem texto.");
      return;
    }
    lease.signal?.throwIfAborted();
    await sql.query("UPDATE channel_deliveries SET status='sending',updated_at=now() WHERE user_id=$1 AND job_id=$2", [user.id, lease.id]);
    await deliveryTrace(sql, user.id, run.id, lease.id, "running", "Enviando a resposta ao provedor.");
    return saved;
  });
  if (!reply) return;
  // A send occupies the original user's job slot until fetch settles.
  let sent = false;
  try {
    lease.signal?.throwIfAborted();
    await assertJobLease(db, user.id);
    await enviarMensagem(reply.recipient, message);
    sent = true;
  } finally {
    await db.transaction(async sql => {
      await assertJobLease(sql, user.id);
      await sql.query("UPDATE channel_deliveries SET status=$3,updated_at=now() WHERE user_id=$1 AND job_id=$2 AND status='sending'", [user.id, lease.id, sent ? "sent" : "uncertain"]);
      await deliveryTrace(sql, user.id, run.id, lease.id, sent ? "completed" : "failed", sent ? "Resposta aceita pelo provedor." : "Envio sem confirmação. Confira no provedor antes de reenviar.");
    });
  }
}
