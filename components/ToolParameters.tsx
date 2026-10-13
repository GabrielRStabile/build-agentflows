"use client";
import { useEffect, useRef, useState } from "react";
import type { ToolInfo } from "@/lib/tools";
import type { ToolCard } from "@/lib/agent-tools";
import type { SavedToolCredential } from "@/lib/tool-credential-store";
import { ToolCredentialFields } from "./ToolCredentialFields";
import { Icon, request } from "./StudioUI";
import { REPLICATE_MODEL } from "@/lib/media-models";
export const ACTION_TOOLS = ["brave_mcp", "browserless", "postgres_mcp", "github_mcp", "custom_mcp", "composio", "openapi"];
type Option = { id: string; name: string; description?: string };
export function ToolParameters({ tool, card, credentials, onChange, onSaved }: {
  tool: ToolInfo; card: ToolCard; credentials: SavedToolCredential[]; onChange: (patch: Partial<ToolCard>) => void; onSaved: (credential: SavedToolCredential) => void;
}) {
  const params = card.params || {};
  const [flows, setFlows] = useState<Option[]>([]), [apps, setApps] = useState<Option[]>([]), [accounts, setAccounts] = useState<Option[]>([]), [actions, setActions] = useState<Option[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [query, setQuery] = useState("");
  const generation = useRef(0);
  const connection = card.credentialId;
  useEffect(() => {
    const timer = setTimeout(() => {
      if (tool.name === "executar_fluxo") request<(Option & { published?: unknown })[]>("/api/flows").then((all) => setFlows(all.filter((flow) => !!flow.published))).catch(() => setError("Não foi possível carregar os fluxos."));
    }, 0);
    const invalidate = () => { generation.current++; };
    return () => { clearTimeout(timer); invalidate(); };
  }, [tool.name, connection, params.app]);
  function change(key: string, value: string) { onChange({ params: { ...params, [key]: value } }); }
  async function load(kind: "apps" | "accounts" | "actions") {
    const current = ++generation.current;
    setBusy(true); setError("");
    try {
      const result = await request<Option[]>("/api/tools/options", "POST", { tool: tool.id, credentialId: connection, params, kind });
      if (current === generation.current) { if (kind === "apps") setApps(result); else if (kind === "accounts") setAccounts(result); else setActions(result); }
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : "Não foi possível carregar as opções."); }
    finally { if (current === generation.current) setBusy(false); }
  }
  let selected: string[] = [];
  try { selected = JSON.parse(params.actions || "[]"); } catch {}
  const accountChanged = (id: string) => { generation.current++; setBusy(false); setApps([]); setAccounts([]); setActions([]); onChange({ credentialId: id, params: { ...params, ...(ACTION_TOOLS.includes(tool.name) ? { actions: "[]", connectedAccountId: "" } : {}) } }); };
  return <div className="tool-parameters-fields">
    <ToolCredentialFields tool={tool} credentialId={card.credentialId} credentials={credentials} onChange={accountChanged} onSaved={onSaved} />
    {tool.name === "executar_fluxo" && <>
      <label>Fluxo Agêntico<select value={params.flowId || ""} onChange={(event) => change("flowId", event.target.value)}><option value="">Selecione um fluxo publicado</option>{flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}</option>)}{params.flowId && !flows.some((flow) => flow.id === params.flowId) && <option value={params.flowId}>Fluxo indisponível</option>}</select></label>
      <label>Descrição<textarea rows={2} placeholder="Quando o agente deve usar este fluxo?" value={params.description || ""} onChange={(event) => change("description", event.target.value)} /></label>
    </>}
    {tool.name === "replicate" && <ReplicateModelField credentialId={connection} params={params} onChange={(model) => onChange({ params: { ...params, model } })} onDescription={(description) => change("description", description)} />}
    {tool.name === "data_hora" && <label>Fuso horário<select value={params.timezone || "America/Sao_Paulo"} onChange={(event) => change("timezone", event.target.value)}>{["America/Sao_Paulo", "America/Manaus", "America/Belem", "America/Fortaleza", "America/Recife", "America/Cuiaba", "America/Rio_Branco", "America/Noronha", "Europe/Lisbon", "UTC"].map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></label>}
    {tool.name === "composio" && <>
      <label>Aplicativo<select value={params.app || ""} onChange={(event) => { generation.current++; setBusy(false); setAccounts([]); setActions([]); onChange({ params: { ...params, app: event.target.value, connectedAccountId: "", actions: "[]" } }); }}><option value="">Selecione um aplicativo</option>{apps.map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}{params.app && !apps.some((app) => app.id === params.app) && <option value={params.app}>{params.app}</option>}</select></label>
      <button className="tool-text-button" type="button" disabled={busy || !connection} onClick={() => void load("apps")}>Carregar aplicativos</button>
      {params.app && <><label>Conta conectada<select value={params.connectedAccountId || ""} onChange={(event) => change("connectedAccountId", event.target.value)}><option value="">Selecione uma conta</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}{params.connectedAccountId && !accounts.some((a) => a.id === params.connectedAccountId) && <option value={params.connectedAccountId}>{params.connectedAccountId}</option>}</select></label><button className="tool-text-button" type="button" disabled={busy || !connection} onClick={() => void load("accounts")}>Carregar contas</button></>}
    </>}
    {ACTION_TOOLS.includes(tool.name) && <div className="tool-allowed-actions">
      <div className="tool-section-heading"><span>Ações disponíveis</span><button type="button" className="tool-text-button" disabled={busy || !connection || (tool.name === "composio" && !params.app)} onClick={() => void load("actions")}>{busy ? "Carregando…" : "Atualizar"}</button></div>
      {!!actions.length && <input type="search" aria-label="Buscar ações" placeholder="Buscar ação…" value={query} onChange={(event) => setQuery(event.target.value)} />}
      <div className="tool-allowed-list">{[...actions, ...selected.filter((id) => !actions.some((action) => action.id === id)).map((id) => ({ id, name: id }))].filter((action) => action.name.toLowerCase().includes(query.toLowerCase())).map((action) => <label key={action.id}><input type="checkbox" checked={selected.includes(action.id)} onChange={(event) => change("actions", JSON.stringify(event.target.checked ? [...selected, action.id] : selected.filter((id) => id !== action.id)))} /><span>{action.name}</span></label>)}</div>
      {!actions.length && !selected.length && <small>Atualize a lista para selecionar as ações.</small>}
      {params.actions === undefined && <small>Este fluxo anterior usa todas as ações. Marque as que deseja manter.</small>}
    </div>}
    {!tool.credentialProvider && !["executar_fluxo", "data_hora", "replicate"].includes(tool.name) && <small>Não há parâmetros adicionais.</small>}
    {error && <p className="studio-error" role="alert">{error}</p>}
  </div>;
}

type ReplicateReport = { model: string; promptField?: string; imageField?: string; multipleImages: boolean };
// Reading the model is free; the feedback tells whether the agent can send reference images.
function ReplicateModelField({ credentialId, params, onChange, onDescription }: {
  credentialId?: string; params: Record<string, string>; onChange: (model: string) => void; onDescription: (value: string) => void;
}) {
  const model = params.model || "";
  const [report, setReport] = useState<ReplicateReport | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    const timer = setTimeout(() => {
      setReport(null); setError("");
      if (!model || !credentialId) return;
      if (!REPLICATE_MODEL.test(model)) { setError("Use o formato empresa/modelo, em letras minúsculas. Ex.: google/nano-banana."); return; }
      setBusy(true);
      request<ReplicateReport>("/api/tools/options", "POST", { tool: "interno:replicate", credentialId, params: { model }, kind: "model" })
        .then((result) => { if (current === generation.current) setReport(result); })
        .catch((e) => { if (current === generation.current) setError(e instanceof Error ? e.message : "Não foi possível verificar o modelo."); })
        .finally(() => { if (current === generation.current) setBusy(false); });
    }, 500);
    return () => clearTimeout(timer);
  }, [model, credentialId]);
  return <>
    <label>Modelo da Replicate<input aria-label="Modelo da Replicate" placeholder="empresa/modelo" spellCheck={false} autoCapitalize="none" value={model}
      onChange={(event) => onChange(event.target.value.trim().toLowerCase())} /></label>
    <div className="replicate-model-status" role="status" aria-live="polite">
      {!credentialId ? <small>Selecione a credencial para verificar o modelo.</small>
        : !model ? <small>Ex.: google/nano-banana-pro. <a href="https://replicate.com/explore" target="_blank" rel="noreferrer">Explorar modelos</a></small>
        : busy ? <small>Verificando o modelo…</small>
        : error ? <p className="studio-error">{error}</p>
        : report && (report.imageField
          ? <p className="replicate-model-ok"><Icon name="check" size={15} />Multimodal: recebe texto e {report.multipleImages ? "até 5 imagens" : "1 imagem"} de referência (<code>{report.imageField}</code>). O agente pode editar imagens anexadas ou geradas.</p>
          : <p className="replicate-model-text"><Icon name="info" size={15} />Recebe apenas texto. Imagens anexadas não serão enviadas a este modelo; para editar imagens, escolha um modelo multimodal, como google/nano-banana-pro.</p>)}
    </div>
    <label>Quando usar (opcional)<textarea rows={2} placeholder="Ex.: use para criar as artes dos posts." value={params.description || ""} onChange={(event) => onDescription(event.target.value)} /></label>
  </>;
}
