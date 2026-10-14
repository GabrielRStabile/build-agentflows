"use client";
import { useCallback, useEffect, useState } from "react";
import type { SavedToolCredential } from "@/lib/tool-credential-store";
import { CREDENTIAL_CATALOG } from "@/lib/tool-presentation";
import { formatCredentialExpiry } from "@/lib/credential-expiry";
import { ToolLogo } from "./ToolSelect";
import { Icon, IconButton, Modal, request } from "./StudioUI";
import { ToolCredentialDialog } from "./ToolCredentialDialog";

export function ToolCredentialsManager() {
  const [items, setItems] = useState<SavedToolCredential[]>([]), [loading, setLoading] = useState(true);
  const [error, setError] = useState(""), [query, setQuery] = useState("");
  const [editor, setEditor] = useState<SavedToolCredential | "new" | null>(null);
  const [removing, setRemoving] = useState<SavedToolCredential | null>(null), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setItems(await request<SavedToolCredential[]>("/api/tool-credentials")); }
    catch (e) { setError(e instanceof Error ? e.message : "Não foi possível carregar as credenciais."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const timer = setTimeout(() => {
      void load().then(() => { if (query.has("erro")) setError(query.get("erro") || ""); });
      if (query.has("erro") || query.has("conectado")) history.replaceState(null, "", "/credenciais");
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);
  async function remove() {
    if (!removing) return;
    setBusy(true); setError("");
    try { await request(`/api/tool-credentials/${encodeURIComponent(removing.id)}`, "DELETE"); setItems((all) => all.filter((c) => c.id !== removing.id)); setRemoving(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Não foi possível excluir a credencial."); }
    finally { setBusy(false); }
  }
  const toolFor = (c: SavedToolCredential) => CREDENTIAL_CATALOG.find((tool) => tool.provider === c.provider);
  const shown = items.filter((c) => `${c.name} ${c.providerLabel} ${toolFor(c)?.name || ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <section className="tool-credentials-manager" id="credenciais">
    <div className="settings-section-heading"><Icon name="link" size={18} /><div><h2>Modelos, ferramentas e embeddings</h2><p>Guarde suas conexões e reutilize-as nos agentes e nas bases de conhecimento.</p></div></div>
    <div className="credential-manager-card">
      <div className="credential-manager-toolbar"><label>Buscar conexão<input type="search" value={query} placeholder="Nome ou serviço" onChange={(e) => setQuery(e.target.value)} /></label><button type="button" className="studio-button" onClick={() => setEditor("new")}><Icon name="plus" size={16} />Nova credencial</button></div>
      {loading && <p role="status">Carregando conexões…</p>}
      {!loading && !items.length && <p>Nenhuma credencial salva. Você também pode criar uma ao adicionar um modelo ou uma ferramenta no bloco.</p>}
      {!!items.length && !shown.length && <p>Nenhuma conexão encontrada para essa busca.</p>}
      {shown.map((c) => <div className="credential-manager-row" key={c.id}><div className="credential-manager-identity"><ToolLogo id={toolFor(c)?.id || `interno:${c.provider}`} /><div><strong>{c.name}</strong><small>{toolFor(c)?.name || c.providerLabel} · {c.expiresAt ? `Gratuita até ${formatCredentialExpiry(c.expiresAt)}` : c.configured ? "Credencial salva" : "Revisar conexão"}</small></div></div><div className="studio-actions">
        {!c.readOnly && <><IconButton icon="pencil" label={`Editar credencial ${c.name}`} onClick={() => setEditor(c)} /><IconButton icon="trash" label={`Excluir credencial ${c.name}`} onClick={() => { setError(""); setRemoving(c); }} /></>}
      </div></div>)}
      {error && !removing && <div role="alert"><p className="studio-error">{error}</p><button type="button" className="tool-text-button" onClick={() => void load()}>Tentar novamente</button></div>}
    </div>
    {editor && <ToolCredentialDialog credential={editor === "new" ? undefined : editor} onClose={() => setEditor(null)} onSaved={(c) => { setItems((all) => [...all.filter((o) => o.id !== c.id), c]); setEditor(null); }} />}
    {removing && <Modal title="Excluir credencial" onClose={() => { if (!busy) setRemoving(null); }}>
      <p>Excluir a conexão “{removing.name}”? Conexões em uso por agentes ou bases de conhecimento precisam ser desvinculadas primeiro.</p>
      {error && <p className="studio-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="studio-button" disabled={busy} onClick={() => setRemoving(null)}>Cancelar</button><button type="button" className="studio-button destructive" disabled={busy} onClick={() => void remove()}>{busy ? "Excluindo…" : "Excluir credencial"}</button></div>
    </Modal>}
  </section>;
}
