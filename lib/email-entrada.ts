// E-mail como entrada de fluxo: o worker lê a caixa por IMAP (senha de app) a cada minuto e cada
// mensagem nova vira uma execução do fluxo vinculado, pelo mesmo trilho dos canais (channel_events).
// Só leitura: a caixa é aberta em modo somente leitura, nada é marcado como lido, movido ou apagado.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ImapFlow, type MessageStructureObject } from "imapflow";
import type { Database } from "./saas-db";
import { getConfig } from "./store";
import { withTenantJob } from "./tenant-context";
import { FlowError } from "./flow-store";
import { AuthError, hashToken } from "./saas-security";
import { privateKnowledgeAddress } from "./knowledge-http";
import { stripHtml } from "./tools";
import { EMAIL_CAMPOS, emailConfigurado } from "./conexoes";

/** Chaves que, se mudarem, invalidam a leitura em curso: outra caixa recomeça do zero. */
export const EMAIL_CHAVES = ["EMAIL_FLOW_ID", ...EMAIL_CAMPOS.map((c) => c.chave)];

/** Intervalo entre leituras da mesma caixa. */
export const INTERVALO_MS = 60_000;
/** Mensagens por leitura: o restante fica para a próxima, sem pular nenhuma. */
export const POR_LEITURA = 10;
const LIMITE_ENTRADA = 20_000;
const LIMITE_TEXTO_BYTES = 512 * 1024;

export type Remetente = { endereco: string; nome: string };
/** Mensagem como o adaptador IMAP a entrega: envelope, cabeçalhos de resposta automática e o texto já decodificado. */
export type MensagemImap = {
  uid: number;
  messageId: string;
  de: Remetente;
  assunto: string;
  data?: string;
  respostaAutomatica: boolean;
  texto: string;
  anexos: string[];
};
/** O que o fluxo recebe de um e-mail. */
export type EmailRecebido = { id: string; de: Remetente; assunto: string; data?: string; texto: string };

/** Caixa aberta: lista os UIDs a partir de um ponto e baixa uma mensagem por vez. */
export type CaixaImap = {
  abrir(): Promise<{ uidValidity: string; uidNext: number }>;
  listar(desde: number): Promise<number[]>;
  ler(uid: number): Promise<MensagemImap | null>;
  fechar(): Promise<void>;
};

/** Estado da leitura, guardado em email_inboxes.body. */
export type EstadoCaixa = {
  impressao?: string;
  uidValidity?: string;
  ultimoUid?: number;
  lidaEm?: string;
  recebidas?: number;
  ignoradas?: number;
  ultimaIgnorada?: string;
  erro?: string;
};

/** Impressão da caixa configurada: trocar servidor, conta, senha, pasta ou fluxo recomeça a leitura de agora. */
export function impressaoDaCaixa(read: (key: string) => string | undefined = getConfig) {
  return hashToken(JSON.stringify(EMAIL_CHAVES.map((key) => [key, read(key) || ""])));
}

export function textoDoEmail(m: EmailRecebido) {
  const de = m.de.nome ? `${m.de.nome} <${m.de.endereco}>` : m.de.endereco;
  return [`De: ${de}`, `Assunto: ${m.assunto || "(sem assunto)"}`, ...(m.data ? [`Data: ${m.data}`] : []), "", m.texto.trim() || "(sem texto)"].join("\n");
}

/** Por que a mensagem não vira execução, ou null quando deve virar. */
export function motivoParaIgnorar(m: MensagemImap, conta: string): string | null {
  if (!m.de.endereco) return "sem remetente";
  // A própria conta escrevendo (inclusive um fluxo que responde por e-mail) entraria em laço.
  if (m.de.endereco.toLowerCase() === conta.toLowerCase()) return "enviado pela própria conta";
  if (m.respostaAutomatica) return "resposta automática (ausência, férias)";
  return null;
}

export function paraEmail(m: MensagemImap, uidValidity: string): EmailRecebido {
  const anexos = m.anexos.length ? `\n\nAnexos (não lidos pelo fluxo): ${m.anexos.join(", ")}` : "";
  return {
    id: m.messageId || `uid:${uidValidity}:${m.uid}`,
    de: m.de, assunto: m.assunto, data: m.data,
    texto: m.texto.trim() + anexos,
  };
}

/**
 * Uma leitura da caixa. Na primeira vez (ou quando a caixa, a pasta ou o fluxo mudam) só marca o ponto de
 * partida: o histórico não dispara o fluxo. Depois entrega, em ordem, cada mensagem posterior ao cursor.
 * O cursor só avança sobre mensagem entregue ou ignorada por regra; uma falha ao entregar (fila cheia,
 * cota do mês, fluxo removido) para a leitura e a mesma mensagem é tentada na próxima.
 */
export async function lerCaixa(caixa: CaixaImap, estado: EstadoCaixa, impressao: string, conta: string,
  entregar: (email: EmailRecebido) => Promise<{ duplicate?: boolean } | null | void>, agora = new Date()): Promise<EstadoCaixa> {
  const lidaEm = agora.toISOString();
  const aberta = await caixa.abrir();
  try {
    if (estado.impressao !== impressao || estado.uidValidity !== aberta.uidValidity || typeof estado.ultimoUid !== "number")
      return { impressao, uidValidity: aberta.uidValidity, ultimoUid: Math.max(0, aberta.uidNext - 1), lidaEm, recebidas: 0, ignoradas: 0 };
    const novo: EstadoCaixa = { ...estado, lidaEm, erro: undefined };
    const uids = (await caixa.listar(estado.ultimoUid + 1)).filter((uid) => uid > estado.ultimoUid!).sort((a, b) => a - b).slice(0, POR_LEITURA);
    for (const uid of uids) {
      const mensagem = await caixa.ler(uid);
      const motivo = !mensagem ? "não encontrada" : motivoParaIgnorar(mensagem, conta);
      const email = mensagem && !motivo ? paraEmail(mensagem, aberta.uidValidity) : null;
      const texto = email ? textoDoEmail(email) : "";
      let ignorar = motivo || (texto.length > LIMITE_ENTRADA ? "texto acima de 20 mil caracteres" : null);
      if (!ignorar) {
        try {
          // O mesmo Message-ID em outro UID (cópia, mesma mensagem em dois destinatários) não executa de novo.
          if ((await entregar(email!))?.duplicate) ignorar = "já recebido";
        } catch (error) {
          novo.erro = error instanceof FlowError || error instanceof AuthError ? error.message : "Não foi possível iniciar a execução deste e-mail.";
          break;
        }
      }
      if (ignorar) {
        novo.ignoradas = (novo.ignoradas || 0) + 1;
        novo.ultimaIgnorada = `${mensagem?.assunto || `mensagem ${uid}`}: ${ignorar}`;
      } else novo.recebidas = (novo.recebidas || 0) + 1;
      novo.ultimoUid = uid;
    }
    return novo;
  } finally {
    await caixa.fechar().catch(() => undefined);
  }
}

// --- Adaptador IMAP ----------------------------------------------------------------------------------

type ConfigImap = { host: string; porta: number; usuario: string; senha: string; pasta: string };
function configImap(read: (key: string) => string | undefined = getConfig): ConfigImap {
  const host = (read("EMAIL_IMAP_HOST") || "").trim().toLowerCase(), usuario = (read("EMAIL_IMAP_USUARIO") || "").trim(), senha = read("EMAIL_IMAP_SENHA") || "";
  const porta = Number(read("EMAIL_IMAP_PORTA") || 993);
  if (!host || !usuario || !senha) throw new FlowError("Preencha servidor, e-mail e senha de app.");
  if (!/^[a-z0-9.-]+$/.test(host) || isIP(host)) throw new FlowError("Informe o nome do servidor IMAP, como imap.gmail.com.");
  if (porta !== 993 && porta !== 143) throw new FlowError("Use a porta 993 (padrão) ou 143.");
  return { host, porta, usuario, senha: senha.replace(/\s+/g, ""), pasta: (read("EMAIL_IMAP_PASTA") || "").trim() || "INBOX" };
}

/** Resolve uma vez e conecta no endereço conferido: o servidor IMAP vem da pessoa e não pode alcançar a rede interna. */
async function enderecoPublico(host: string) {
  const enderecos = await lookup(host, { all: true }).catch(() => []);
  if (!enderecos.length) throw new FlowError("Servidor IMAP não encontrado. Confira o nome.");
  if (enderecos.some(({ address }) => privateKnowledgeAddress(address))) throw new FlowError("O servidor IMAP precisa ser um endereço público da internet.");
  return enderecos[0].address;
}

type Partes = { plano?: MessageStructureObject; html?: MessageStructureObject; anexos: string[] };
function partesDeTexto(no: MessageStructureObject | undefined, partes: Partes = { anexos: [] }) {
  if (!no) return partes;
  if (no.childNodes?.length) {
    for (const filho of no.childNodes) partesDeTexto(filho, partes);
    return partes;
  }
  const nome = no.dispositionParameters?.filename || no.parameters?.name;
  if (no.disposition === "attachment" || (nome && !no.type.startsWith("text/"))) {
    partes.anexos.push(nome || no.type);
    return partes;
  }
  // Mensagem de uma parte só não tem identificador na estrutura; no IMAP o corpo dela é a parte "1".
  const parte = { ...no, part: no.part || "1" };
  if (no.type === "text/plain" && !partes.plano) partes.plano = parte;
  else if (no.type === "text/html" && !partes.html) partes.html = parte;
  return partes;
}

function quotedPrintable(bruto: Buffer) {
  const texto = bruto.toString("latin1").replace(/=\r?\n/g, ""), bytes: number[] = [];
  for (let i = 0; i < texto.length; i++) {
    const hex = texto[i] === "=" ? texto.slice(i + 1, i + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; }
    else bytes.push(texto.charCodeAt(i));
  }
  return Buffer.from(bytes);
}
/**
 * Decodifica pela estrutura da mensagem (codificação e charset de cada parte). Não usa o download do
 * imapflow, que decide pelo cabeçalho MIME da parte pedido ao servidor, e há servidores que devolvem o
 * cabeçalho da parte pai em partes aninhadas: o texto chegava ao fluxo em quoted-printable cru.
 */
function decodificar(bruto: Buffer, no: MessageStructureObject, jaDecodificado: boolean) {
  const codificacao = (no.encoding || "").toLowerCase();
  const bytes = jaDecodificado ? bruto
    : codificacao === "base64" ? Buffer.from(bruto.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64")
      : codificacao === "quoted-printable" ? quotedPrintable(bruto) : bruto;
  try {
    return new TextDecoder(no.parameters?.charset || "utf-8").decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

async function lerParte(cliente: ImapFlow, uid: number, no: MessageStructureObject) {
  const chave = no.part!;
  const m = await cliente.fetchOne(String(uid), { uid: true, bodyParts: [{ key: chave, maxLength: LIMITE_TEXTO_BYTES }] }, { uid: true });
  const bruto = m ? m.bodyParts?.get(chave) : undefined;
  return bruto ? decodificar(bruto, no, !!m && !!m.binaryParts?.has(chave)) : "";
}

const AUTOMATICA = /^auto-submitted:\s*auto-replied|^x-autoreply:|^x-autorespond:|^precedence:\s*auto_reply/im;

export async function abrirCaixaImap(read: (key: string) => string | undefined = getConfig, signal?: AbortSignal): Promise<CaixaImap> {
  const config = configImap(read);
  const endereco = await enderecoPublico(config.host);
  const cliente = new ImapFlow({
    host: endereco, servername: config.host, port: config.porta, secure: config.porta === 993, doSTARTTLS: config.porta === 143 ? true : undefined,
    auth: { user: config.usuario, pass: config.senha }, logger: false, disableAutoIdle: true,
    connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 60_000,
  });
  // Erros de socket depois da conexão chegam por evento; sem ouvinte derrubariam o worker.
  cliente.on("error", () => undefined);
  signal?.addEventListener("abort", () => cliente.close(), { once: true });
  try {
    await cliente.connect();
  } catch (error) {
    cliente.close();
    throw falhaImap(error);
  }
  let trava: { release(): void } | undefined;
  return {
    async abrir() {
      try {
        trava = await cliente.getMailboxLock(config.pasta, { readOnly: true });
      } catch {
        throw new FlowError(`A pasta “${config.pasta}” não existe nesta caixa.`);
      }
      const caixa = cliente.mailbox;
      if (!caixa) throw new FlowError("Não foi possível abrir a caixa de entrada.");
      return { uidValidity: String(caixa.uidValidity), uidNext: Number(caixa.uidNext) };
    },
    async listar(desde) {
      const uids = await cliente.search({ uid: `${desde}:*` }, { uid: true });
      return uids || [];
    },
    async ler(uid) {
      const m = await cliente.fetchOne(String(uid), { uid: true, envelope: true, bodyStructure: true, headers: ["auto-submitted", "x-autoreply", "x-autorespond", "precedence"] }, { uid: true });
      if (!m) return null;
      const partes = partesDeTexto(m.bodyStructure);
      const plano = partes.plano ? await lerParte(cliente, uid, partes.plano) : "";
      const texto = plano.trim() ? plano : partes.html ? stripHtml(await lerParte(cliente, uid, partes.html)) : "";
      const de = m.envelope?.from?.[0];
      return {
        uid, messageId: (m.envelope?.messageId || "").slice(0, 300),
        de: { endereco: (de?.address || "").trim(), nome: (de?.name || "").trim() },
        assunto: (m.envelope?.subject || "").trim(), data: m.envelope?.date ? new Date(m.envelope.date).toISOString() : undefined,
        respostaAutomatica: AUTOMATICA.test(m.headers?.toString("utf8") || ""),
        texto, anexos: partes.anexos,
      };
    },
    async fechar() {
      trava?.release();
      await cliente.logout().catch(() => cliente.close());
    },
  };
}

function falhaImap(error: unknown) {
  if (error instanceof FlowError) return error;
  if (error instanceof AuthError) return new FlowError(error.message);
  const e = error as { authenticationFailed?: boolean; code?: string; responseText?: string };
  if (e?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(e?.responseText || ""))
    return new FlowError("O servidor recusou o e-mail ou a senha de app. Confira se é uma senha de app e se o IMAP está ativado na conta.");
  if (e?.code === "ETIMEDOUT" || e?.code === "CONNECT_TIMEOUT" || e?.code === "GREETING_TIMEOUT") return new FlowError("O servidor IMAP não respondeu a tempo. Confira o nome e a porta.");
  if (e?.code === "ECONNREFUSED") return new FlowError("O servidor IMAP recusou a conexão nessa porta.");
  if (/certificate|self.signed|altnames/i.test(String((error as Error)?.message))) return new FlowError("O certificado do servidor IMAP não confere com o nome informado.");
  return new FlowError("Não foi possível conectar ao servidor IMAP agora.");
}

/** Botão "Testar conexão": entra na caixa e conta as mensagens da pasta, sem ler nenhuma. */
export async function testarEmail(): Promise<{ ok: boolean; mensagem: string }> {
  if (!emailConfigurado()) return { ok: false, mensagem: "Preencha servidor, e-mail e senha de app." };
  try {
    const caixa = await abrirCaixaImap(getConfig, AbortSignal.timeout(45_000));
    try {
      await caixa.abrir();
    } finally {
      await caixa.fechar();
    }
    return { ok: true, mensagem: `Conectado a ${getConfig("EMAIL_IMAP_USUARIO")}. Novos e-mails da pasta ${getConfig("EMAIL_IMAP_PASTA") || "INBOX"} disparam o fluxo vinculado.` };
  } catch (error) {
    return { ok: false, mensagem: falhaImap(error).message };
  }
}

// --- Worker ------------------------------------------------------------------------------------------

type Linha = { user_id: string; body: EstadoCaixa };

/** Inclui (ou adianta) a caixa da conta na fila de leitura; chamado ao salvar a configuração do e-mail. */
export async function agendarLeitura(sql: Pick<Database, "query">, owner: string) {
  await sql.query("INSERT INTO email_inboxes(user_id) VALUES($1) ON CONFLICT(user_id) DO UPDATE SET next_poll_at=now()", [owner]);
}

/**
 * Worker: reivindica cada caixa vencida empurrando next_poll_at na mesma transação (vários workers dividem
 * por SKIP LOCKED) e lê fora da transação. Caixa sem fluxo vinculado ou sem credenciais sai da fila.
 */
export async function dispatchDueInboxes(db: Database, ler: typeof abrirCaixaImap = abrirCaixaImap, now = Date.now(), max = 10) {
  let lidas = 0;
  for (; lidas < max; lidas++) {
    const linha = await db.transaction(async (sql) => {
      const { rows } = await sql.query<Linha>("SELECT user_id,body FROM email_inboxes WHERE next_poll_at<=$1 ORDER BY next_poll_at LIMIT 1 FOR UPDATE SKIP LOCKED", [new Date(now).toISOString()]);
      if (!rows[0]) return undefined;
      await sql.query("UPDATE email_inboxes SET next_poll_at=$2 WHERE user_id=$1", [rows[0].user_id, new Date(now + INTERVALO_MS).toISOString()]);
      return rows[0];
    });
    if (!linha) break;
    let estado: EstadoCaixa | null;
    try {
      estado = await withTenantJob(db, linha.user_id, async () => {
        if (!emailConfigurado() || !getConfig("EMAIL_FLOW_ID")) return null;
        const { processarEmail } = await import("./channel-flows");
        const caixa = await ler(getConfig, AbortSignal.timeout(INTERVALO_MS - 5_000));
        return lerCaixa(caixa, linha.body, impressaoDaCaixa(), getConfig("EMAIL_IMAP_USUARIO") || "", processarEmail);
      });
    } catch (error) {
      estado = { ...linha.body, lidaEm: new Date().toISOString(), erro: falhaImap(error).message };
    }
    if (!estado) await db.query("DELETE FROM email_inboxes WHERE user_id=$1", [linha.user_id]);
    else await db.query("UPDATE email_inboxes SET body=$2 WHERE user_id=$1", [linha.user_id, JSON.stringify(estado)]);
  }
  return lidas;
}

/** Situação mostrada em Implantar › E-mail. */
export async function situacaoDaCaixa(db: Pick<Database, "query">, owner: string) {
  const { rows } = await db.query<Linha>("SELECT user_id,body FROM email_inboxes WHERE user_id=$1", [owner]);
  const body = rows[0]?.body;
  if (!body) return null;
  return { lidaEm: body.lidaEm || null, recebidas: body.recebidas || 0, ignoradas: body.ignoradas || 0, ultimaIgnorada: body.ultimaIgnorada || null, erro: body.erro || null };
}
