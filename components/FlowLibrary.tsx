"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Flow, Kind } from "@/lib/flow-types";
import { BLOCKS } from "@/lib/flow-types";
import { PRESETS, NODE_STYLE } from "@/lib/flow-presets";
import { portableGraph } from "@/lib/flow-portable";
import { Icon, IconButton, Modal, StudioShell, announcePlanLimit, request } from "./StudioUI";
import type { AccountUsage } from "@/lib/saas-plan";
import { ChatGPTConnection, useChatGPT } from "./ChatGPTConnection";
export function FlowLibrary() {
  const router = useRouter(),
    file = useRef<HTMLInputElement>(null),
    started = useRef(false);
  const [flows, setFlows] = useState<Flow[]>([]),
    [loading, setLoading] = useState(true),
    [search, setSearch] = useState(""),
    [view, setView] = useState<"grid" | "list">("grid"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [connect, setConnect] = useState(false),
    [templates, setTemplates] = useState(false),
    [notice, setNotice] = useState(""),
    [page, setPage] = useState(1),
    [perPage, setPerPage] = useState(10),
    [toDelete, setToDelete] = useState<Flow | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem("agentflows-por-pagina"));
      if ([10, 20, 50, 100].includes(saved))
        setTimeout(() => setPerPage(saved), 0);
    } catch {}
  }, []);
  const { connection, setConnection } = useChatGPT();
  const load = useCallback(async () => {
    const items = await request<Flow[]>("/api/flows");
    setFlows(items);
    return items;
  }, []);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const q = new URLSearchParams(location.search);
    if (q.has("connect")) setTimeout(() => setConnect(true), 0);
    void load()
      .then(async (items) => {
        if (q.has("exemplo")) {
          let f = items[0];
          if (!f)
            f = await request<Flow>("/api/flows", "POST", {
              name: "Triagem de atendimento",
              example: true,
            });
          router.replace(
            "/flows/" + f.id + (q.has("captura") ? "?captura=1" : ""),
          );
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [load, router]);
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
  async function create(presetId?: string) {
    // The editor only creates the flow on save: warn before any work is done. The server still enforces it.
    const usage = await request<{ usage: AccountUsage }>("/api/conta").then((a) => a.usage).catch(() => null);
    if (usage?.flows.limit != null && usage.flows.used >= usage.flows.limit) {
      announcePlanLimit(`O beta permite até ${usage.flows.limit} fluxos por conta. Exclua um fluxo ou faça parte do AI Action para ter fluxos ilimitados.`, usage.upgradeUrl);
      return;
    }
    router.push("/flows/new" + (presetId ? "?preset=" + encodeURIComponent(presetId) : ""));
  }
  async function duplicate(f: Flow) {
    await act(async () => {
      const copy = await request<Flow>("/api/flows", "POST", {
        name: f.name + " (cópia)",
      });
      await request("/api/flows/" + copy.id, "PUT", {
        ...copy,
        description: f.description,
        voiceId: f.voiceId || "",
        graph: f.graph,
      });
      await load();
      setNotice(`Fluxo duplicado como “${copy.name}”.`);
    });
  }
  function download(f: Flow) {
    const u = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              format: "build-agentflows/v1",
              name: f.name,
              description: f.description,
              voiceId: f.voiceId || "",
              graph: portableGraph(f.graph),
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const a = document.createElement("a");
    a.href = u;
    a.download = f.name.replace(/[^a-z0-9_-]/gi, "_") + ".json";
    a.click();
    URL.revokeObjectURL(u);
  }
  async function importFile(f: File) {
    await act(async () => {
      if (f.size > 300000) throw new Error("Use um arquivo de até 300 KB.");
      const b = JSON.parse(await f.text());
      if (b.format !== "build-agentflows/v1")
        throw new Error("Use um fluxo exportado pelo Build Agentflows.");
      const created = await request<Flow>("/api/flows", "POST", {
        name: b.name,
      });
      try {
        await request("/api/flows/" + created.id, "PUT", {
          name: b.name,
          description: b.description || "",
          voiceId: b.voiceId || "",
          // Arquivo genérico: vínculos de outra conta (credenciais, bases, subfluxos) são descartados.
          graph: portableGraph(b.graph),
        });
        router.push("/flows/" + created.id);
      } catch (e) {
        await request("/api/flows/" + created.id, "DELETE");
        throw e;
      }
    });
  }
  const filtered = flows.filter((f) =>
    (f.name + " " + f.description).toLowerCase().includes(search.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * perPage, current * perPage);
  function choosePerPage(n: number) {
    setPerPage(n);
    setPage(1);
    try {
      localStorage.setItem("agentflows-por-pagina", String(n));
    } catch {}
  }
  return (
    <StudioShell
      active="flows"
    >
      <main className="library-page">
        <header className="library-header">
          <div>
            <div className="studio-breadcrumb">Workspace / Fluxo Agêntico</div>
            <h1>Fluxo Agêntico</h1>
            <p>Construa e conecte seus agentes de IA.</p>
          </div>
          <div className="studio-actions">
            <button
              className="studio-button"
              disabled={busy}
              onClick={() => setTemplates(true)}
            >
              <Icon name="book" size={18} />
              Usar modelo
            </button>
            <button
              className="studio-button primary"
              disabled={busy}
              onClick={() => create()}
            >
              <Icon name="plus" size={18} />
              Novo Fluxo Agêntico
            </button>
          </div>
        </header>
        {error && (
          <div className="studio-error" role="alert">
            {error}
          </div>
        )}
        <div className="library-toolbar flow-library-toolbar">
          <label className="studio-search">
            <Icon name="search" size={18} />
            <input
              aria-label="Buscar fluxos"
              placeholder="Buscar fluxos agênticos"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <div className="view-toggle">
            <IconButton
              icon="grid"
              label="Visualizar cartões"
              active={view === "grid"}
              onClick={() => setView("grid")}
            />
            <IconButton
              icon="list"
              label="Visualizar lista"
              active={view === "list"}
              onClick={() => setView("list")}
            />
          </div>
          <button
            className="studio-button subtle"
            disabled={busy}
            onClick={() => file.current?.click()}
          >
            <Icon name="upload" size={18} />
            Importar
          </button>
          <input
            hidden
            ref={file}
            type="file"
            accept=".json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.target.value = "";
            }}
          />
        </div>
        {loading ? (
          <div className="library-loading">
            <span className="studio-spinner" /> Carregando fluxos…
          </div>
        ) : !filtered.length ? (
          <section className="library-empty">
            <div className="empty-flow-art">
              <span>
                <Icon name="start" size={23} />
              </span>
              <i />
              <span>
                <Icon name="agent" size={30} />
              </span>
              <i />
              <span>
                <Icon name="end" size={23} />
              </span>
            </div>
            <h2>
              {search
                ? "Nenhum fluxo encontrado"
                : "Seu primeiro agente começa aqui"}
            </h2>
            <p>
              {search
                ? "Tente outro nome ou limpe a busca."
                : "Conecte blocos, defina instruções e veja seu fluxo ganhar vida."}
            </p>
            <button
              className="studio-button primary"
              onClick={() => (search ? setSearch("") : setTemplates(true))}
            >
              {search ? "Limpar busca" : "Explorar modelos"}
            </button>
          </section>
        ) : (
          <div className={"flow-collection " + view}>
            {visible.map((f) => (
              <article className="flow-card" key={f.id}>
                <Link className="flow-card-link" href={"/flows/" + f.id}>
                  <div className="flow-card-top">
                    <div className="flow-card-symbol">
                      <Icon name="flows" size={22} />
                    </div>
                  </div>
                  <h2>{f.name}</h2>
                  <p>
                    {f.description ||
                      "Adicione instruções e conecte os blocos do seu fluxo."}
                  </p>
                  <div className="flow-card-nodes">
                    {[...new Set(f.graph.nodes.map((n) => n.data.kind))]
                      .slice(0, 6)
                      .map((k) => (
                        <span
                          key={k}
                          title={BLOCKS[k].label}
                          style={{
                            color: "white",
                            background: NODE_STYLE[k].color,
                          }}
                        >
                          <Icon name={k} size={18} />
                        </span>
                      ))}
                  </div>
                  <footer>
                    <span>{f.graph.nodes.length} blocos</span>
                    <span>
                      Atualizado{" "}
                      {new Date(f.updatedAt).toLocaleDateString("pt-BR")}
                    </span>
                  </footer>
                </Link>
                <details className="card-menu" onClick={(e) => {
                  if ((e.target as Element).closest("button")) e.currentTarget.open = false;
                }}>
                  <summary aria-label={"Ações de " + f.name}>
                    <Icon name="more" />
                  </summary>
                  <div>
                    <button onClick={() => duplicate(f)}>
                      <Icon name="copy" size={16} />
                      Duplicar
                    </button>
                    <button onClick={() => download(f)}>
                      <Icon name="download" size={16} />
                      Exportar
                    </button>
                    <button className="danger" onClick={() => setToDelete(f)}>
                      <Icon name="trash" size={16} />
                      Excluir
                    </button>
                  </div>
                </details>
              </article>
            ))}
          </div>
        )}
        {pages > 1 && (
          <nav className="library-pagination" aria-label="Paginação">
            <label>
              Por página
              <select
                value={perPage}
                onChange={(e) => choosePerPage(Number(e.target.value))}
              >
                {[10, 20, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <span>
              {(current - 1) * perPage + 1}–
              {Math.min(current * perPage, filtered.length)} de{" "}
              {filtered.length}
            </span>
            <div className="pagination-pages">
              <IconButton
                icon="arrow"
                label="Página anterior"
                disabled={current <= 1}
                onClick={() => setPage(current - 1)}
              />
              {Array.from({ length: pages }, (_, i) => i + 1)
                .filter(
                  (p) => p === 1 || p === pages || Math.abs(p - current) <= 1,
                )
                .map((p, i, list) => (
                  <span key={p} className="page-slot">
                    {i > 0 && list[i - 1] !== p - 1 && <i>…</i>}
                    <button
                      className={p === current ? "active" : ""}
                      aria-current={p === current ? "page" : undefined}
                      onClick={() => setPage(p)}
                    >
                      {p}
                    </button>
                  </span>
                ))}
              <IconButton
                icon="chevron"
                label="Próxima página"
                disabled={current >= pages}
                onClick={() => setPage(current + 1)}
              />
            </div>
          </nav>
        )}
        {connection && !connection.account && (
          <div className="library-connect-banner">
            <Icon name="spark" size={23} />
            <div>
              <strong>Use sua assinatura ChatGPT</strong>
              <p>Conecte uma vez e execute seus agentes com sua conta.</p>
            </div>
            <button className="studio-button" onClick={() => setConnect(true)}>
              Conectar ChatGPT
            </button>
          </div>
        )}
      </main>
      {notice && (
        <div role="status" className="canvas-toast studio-toast">
          <Icon name="check" size={17} />
          {notice}
        </div>
      )}
      {connect && (
        <ChatGPTConnection
          onClose={() => setConnect(false)}
          onChange={setConnection}
        />
      )}
      {templates && (
        <Modal
          title="Comece com um modelo"
          onClose={() => setTemplates(false)}
          wide
        >
          <p className="modal-lead">
            Escolha um ponto de partida. Cada bloco pode ser adaptado ao seu
            processo.
          </p>
          <div className="preset-grid">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                className="preset-card"
                disabled={busy}
                onClick={() => create(p.id)}
              >
                <span className="preset-category">{p.category}</span>
                <div className="preset-chain">
                  {p.kinds.map((k: Kind, i) => (
                    <span
                      key={i}
                      style={{
                        color: "white",
                        background: NODE_STYLE[k].color,
                      }}
                    >
                      <Icon name={k} size={22} />
                    </span>
                  ))}
                </div>
                <h3>{p.name}</h3>
                <p>{p.description}</p>
                <strong>
                  Usar este modelo <Icon name="plus" size={15} />
                </strong>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {toDelete && (
        <Modal title="Excluir Fluxo Agêntico" onClose={() => setToDelete(null)}>
          <p>
            Excluir “{toDelete.name}”? O histórico de execuções será preservado.
          </p>
          <div className="modal-actions">
            <button className="studio-button" onClick={() => setToDelete(null)}>
              Cancelar
            </button>
            <button
              className="studio-button danger"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await request("/api/flows/" + toDelete.id, "DELETE");
                  setToDelete(null);
                  await load();
                  setNotice("Fluxo excluído.");
                })
              }
            >
              Excluir fluxo
            </button>
          </div>
        </Modal>
      )}
    </StudioShell>
  );
}
