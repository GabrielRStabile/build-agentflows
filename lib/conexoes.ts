// Conexões do produto (tela Configurações): OpenRouter, servidores de ferramentas (MCP), WhatsApp e
// ElevenLabs. O ChatGPT continua sendo a conexão principal e fica em lib/chatgpt.ts.
// Tudo é guardado no banco cifrado da suíte (lib/store.ts); segredos nunca voltam inteiros.
import { randomBytes } from "node:crypto";
import { channelKey } from "./channel-auth";
import { getConfig, setConfig, mascarar, configTransaction } from "./store";
import { conexaoAutorizada, desconectar as desautorizar } from "./mcp-oauth";
import { FlowError } from "./flow-store";
import { TOOL_CREDENTIAL_KEYS } from "./tool-credentials";
import { MEDIA_PROVIDERS } from "./media-models";
import { mediaCredentials } from "./media-credentials";
import { currentTenant } from "./tenant-context";
export type Campo = {
  chave: string;
  rotulo: string;
  tipo: "text" | "secret" | "select";
  opcional?: boolean;
  ajuda?: string;
  placeholder?: string;
  opcoes?: { valor: string; rotulo: string }[];
};
export type CampoStatus = Campo & { definido: boolean; mascarado: string | null; valor?: string };
export const PROVEDORES_WHATSAPP = [
  { valor: "zapi", rotulo: "Z-API (conexão por QR Code)" },
  { valor: "meta", rotulo: "WhatsApp oficial (Meta Cloud)" },
  { valor: "zapperhub", rotulo: "ZapperHub" },
];
export const WHATSAPP_CAMPOS: Campo[] = [
  { chave: "WHATSAPP_PROVEDOR", rotulo: "Provedor", tipo: "select", opcoes: PROVEDORES_WHATSAPP },
  { chave: "ZAPI_INSTANCE_ID", rotulo: "Z-API · Identificação da instância", tipo: "text", opcional: true },
  { chave: "ZAPI_TOKEN", rotulo: "Z-API · Chave da instância", tipo: "secret", opcional: true },
  { chave: "ZAPI_CLIENT_TOKEN", rotulo: "Z-API · Chave de segurança da conta", tipo: "secret", opcional: true },
  { chave: "WHATSAPP_PHONE_NUMBER_ID", rotulo: "Meta · Identificador do número", tipo: "text", opcional: true },
  { chave: "WHATSAPP_TOKEN", rotulo: "Meta · Código de acesso permanente", tipo: "secret", opcional: true },
  { chave: "WHATSAPP_APP_SECRET", rotulo: "Meta · Segredo do aplicativo", tipo: "secret", opcional: true, ajuda: "Necessário para validar as mensagens recebidas da Meta." },
  { chave: "ZAPPERHUB_URL", rotulo: "ZapperHub · Endereço da API", tipo: "text", opcional: true, placeholder: "https://api.zapperapi.com" },
  { chave: "ZAPPERHUB_KEY", rotulo: "ZapperHub · Chave", tipo: "secret", opcional: true },
];
export const ELEVENLABS_CAMPOS: Campo[] = [
  { chave: "ELEVENLABS_API_KEY", rotulo: "Chave da ElevenLabs", tipo: "secret", placeholder: "sk_...", ajuda: "A voz é escolhida no chat de cada fluxo; ligações são configuradas em Implantar." },
];
// Ligações por voz: configuradas por fluxo em Implantar › Ligações.
export const LIGACAO_CAMPOS: Campo[] = [
  { chave: "ELEVENLABS_AGENT_ID", rotulo: "Agente de conversa", tipo: "text", ajuda: "Identificador do agente criado em Conversational AI." },
  { chave: "ELEVENLABS_PHONE_NUMBER_ID", rotulo: "Número para ligações", tipo: "text", ajuda: "Identificador do número importado na ElevenLabs (Twilio ou SIP)." },
  { chave: "ELEVENLABS_WEBHOOK_SECRET", rotulo: "Segredo do aviso de fim de ligação", tipo: "secret", opcional: true, ajuda: "Copie do aviso pós-ligação em Conversational AI › Settings." },
];
// E-mail de entrada: caixa lida por IMAP pelo worker (lib/email-entrada.ts), configurada em Implantar › E-mail.
export const EMAIL_CAMPOS: Campo[] = [
  { chave: "EMAIL_IMAP_HOST", rotulo: "Servidor IMAP", tipo: "text", placeholder: "imap.gmail.com", ajuda: "Gmail: imap.gmail.com · Yahoo: imap.mail.yahoo.com · iCloud: imap.mail.me.com · Zoho: imap.zoho.com." },
  { chave: "EMAIL_IMAP_PORTA", rotulo: "Porta", tipo: "text", opcional: true, placeholder: "993" },
  { chave: "EMAIL_IMAP_USUARIO", rotulo: "Endereço de e-mail", tipo: "text", placeholder: "voce@empresa.com" },
  { chave: "EMAIL_IMAP_SENHA", rotulo: "Senha de app", tipo: "secret", ajuda: "Não é a senha normal da conta. No Gmail, crie em myaccount.google.com/apppasswords (exige verificação em duas etapas). Contas Microsoft (Outlook, Hotmail, 365) não aceitam mais senha de app por IMAP." },
  { chave: "EMAIL_IMAP_PASTA", rotulo: "Pasta", tipo: "text", opcional: true, placeholder: "INBOX", ajuda: "Pasta lida pelo fluxo. Use um marcador ou filtro do provedor para mandar só os e-mails certos para ela." },
];
const CHAVES_LIVRES = new Set([
  ...WHATSAPP_CAMPOS.map((c) => c.chave),
  ...ELEVENLABS_CAMPOS.map((c) => c.chave),
  ...LIGACAO_CAMPOS.map((c) => c.chave),
  ...EMAIL_CAMPOS.map((c) => c.chave),
  "EMAIL_FLOW_ID",
  "ELEVENLABS_VOICE_ID",
  "WHATSAPP_FLOW_ID",
  "ELEVENLABS_FLOW_ID",
  "OPENROUTER_API_KEY",
  ...MEDIA_PROVIDERS.map((provider) => provider.key),
  ...TOOL_CREDENTIAL_KEYS,
]);
// Grava um conjunto de campos; só chaves conhecidas, só texto curto.
export function salvarCampos(campos: unknown, aceiteWhatsApp?: unknown) {
  if (!campos || typeof campos !== "object" || Array.isArray(campos))
    throw new FlowError("Envie os campos a salvar.");
  const entries = Object.entries(campos as Record<string, unknown>);
  for (const [chave, valor] of entries) {
    if (!CHAVES_LIVRES.has(chave)) throw new FlowError(`Campo desconhecido: ${chave}.`);
    if (valor !== null && (typeof valor !== "string" || valor.length > 4000))
      throw new FlowError(`Valor inválido em ${chave}.`);
    if (chave.startsWith("EMAIL_IMAP_") && typeof valor === "string" && /[\r\n]/.test(valor))
      throw new FlowError("Os dados do e-mail não podem ter quebras de linha.");
    if (MEDIA_PROVIDERS.some((provider) => provider.key === chave) && typeof valor === "string" && (!valor.trim() || /[\r\n]/.test(valor)))
      throw new FlowError("Cole uma chave de imagem válida, sem quebras de linha.");
  }
  const values = campos as Record<string, string | null>;
  const provider = ("WHATSAPP_PROVEDOR" in values ? values.WHATSAPP_PROVEDOR : provedorWhatsApp());
  const touchesWhatsApp = entries.some(([k]) => /^(WHATSAPP_|ZAPI_|ZAPPERHUB_)/.test(k));
  const accepted = aceiteWhatsApp as { provedor?: string; versao?: string } | undefined;
  const requires = touchesWhatsApp && (provider === "zapi" || provider === "zapperhub");
  const newAcceptance = requires && accepted?.provedor === provider && accepted.versao === "2026-09-20";
  if (requires && !newAcceptance && aceiteWhatsAppAtual()?.provedor !== provider)
    throw new FlowError("Leia e aceite os termos de uso da integração não oficial do WhatsApp.");
  configTransaction(() => {
    for (const [key, value] of entries) {
      if (typeof value === "string" && /^•+$|^.{4}••••.{4}$/.test(value)) continue;
      setConfig(key, typeof value === "string" && MEDIA_PROVIDERS.some((provider) => provider.key === key) ? value.trim() : value as string | null);
    }
    if (newAcceptance) setConfig("WHATSAPP_ACEITE", JSON.stringify({ provedor: provider, versao: "2026-09-20", data: new Date().toISOString() }));
  });
}
export function aceiteWhatsAppAtual(): { provedor: string; versao: string; data: string } | null {
  try {
    const a = JSON.parse(getConfig("WHATSAPP_ACEITE") || "null");
    return a?.versao === "2026-09-20" && typeof a.data === "string" ? a : null;
  } catch { return null; }
}
export function statusCampos(campos: Campo[]): CampoStatus[] {
  return campos.map((c) => {
    const v = getConfig(c.chave);
    return {
      ...c,
      definido: !!v,
      mascarado: c.tipo === "secret" ? mascarar(v) : null,
      valor: c.tipo === "secret" ? undefined : v,
    };
  });
}
// --- Servidores de ferramentas (MCP) ---------------------------------------------------------
export type ServidorMCP = { prefixo: string; nome: string };
const CHAVE_SERVIDORES = "MCP_SERVIDORES";
export function servidoresMCP(): ServidorMCP[] {
  let lista: ServidorMCP[] = [];
  try {
    lista = JSON.parse(getConfig(CHAVE_SERVIDORES) || "[]");
  } catch {
    lista = [];
  }
  return lista;
}
export function servidorMCP(prefixo: string) {
  const s = servidoresMCP().find((s) => s.prefixo === prefixo);
  if (!s) throw new FlowError("Servidor de ferramentas não encontrado.", 404);
  return { ...s, url: getConfig(`${prefixo}_URL`) || "" };
}
export function adicionarServidorMCP(nome: unknown, url: unknown, codigo?: unknown) {
  if (typeof nome !== "string" || !nome.trim() || nome.length > 60)
    throw new FlowError("Dê um nome curto ao servidor.");
  let u: URL;
  try {
    u = new URL(String(url));
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw 0;
  } catch {
    throw new FlowError("Informe um endereço HTTP válido.");
  }
  if (codigo != null && (typeof codigo !== "string" || codigo.length > 10000))
    throw new FlowError("Informe um código válido.");
  const prefixo = "MCP_" + randomBytes(3).toString("hex").toUpperCase();
  const lista = servidoresMCP();
  setConfig(CHAVE_SERVIDORES, JSON.stringify([...lista, { prefixo, nome: nome.trim() }]));
  setConfig(`${prefixo}_URL`, u.toString());
  if (codigo) setConfig(`${prefixo}_CODIGO`, codigo);
  return { prefixo, nome: nome.trim(), url: u.toString() };
}
export function atualizarServidorMCP(prefixo: string, nome: unknown, url: unknown, codigo?: unknown) {
  const previous = servidorMCP(prefixo);
  if (typeof nome !== "string" || !nome.trim() || nome.length > 60) throw new FlowError("Dê um nome curto ao servidor.");
  let address: URL;
  try { address = new URL(String(url)); if (!["http:", "https:"].includes(address.protocol) || address.username || address.password) throw 0; } catch { throw new FlowError("Informe um endereço HTTP válido."); }
  if (codigo != null && (typeof codigo !== "string" || codigo.length > 10000)) throw new FlowError("Informe um código válido.");
  if (previous.url !== address.toString()) desautorizar(prefixo);
  setConfig(`${prefixo}_URL`, address.toString());
  if (codigo) setConfig(`${prefixo}_CODIGO`, codigo as string);
  setConfig(CHAVE_SERVIDORES, JSON.stringify(servidoresMCP().map((s) => s.prefixo === prefixo ? { ...s, nome: nome.trim() } : s)));
}
export function removerServidorMCP(prefixo: string) {
  servidorMCP(prefixo);
  desautorizar(prefixo);
  setConfig(`${prefixo}_URL`, null);
  setConfig(`${prefixo}_RECURSO`, null);
  setConfig(CHAVE_SERVIDORES, JSON.stringify(servidoresMCP().filter((s) => s.prefixo !== prefixo)));
}
export async function conexaoMCP(prefixo: string) {
  servidorMCP(prefixo);
  return conexaoAutorizada(prefixo);
}
// --- Estado geral da tela Configurações -----------------------------------------------------------
export function provedorWhatsApp() {
  const escolhido = getConfig("WHATSAPP_PROVEDOR");
  if (escolhido === "zapi" || escolhido === "meta" || escolhido === "zapperhub") return escolhido;
  if (getConfig("ZAPI_INSTANCE_ID")) return "zapi";
  if (getConfig("WHATSAPP_TOKEN")) return "meta";
  if (getConfig("ZAPPERHUB_KEY")) return "zapperhub";
  return null;
}
export function whatsappConfigurado() {
  const p = provedorWhatsApp();
  if ((p === "zapi" || p === "zapperhub") && aceiteWhatsAppAtual()?.provedor !== p) return false;
  if (p === "zapi") return !!(getConfig("ZAPI_INSTANCE_ID") && getConfig("ZAPI_TOKEN") && getConfig("ZAPI_CLIENT_TOKEN"));
  if (p === "meta") return !!(getConfig("WHATSAPP_TOKEN") && getConfig("WHATSAPP_PHONE_NUMBER_ID"));
  if (p === "zapperhub") return !!getConfig("ZAPPERHUB_KEY");
  return false;
}
export function emailConfigurado() {
  return !!(getConfig("EMAIL_IMAP_HOST") && getConfig("EMAIL_IMAP_USUARIO") && getConfig("EMAIL_IMAP_SENHA"));
}
export function elevenLabsConfigurado() {
  return !!getConfig("ELEVENLABS_API_KEY");
}
export function ligacaoConfigurada() {
  return elevenLabsConfigurado() && !!getConfig("ELEVENLABS_AGENT_ID") && !!getConfig("ELEVENLABS_PHONE_NUMBER_ID");
}
// Chave secreta na URL dos avisos (Z-API/ZapperHub) e valor de verificação da Meta, gerados uma vez.
export const chaveWebhook = () => channelKey("whatsapp");
export async function statusConexoes(origem: string) {
  const servidores = await Promise.all(
    servidoresMCP().map(async (s) => ({
      ...s,
      url: getConfig(`${s.prefixo}_URL`) || "",
      autorizado: !!(await conexaoAutorizada(s.prefixo)),
    })),
  );
  return {
    media: mediaCredentials(),
    openrouter: {
      conectado: !!getConfig("OPENROUTER_API_KEY"),
      mascarado: mascarar(getConfig("OPENROUTER_API_KEY")),
    },
    mcp: servidores,
    whatsapp: {
      provedor: provedorWhatsApp(),
      aceite: aceiteWhatsAppAtual(),
      configurado: whatsappConfigurado(),
      fluxo: getConfig("WHATSAPP_FLOW_ID") || null,
      campos: statusCampos(WHATSAPP_CAMPOS),
      aviso: `${origem}/webhook/whatsapp?chave=${chaveWebhook()}`,
      verificacao: chaveWebhook(),
    },
    elevenlabs: {
      configurado: elevenLabsConfigurado(),
      ligacao: ligacaoConfigurada(),
      fluxo: getConfig("ELEVENLABS_FLOW_ID") || null,
      campos: statusCampos(ELEVENLABS_CAMPOS),
      aviso: `${origem}/webhook/elevenlabs?chave=${channelKey("elevenlabs")}`,
    },
    email: {
      configurado: emailConfigurado(),
      fluxo: getConfig("EMAIL_FLOW_ID") || null,
      campos: statusCampos(EMAIL_CAMPOS),
      situacao: await (await import("./email-entrada")).situacaoDaCaixa(currentTenant().db, currentTenant().user.id),
    },
    ligacao: {
      configurada: ligacaoConfigurada(),
      fluxo: getConfig("ELEVENLABS_FLOW_ID") || null,
      campos: statusCampos(LIGACAO_CAMPOS),
      aviso: `${origem}/webhook/elevenlabs?chave=${channelKey("elevenlabs")}`,
    },
  };
}
