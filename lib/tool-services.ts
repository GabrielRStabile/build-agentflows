import { constants, lstatSync, mkdirSync, openSync, readFileSync, closeSync, writeFileSync, fstatSync } from "node:fs";
import { resolve, join, dirname, relative, sep } from "node:path";
import { toolConfig as getConfig, setToolConfig as setConfig } from "./tool-config-context";
import { FlowError } from "./flow-store";
import type { AgentTool } from "./chatgpt";
import type { Builtin } from "./tools";
import { fetchText, stripHtml, isPrivateHost } from "./tools";
import { privateDataDirectory } from "./tenant-files";

const E2B_MAX_IMAGES = 5;
const string = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const object = { type: "object", additionalProperties: true };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const text = (a: Record<string, unknown>, key: string, fallback = "") => String(a[key] ?? fallback);
const required = (a: Record<string, unknown>, key: string) => {
  const value = text(a, key).trim();
  if (!value) throw new FlowError(`Informe ${key}.`);
  return value;
};
const id = (a: Record<string, unknown>, key: string, fallback?: string) => encodeURIComponent(fallback ? text(a, key, fallback) : required(a, key));
async function response(r: Response): Promise<string> {
  if (!r.ok) throw new FlowError(`O serviço respondeu com erro ${r.status}. Confira a credencial e as permissões da conta.`);
  return (await r.text()).slice(0, 50000) || "Operação concluída.";
}
// Refresh credentials are optional; a short-lived access token can also be supplied by the user.
export async function serviceToken(provider: "GOOGLE" | "MICROSOFT") {
  const prefix = `TOOL_${provider}`;
  let token = getConfig(`${prefix}_TOKEN`);
  const refresh = getConfig(`${prefix}_REFRESH_TOKEN`);
  const client = getConfig(`${prefix}_CLIENT_ID`);
  if (refresh && client && (!token || Number(getConfig(`${prefix}_EXPIRES_AT`) || 0) < Date.now() + 60000)) {
    const tenant = encodeURIComponent(getConfig("TOOL_MICROSOFT_TENANT") || "common");
    const url = provider === "GOOGLE" ? "https://oauth2.googleapis.com/token" : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: client });
    const secret = getConfig(`${prefix}_CLIENT_SECRET`);
    if (secret) body.set("client_secret", secret);
    const r = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(30000), redirect: "error" });
    if (!r.ok) throw new FlowError("A autorização expirou. Atualize a credencial desta ferramenta no Agente.");
    const data = await r.json();
    if (typeof data.access_token !== "string") throw new FlowError("O serviço não retornou uma autorização válida.");
    token = data.access_token;
    setConfig(`${prefix}_TOKEN`, token);
    setConfig(`${prefix}_EXPIRES_AT`, String(Date.now() + (Number(data.expires_in) || 3600) * 1000));
    if (data.refresh_token) setConfig(`${prefix}_REFRESH_TOKEN`, data.refresh_token);
  }
  if (!token) throw new FlowError("Configure a credencial desta ferramenta no Agente.");
  return token;
}
async function service(provider: "GOOGLE" | "MICROSOFT", url: string, method = "GET", body?: unknown) {
  return response(await fetch(url, { method, headers: { Authorization: `Bearer ${await serviceToken(provider)}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: "error" }));
}
const hasToken = (p: string) => () => !!(getConfig(`TOOL_${p}_TOKEN`) || (getConfig(`TOOL_${p}_REFRESH_TOKEN`) && getConfig(`TOOL_${p}_CLIENT_ID`)));
function operation(a: Record<string, unknown>, allowed: string[]) {
  const action = required(a, "acao");
  if (!allowed.includes(action)) throw new FlowError("Escolha uma ação disponível para esta ferramenta.");
  return action;
}
const actionSchema = (actions: string[], fields: Record<string, unknown>) => schema({ acao: { type: "string", enum: actions }, ...fields }, ["acao"]);
export function filePath(file: string) {
  if (!file || file.includes("\0") || file.includes("\\") || file.startsWith("/") || file.split("/").some((p) => p === ".." || p === "." || !p)) throw new FlowError("Use um caminho relativo dentro da pasta de arquivos dos agentes.");
  const root = privateDataDirectory("tool-files");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = resolve(root, file);
  if (relative(root, target).startsWith("..") || target === root) throw new FlowError("Caminho de arquivo inválido.");
  let current = root;
  for (const part of ["", ...relative(root, target).split(sep)]) {
    if (part) current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new FlowError("Links simbólicos não são permitidos."); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return target;
}
export const SERVICE_TOOLS: Builtin[] = [
  { id: "interno:gmail", name: "gmail", label: "Gmail", category: "Google Workspace", credential: "google_workspace", available: hasToken("GOOGLE"),
    description: "Lista, lê e envia mensagens do Gmail da conta conectada. Enviar exige destinatário, assunto e texto.",
    schema: actionSchema(["listar", "ler", "enviar"], { consulta: string("Busca Gmail"), id: string("ID da mensagem para ler"), para: string(), assunto: string(), texto: string() }),
    call: async (a) => {
      const action = operation(a, ["listar", "ler", "enviar"]), base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
      if (action === "listar") return service("GOOGLE", `${base}?maxResults=20&q=${encodeURIComponent(text(a, "consulta"))}`);
      if (action === "ler") return service("GOOGLE", `${base}/${id(a, "id")}?format=full`);
      const to = required(a, "para"), subject = required(a, "assunto");
      if (/[\r\n]/.test(to + subject)) throw new FlowError("Destinatário ou assunto inválido.");
      const mime = `To: ${to}\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(required(a, "texto")).toString("base64")}`;
      return service("GOOGLE", `${base}/send`, "POST", { raw: Buffer.from(mime).toString("base64url") });
    } },
  { id: "interno:google_calendar", name: "google_calendar", label: "Google Calendar", category: "Google Workspace", credential: "google_workspace", available: hasToken("GOOGLE"),
    description: "Lista calendários e eventos; cria ou atualiza eventos. dados segue a API Calendar: summary, start, end, attendees.",
    schema: actionSchema(["calendarios", "eventos", "criar", "atualizar"], { calendario: string("ID, padrão primary"), id: string("ID do evento"), inicio: string("timeMin RFC3339"), fim: string("timeMax RFC3339"), dados: object }),
    call: async (a) => {
      const action = operation(a, ["calendarios", "eventos", "criar", "atualizar"]);
      if (action === "calendarios") return service("GOOGLE", "https://www.googleapis.com/calendar/v3/users/me/calendarList");
      const base = `https://www.googleapis.com/calendar/v3/calendars/${id(a, "calendario", "primary")}/events`;
      if (action === "eventos") { const q = new URLSearchParams({ maxResults: "50", singleEvents: "true", orderBy: "startTime" }); if (a.inicio) q.set("timeMin", text(a, "inicio")); if (a.fim) q.set("timeMax", text(a, "fim")); return service("GOOGLE", `${base}?${q}`); }
      return service("GOOGLE", base + (action === "atualizar" ? `/${id(a, "id")}` : ""), action === "criar" ? "POST" : "PATCH", a.dados || {});
    } },
  { id: "interno:google_drive", name: "google_drive", label: "Google Drive", category: "Google Workspace", credential: "google_workspace", available: hasToken("GOOGLE"),
    description: "Busca arquivos no Drive, lê arquivos de texto e exporta documentos Google como texto.",
    schema: actionSchema(["listar", "ler", "exportar"], { consulta: string("Expressão q da API Drive"), id: string("ID do arquivo") }),
    call: async (a) => {
      const action = operation(a, ["listar", "ler", "exportar"]), base = "https://www.googleapis.com/drive/v3/files";
      if (action === "listar") return service("GOOGLE", `${base}?${new URLSearchParams({ q: text(a, "consulta", "trashed = false"), pageSize: "50", fields: "nextPageToken,files(id,name,mimeType,webViewLink)" })}`);
      return service("GOOGLE", `${base}/${id(a, "id")}${action === "exportar" ? "/export?mimeType=text%2Fplain" : "?alt=media"}`);
    } },
  { id: "interno:google_sheets", name: "google_sheets", label: "Google Sheets", category: "Google Workspace", credential: "google_workspace", available: hasToken("GOOGLE"),
    description: "Lê, substitui ou adiciona linhas de uma planilha. Use intervalo A1 e valores como matriz de linhas.",
    schema: actionSchema(["ler", "atualizar", "adicionar"], { planilha: string("ID da planilha"), intervalo: string("Ex.: Planilha1!A1:C10"), valores: { type: "array", items: { type: "array", items: {} } } }),
    call: async (a) => {
      const action = operation(a, ["ler", "atualizar", "adicionar"]), base = `https://sheets.googleapis.com/v4/spreadsheets/${id(a, "planilha")}/values/${id(a, "intervalo")}`;
      if (action === "ler") return service("GOOGLE", base);
      if (!Array.isArray(a.valores) || !a.valores.every(Array.isArray)) throw new FlowError("Informe os valores em linhas e colunas.");
      return service("GOOGLE", base + (action === "adicionar" ? ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS" : "?valueInputOption=RAW"), action === "adicionar" ? "POST" : "PUT", { values: a.valores });
    } },
  { id: "interno:outlook", name: "outlook", label: "Microsoft Outlook", category: "Microsoft 365", credential: "microsoft", available: hasToken("MICROSOFT"),
    description: "Lista, lê e envia e-mails do Outlook da conta conectada.",
    schema: actionSchema(["listar", "ler", "enviar"], { id: string(), para: string("Um endereço de e-mail"), assunto: string(), texto: string() }),
    call: async (a) => {
      const action = operation(a, ["listar", "ler", "enviar"]), base = "https://graph.microsoft.com/v1.0/me";
      if (action === "listar") return service("MICROSOFT", `${base}/messages?$top=20&$select=id,subject,from,receivedDateTime,bodyPreview`);
      if (action === "ler") return service("MICROSOFT", `${base}/messages/${id(a, "id")}`);
      return service("MICROSOFT", `${base}/sendMail`, "POST", { message: { subject: required(a, "assunto"), body: { contentType: "Text", content: required(a, "texto") }, toRecipients: [{ emailAddress: { address: required(a, "para") } }] }, saveToSentItems: true });
    } },
  { id: "interno:teams", name: "teams", label: "Microsoft Teams", category: "Microsoft 365", credential: "microsoft", available: hasToken("MICROSOFT"),
    description: "Lista equipes, canais e mensagens e envia mensagens de texto a um canal do Teams.",
    schema: actionSchema(["equipes", "canais", "mensagens", "enviar"], { equipe: string(), canal: string(), texto: string() }),
    call: async (a) => {
      const action = operation(a, ["equipes", "canais", "mensagens", "enviar"]), base = "https://graph.microsoft.com/v1.0";
      if (action === "equipes") return service("MICROSOFT", `${base}/me/joinedTeams`);
      const channels = `${base}/teams/${id(a, "equipe")}/channels`;
      if (action === "canais") return service("MICROSOFT", channels);
      const url = `${channels}/${id(a, "canal")}/messages`;
      return service("MICROSOFT", url, action === "enviar" ? "POST" : "GET", action === "enviar" ? { body: { contentType: "text", content: required(a, "texto") } } : undefined);
    } },
  ...(["get", "post"] as const).map((method): Builtin => ({ id: `interno:request_${method}`, name: `request_${method}`, label: `Request ${method === "get" ? "Get" : "Post"}`, category: "Web e dados", description: `Requisição ${method.toUpperCase()} a um endereço público${method === "post" ? " com corpo JSON" : ""}.`,
    schema: schema({ url: string(), ...(method === "post" ? { corpo: object } : {}) }, ["url"]),
    call: async (a) => fetchText(required(a, "url"), method.toUpperCase(), method === "post" ? JSON.stringify(a.corpo || {}) : undefined) })),
  { id: "interno:web_browser", name: "web_browser", label: "Web Browser", category: "Web e dados", description: "Visita uma página pública e extrai seu texto para o agente analisar. Para páginas com JavaScript, use Browserless MCP.", schema: schema({ url: string() }, ["url"]), call: async (a) => stripHtml(await fetchText(required(a, "url"))).slice(0, 30000) },
  { id: "interno:read_file", name: "read_file", label: "Read File", category: "Arquivos e código", description: "Lê um arquivo de texto da pasta compartilhada dos agentes, com limite de 1 MB. Caminho relativo.", schema: schema({ caminho: string() }, ["caminho"]), call: async (a) => {
    const fd = openSync(filePath(required(a, "caminho")), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 1024 * 1024) throw new FlowError("Escolha um arquivo de texto de até 1 MB."); return readFileSync(fd, "utf8"); } finally { closeSync(fd); }
  } },
  { id: "interno:write_file", name: "write_file", label: "Write File", category: "Arquivos e código", description: "Cria ou substitui um arquivo de texto na pasta compartilhada dos agentes, até 1 MB. Não acessa arquivos do aplicativo.", schema: schema({ caminho: string(), conteudo: string() }, ["caminho", "conteudo"]), call: async (a) => {
    const path = filePath(required(a, "caminho")), content = text(a, "conteudo");
    if (Buffer.byteLength(content) > 1024 * 1024) throw new FlowError("O arquivo deve ter até 1 MB.");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, content); } finally { closeSync(fd); }
    return "Arquivo salvo: " + text(a, "caminho");
  } },
  { id: "interno:e2b", name: "e2b", label: "Code Interpreter by E2B", category: "Arquivos e código", credential: "e2b", available: () => !!getConfig("TOOL_E2B_KEY"), description: "Executa Python ou JavaScript em um ambiente remoto isolado E2B. Retorna resultados e saída, sem acesso às credenciais do app. Para gráficos, use matplotlib e termine com plt.show(): a imagem aparece automaticamente para a pessoa abaixo da sua resposta. Não salve gráficos em disco (não há pasta compartilhada) e não inclua links nem markdown da imagem.", schema: schema({ codigo: string(), linguagem: { type: "string", enum: ["python", "javascript"] } }, ["codigo"]), call: async (a) => {
    const { Sandbox } = await import("@e2b/code-interpreter");
    const sandbox = await Sandbox.create({ apiKey: getConfig("TOOL_E2B_KEY"), timeoutMs: 60000 });
    let execution;
    try { execution = await sandbox.runCode(required(a, "codigo"), { language: a.linguagem === "javascript" ? "javascript" : "python", timeoutMs: 45000 }); }
    finally { await sandbox.kill(); }
    // Displayed images (plt.show, PIL) come back as base64: they become private attachments shown below the answer, never text for the model.
    const images: Buffer[] = [], seen = new Set<string>();
    const resultados = execution.results.map((r) => {
      const data = r.png || r.jpeg;
      if (!data) return r.text;
      if (!seen.has(data) && images.length < E2B_MAX_IMAGES) { seen.add(data); images.push(Buffer.from(data, "base64")); }
      return "[imagem exibida para a pessoa]";
    });
    const { toolRunScope } = await import("./replicate-tool");
    const scope = toolRunScope.getStore();
    let imagens: string | undefined;
    if (images.length && scope) {
      const { saveMediaFiles } = await import("./media-runtime");
      const saved = await saveMediaFiles(scope.run.flowId, images, scope.signal);
      scope.trace.images = [...(scope.trace.images || []), ...saved.files];
      imagens = `${saved.files.length} imagem(ns) gerada(s); já aparecem para a pessoa abaixo da sua resposta. Não inclua links nem markdown delas.`;
    } else if (images.length) imagens = "As imagens geradas só são exibidas quando a ferramenta é usada por um bloco Agente.";
    return JSON.stringify({ resultados, ...(imagens ? { imagens } : {}), saida: execution.logs, erro: execution.error }).slice(0, 50000);
  } },
  ...([
    ["brave_mcp", "Brave Search MCP", "brave", "TOOL_BRAVE_KEY"],
    ["postgres_mcp", "Postgres MCP", "postgres_mcp", "TOOL_POSTGRES_URL"],
    ["github_mcp", "Github MCP", "github_mcp", "TOOL_GITHUB_TOKEN"],
    ["custom_mcp", "Custom MCP", "custom_mcp", "TOOL_CUSTOM_MCP_URL"],
    ["composio", "Composio", "composio", "TOOL_COMPOSIO_KEY"],
  ].map(([name, label, credential, key]): Builtin => ({ id: `interno:${name}`, name, label, credential, category: "Integrações", available: () => !!getConfig(key), description: `Ações disponíveis em ${label}.`, schema: schema({}), call: async () => { throw new FlowError("Use esta ferramenta em um bloco Agente."); } }))),
  ...(["browserless", "slack"] as const).map((service): Builtin => ({ id: `interno:${service}`, name: service, label: service === "browserless" ? "Browserless MCP" : "Slack MCP", category: "Servidores de ferramentas", credential: service, available: () => !!getConfig(`TOOL_${service.toUpperCase()}_TOKEN`), description: service === "browserless" ? "Navegação, captura de páginas e automação pelo Browserless MCP." : "Pesquisa e colaboração no Slack pelo servidor MCP oficial.", schema: schema({}), call: async () => { throw new FlowError("Escolha este conjunto de ferramentas em um bloco Agente."); } })),
  { id: "interno:openapi", name: "openapi", label: "OpenAPI Toolkit", category: "Web e dados", credential: "openapi", available: () => !!getConfig("TOOL_OPENAPI_URL"), description: "Disponibiliza ao agente as operações de uma especificação OpenAPI 3 em JSON, com credencial Bearer opcional.", schema: schema({}), call: async () => { throw new FlowError("Escolha este conjunto de ferramentas em um bloco Agente."); } },
];

export async function resolveServiceToolkit(name: string, params: Record<string, string> = {}): Promise<AgentTool[] | null> {
  if (name === "composio") return (await import("./tool-composio")).composioTools(params);
  if (name === "brave_mcp" || name === "postgres_mcp") {
    const { localTools } = await import("./tool-mcp");
    return localTools(name, name === "brave_mcp" ? "brave" : "postgres", getConfig(name === "brave_mcp" ? "TOOL_BRAVE_KEY" : "TOOL_POSTGRES_URL") || "");
  }
  if (name === "github_mcp" || name === "custom_mcp") {
    const { remoteTools } = await import("./tool-mcp");
    const url = name === "github_mcp" ? "https://api.githubcopilot.com/mcp/" : publicUrl(getConfig("TOOL_CUSTOM_MCP_URL") || "").toString();
    return remoteTools(name, url, getConfig(name === "github_mcp" ? "TOOL_GITHUB_TOKEN" : "TOOL_CUSTOM_MCP_TOKEN"));
  }
  if (name === "openapi") return (await import("./tool-openapi")).openApiTools();
  if (name !== "browserless" && name !== "slack") return null;
  const { remoteTools } = await import("./tool-mcp");
  return remoteTools(name, name === "browserless" ? "https://mcp.browserless.io/mcp" : "https://mcp.slack.com/mcp", getConfig(`TOOL_${name.toUpperCase()}_TOKEN`));
}
export function publicUrl(value: string) {
  const u = new URL(value);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || isPrivateHost(u.hostname)) throw new FlowError("Use um endereço público HTTP ou HTTPS.");
  return u;
}
