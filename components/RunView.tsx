"use client";
import { useEffect, useState } from "react";
import type { Run } from "@/lib/flow-types";
import { MarkdownContent } from "./MarkdownContent";
import { TraceDetails, TraceRow } from "./TraceDetails";
import { Icon, request } from "./StudioUI";
import { formatCost, runCost } from "@/lib/token-usage";
export const RUN_STATUS = {
  running: "Em execução",
  waiting: "Aguardando aprovação",
  completed: "Concluída",
  failed: "Falhou",
  cancelled: "Cancelada",
};
export function RunView({
  run: initialRun,
  onChange,
  compact = false,
}: {
  run: Run;
  onChange?: (r: Run) => void;
  compact?: boolean;
}) {
  const [received, setReceived] = useState<Run | null>(null);
  const run = received?.id === initialRun.id && received.updatedAt >= initialRun.updatedAt ? received : initialRun;
  useEffect(() => {
    if (run.status !== "running") return;
    let active = true, fetching = false;
    const timer = setInterval(() => {
      if (fetching) return;
      fetching = true;
      void request<Run>("/api/runs/" + run.id).then((next) => {
        if (active) { setReceived(next); onChange?.(next); }
      }).catch(() => {}).finally(() => { fetching = false; });
    }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [run.id, run.status, onChange]);
  const [selectedTrace, setSelectedTrace] = useState<number | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [tab, setTab] = useState<"output" | "steps" | "state">("output");
  async function decide(action: string, decision?: string) {
    setBusy(true);
    setError("");
    try {
      const next = await request<Run>("/api/runs/" + run.id, "POST", { action, decision });
      setReceived(next); onChange?.(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível continuar.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={"studio-run " + (compact ? "compact" : "")}>
      {selectedTrace !== null && run.trace[selectedTrace] && <TraceDetails trace={run.trace[selectedTrace]} kind={run.graph.nodes.find((node) => node.id === run.trace[selectedTrace].nodeId)?.data.kind} onClose={() => setSelectedTrace(null)} />}
      <header>
        <div>
          <span className="run-provider">
            <Icon name={run.demo ? "play" : "spark"} size={15} />
            {run.demo ? "Demonstração" : "Execução"} ·{" "}
            {run.version ? "v" + run.version : "rascunho"}
            {runCost(run.trace) !== undefined && <> · <span title="Soma dos custos informados pelos provedores nesta execução">{formatCost(runCost(run.trace)!)}</span></>}
          </span>
          {!compact && <h2>{run.name}</h2>}
        </div>
        <span className={"execution-status " + run.status}>
          {run.queued && run.status === "running" ? "Na fila" : RUN_STATUS[run.status]}
        </span>
      </header>
      {run.error && (
        <p role="alert" className="studio-error">
          {run.error}
        </p>
      )}
      {error && (
        <p role="alert" className="studio-error">
          {error}
        </p>
      )}
      <div className="run-tabs">
        <button
          className={tab === "output" ? "active" : ""}
          onClick={() => setTab("output")}
        >
          Resposta
        </button>
        <button
          className={tab === "steps" ? "active" : ""}
          onClick={() => setTab("steps")}
        >
          Etapas <span>{run.trace.length}</span>
        </button>
        <button
          className={tab === "state" ? "active" : ""}
          onClick={() => setTab("state")}
        >
          Estado
        </button>
      </div>
      {tab === "output" ? (
        <div className="run-response">
          <MarkdownContent>{run.output || "Aguardando resposta…"}</MarkdownContent>
        </div>
      ) : tab === "state" ? (
        <pre className="run-state">{JSON.stringify(run.state, null, 2)}</pre>
      ) : (
        <div className="run-timeline">
          {run.trace.map((t, i) => (
            <TraceRow key={i} trace={t} onOpen={() => setSelectedTrace(i)} />
          ))}
        </div>
      )}
      {run.status === "waiting" && (
        <div className="approval-actions">
          <p>Este fluxo precisa da sua decisão.</p>
          <button
            className="studio-button primary"
            disabled={busy}
            onClick={() => decide("resume", "yes")}
          >
            Aprovar e continuar
          </button>
          <button
            className="studio-button"
            disabled={busy}
            onClick={() => decide("resume", "no")}
          >
            Rejeitar
          </button>
        </div>
      )}
      {["waiting", "running"].includes(run.status) && (
        <button
          className="studio-button subtle danger"
          disabled={busy}
          onClick={() => decide("cancel")}
        >
          <Icon name="stop" size={14} />
          Cancelar execução
        </button>
      )}
    </section>
  );
}
