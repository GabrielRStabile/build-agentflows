"use client";
import { useEffect, useState } from "react";
import type { Flow } from "@/lib/flow-types";
import { EmbedSettings } from "./EmbedSettings";
import { Icon, Modal, request } from "./StudioUI";
const TABS = [
  ["whatsapp", "WhatsApp"],
  ["calls", "Ligações"],
  ["dev", "cURL"],
  ["mcp", "Conector MCP"],
] as const;
type Tab = "embed" | (typeof TABS)[number][0];
type DevLanguage = "curl" | "javascript" | "python";
type CampoStatus = {
  chave: string;
  rotulo: string;
  tipo: "text" | "secret" | "select";
  opcional?: boolean;
  ajuda?: string;
  mascarado: string | null;
  valor?: string;
};
type Channels = {
  whatsapp: { provedor: string | null; configurado: boolean; fluxo: string | null };
  elevenlabs: { configurado: boolean };
  ligacao: { configurada: boolean; fluxo: string | null; campos: CampoStatus[]; aviso: string };
};
// Diálogo de implantação: canais, código de acesso e um exemplo por
// linguagem para chamar a configuração salva do fluxo.
export function IntegrationDialog({
  flow,
  onClose,
}: {
  flow: Flow;
  onClose: () => void;
}) {
  const [devLanguage, setDevLanguage] = useState<DevLanguage>("curl");
  const [access, setAccess] = useState<{
      ativo: boolean;
      mascarado: string | null;
    } | null>(null),
    [code, setCode] = useState(""),
    [origin, setOrigin] = useState(""),
    [tab, setTab] = useState<Tab>("embed"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(""),
    [channels, setChannels] = useState<Channels | null>(null),
    [flows, setFlows] = useState<Flow[]>([]),
    [drafts, setDrafts] = useState<Record<string, string>>({}),
    [phone, setPhone] = useState(""),
    [called, setCalled] = useState("");
  const loadChannels = () =>
    Promise.all([request<Channels>("/api/conexoes"), request<Flow[]>("/api/flows")])
      .then(([c, f]) => {
        setChannels(c);
        setFlows(f);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void request<{ ativo: boolean; mascarado: string | null }>("/api/mcp/token")
      .then(setAccess)
      .catch((e) => setError(e.message));
    void loadChannels();
    const timer = setTimeout(() => setOrigin(location.origin), 0);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(""), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível concluir.");
    } finally {
      setBusy(false);
    }
  }
  const url = `${origin}/webhook/flows/${flow.id}`,
    bearer = code || "SUA_CHAVE_DE_ACESSO";
  type CodeTab = DevLanguage | "mcp";
  const codeTab: CodeTab = tab === "mcp" ? "mcp" : devLanguage;
  const snippets: Record<CodeTab, string> = {
    curl: `curl -X POST '${url}' \\
  -H 'Authorization: Bearer ${bearer}' \\
  -H 'Content-Type: application/json' \\
  -d '{"input":"Sua mensagem"}'`,
    javascript: `const resposta = await fetch("${url}", {
  method: "POST",
  headers: {
    Authorization: "Bearer ${bearer}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ input: "Sua mensagem" }),
});
const { id, queued } = await resposta.json();
// Consulte depois: GET ${url}?runId=ID_RECEBIDO
// Envie o mesmo cabeçalho Authorization.`,
    python: `import requests

resposta = requests.post(
    "${url}",
    headers={"Authorization": "Bearer ${bearer}"},
    json={"input": "Sua mensagem"},
    timeout=180,
)
dados = resposta.json()
print(dados["id"], dados["queued"])
# Consulte depois: GET ${url}?runId=ID_RECEBIDO
# Envie o mesmo cabeçalho Authorization.`,
    mcp: JSON.stringify(
      {
        mcpServers: {
          agentflows: {
            url: `${origin}/mcp`,
            headers: { Authorization: `Bearer ${bearer}` },
          },
        },
      },
      null,
      2,
    ),
  };
  async function copy(text: string, key: string) {
    setError(""); setCopied("");
    try { await navigator.clipboard.writeText(text); setCopied(key); }
    catch { setError("Não foi possível copiar. Selecione o código e copie manualmente."); }
  }
  async function saveChannel(campos: Record<string, string | null>) {
    await act(async () => {
      await request("/api/conexoes", "PUT", { campos });
      setDrafts({});
      await loadChannels();
    });
  }
  const flowName = (id: string | null) =>
    id ? flows.find((f) => f.id === id)?.name || "(fluxo removido)" : null;
  const publishHint = !flow.published && (
    <p className="generator-warning">
      Salve o fluxo no editor para usar este canal.
    </p>
  );
  const accessControls = (
    <section className="integration-section integration-access">
            <h3>Chave de acesso</h3>
            <p>
              A chave autentica chamadas HTTP e assistentes conectados. Ela dá
              acesso aos fluxos publicados, ao histórico de execuções e às
              aprovações da sua conta; compartilhe somente com sistemas autorizados.
            </p>
            {code ? (
              <div className="generated-code">
                <code>{code}</code>
                <button
                  className="studio-button"
                  onClick={() => copy(code, "code")}
                >
                  {copied === "code" ? "Copiado" : "Copiar chave"}
                </button>
              </div>
            ) : (
              <p>
                {access?.ativo
                  ? "Chave ativa: " + access.mascarado
                  : "Nenhuma chave de acesso ativa."}
              </p>
            )}
            <div className="studio-actions">
              <button
                className="studio-button"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const b = await request<{ codigo: string }>(
                      "/api/mcp/token",
                      "POST",
                    );
                    setCode(b.codigo);
                    setAccess({ ativo: true, mascarado: null });
                  })
                }
              >
                {access?.ativo ? "Gerar nova chave" : "Gerar chave"}
              </button>
              {access?.ativo && (
                <button
                  className="studio-button danger"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await request("/api/mcp/token", "DELETE");
                      setCode("");
                      setAccess({ ativo: false, mascarado: null });
                    })
                  }
                >
                  Revogar chave
                </button>
              )}
            </div>
          </section>
  );
  return (
    <Modal label="Implantar Fluxo Agêntico" onClose={onClose} wide>
      <div className="dialog-tabs">
        <button className={tab === "embed" ? "active" : ""} onClick={() => setTab("embed")}>Chat no site</button>
        <button className={tab !== "embed" ? "active" : ""} onClick={() => setTab("whatsapp")}>Integrações</button>
      </div>
      {tab !== "embed" && <nav className="integration-options" aria-label="Tipos de integração">
        {TABS.map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}
      </nav>}
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
      {tab === "embed" ? <EmbedSettings flowId={flow.id} published={!!flow.published} origin={origin}/> : tab === "whatsapp" ? (
        <section className="integration-section">
          <h3>Responder no WhatsApp</h3>
          {!channels ? (
            <p>Consultando conexões…</p>
          ) : !channels.whatsapp.configurado ? (
            <p>
              Conecte o número em{" "}
              <a href="/configuracoes" target="_blank" rel="noreferrer">
                Configurações › WhatsApp
              </a>{" "}
              e volte aqui para vincular este fluxo.
            </p>
          ) : (
            <>
              <p>
                Mensagens recebidas no número conectado executam o fluxo vinculado e a
                resposta volta pelo mesmo número. Um fluxo por número.
              </p>
              <p className="connection-note">
                {channels.whatsapp.fluxo === flow.id
                  ? "Este fluxo está vinculado ao WhatsApp."
                  : channels.whatsapp.fluxo
                    ? `Hoje o número responde com “${flowName(channels.whatsapp.fluxo)}”.`
                    : "Nenhum fluxo vinculado ainda."}
              </p>
              {publishHint}
              <div className="studio-actions">
                {channels.whatsapp.fluxo === flow.id ? (
                  <button
                    className="studio-button danger"
                    disabled={busy}
                    onClick={() => saveChannel({ WHATSAPP_FLOW_ID: null })}
                  >
                    Desvincular do WhatsApp
                  </button>
                ) : (
                  <button
                    className="studio-button primary"
                    disabled={busy || !flow.published}
                    onClick={() => saveChannel({ WHATSAPP_FLOW_ID: flow.id })}
                  >
                    <Icon name="whatsapp" size={16} />
                    Vincular este fluxo ao WhatsApp
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      ) : tab === "calls" ? (
        <section className="integration-section">
          <h3>Ligações por voz</h3>
          {!channels ? (
            <p>Consultando conexões…</p>
          ) : !channels.elevenlabs.configurado ? (
            <p>
              Salve a chave da ElevenLabs em{" "}
              <a href="/configuracoes" target="_blank" rel="noreferrer">
                Configurações › ElevenLabs
              </a>{" "}
              para habilitar ligações.
            </p>
          ) : (
            <>
              <p>
                Um agente de conversa da ElevenLabs atende e faz ligações. Ao fim de cada
                ligação, o fluxo vinculado recebe a transcrição para registrar, classificar
                ou dar sequência (por exemplo, enviar um WhatsApp).
              </p>
              <div className="node-fields">
                {channels.ligacao.campos.map((c) => (
                  <label key={c.chave}>
                    {c.rotulo}
                    <input
                      type={c.tipo === "secret" ? "password" : "text"}
                      autoComplete="off"
                      value={drafts[c.chave] ?? (c.tipo === "secret" ? "" : c.valor || "")}
                      placeholder={c.tipo === "secret" ? c.mascarado || "" : ""}
                      onChange={(e) => setDrafts({ ...drafts, [c.chave]: e.target.value })}
                    />
                    {c.ajuda && <small>{c.ajuda}</small>}
                  </label>
                ))}
              </div>
              <div className="connection-hint">
                <strong>Endereço do aviso de fim de ligação</strong>
                <code>{channels.ligacao.aviso}</code>
                <div className="studio-actions">
                  <button
                    className="studio-button subtle"
                    onClick={() => copy(channels.ligacao.aviso, "aviso")}
                  >
                    <Icon name="copy" size={15} />
                    {copied === "aviso" ? "Copiado" : "Copiar endereço"}
                  </button>
                </div>
                <small>
                  Cole em Conversational AI › Settings › Post-call webhook e copie o segredo
                  gerado lá para o campo acima.
                </small>
              </div>
              <p className="connection-note">
                {channels.ligacao.fluxo === flow.id
                  ? "Este fluxo recebe as transcrições das ligações."
                  : channels.ligacao.fluxo
                    ? `Hoje as transcrições vão para “${flowName(channels.ligacao.fluxo)}”.`
                    : "Nenhum fluxo recebe as transcrições ainda."}
              </p>
              {publishHint}
              <div className="studio-actions">
                <button
                  className="studio-button"
                  disabled={busy || !Object.keys(drafts).length}
                  onClick={() =>
                    saveChannel(
                      Object.fromEntries(
                        Object.entries(drafts).map(([k, v]) => [k, v === "" ? null : v]),
                      ),
                    )
                  }
                >
                  Salvar dados da ligação
                </button>
                {channels.ligacao.fluxo === flow.id ? (
                  <button
                    className="studio-button danger"
                    disabled={busy}
                    onClick={() => saveChannel({ ELEVENLABS_FLOW_ID: null })}
                  >
                    Desvincular das ligações
                  </button>
                ) : (
                  <button
                    className="studio-button primary"
                    disabled={busy || !flow.published}
                    onClick={() => saveChannel({ ELEVENLABS_FLOW_ID: flow.id })}
                  >
                    <Icon name="call" size={16} />
                    Vincular este fluxo às ligações
                  </button>
                )}
              </div>
              {channels.ligacao.configurada && (
                <div className="integration-call-test">
                  <strong>Ligar agora (prospecção ativa)</strong>
                  <div className="studio-actions">
                    <input
                      type="tel"
                      placeholder="+55 11 99999-0000"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                    <button
                      className="studio-button primary"
                      disabled={busy || phone.replace(/\D/g, "").length < 10}
                      onClick={() =>
                        act(async () => {
                          const r = await request<{ conversationId?: string }>(
                            "/api/voz/ligar",
                            "POST",
                            { telefone: phone, contexto: `Ligação iniciada a partir do fluxo “${flow.name}”.` },
                          );
                          setCalled(
                            r.conversationId
                              ? `Ligação iniciada (conversa ${r.conversationId}).`
                              : "Ligação iniciada.",
                          );
                        })
                      }
                    >
                      <Icon name="call" size={15} />
                      Ligar
                    </button>
                  </div>
                  {called && <p className="connection-result ok">{called}</p>}
                </div>
              )}
            </>
          )}
        </section>
      ) : (
        <>
        <section className="integration-section">
          <div className="integration-code-title">
            <h3>
              {tab === "mcp"
                ? "Conecte seu assistente"
                : "Execute seu fluxo"}
            </h3>
            <button
              className="studio-button subtle"
              disabled={!code}
              onClick={() => copy(snippets[codeTab], codeTab)}
            >
              <Icon name="copy" size={16} />
              {copied === codeTab ? "Copiado" : "Copiar"}
            </button>
          </div>
          <p>
            {tab === "mcp"
              ? "Cole esta configuração no cliente MCP do seu assistente. Ele passa a listar seus fluxos publicados, enfileirar execuções, consultar resultados e responder aprovações."
              : "O POST retorna HTTP 202 com id e queued. Consulte o resultado com GET neste mesmo endereço, adicionando ?runId=ID_RECEBIDO e o mesmo Bearer. Enquanto queued for true, a tarefa aguarda na fila; waiting indica aprovação pendente."}
          </p>
          {tab === "dev" && <label className="integration-language">
            Linguagem
            <select value={devLanguage} onChange={(event) => setDevLanguage(event.target.value as DevLanguage)}>
              <option value="curl">cURL</option>
              <option value="javascript">JavaScript</option>
              <option value="python">Python</option>
            </select>
          </label>}
          <pre className="integration-code">{snippets[codeTab]}</pre>
          {!flow.published && (
            <p className="generator-warning">
              Salve o fluxo no editor antes de usar este exemplo.
            </p>
          )}
        </section>
        {accessControls}
        </>
      )}
    </Modal>
  );
}
