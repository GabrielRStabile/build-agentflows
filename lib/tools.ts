// Ferramentas do Agente, no espírito do Flowise: um catálogo com ferramentas prontas (sem
// configurar nada) e as ferramentas de cada servidor MCP conectado em Configurações.
//
// Identificadores guardados no bloco: "interno:<nome>" para as prontas e "mcp:<prefixo>:<nome>"
// para as de um servidor. O modelo recebe o nome curto da ferramenta.
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTool } from "./chatgpt";
import { conexaoMCP, servidoresMCP, servidorMCP } from "./conexoes";
import { conectar, chamar, listarFerramentas } from "./mcp-cliente";
import { FlowError, listFlows } from "./flow-service";
import { toolConfig as getConfig } from "./tool-config-context";
import { withToolCredential } from "./tool-credential-store";
import { readToolCards } from "./agent-tools";
import { TOOL_CREDENTIALS, type Credential } from "./tool-credentials";
import { SERVICE_TOOLS, resolveServiceToolkit } from "./tool-services";
export type ToolInfo = {
  label?: string;
  id: string;
  name: string;
  description: string;
  schema: unknown;
  category?: string;
  // Ferramenta pronta que ainda precisa de credencial (campos) ou de uma conexão (setup).
  configured?: boolean;
  credentials?: Credential[];
  credentialProvider?: string;
  setup?: string;
};
export type ToolGroup = { id: string; name: string; kind: "builtin" | "mcp"; tools: ToolInfo[]; error?: string };
export type Builtin = ToolInfo & { credential?: string; available?: () => boolean; call: (args: Record<string, unknown>) => Promise<string> };
// --- Calculadora sem eval: números, + - * / % ^ e parênteses. ---------------------------------
export function calculate(expression: string): number {
  const src = expression.replace(/\s+/g, "").replace(/,/g, ".");
  if (!src || !/^[0-9.+\-*/%^()]+$/.test(src)) throw new FlowError("Use apenas números e + - * / % ^ ( ).");
  let i = 0;
  const peek = () => src[i];
  const number = (): number => {
    if (peek() === "(") {
      i++;
      const v = expr();
      if (peek() !== ")") throw new FlowError("Parêntese sem fechar.");
      i++;
      return v;
    }
    if (peek() === "-") {
      i++;
      return -number();
    }
    const m = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(src.slice(i));
    if (!m) throw new FlowError("Expressão inválida.");
    i += m[0].length;
    return Number(m[0]);
  };
  const power = (): number => {
    const base = number();
    if (peek() === "^") {
      i++;
      return base ** power();
    }
    return base;
  };
  const term = (): number => {
    let v = power();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = src[i++];
      const r = power();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = src[i++];
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const v = expr();
  if (i !== src.length) throw new FlowError("Expressão inválida.");
  if (!Number.isFinite(v)) throw new FlowError("O resultado não é um número válido.");
  return v;
}
// Endereços internos da rede não podem ser alcançados a partir de uma ferramenta do agente.
export function isPrivateHost(host: string) {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) ||
    h === "::1" ||
    h.startsWith("[")
  );
}
export async function fetchText(url: string, method = "GET", body?: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new FlowError("Endereço inválido.");
  }
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || isPrivateHost(u.hostname))
    throw new FlowError("Este endereço não pode ser acessado pelo agente.");
  const res = await fetch(u, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: method === "GET" ? undefined : body,
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  const text = (await res.text()).slice(0, 100000);
  if (!res.ok) throw new FlowError(`O serviço respondeu com erro ${res.status}.`);
  return text;
}
// --- Catálogo de ferramentas prontas (mesmos serviços do Flowise) ----------------------------
function cred(id: string) {
  const list = TOOL_CREDENTIALS[id] || [];
  const values: Record<string, string> = {};
  for (const c of list) values[c.chave] = getConfig(c.chave) || "";
  return { ok: list.every((c) => values[c.chave]), values };
}
function needs(id: string) {
  return () => cred(id).ok;
}
type Hit = { titulo?: string; url?: string; trecho?: string };
function hits(list: Hit[], extra?: Record<string, unknown>) {
  return JSON.stringify({ ...(extra || {}), resultados: list.slice(0, 8) }).slice(0, 30000);
}
async function getJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new FlowError(`O serviço de busca respondeu com erro ${r.status}.`);
  return (await r.json()) as Record<string, unknown>;
}
const QUERY = { type: "object", properties: { consulta: { type: "string", description: "o que buscar" } }, required: ["consulta"] };
export function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
// Caminho simples "a.b[0].c" dentro de um JSON.
export function extractPath(value: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: unknown = value;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
const flowToolDepth = new AsyncLocalStorage<number>();
const BUILTIN: Builtin[] = [
  // Busca na web
  {
    id: "interno:tavily", name: "tavily", category: "Busca na web", credential: "tavily",
    description: "Busca na web pela Tavily, feita para agentes de IA, com resposta resumida.",
    schema: QUERY, available: needs("tavily"),
    call: async (a) => {
      const d = await getJson("https://api.tavily.com/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: cred("tavily").values.TOOL_TAVILY_KEY, query: String(a.consulta ?? ""), max_results: 5, include_answer: true }),
      });
      const r = (d.results as { title?: string; url?: string; content?: string }[]) || [];
      return hits(r.map((x) => ({ titulo: x.title, url: x.url, trecho: x.content })), { resposta: d.answer });
    },
  },
  {
    id: "interno:searchapi", name: "searchapi", category: "Busca na web", credential: "searchapi",
    description: "Resultados do Google em tempo real pela SearchApi.",
    schema: QUERY, available: needs("searchapi"),
    call: async (a) => {
      const u = new URL("https://www.searchapi.io/api/v1/search");
      u.searchParams.set("engine", "google"); u.searchParams.set("q", String(a.consulta ?? "")); u.searchParams.set("api_key", cred("searchapi").values.TOOL_SEARCHAPI_KEY);
      const d = await getJson(u.toString());
      const r = (d.organic_results as { title?: string; link?: string; snippet?: string }[]) || [];
      return hits(r.map((x) => ({ titulo: x.title, url: x.link, trecho: x.snippet })), { resposta: (d.answer_box as { answer?: string } | undefined)?.answer });
    },
  },
  {
    id: "interno:exa", name: "exa", category: "Busca na web", credential: "exa",
    description: "Busca semântica pela Exa, com o texto das páginas encontradas.",
    schema: QUERY, available: needs("exa"),
    call: async (a) => {
      const d = await getJson("https://api.exa.ai/search", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": cred("exa").values.TOOL_EXA_KEY },
        body: JSON.stringify({ query: String(a.consulta ?? ""), numResults: 5, contents: { text: { maxCharacters: 1500 } } }),
      });
      const r = (d.results as { title?: string; url?: string; text?: string }[]) || [];
      return hits(r.map((x) => ({ titulo: x.title, url: x.url, trecho: x.text })));
    },
  },
  {
    id: "interno:serper", name: "serper", category: "Busca na web", credential: "serper",
    description: "Resultados do Google pela Serper.dev.",
    schema: QUERY, available: needs("serper"),
    call: async (a) => {
      const d = await getJson("https://google.serper.dev/search", {
        method: "POST", headers: { "Content-Type": "application/json", "X-API-KEY": cred("serper").values.TOOL_SERPER_KEY },
        body: JSON.stringify({ q: String(a.consulta ?? ""), num: 5, gl: "br", hl: "pt-br" }),
      });
      const r = (d.organic as { title?: string; link?: string; snippet?: string }[]) || [];
      return hits(r.map((x) => ({ titulo: x.title, url: x.link, trecho: x.snippet })), { resposta: (d.answerBox as { answer?: string; snippet?: string } | undefined)?.answer });
    },
  },
  {
    id: "interno:serpapi", name: "serpapi", category: "Busca na web", credential: "serpapi",
    description: "Resultados do Google pela SerpApi.",
    schema: QUERY, available: needs("serpapi"),
    call: async (a) => {
      const u = new URL("https://serpapi.com/search.json");
      u.searchParams.set("q", String(a.consulta ?? "")); u.searchParams.set("api_key", cred("serpapi").values.TOOL_SERPAPI_KEY); u.searchParams.set("num", "5"); u.searchParams.set("hl", "pt-br"); u.searchParams.set("gl", "br");
      const d = await getJson(u.toString());
      const r = (d.organic_results as { title?: string; link?: string; snippet?: string }[]) || [];
      return hits(r.map((x) => ({ titulo: x.title, url: x.link, trecho: x.snippet })));
    },
  },
  {
    id: "interno:brave", name: "brave", category: "Busca na web", credential: "brave",
    description: "Busca na web pela Brave Search.",
    schema: QUERY, available: needs("brave"),
    call: async (a) => {
      const u = new URL("https://api.search.brave.com/res/v1/web/search");
      u.searchParams.set("q", String(a.consulta ?? "")); u.searchParams.set("count", "5");
      const d = await getJson(u.toString(), { headers: { Accept: "application/json", "X-Subscription-Token": cred("brave").values.TOOL_BRAVE_KEY } });
      const r = ((d.web as { results?: { title?: string; url?: string; description?: string }[] } | undefined)?.results) || [];
      return hits(r.map((x) => ({ titulo: x.title, url: x.url, trecho: x.description })));
    },
  },
  {
    id: "interno:google", name: "google", category: "Busca na web", credential: "google",
    description: "Google Custom Search (mecanismo de busca programável).",
    schema: QUERY, available: needs("google"),
    call: async (a) => {
      const { values } = cred("google");
      const u = new URL("https://www.googleapis.com/customsearch/v1");
      u.searchParams.set("key", values.TOOL_GOOGLE_KEY); u.searchParams.set("cx", values.TOOL_GOOGLE_CX); u.searchParams.set("q", String(a.consulta ?? "")); u.searchParams.set("num", "5");
      const d = await getJson(u.toString());
      const r = (d.items as { title?: string; link?: string; snippet?: string }[]) || [];
      return hits(r.map((x) => ({ titulo: x.title, url: x.link, trecho: x.snippet })));
    },
  },
  {
    id: "interno:searxng", name: "searxng", category: "Busca na web", credential: "searxng",
    description: "Busca na sua própria instância SearXNG (metabusca livre).",
    schema: QUERY, available: needs("searxng"),
    call: async (a) => {
      const base = cred("searxng").values.TOOL_SEARXNG_URL.replace(/\/+$/, "");
      const u = new URL(base + "/search");
      u.searchParams.set("q", String(a.consulta ?? "")); u.searchParams.set("format", "json");
      const d = await getJson(u.toString());
      const r = (d.results as { title?: string; url?: string; content?: string }[]) || [];
      return hits(r.map((x) => ({ titulo: x.title, url: x.url, trecho: x.content })));
    },
  },
  // Conhecimento
  {
    id: "interno:arxiv", name: "arxiv", category: "Conhecimento",
    description: "Busca artigos científicos no arXiv (título, resumo e link).",
    schema: QUERY,
    call: async (a) => {
      const u = new URL("https://export.arxiv.org/api/query");
      u.searchParams.set("search_query", "all:" + String(a.consulta ?? "")); u.searchParams.set("max_results", "5");
      const xml = await fetchText(u.toString());
      const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
        const e = m[1];
        const pick = (tag: string) => (e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] || "").replace(/\s+/g, " ").trim();
        return { titulo: pick("title"), url: pick("id"), trecho: pick("summary").slice(0, 600) };
      });
      return hits(entries);
    },
  },
  {
    id: "interno:wolfram", name: "wolfram", category: "Conhecimento", credential: "wolfram",
    description: "Respostas curtas de cálculo e conhecimento pelo Wolfram Alpha.",
    schema: { type: "object", properties: { pergunta: { type: "string" } }, required: ["pergunta"] }, available: needs("wolfram"),
    call: async (a) => {
      const u = new URL("https://api.wolframalpha.com/v1/result");
      u.searchParams.set("appid", cred("wolfram").values.TOOL_WOLFRAM_APPID); u.searchParams.set("i", String(a.pergunta ?? ""));
      const r = await fetch(u.toString(), { signal: AbortSignal.timeout(30000) });
      const text = await r.text();
      if (!r.ok) throw new FlowError(r.status === 501 ? "O Wolfram Alpha não soube responder a essa pergunta." : `O Wolfram Alpha respondeu com erro ${r.status}.`);
      return text.slice(0, 5000);
    },
  },
  // Web e dados
  {
    id: "interno:ler_pagina", name: "ler_pagina", category: "Web e dados",
    description: "Lê o texto de uma página pública da internet.",
    schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    call: async (a) => stripHtml(await fetchText(String(a.url ?? ""))).slice(0, 20000),
  },
  {
    id: "interno:requisicao_http", name: "requisicao_http", category: "Web e dados",
    description: "Consulta ou envia dados a um endereço público na internet (GET ou POST com JSON).",
    schema: { type: "object", properties: { url: { type: "string" }, method: { type: "string", enum: ["GET", "POST"] }, body: { type: "string", description: "JSON enviado no POST" } }, required: ["url"] },
    call: async (a) => fetchText(String(a.url ?? ""), a.method === "POST" ? "POST" : "GET", a.body ? String(a.body) : undefined),
  },
  {
    id: "interno:extrair_json", name: "extrair_json", category: "Web e dados",
    description: "Extrai um valor de um JSON por caminho (ex.: dados.itens[0].nome).",
    schema: { type: "object", properties: { json: { type: "string" }, caminho: { type: "string" } }, required: ["json", "caminho"] },
    call: async (a) => {
      let v: unknown;
      try { v = JSON.parse(String(a.json ?? "")); } catch { throw new FlowError("O texto não é um JSON válido."); }
      const out = extractPath(v, String(a.caminho ?? ""));
      return out === undefined ? "Caminho não encontrado." : typeof out === "string" ? out : JSON.stringify(out).slice(0, 30000);
    },
  },
  // Imagens e vídeo: o modelo escolhido nos parâmetros define se aceita imagens de referência.
  {
    id: "interno:replicate", name: "replicate", label: "Replicate", category: "Imagens e vídeo", credential: "ai_replicate",
    available: () => !!getConfig("REPLICATE_API_TOKEN"),
    description: "Gera imagens ou vídeos com um modelo da Replicate. Modelos que aceitam imagens também recebem referências para edição.",
    schema: { type: "object", properties: {} },
    call: async () => { throw new FlowError("Use esta ferramenta em um bloco Agente."); },
  },
  // Utilidades
  {
    id: "interno:data_hora", name: "data_hora", category: "Utilidades",
    description: "Informa a data e a hora atuais no Brasil.",
    schema: { type: "object", properties: {} },
    call: async () => {
      const now = new Date();
      return JSON.stringify({ iso: now.toISOString(), brasil: now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "full", timeStyle: "short" }) });
    },
  },
  {
    id: "interno:calculadora", name: "calculadora", category: "Utilidades",
    description: "Calcula uma expressão matemática (ex.: (1200*0.15)+80).",
    schema: { type: "object", properties: { expressao: { type: "string" } }, required: ["expressao"] },
    call: async (a) => String(calculate(String(a.expressao ?? ""))),
  },
  // Fluxos
  {
    id: "interno:executar_fluxo", name: "executar_fluxo", category: "Fluxos",
    description: "Executa outro fluxo publicado desta instalação e devolve a resposta dele.",
    schema: { type: "object", properties: { fluxo: { type: "string", description: "nome ou identificador do fluxo" }, entrada: { type: "string" } }, required: ["fluxo", "entrada"] },
    call: async (a) => {
      const depth = flowToolDepth.getStore() || 0;
      if (depth >= 5) throw new FlowError("Limite de agentes encadeados atingido. Confira se os fluxos chamam uns aos outros.");
      return flowToolDepth.run(depth + 1, async () => {
      const { startRun } = await import("./flow-runtime");
      const alvo = String(a.fluxo ?? "");
      const f = (await listFlows()).find((f) => f.published && (f.id === alvo || f.name.toLowerCase() === alvo.toLowerCase()));
      if (!f) throw new FlowError("Fluxo publicado não encontrado.");
      const r = await startRun(f.id, String(a.entrada ?? ""), true);
      return JSON.stringify({ status: r.status, output: r.output, error: r.error, id: r.id });
      });
    },
  },
];
const TOOL_LABELS: Record<string, string> = { brave: "BraveSearch API", calculadora: "Calculator", exa: "Exa Search", google: "Google Custom Search", searchapi: "SearchApi", searxng: "SearXNG", serpapi: "Serp API", serper: "Serper", tavily: "Tavily", arxiv: "arXiv", wolfram: "Wolfram Alpha", ler_pagina: "Ler página", requisicao_http: "Requisição HTTP", extrair_json: "Extrair JSON", data_hora: "Data e hora", executar_fluxo: "Executar fluxo" };
export function builtinTools(): ToolInfo[] {
  return [...SERVICE_TOOLS, ...BUILTIN].map(({ id, name, label, description, schema, category, credential, setup, available }) => ({
    id,
    name,
    label: label || TOOL_LABELS[name] || name,
    description,
    schema,
    category,
    configured: !available || available(),
    credentialProvider: credential,
    credentials: credential ? TOOL_CREDENTIALS[credential].map((c) => ({ ...c, definido: !!getConfig(c.chave), valor: c.secret ? undefined : getConfig(c.chave) })) : undefined,
    setup,
  }));
}
export function toolShortName(id: string) {
  return id.split(":").pop() || id;
}
// Catálogo para o diálogo do Agente: ferramentas prontas e um grupo por servidor conectado.
export async function listTools(scope?: string): Promise<ToolGroup[]> {
  const groups: ToolGroup[] = !scope || scope === "interno" ? [{ id: "interno", name: "Ferramentas prontas", kind: "builtin", tools: builtinTools() }] : [];
  const servers = scope === "interno" ? [] : scope ? [servidorMCP(scope)] : servidoresMCP();
  for (const s of servers) {
    const group: ToolGroup = { id: "mcp:" + s.prefixo, name: s.nome, kind: "mcp", tools: [] };
    try {
      const c = await conexaoMCP(s.prefixo);
      if (!c) throw new Error("Autorize este servidor na gestão de ferramentas do Agente.");
      group.tools = (await listarFerramentas(conectar(c.url, c.token))).map((t) => ({
        id: `mcp:${s.prefixo}:${t.nome}`,
        name: t.nome,
        description: t.descricao || t.nome,
        schema: t.schema || { type: "object", properties: {} },
      }));
    } catch (err) {
      group.error = err instanceof Error ? err.message : "Não foi possível listar as ferramentas.";
    }
    groups.push(group);
  }
  return groups;
}
// Ferramentas prontas para o modelo, a partir dos identificadores marcados no bloco.
export async function resolveTools(ids: string[], cardsValue = ""): Promise<AgentTool[]> {
  const wanted = [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
  if (wanted.some(id => !/^(?:interno:[^:]+|mcp:[^:]+:.+)$/.test(id))) throw new FlowError("Selecione uma ferramenta vinculada à sua conta.");
  const cards = readToolCards(ids.join(","), cardsValue);
  const out: AgentTool[] = [];
  const byServer = new Map<string, string[]>();
  for (const id of wanted) {
    if (id.startsWith("interno:")) {
      const b = [...SERVICE_TOOLS, ...BUILTIN].find((t) => t.id === id);
      const card = cards.find((card) => card.kind === "tool" && card.target === id);
      const credentialId = card?.credentialId, params = card?.params || {};
      if (!b || !withToolCredential(credentialId, b.credential, () => !b.available || b.available()))
        throw new FlowError(`A ferramenta “${toolShortName(id)}” não está disponível. Confira as credenciais no Agente.`);
      const toolkit = await withToolCredential(credentialId, b.credential, () => resolveServiceToolkit(b.name, params));
      if (toolkit) {
        const selected = params.actions === undefined ? null : JSON.parse(params.actions) as string[];
        if (selected && (!Array.isArray(selected) || !selected.length)) throw new FlowError("Selecione ao menos uma ação nos parâmetros da ferramenta.");
        if (selected?.some((name) => !toolkit.some((tool) => tool.name === name))) throw new FlowError("Uma ação selecionada não está mais disponível. Atualize os parâmetros da ferramenta.");
        out.push(...toolkit.filter((tool) => !selected || selected.includes(tool.name)).map((tool) => ({ ...tool, call: (args: unknown) => withToolCredential(credentialId, b.credential, () => tool.call(args)) }))); continue; }
      if (b.name === "executar_fluxo" && params.flowId !== undefined) {
        if (!params.flowId) throw new FlowError("Selecione um fluxo nos parâmetros de Agent as a Tool.");
        out.push({ name: b.name, description: params.description || b.description, schema: { type: "object", properties: { entrada: { type: "string" } }, required: ["entrada"] }, call: async (args) => {
          return b.call({ entrada: (args as { entrada?: string })?.entrada || "", fluxo: params.flowId });
        } }); continue;
      }
      if (b.name === "replicate") {
        const key = withToolCredential(credentialId, b.credential, () => getConfig("REPLICATE_API_TOKEN"));
        if (!key) throw new FlowError("Selecione a credencial da Replicate nos parâmetros da ferramenta.");
        const { replicateAgentTool } = await import("./replicate-tool");
        out.push(await replicateAgentTool(params, key)); continue;
      }
      if (b.name === "data_hora" && params.timezone) {
        try { new Intl.DateTimeFormat("pt-BR", { timeZone: params.timezone }); } catch { throw new FlowError("Confira o fuso horário da ferramenta."); }
        out.push({ name: b.name, description: b.description, schema: b.schema, call: async () => { const now = new Date(); return JSON.stringify({ iso: now.toISOString(), local: now.toLocaleString("pt-BR", { timeZone: params.timezone }), fuso: params.timezone }); } }); continue;
      }
      out.push({ name: b.name, description: b.description, schema: b.schema, call: (args) => withToolCredential(credentialId, b.credential, () => b.call((args || {}) as Record<string, unknown>)) });
      continue;
    }
    const [, prefix, ...rest] = id.split(":");
    byServer.set(prefix, [...(byServer.get(prefix) || []), rest.join(":")]);
  }
  for (const [prefix, names] of byServer) {
    const c = await conexaoMCP(prefix).catch(() => undefined);
    if (!c) throw new FlowError("Um servidor de ferramentas do bloco não está conectado. Confira as credenciais no Agente.");
    const conn = conectar(c.url, c.token);
    const remote = await listarFerramentas(conn);
    for (const name of names) {
      const t = remote.find((r) => r.nome === name);
      if (!t) throw new FlowError(`A ferramenta “${name}” não está disponível. Confira os nomes.`);
      out.push({
        name: t.nome,
        description: t.descricao || t.nome,
        schema: t.schema || { type: "object", properties: {} },
        call: async (args) => {
          const result = await chamar(conn, t.nome, (args || {}) as Record<string, unknown>);
          return (typeof result === "string" ? result : JSON.stringify(result)).slice(0, 30000);
        },
      });
    }
  }
  const seen = new Set<string>();
  return out.map((t, index) => {
    const base = t.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 55) || "tool";
    let name = base, suffix = index;
    while (seen.has(name)) name = `${base}_${suffix++}`;
    seen.add(name);
    return { ...t, name };
  });
}
export async function callTool(id: string, args: unknown) {
  const resolved = await resolveTools([id]);
  if (resolved.length > 1) throw new FlowError("Use este conjunto de ferramentas em um bloco Agente.");
  const [tool] = resolved;
  if (!tool) throw new FlowError("Escolha a ferramenta a executar.");
  return tool.call(args);
}
