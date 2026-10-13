"use client";
import { useEffect, useState } from "react";
import { request, Icon, IconButton } from "./StudioUI";
import { AI_PROVIDERS, aiProvider, modelProviderId, aiCredentialProvider, type AiModel } from "@/lib/ai-providers";
import type { SavedToolCredential } from "@/lib/tool-credential-store";
import { ToolSelect } from "./ToolSelect";
import { ToolCredentialDialog } from "./ToolCredentialDialog";
import { MEDIA_PROVIDERS, mediaModel, isMediaModel, REPLICATE_PREFIX, replicateModelName } from "@/lib/media-models";
export type ChatModel = { id: string; name: string; inputModalities?: string[] };
export type RouterModel = { id: string; nome: string; provedor: string; inputModalities?: string[] };
const PREFIX = "openrouter:";
const NEW_CREDENTIAL = "__nova_credencial__";
// Nome curto de um modelo salvo no bloco, para a pílula do bloco e a lista.
export const OPENROUTER_AUTO = PREFIX + "openrouter/auto";
export function modelLabel(model?: string) {
  if (!model) return "ChatGPT";
  if (mediaModel(model)) return mediaModel(model)!.name;
  if (model === OPENROUTER_AUTO) return "OpenRouter automático";
  if (model.startsWith(PREFIX)) {
    const id = model.slice(PREFIX.length);
    return id.includes("/") ? id.split("/").slice(1).join("/") : id;
  }
  return model.includes(":") ? model.slice(model.indexOf(":") + 1) || "Selecione um modelo" : model;
}
export function modelProvider(model?: string) {
  const media = mediaModel(model);
  if (media) return MEDIA_PROVIDERS.find((provider) => provider.id === media.provider)!.name;
  return aiProvider(modelProviderId(model))?.name || "ChatGPT";
}
export function ModelPicker({ value, kind, chatModels, connected, config, onConfigChange, onConnect }: {
  value: string; kind: string; chatModels: ChatModel[]; connected: boolean; config: Record<string, string>;
  onConfigChange: (values: Record<string, string>) => void; onConnect: () => void;
}) {
  const provider = modelProviderId(value), metadata = aiProvider(provider);
  const [credentials, setCredentials] = useState<SavedToolCredential[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [editor, setEditor] = useState<SavedToolCredential | "new" | null>(null);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    let alive = true;
    void request<SavedToolCredential[]>("/api/tool-credentials").then(items => { if (alive) setCredentials(items); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  const matching = credentials.filter(c => c.provider === aiCredentialProvider(provider));
  const credentialId = config.modelCredentialId || "";
  useEffect(() => {
    // Replicate has no listed catalogue: the LLM block names any owner/model directly.
    if (provider === "chatgpt" || provider === "replicate") return;
    let alive = true;
    const timer = setTimeout(() => {
      setLoading(true); setError(""); setModels([]);
      const query = new URLSearchParams({ provider, ...(credentialId ? { credentialId } : {}) });
      void request<{ models: AiModel[] }>(`/api/conexoes/provedores?${query}`)
        .then(result => { if (alive) setModels(result.models); })
        .catch(e => { if (alive) setError(e.message); })
        .finally(() => { if (alive) setLoading(false); });
    }, 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [provider, credentialId, retry]);
  const selected = models.find(m => m.id === value);
  const selectedCredential = matching.find(c => c.id === credentialId);
  // Agents call tools in a text loop; Replicate generation models belong to the LLM block. Saved agents keep their choice.
  const catalog = [{ id: "chatgpt", name: "ChatGPT · assinatura" }, ...AI_PROVIDERS.filter(p => kind !== "agent" || p.id !== "replicate" || provider === "replicate").map(p => ({ id: `credential:ai_${p.id}`, name: p.name }))];
  function saved(c: SavedToolCredential) {
    setCredentials(items => [...items.filter(i => i.id !== c.id), c]); setEditor(null);
    onConfigChange({ modelCredentialId: c.id }); setRetry(n => n + 1);
  }
  return <div className="model-picker provider-picker">
    <ToolSelect label="Fornecedor" listLabel="Fornecedores de IA" value={provider === "chatgpt" ? "chatgpt" : `credential:ai_${provider}`} catalog={catalog}
      onChange={id => {
        const next = id === "chatgpt" ? "chatgpt" : id.replace("credential:ai_", "");
        const firstCredential = credentials.find(c => c.provider === aiCredentialProvider(next));
        onConfigChange({ model: next === "chatgpt" ? "" : next === "openrouter" ? OPENROUTER_AUTO : `${next}:`, modelCredentialId: firstCredential?.id || "", modelTemperature: "", modelMaxTokens: "" });
        setModels([]); setExpanded(true);
      }} />
    <section className="provider-parameters">
      <button type="button" className="provider-parameters-heading" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <Icon name="settings" size={18} /><span>Parâmetros de {metadata?.name || "ChatGPT"}</span><Icon name="chevron" size={16} />
      </button>
      {expanded && <div className="node-fields provider-parameters-body">
        {provider === "chatgpt" ? <>
          <div className="provider-credential-row"><span>{connected ? "Assinatura ChatGPT conectada" : "Conecte sua assinatura ChatGPT"}</span><button type="button" className="studio-button" onClick={onConnect}>{connected ? "Gerenciar" : "Conectar"}</button></div>
          <label>Modelo<select aria-label="Modelo de IA" value={value} onChange={e => onConfigChange({ model: e.target.value })}>
            <option value="">Padrão da conexão ChatGPT</option>
            {chatModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            {value && !chatModels.some(m => m.id === value) && <option value={value}>{value} · modelo salvo</option>}
          </select></label>
        </> : <>
          <label>Credencial<div className="provider-credential-row">
            {/* The last option is an action: it opens the dialog and the controlled value stays unchanged. */}
            <select aria-label="Credencial do modelo" value={credentialId} onChange={e => e.target.value === NEW_CREDENTIAL ? setEditor("new") : onConfigChange({ modelCredentialId: e.target.value })}>
              <option value="">{matching.length ? "Conexão padrão (fluxos existentes)" : "Selecione ou conecte uma credencial"}</option>
              {matching.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              {credentialId && !selectedCredential && <option value={credentialId}>Credencial indisponível</option>}
              <option value={NEW_CREDENTIAL}>+ Conectar nova credencial…</option>
            </select>
            {selectedCredential && <IconButton icon="pencil" label="Editar credencial do modelo" onClick={() => setEditor(selectedCredential)} />}
          </div></label>
          {provider === "replicate" ? <label>Modelo da Replicate<input aria-label="Modelo da Replicate" placeholder="empresa/modelo" spellCheck={false} autoCapitalize="none" value={replicateModelName(value) || ""}
              onChange={e => onConfigChange({ model: REPLICATE_PREFIX + e.target.value.trim().toLowerCase(), modelTemperature: "", modelMaxTokens: "" })} />
            <small>Use o nome exibido na Replicate, como google/nano-banana. O resultado pode ser texto, imagens ou um vídeo, conforme o modelo. <a href="https://replicate.com/explore" target="_blank" rel="noreferrer">Explorar modelos</a></small>
          </label> : loading ? <small role="status">Carregando modelos…</small> : <>
            <ToolSelect label="Modelo de IA" listLabel="Modelos de IA" value={value} catalog={models} icon={<Icon name="spark" size={18} />} emptyMessage="Nenhum modelo disponível. Conecte uma credencial e tente novamente." missingLabel={modelLabel(value)}
              onChange={model => onConfigChange({ model, modelTemperature: "", modelMaxTokens: "" })} />
            {!!models.length && <small>{models.length} modelos disponíveis{selected?.contextLength ? ` · contexto de ${selected.contextLength.toLocaleString("pt-BR")} tokens` : ""}{selected?.inputModalities.includes("image") ? " · aceita imagens" : ""}</small>}
          </>}
          {error && <div role="alert"><p className="studio-error">{error}</p><button type="button" className="tool-text-button" onClick={() => setRetry(n => n + 1)}>Tentar novamente</button></div>}
          {selected?.parameters.includes("temperature") && <label>Temperatura<input aria-label="Temperatura" type="number" min="0" max={provider === "anthropic" ? "1" : "2"} step="0.1" placeholder="Padrão do modelo" value={config.modelTemperature || ""} onChange={e => onConfigChange({ modelTemperature: e.target.value })} /></label>}
          {selected?.parameters.includes("max_tokens") && <label>Máximo de tokens de saída<input aria-label="Máximo de tokens de saída" type="number" min="1" max={selected.maxOutputTokens || 1000000} step="1" placeholder="4000" value={config.modelMaxTokens || ""} onChange={e => onConfigChange({ modelMaxTokens: e.target.value })} /></label>}
          {isMediaModel(value) && provider !== "replicate" && <small>Gera imagens com o saldo do fornecedor. {mediaModel(value)?.inputModalities.includes("image") ? "Aceita até 5 referências e 6 MB no total." : "Recebe descrições em texto."}</small>}
        </>}
        <a className="tool-text-button" href="/credenciais" target="_blank" rel="noreferrer">Gerenciar todas as credenciais</a>
      </div>}
    </section>
    {editor && <ToolCredentialDialog provider={aiCredentialProvider(provider)} credential={editor === "new" ? undefined : editor} onClose={() => setEditor(null)} onSaved={saved} />}
  </div>;
}
