import { AI_CREDENTIAL_CATALOG } from "./ai-providers";
import { EMBEDDING_CREDENTIAL_CATALOG } from "./embedding-credentials";
// Catálogo visível no editor. IDs antigos continuam executáveis para preservar fluxos salvos.
export const AGENT_TOOL_CATALOG = [
  { id: "interno:executar_fluxo", name: "Agent as a Tool", icon: "/tool-icons/executar_fluxo.svg" },
  { id: "interno:arxiv", name: "Arxiv", icon: "/tool-icons/arxiv.png" },
  { id: "interno:brave", name: "BraveSearch", icon: "/tool-icons/brave.svg" },
  { id: "interno:brave_mcp", name: "Brave Search MCP", icon: "/tool-icons/brave_mcp.svg" },
  { id: "interno:browserless", name: "Browserless MCP", icon: "/tool-icons/browserless.svg" },
  { id: "interno:calculadora", name: "Calculator", icon: "/tool-icons/calculadora.svg" },
  { id: "interno:e2b", name: "Code Interpreter by E2B", icon: "/tool-icons/e2b.png" },
  { id: "interno:composio", name: "Composio", icon: "/tool-icons/composio.svg" },
  { id: "interno:data_hora", name: "CurrentDateTime", icon: "/tool-icons/data_hora.svg" },
  { id: "interno:custom_mcp", name: "Custom MCP", icon: "/tool-icons/custom_mcp.png" },
  { id: "interno:exa", name: "Exa AI", icon: "/tool-icons/exa.svg" },
  { id: "interno:github_mcp", name: "Github MCP", icon: "/tool-icons/github_mcp.png" },
  { id: "interno:teams", name: "Microsoft Teams", icon: "/tool-icons/teams.svg" },
  { id: "interno:openapi", name: "OpenAPI Toolkit", icon: "/tool-icons/openapi.svg" },
  { id: "interno:postgres_mcp", name: "Postgres MCP", icon: "/tool-icons/postgres_mcp.svg" },
  { id: "interno:replicate", name: "Replicate", icon: "/provider-icons/replicate.svg" },
  { id: "interno:searchapi", name: "Search API", icon: "/tool-icons/searchapi.svg" },
  { id: "interno:tavily", name: "Tavily API", icon: "/tool-icons/tavily.svg" },
  { id: "interno:ler_pagina", name: "Web Scraper Tool", icon: "/tool-icons/ler_pagina.svg" },
  { id: "interno:wolfram", name: "WolframAlpha", icon: "/tool-icons/wolfram.png" },
].sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));
export function toolTitle(tool: { name: string; label?: string; id?: string }) {
  return AGENT_TOOL_CATALOG.find((item) => item.id === (tool.id || `interno:${tool.name}`))?.name || tool.label || tool.name;
}
const DATABASE_CREDENTIAL_CATALOG = [{ id: "credential:knowledge_postgres", provider: "knowledge_postgres", name: "Postgres · Base de Conhecimento", icon: "/knowledge-icons/vectors-postgres.svg" }];
export function toolIcon(id: string) { if (id === "chatgpt") return "/knowledge-icons/embeddings-openai.svg"; return [...AGENT_TOOL_CATALOG, ...EMBEDDING_CREDENTIAL_CATALOG, ...DATABASE_CREDENTIAL_CATALOG, ...AI_CREDENTIAL_CATALOG].find((item) => item.id === id)?.icon; }

// Uma credencial Brave atende à ferramenta HTTP e à versão MCP; Teams usa Microsoft.
const CREDENTIAL_PROVIDERS: Record<string, string> = {
  brave: "brave", brave_mcp: "brave", browserless: "browserless", e2b: "e2b", composio: "composio",
  custom_mcp: "custom_mcp", exa: "exa", github_mcp: "github_mcp", teams: "microsoft", openapi: "openapi",
  postgres_mcp: "postgres_mcp", searchapi: "searchapi", tavily: "tavily", wolfram: "wolfram",
};
export const CREDENTIAL_TOOL_CATALOG = AGENT_TOOL_CATALOG.flatMap((tool) => {
  const provider = CREDENTIAL_PROVIDERS[tool.id.split(":")[1]];
  return provider ? [{ ...tool, provider }] : [];
});

export const CREDENTIAL_CATALOG = [...CREDENTIAL_TOOL_CATALOG, ...EMBEDDING_CREDENTIAL_CATALOG, ...DATABASE_CREDENTIAL_CATALOG, ...AI_CREDENTIAL_CATALOG].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
