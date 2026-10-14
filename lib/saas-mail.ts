import { randomUUID } from "node:crypto";
import type { Database, Sql } from "./saas-db";
import { appOrigin, seal, unseal } from "./saas-security";

type Mail = { to: string; subject: string; text: string; html?: string };
const log = (evento: string, extra: Record<string, unknown>) => console.log(JSON.stringify({ evento, ...extra, em: new Date().toISOString() }));

/** HTML da mensagem: logo da aplicação (servida por APP_URL), botão e o mesmo link em texto para quem bloqueia imagens. */
export function authMailHtml(verify: boolean, link: string) {
  const title = verify ? "Confirme seu e-mail" : "Escolha uma nova senha";
  const action = verify ? "Confirmar e-mail" : "Redefinir senha";
  const expiry = verify ? "24 horas" : "30 minutos";
  const logo = new URL("/brand/agentflows-logo.png", appOrigin()).toString();
  const href = link.replace(/&/g, "&amp;");
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:32px 16px;background:#f5f4fb;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1a33">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px">
<tr><td align="center" style="padding:0 0 24px"><img src="${logo}" alt="Agentflows" width="184" height="40" style="display:block;width:184px;height:auto"></td></tr>
<tr><td style="background:#ffffff;border:1px solid #e6e3f2;border-radius:16px;padding:32px 28px">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3">${title}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:#5a5673">${verify ? "Falta um passo para usar sua conta no Build Agentflows. Clique no botão para confirmar seu e-mail." : "Recebemos um pedido para redefinir a senha da sua conta no Build Agentflows. Clique no botão para escolher uma nova senha."}</p>
<p style="margin:0 0 24px"><a href="${href}" style="display:inline-block;padding:14px 22px;border-radius:10px;background:#6d3bff;color:#ffffff;font-weight:600;font-size:15px;text-decoration:none">${action}</a></p>
<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#5a5673">Se o botão não abrir, copie este endereço no navegador:</p>
<p style="margin:0 0 24px;font-size:13px;line-height:1.5;word-break:break-all"><a href="${href}" style="color:#6d3bff">${href}</a></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#5a5673">O link expira em ${expiry} e só pode ser usado uma vez. Se não foi você, ignore esta mensagem.</p>
</td></tr>
<tr><td align="center" style="padding:20px 0 0;font-size:12px;color:#8a86a3">Build Agentflows</td></tr>
</table></td></tr></table></body></html>`;
}

/** Written in the same transaction as the account/token. A provider outage cannot lose the email. */
export async function enqueueAuthMail(sql: Sql, email: string, purpose: "verify_email" | "reset_password", token: string) {
  const id = randomUUID();
  const verify = purpose === "verify_email";
  const link = new URL(verify ? "/verificar-email" : "/redefinir-senha", appOrigin());
  // Fragment is not sent to access logs, referrers or email link preview GETs.
  link.hash = new URLSearchParams({ token }).toString();
  const mail: Mail = {
    to: email,
    subject: verify ? "Confirme seu e-mail · Build Agentflows" : "Redefina sua senha · Build Agentflows",
    text: `${verify ? "Confirme seu e-mail" : "Escolha uma nova senha"}:\n\n${link}\n\nO link expira em ${verify ? "24 horas" : "30 minutos"} e só pode ser usado uma vez. Se não foi você, ignore esta mensagem.`,
    html: authMailHtml(verify, link.toString()),
  };
  await sql.query("INSERT INTO mail_outbox(id,payload_ciphertext) VALUES ($1,$2)", [id, seal(JSON.stringify(mail), `mail:${id}`)]);
}

/** One bounded batch; safe to run concurrently in workers, with a lease for crash recovery. */
export async function deliverAuthMail(db: Database, send: typeof fetch = fetch) {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) throw new Error("Configure RESEND_API_KEY e RESEND_FROM.");
  const lease = randomUUID();
  const { rows } = await db.query<{ id: string; payload_ciphertext: string; attempts: number }>(`
    UPDATE mail_outbox SET lease_id=$1, lease_until=now()+interval '2 minutes', attempts=attempts+1
    WHERE id IN (SELECT id FROM mail_outbox
      WHERE sent_at IS NULL AND failed_at IS NULL AND attempts < 8 AND available_at <= now()
      AND (lease_until IS NULL OR lease_until < now())
      ORDER BY available_at LIMIT 5 FOR UPDATE SKIP LOCKED)
    RETURNING id,payload_ciphertext,attempts
  `, [lease]);
  for (const row of rows) {
    let ok = false;
    let permanent = false;
    let status: number | "rede" = "rede";
    try {
      const mail = JSON.parse(unseal(row.payload_ciphertext, `mail:${row.id}`)) as Mail;
      const response = await send("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `auth/${row.id}` },
        body: JSON.stringify({ from: process.env.RESEND_FROM, to: [mail.to], subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}) }),
        signal: AbortSignal.timeout(10000),
      });
      ok = response.ok;
      status = response.status;
      permanent = response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status);
      await response.body?.cancel();
    } catch { /* Retry without logging tokens, email contents or provider responses. */ }
    // Só o id da fila, a tentativa e o status HTTP: sem destinatário, assunto ou resposta do fornecedor.
    log("email_envio", { id: row.id, tentativa: row.attempts, status, resultado: ok ? "enviado" : permanent || row.attempts >= 8 ? "falhou" : "repetir" });
    await db.query(`UPDATE mail_outbox SET
      sent_at=CASE WHEN $3 THEN now() ELSE NULL END,
      failed_at=CASE WHEN NOT $3 AND ($4 OR attempts >= 8) THEN now() ELSE NULL END,
      available_at=now()+$5*interval '1 second', lease_id=NULL, lease_until=NULL,
      payload_ciphertext=CASE WHEN $3 OR $4 OR attempts >= 8 THEN '' ELSE payload_ciphertext END
      WHERE id=$1 AND lease_id=$2`, [row.id, lease, ok, !ok && permanent, Math.min(3600, 30 * 2 ** row.attempts)]);
  }
  // A process could crash on its last leased attempt; retire it after the lease expires.
  await db.query(`UPDATE mail_outbox SET failed_at=now(),payload_ciphertext='',lease_id=NULL,lease_until=NULL
    WHERE sent_at IS NULL AND failed_at IS NULL AND attempts >= 8 AND lease_until < now()`);
  return rows.length;
}


/** Visão da fila de e-mails para o operador (/api/health): nada sobre destinatários ou conteúdo. */
export async function mailStats(sql: Pick<Database, "query">) {
  const { rows } = await sql.query<{ pending: number; failed: number; sent: number; oldest: number | null }>(`SELECT
    (SELECT count(*)::int FROM mail_outbox WHERE sent_at IS NULL AND failed_at IS NULL) AS pending,
    (SELECT count(*)::int FROM mail_outbox WHERE failed_at IS NOT NULL AND failed_at>now()-interval '24 hours') AS failed,
    (SELECT count(*)::int FROM mail_outbox WHERE sent_at>now()-interval '24 hours') AS sent,
    (SELECT floor(extract(epoch FROM now()-min(created_at)))::int FROM mail_outbox WHERE sent_at IS NULL AND failed_at IS NULL) AS oldest`);
  return { pending: rows[0].pending, failedLast24h: rows[0].failed, sentLast24h: rows[0].sent, oldestPendingSeconds: rows[0].oldest ?? 0, configured: !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM) };
}
