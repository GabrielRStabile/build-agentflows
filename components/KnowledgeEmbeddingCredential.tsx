"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { SavedToolCredential } from "@/lib/tool-credential-store";
import type { IndexConfig } from "@/lib/knowledge-types";
import {
  embeddingCredentialProvider,
  embeddingCredentialUrl,
} from "@/lib/embedding-credentials";
import { formatCredentialExpiry } from "@/lib/credential-expiry";
import { Icon, request } from "./StudioUI";
import { ToolCredentialDialog } from "./ToolCredentialDialog";
export function KnowledgeEmbeddingCredential({
  embedding,
  onChange,
}: {
  embedding: IndexConfig["embeddings"];
  onChange: (value: Partial<IndexConfig["embeddings"]>) => void;
}) {
  const [items, setItems] = useState<SavedToolCredential[]>([]);
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const provider = embeddingCredentialProvider(embedding.provider);
  useEffect(() => {
    let active = true;
    void request<SavedToolCredential[]>(
      `/api/tool-credentials?provider=${provider}`,
    )
      .then((data) => {
        if (!active) return;
        setItems(data);
        // Base sem credencial escolhida: a compartilhada do ambiente entra como padrão, trocável a qualquer momento.
        const shared = data.find((c) => c.readOnly);
        if (shared && !embedding.credentialId && !embedding.configured) onChange({ credentialId: shared.id, configured: true, apiKey: "", url: shared.fields.find((f) => f.chave === embeddingCredentialUrl(embedding.provider))?.valor || embedding.url });
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // Só a troca de provedor recarrega a lista; a seleção inicial lê a configuração daquele momento.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);
  const selected = items.find((c) => c.id === embedding.credentialId);
  const endpoint = (c: SavedToolCredential) =>
    c.fields.find((f) => f.chave === embeddingCredentialUrl(embedding.provider))
      ?.valor || embedding.url;
  function choose(c?: SavedToolCredential) {
    onChange({
      credentialId: c?.id,
      configured: !!c,
      apiKey: "",
      url: c ? endpoint(c) : embedding.url,
    });
    setError("");
  }
  return (
    <div className="tool-credential-fields">
      <div className="credential-select-row">
        <label>
          Credencial
          <select
            aria-label="Credencial de embedding"
            required={embedding.provider !== "ollama"}
            disabled={loading}
            value={embedding.credentialId || ""}
            onChange={(e) => {
              if (e.target.value === "new") setEditor("new");
              else choose(items.find((c) => c.id === e.target.value));
            }}
          >
            <option value="" disabled={embedding.provider !== "ollama"}>
              {loading
                ? "Carregando credenciais…"
                : embedding.provider === "ollama"
                  ? "Sem autenticação"
                  : "Selecionar credencial"}
            </option>
            {items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {embedding.credentialId && !selected && (
              <option value={embedding.credentialId}>
                Credencial indisponível
              </option>
            )}
            <option value="new">+ Criar nova credencial</option>
          </select>
        </label>
        {selected && !selected.readOnly && (
          <button
            type="button"
            className="studio-icon-button"
            aria-label="Editar credencial de embedding"
            onClick={() => setEditor("edit")}
          >
            <Icon name="pencil" size={18} />
          </button>
        )}
      </div>
      <small>
        {selected?.expiresAt
          ? `Credencial gratuita, válida até ${formatCredentialExpiry(selected.expiresAt)}. Depois disso, cadastre sua própria chave. `
          : ""}
        Conexões compartilhadas em <Link href="/credenciais">Credenciais</Link>.
      </small>
      {selected && endpoint(selected) !== embedding.url && (
        <button
          type="button"
          className="studio-button"
          onClick={() => choose(selected)}
        >
          Aplicar endereço atualizado
        </button>
      )}
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
      {!loading && embedding.credentialId && !selected && (
        <p className="studio-error">
          Escolha uma credencial disponível para este provedor.
        </p>
      )}
      {editor && (
        <ToolCredentialDialog
          provider={provider}
          credential={editor === "edit" ? selected : undefined}
          onClose={() => setEditor(null)}
          onSaved={(c) => {
            setItems((all) => [...all.filter((item) => item.id !== c.id), c]);
            choose(c);
            setEditor(null);
          }}
        />
      )}
    </div>
  );
}
