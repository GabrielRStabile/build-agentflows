"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  Background,
  Controls,
  ControlButton,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  type ReactFlowInstance,
  type Connection,
  type FinalConnectionState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  BLOCKS,
  block,
  shortLabel,
  type Kind,
  type Block,
  type Flow,
  type Graph,
  type Run,
} from "@/lib/flow-types";
import { NODE_STYLE, PALETTE_HIDDEN, preset, PRESETS } from "@/lib/flow-presets";
import {
  connect as connectGraph,
  connectionProblem,
  outputLabel,
  outputs,
} from "@/lib/flow-graph";
import { Icon, IconButton, Modal, request, useDismissMenus } from "./StudioUI";
import { ChatGPTConnection, useChatGPT } from "./ChatGPTConnection";
import { NodeDialog } from "./NodeDialog";
import { ChatPopup } from "./ChatPopup";
import { FlowSettingsDialog } from "./FlowSettingsDialog";
import { IntegrationDialog } from "./IntegrationDialog";
import { GeneratorDialog } from "./GeneratorDialog";
import type { FlowMessage } from "@/lib/flow-ai-edit";
import type { Generated } from "@/lib/flow-generator";
import { AgentNode, type VisualNode } from "./flow/AgentNode";
import { AgentEdge, type VisualEdge } from "./flow/AgentEdge";
import { ConnectionLine } from "./flow/ConnectionLine";
import type { Attachment } from "@/lib/attachment-types";
import { readEditorChat, writeEditorChat } from "@/lib/editor-chat";
import { queueLabel } from "@/lib/queue-status";
const nodeTypes = { block: AgentNode };
const edgeTypes = { agent: AgentEdge };
const FIT_VIEW_OPTIONS = { padding: 0.3, maxZoom: 2 };
// Conexão iniciada em uma saída e solta no vazio: o próximo bloco nasce já conectado.
type Pending = {
  source: string;
  sourceHandle: string | null;
  position: { x: number; y: number };
  screen: { x: number; y: number };
};
export function FlowEditor({ id }: { id: string }) {
  useDismissMenus();
  const executionLifetime = useRef({ active: true });
  useEffect(() => {
    const lifetime = { active: true };
    executionLifetime.current = lifetime;
    return () => { lifetime.active = false; };
  }, [id]);
  const router = useRouter(),
    canvasRef = useRef<HTMLDivElement>(null),
    instance = useRef<Pick<
      ReactFlowInstance<VisualNode, VisualEdge>,
      "screenToFlowPosition" | "fitView"
    > | null>(
      null,
    ),
    past = useRef<Graph[]>([]),
    future = useRef<Graph[]>([]);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const [dirty, setDirty] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [palette, setPalette] = useState(false);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [rename, setRename] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [naming, setNaming] = useState(false);
  const firstName = useRef<((name: string | null) => void) | null>(null);
  const [connect, setConnect] = useState(false);
  const [integration, setIntegration] = useState(false);
  const [chat, setChat] = useState(false);
  const [history, setHistory] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [session, setSession] = useState<Run[]>([]);
  const [pendingInput, setPendingInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [openrouterConnected, setOpenrouterConnected] = useState(false);
  const [snap, setSnap] = useState(false);
  const [dots, setDots] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [info, setInfo] = useState<Kind | null>(null);
  const [generator, setGenerator] = useState(false);
  const [aiConversation, setAiConversation] = useState<{ flowId: string; messages: FlowMessage[] }>({ flowId: id, messages: [] });
  const [leaving, setLeaving] = useState(false);
  const [clearChat, setClearChat] = useState(false);
  const [dark, setDark] = useState(false);
  const [voice, setVoice] = useState({ voz: false, ligacao: false });
  const { connection, setConnection } = useChatGPT();
  const aiConnected = !!connection?.account || openrouterConnected;
  // The open chat covers the right side of the canvas, where the flow usually ends.
  // Refit into the visible area so the last block (and its completion badge) stays in view.
  useEffect(() => {
    if (!chat || expanded) return;
    const frame = requestAnimationFrame(() => {
      const canvas = document.querySelector(".react-flow")?.getBoundingClientRect();
      const panel = document.querySelector(".chat-popup:not([hidden])")?.getBoundingClientRect();
      if (!canvas || !panel) return;
      const right = canvas.right - panel.left + 24;
      // Narrow screens show the chat over the whole canvas; nothing useful would remain.
      if (canvas.width - right < 320) return;
      void instance.current?.fitView({ ...FIT_VIEW_OPTIONS, padding: { top: "12%", bottom: "12%", left: "8%", right: `${Math.round(right)}px` }, duration: 200 });
    });
    return () => cancelAnimationFrame(frame);
  }, [chat, expanded]);
  useEffect(() => {
    const dismiss = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("dialog[open]")) return;
      if (!target.closest(".react-flow__node, .af-toolbar")) setGraph((g) => g.nodes.some((n) => n.selected) ? { ...g, nodes: g.nodes.map((n) => ({ ...n, selected: false })) } : g);
      if (!target.closest(".chat-popup, .canvas-right-actions")) setChat(false);
      if (!target.closest(".node-palette, .add-node-button")) {
        setPalette(false); setPending(null); setSearch("");
      }
      if (!target.closest('.canvas-test-panel, [aria-label="Histórico do fluxo"]')) setHistory(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
      setGraph((g) => g.nodes.some((n) => n.selected) ? { ...g, nodes: g.nodes.map((n) => ({ ...n, selected: false })) } : g);
      setChat(false); setPalette(false); setPending(null); setSearch(""); setHistory(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  useEffect(() => {
    const refresh = () => {
      void request<{ provider: string; configured: boolean }[]>("/api/tool-credentials").then(items => setOpenrouterConnected(items.some(c => c.provider.startsWith("ai_") && c.configured))).catch(() => {});
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("credentials-changed", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("credentials-changed", refresh); };
  }, []);
  useEffect(() => {
    let alive = true;
    const selectedPreset = id === "new" ? PRESETS.find((p) => p.id === new URLSearchParams(location.search).get("preset")) : undefined;
    const draft: Flow = { id: "new", name: "", description: selectedPreset?.description || "", graph: selectedPreset ? preset(selectedPreset.id) : { nodes: [block("start", "inicio", 0, 0)], edges: [] }, published: null, version: 1, updatedAt: "" };
    void (id === "new" ? Promise.resolve(draft) : request<Flow>("/api/flows/" + id))
      .then((f) => {
        if (alive) {
          setFlow(f);
          if (!f.published) setDirty(true);
          setGraph(f.graph);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    const refreshVoice = () => { void request<{ voz: boolean; ligacao: boolean }>("/api/voz")
      .then((v) => {
        if (alive) setVoice(v);
      })
      .catch(() => {}); };
    refreshVoice();
    window.addEventListener("focus", refreshVoice);
    const theme = localStorage.getItem("agentflows-theme") || "light";
    document.documentElement.dataset.studioTheme = theme;
    const timer = setTimeout(() => setDark(theme === "dark"), 0);
    return () => {
      alive = false;
      window.removeEventListener("focus", refreshVoice);
      clearTimeout(timer);
    };
  }, [id]);
  const snapshot = useCallback((g: Graph) => {
    past.current = [...past.current.slice(-49), structuredClone(g)];
    future.current = [];
    setUndoCount(past.current.length);
    setRedoCount(0);
  }, []);
  const commit = useCallback(
    (g: Graph) => {
      snapshot(graph);
      setGraph(g);
      setDirty(true);
    },
    [graph, snapshot, setGraph, setDirty],
  );
  const undo = useCallback(() => {
    const g = past.current.pop();
    if (!g) return;
    future.current.push(structuredClone(graph));
    setGraph(g);
    setUndoCount(past.current.length);
    setRedoCount(future.current.length);
    setDirty(true);
  }, [graph, setGraph, setDirty, setUndoCount, setRedoCount]);
  const redo = useCallback(() => {
    const g = future.current.pop();
    if (!g) return;
    past.current.push(structuredClone(graph));
    setGraph(g);
    setUndoCount(past.current.length);
    setRedoCount(future.current.length);
    setDirty(true);
  }, [graph, setGraph, setDirty, setUndoCount, setRedoCount]);
  const save = useCallback(async () => {
    if (!flow) throw new Error("Fluxo não carregado.");
    if (firstName.current) return null;
    const isNew = flow.id === "new";
    let name = flow.name;
    if (isNew) {
      setNameDraft("");
      setNaming(true);
      const chosen = await new Promise<string | null>((resolve) => { firstName.current = resolve; });
      if (!chosen) return null;
      name = chosen;
    }
    const saved = await request<Flow>(isNew ? "/api/flows" : "/api/flows/" + flow.id, isNew ? "POST" : "PUT", {
      name, description: flow.description, voiceId: flow.voiceId || "", graph,
    });
    if (isNew) router.replace("/flows/" + saved.id);
    setFlow(saved);
    setDirty(false);
    return saved;
  }, [flow, graph, router, setFlow, setDirty, setNameDraft, setNaming]);
  const act = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Não foi possível concluir.");
      } finally {
        setBusy(false);
      }
    },
    [setBusy, setError, setNotice],
  );
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    const keys = (e: KeyboardEvent) => {
      if (editing || rename || connect || integration || generator) return;
      const el = e.target as HTMLElement;
      if (el.matches("input,textarea,select")) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (!busy)
          void act(async () => {
            if (!await save()) return;
            setNotice("Fluxo salvo.");
          });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("beforeunload", leave);
    window.addEventListener("keydown", keys);
    return () => {
      window.removeEventListener("beforeunload", leave);
      window.removeEventListener("keydown", keys);
    };
  }, [
    dirty,
    editing,
    rename,
    connect,
    integration,
    generator,
    busy,
    save,
    undo,
    redo,
    act,
  ]);
  useEffect(() => {
    if (!history) return;
    void request<Run[]>("/api/runs?flowId=" + id)
      .then(setRuns)
      .catch((e) => setError(e.message));
  }, [history, id]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  function applyGenerated(g: Generated, mode: "new" | "edit") {
    commit(g.graph);
    setFlow({
      ...flow!,
      name: id === "new" ? "" : mode === "edit" || /^Novo (fluxo|Agentflow)$/i.test(flow!.name) ? g.name : flow!.name,
      description: mode === "edit" ? g.description : flow!.description || g.description,
    });
    setNotice(mode === "edit" ? "Ajustes aplicados. Revise e salve o fluxo." : "Fluxo gerado. Revise as instruções de cada bloco e salve.");
    setTimeout(
      () => instance.current?.fitView(FIT_VIEW_OPTIONS),
      60,
    );
  }
  function closePalette() {
    setPalette(false);
    setPending(null);
    setSearch("");
  }
  function add(kind: Kind, position?: { x: number; y: number }) {
    if (kind === "start" && graph.nodes.some((n) => n.data.kind === "start")) {
      setError("O fluxo tem apenas um Início.");
      return;
    }
    const bounds = canvasRef.current?.getBoundingClientRect();
    const pos = position ||
      pending?.position ||
      instance.current?.screenToFlowPosition({
        x: (bounds?.x || 0) + (bounds?.width || 800) / 2 - 100,
        y: (bounds?.y || 0) + (bounds?.height || 600) / 2,
      }) || { x: 300, y: 200 };
    const n = block(kind, "n_" + crypto.randomUUID(), pos.x, pos.y);
    n.data.label = nextLabel(kind);
    n.selected = true;
    let next: Graph = {
      ...graph,
      nodes: [...graph.nodes.map((x) => ({ ...x, selected: false })), n],
    };
    if (pending) {
      const c = { ...pending, target: n.id };
      if (!connectionProblem(next, c)) next = connectGraph(next, c);
    }
    commit(next);
    closePalette();
  }
  // Nome incremental como no Flowise: Agente 0, Agente 1, LLM 0...
  function nextLabel(kind: Kind) {
    if (kind === "start") return "Início";
    const base = shortLabel(kind);
    const used = new Set(graph.nodes.map((n) => n.data.label));
    let i = graph.nodes.filter((n) => n.data.kind === kind).length;
    while (used.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }
  function duplicate(n: Block) {
    const copy = structuredClone(n);
    copy.id = "n_" + crypto.randomUUID();
    copy.position = { x: n.position.x + 50, y: n.position.y + 120 };
    copy.data.label = nextLabel(n.data.kind);
    copy.selected = false;
    commit({ ...graph, nodes: [...graph.nodes, copy] });
    setNotice("Bloco duplicado.");
  }
  function renameBlock(id: string, label: string) {
    if (graph.nodes.find((n) => n.id === id)?.data.kind === "start") return;
    commit({
      ...graph,
      nodes: graph.nodes.map((x) =>
        x.id === id ? { ...x, data: { ...x.data, label } } : x,
      ),
    });
  }
  function remove(id: string) {
    commit({
      nodes: graph.nodes.filter((n) => n.id !== id),
      edges: graph.edges.filter((e) => e.source !== id && e.target !== id),
    });
  }
  function connectNodes(c: Connection) {
    const problem = connectionProblem(graph, c);
    if (problem) {
      setError(problem);
      return;
    }
    commit(connectGraph(graph, c));
  }
  // Ao soltar uma conexão: explica por que foi recusada ou, no vazio, oferece o próximo bloco.
  function connectEnd(
    event: MouseEvent | TouchEvent,
    state: FinalConnectionState,
  ) {
    if (state.isValid || !state.fromNode || state.fromHandle?.type !== "source")
      return;
    if (state.toNode) {
      const problem = connectionProblem(graph, {
        source: state.fromNode.id,
        target: state.toNode.id,
        sourceHandle: state.fromHandle.id,
      });
      if (problem) setError(problem);
      return;
    }
    const from = state.fromNode.id,
      handle = state.fromHandle.id ?? null;
    if (
      graph.edges.some(
        (e) => e.source === from && (e.sourceHandle || null) === handle,
      )
    ) {
      setError(
        "Esta saída já está conectada. Remova a conexão atual ou use uma Condição para ramificar.",
      );
      return;
    }
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!point || !bounds || !instance.current) return;
    setPending({
      source: from,
      sourceHandle: handle,
      position: instance.current.screenToFlowPosition({
        x: point.clientX,
        y: point.clientY,
      }),
      screen: {
        x: Math.min(point.clientX - bounds.x, bounds.width - 330),
        y: Math.min(point.clientY - bounds.y, Math.max(bounds.height - 420, 80)),
      },
    });
    setPalette(true);
  }
  function exportFlow() {
    if (!flow) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              format: "build-agentflows/v1",
              name: flow.name,
              description: flow.description,
              voiceId: flow.voiceId || "",
              graph,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = flow.name.replace(/[^a-z0-9_-]/gi, "_") + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }
  // Cada execução vira uma troca no chat; o mesmo registro é atualizado enquanto roda.
  const updateRun = useCallback((r: Run) => {
    setRun(r);
    setSession((list) =>
      list.some((x) => x.id === r.id)
        ? list.map((x) => (x.id === r.id ? r : x))
        : [...list, r],
    );
  }, [setRun, setSession]);
  // Ao voltar ao fluxo, a conversa de teste reaparece com a última execução, salvo se foi limpa.
  const [restoredChat, setRestoredChat] = useState<string | null>(null);
  useEffect(() => {
    if (id === "new") return;
    let alive = true;
    const ids = readEditorChat(localStorage, id);
    void Promise.all(ids.map((runId) => request<Run>("/api/runs/" + runId).catch(() => null)))
      .then((items) => {
        if (!alive) return;
        const found = items.filter((r): r is Run => !!r && r.flowId === id);
        setRestoredChat(id);
        if (found.length) setSession((list) => [...found.filter((r) => !list.some((x) => x.id === r.id)), ...list]);
        if (found.length) setRun((current) => current || found[found.length - 1]);
      });
    return () => { alive = false; };
  }, [id]);
  useEffect(() => {
    if (id !== "new" && restoredChat === id) writeEditorChat(localStorage, id, session.map((r) => r.id));
  }, [id, restoredChat, session]);
  // Após aprovar/rejeitar (ou abrir pelo histórico), a execução segue no servidor fora de execute();
  // acompanha até terminar para o chat e o canvas não ficarem presos em "Em execução".
  const following = !running && session.some((r) => r.status === "running");
  const followIds = following ? session.filter((r) => r.status === "running").map((r) => r.id).join(",") : "";
  useEffect(() => {
    if (!followIds) return;
    let active = true;
    const timer = setInterval(() => {
      for (const runId of followIds.split(","))
        void request<Run>("/api/runs/" + runId)
          .then((r) => { if (active && executionLifetime.current.active) updateRun(r); })
          .catch(() => {});
    }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [followIds, updateRun]);
  async function execute(input: string, attachments: Attachment[]): Promise<Run | null> {
    const lifetime = executionLifetime.current;
    setRunning(true);
    setError("");
    setPendingInput(input);
    setPendingAttachments(attachments);
    setRun(null);
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const saved = await save();
      if (!saved || !lifetime.active) return null;
      const from = new Date().toISOString();
      timer = setInterval(() => {
        if (!lifetime.active) { clearInterval(timer); return; }
        void request<Run[]>("/api/runs?flowId=" + saved.id)
          .then((items) => {
            const latest = items.find((r) => r.createdAt >= from);
            if (latest && lifetime.active) updateRun(latest);
          })
          .catch(() => {});
      }, 800);
      let result = await request<Run>("/api/flows/" + saved.id + "/run", "POST", {
          input,
          demo: false,
          attachments: attachments.map((a) => a.id),
          conversationRunIds: session.filter((r) => r.status === "completed" && !r.demo).map((r) => r.id),
        });
      if (!lifetime.active) return null;
      updateRun(result);
      if (timer) { clearInterval(timer); timer = undefined; }
      const deadline = Date.now() + 30 * 60_000;
      while (result.status === "running") {
        if (Date.now() > deadline) throw new Error("A tarefa continua no histórico. Abra a execução para acompanhar.");
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (!lifetime.active) return null;
        result = await request<Run>("/api/runs/" + result.id);
        if (!lifetime.active) return null;
        updateRun(result);
      }
      return result;
    } catch (e) {
      if (lifetime.active) setError(e instanceof Error ? e.message : "Não foi possível executar.");
      return null;
    } finally {
      if (timer) clearInterval(timer);
      if (lifetime.active) setRunning(false);
    }
  }
  const node = graph.nodes.find((n) => n.id === editing);
  const visualNodes: VisualNode[] = graph.nodes.map((n) => {
    const done = run?.trace.some((t) => t.nodeId === n.id && t.type !== "tool");
    const current = run?.next === n.id;
    const queued = !!run?.queued && run.status === "running";
    const execution =
      current && ["running", "waiting", "failed"].includes(run?.status || "")
        ? queued ? "queued" : run!.status
        : done
          ? "completed"
          : undefined;
    return {
      ...n,
      data: {
        ...n.data,
        execution,
        executionLabel: execution === "queued" ? queueLabel(run?.queue) : undefined,
        connected: graph.edges
          .filter((e) => e.source === n.id)
          .map((e) => e.sourceHandle || null),
        edit: () => setEditing(n.id),
        duplicate: () => duplicate(n),
        remove: () => remove(n.id),
        info: () => setInfo(n.data.kind),
        rename: (label: string) => renameBlock(n.id, label),
      },
    };
  });
  const kindOf = (id: string) => graph.nodes.find((n) => n.id === id)?.data.kind;
  const visualEdges: VisualEdge[] = graph.edges.map((e) => {
    const from = kindOf(e.source),
      to = kindOf(e.target);
    return {
      ...e,
      type: "agent",
      data: {
        sourceColor: from ? NODE_STYLE[from].color : "#6557d2",
        targetColor: to ? NODE_STYLE[to].color : "#6557d2",
        label: from ? outputLabel(from, e.sourceHandle, graph.nodes.find((n) => n.id === e.source)?.data.config) : "",
        active: (running || following) && run?.status === "running" && run.next === e.target,
      },
    };
  });
  if (!flow)
    return (
      <main className="studio-loading">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button className="studio-button" onClick={() => router.push("/")}>
              Voltar aos fluxos
            </button>
          </>
        ) : (
          <>
            <span className="studio-spinner" />
            Abrindo Fluxo Agêntico…
          </>
        )}
      </main>
    );
  return (
    <main className="canvas-page">
      <header className="canvas-header">
        <IconButton
          icon="arrow"
          label="Voltar aos fluxos"
          onClick={() => {
            if (dirty) setLeaving(true);
            else router.push("/");
          }}
        />
        <div className="canvas-title">
          {dirty && (
            <span className="canvas-unsaved" role="img" aria-label="Alterações não salvas" title="Alterações não salvas">*</span>
          )}
          {editingName ? (
            <form className="canvas-name-form" onSubmit={(event) => {
              event.preventDefault();
              if (busy || !nameDraft.trim()) return;
              void act(async () => {
                const saved = await request<Flow>("/api/flows/" + id, "PUT", {
                  name: nameDraft.trim(), description: flow.description,
                  voiceId: flow.voiceId || "", graph: flow.graph,
                });
                setFlow(saved);
                setEditingName(false);
                setNotice("Nome do fluxo salvo.");
              });
            }}>
              <input aria-label="Nome do fluxo" value={nameDraft} maxLength={100} required autoFocus disabled={busy}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") { event.preventDefault(); setEditingName(false); }
                }} />
              <button type="submit" className="studio-icon-button" aria-label="Salvar nome do fluxo" title="Salvar nome do fluxo" disabled={busy || !nameDraft.trim()}>
                <Icon name="check" size={18} />
              </button>
            </form>
          ) : (
            <>
              <h1><button className="canvas-name-button" disabled={busy || running} onClick={() => {
                if (flow.id === "new") { void act(async () => { if (await save()) setNotice("Fluxo salvo."); }); return; }
                setNameDraft(flow.name); setEditingName(true);
              }}>{flow.name || "Sem nome"}</button></h1>
              <IconButton icon="pencil" label="Editar nome do fluxo" disabled={busy || running} onClick={() => {
                if (flow.id === "new") { void act(async () => { if (await save()) setNotice("Fluxo salvo."); }); return; }
                setNameDraft(flow.name); setEditingName(true);
              }} />
            </>
          )}
        </div>
        <div className="canvas-header-actions">
          <button
            className={
              "studio-button connection-button" +
              (connection?.account ? " is-connected" : "")
            }
            onClick={() => setConnect(true)}
          >
            <Icon name="spark" size={17} />
            <span>{connection?.account ? "ChatGPT" : "Conectar ChatGPT"}</span>
          </button>
          <IconButton
            icon="code"
            label="Implantar fluxo"
            onClick={() => { if (flow.id === "new") void act(async () => { await save(); }); else setIntegration(true); }}
          />
          <details className="canvas-menu" onClick={(e) => {
            if ((e.target as Element).closest("button")) e.currentTarget.open = false;
          }}>
            <summary aria-label="Configurações e ações do fluxo" title="Configurações e ações do fluxo">
              <Icon name="settings" />
            </summary>
            <div>
              <button disabled={flow.id === "new"} onClick={() => { setHistory(!history); setChat(false); }}>
                <Icon name="runs" size={16} />
                Execuções
              </button>
              <button disabled={flow.id === "new"} onClick={() => setRename(true)}>
                <Icon name="settings" size={16} />
                Configurações do fluxo
              </button>
              <button onClick={exportFlow}>
                <Icon name="download" size={16} />
                Exportar fluxo
              </button>
              <button
                disabled={busy || flow.id === "new"}
                onClick={() =>
                  act(async () => {
                    const f = await request<Flow>("/api/flows", "POST", {
                      name: flow.name + " (cópia)",
                    });
                    await request("/api/flows/" + f.id, "PUT", {
                      ...f,
                      description: flow.description,
                      voiceId: flow.voiceId || "",
                      graph,
                    });
                    router.push("/flows/" + f.id);
                  })
                }
              >
                <Icon name="copy" size={16} />
                Duplicar fluxo
              </button>
              <button className="danger" onClick={() => setConfirmDelete(true)}>
                <Icon name="trash" size={16} />
                Excluir fluxo
              </button>
            </div>
          </details>
          <button
            className={"studio-button primary save-button" + (dirty ? "" : " saved")}
            disabled={!dirty || busy || running}
            aria-label="Salvar fluxo"
            title={dirty ? "Salvar alterações" : "Tudo salvo"}
            onClick={() =>
              act(async () => {
                if (!await save()) return;
                setNotice("Fluxo salvo.");
              })
            }
          >
            <Icon name="save" size={17} />
          </button>
        </div>
      </header>
      <div className="canvas-body">
        <div
          className="studio-canvas"
          ref={canvasRef}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            e.preventDefault();
            const kind = e.dataTransfer.getData(
              "application/agentflow",
            ) as Kind;
            if (Object.hasOwn(BLOCKS, kind))
              add(
                kind,
                instance.current?.screenToFlowPosition({
                  x: e.clientX,
                  y: e.clientY,
                }),
              );
          }}
        >
          <ReactFlow<VisualNode, VisualEdge>
            nodes={visualNodes}
            edges={visualEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            connectionLineComponent={ConnectionLine}
            connectionRadius={36}
            isValidConnection={(c) => !connectionProblem(graph, c)}
            onInit={(i) => {
              instance.current = i;
            }}
            onBeforeDelete={async () => {
              snapshot(graph);
              return true;
            }}
            onNodesChange={(changes) => {
              setGraph((g) => ({
                ...g,
                nodes: applyNodeChanges(changes, g.nodes as VisualNode[]).map(
                  (n) => ({ ...n, data: { ...n.data } }) as Block,
                ),
              }));
              if (changes.some((c) => ["remove", "position"].includes(c.type)))
                setDirty(true);
            }}
            onEdgesChange={(changes) => {
              setGraph((g) => ({
                ...g,
                edges: applyEdgeChanges(changes, g.edges),
              }));
              if (changes.some((c) => c.type === "remove")) setDirty(true);
            }}
            onNodeDragStart={() => snapshot(graph)}
            onConnect={connectNodes}
            onConnectEnd={connectEnd}
            onNodeDoubleClick={(_, n) => setEditing(n.id)}
            onPaneClick={() => {
              if (pending) closePalette();
            }}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            minZoom={0.25}
            maxZoom={2}
            snapToGrid={snap}
            snapGrid={[25, 25]}
            deleteKeyCode={
              editing || rename || connect || integration || info || generator
                ? null
                : ["Backspace", "Delete"]
            }
            nodesDraggable={!running}
            nodesConnectable={!running}
            colorMode="light"
          >
            {dots && (
              <Background gap={16} size={1} color={dark ? "#4a4d5e" : "#aaa"} />
            )}
            <Controls
              fitViewOptions={FIT_VIEW_OPTIONS}
              position="bottom-center"
              orientation="horizontal"
              showInteractive={false}
            >
              <ControlButton
                title="Desfazer"
                aria-label="Desfazer"
                disabled={!undoCount}
                onClick={undo}
              >
                <Icon name="undo" size={16} />
              </ControlButton>
              <ControlButton
                title="Refazer"
                aria-label="Refazer"
                disabled={!redoCount}
                onClick={redo}
              >
                <Icon name="redo" size={16} />
              </ControlButton>
              <ControlButton
                title="Alinhar à grade"
                aria-label="Alinhar à grade"
                className={snap ? "active" : ""}
                onClick={() => setSnap(!snap)}
              >
                <Icon name="magnet" size={16} />
              </ControlButton>
              <ControlButton
                title="Mostrar fundo"
                aria-label="Mostrar fundo"
                className={dots ? "active" : ""}
                onClick={() => setDots(!dots)}
              >
                <Icon name="artboard" size={16} />
              </ControlButton>
            </Controls>
            <MiniMap
              position="bottom-left"
              pannable
              zoomable
              nodeColor={(n) => NODE_STYLE[(n.data as Block["data"]).kind].color}
              nodeStrokeColor={dark ? "#525252" : "#fff"}
              nodeStrokeWidth={3}
              maskColor={dark ? "#2d2d2d99" : "#f0f0f099"}
            />
          </ReactFlow>
          <div className="canvas-left-actions">
            <button
              className={"add-node-button" + (palette ? " active" : "")}
              title="Adicionar bloco"
              aria-label="Adicionar bloco"
              onClick={() => (palette ? closePalette() : setPalette(true))}
            >
              <Icon name={palette ? "close" : "plus"} size={23} />
            </button>
            <button
              className="generate-button"
              title="Gerar fluxo com IA"
              aria-label="Gerar fluxo com IA"
              onClick={() => setGenerator(true)}
            >
              <Icon name="spark" size={22} />
            </button>
          </div>
          {palette && (
            <aside
              className={"node-palette" + (pending ? " anchored" : "")}
              style={
                pending
                  ? { left: pending.screen.x, top: pending.screen.y }
                  : undefined
              }
            >
              <header>
                <h2>{pending ? "Próximo bloco" : "Adicionar blocos"}</h2>
                <IconButton
                  icon="close"
                  label="Fechar biblioteca"
                  onClick={closePalette}
                />
              </header>
              <label className="studio-search">
                <Icon name="search" size={17} />
                <input
                  autoFocus
                  placeholder="Buscar blocos"
                  aria-label="Buscar blocos"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <div className="node-palette-scroll">
                {[
                  "Agentes e IA",
                  "Controle de fluxo",
                  "Dados e integrações",
                ].map((group) => (
                  <details key={group} open>
                    <summary>
                      {group}
                      <Icon name="chevron" size={14} />
                    </summary>
                    {(Object.keys(BLOCKS) as Kind[])
                      .filter(
                        (k) =>
                          NODE_STYLE[k].group === group &&
                          !PALETTE_HIDDEN.includes(k) &&
                          !(pending && k === "start") &&
                          (BLOCKS[k].label + " " + BLOCKS[k].help)
                            .toLowerCase()
                            .includes(search.toLowerCase()),
                      )
                      .map((k) => (
                        <button
                          key={k}
                          draggable
                          onDragStart={(e) =>
                            e.dataTransfer.setData("application/agentflow", k)
                          }
                          onClick={() => add(k)}
                        >
                          <span
                            className="palette-node-icon"
                            style={{ background: NODE_STYLE[k].color }}
                          >
                            <Icon name={k} size={21} />
                          </span>
                          <span>
                            <strong>{BLOCKS[k].label}</strong>
                            <small>{BLOCKS[k].help}</small>
                          </span>
                        </button>
                      ))}
                  </details>
                ))}
              </div>
            </aside>
          )}
          <div className="canvas-right-actions">
            {chat && <>
              <IconButton icon="eraser" label="Limpar conversa" disabled={!session.length || running} onClick={() => setClearChat(true)} />
              <IconButton icon="expand" label={expanded ? "Reduzir" : "Expandir"} active={expanded} onClick={() => setExpanded(!expanded)} />
            </>}
            <button
              className={"chat-fab" + (chat ? " active" : "")}
              title={chat ? "Fechar chat" : "Testar Fluxo Agêntico"}
              aria-label={chat ? "Fechar chat" : "Testar Fluxo Agêntico"}
              onClick={() => {
                setChat(!chat);
                setHistory(false);
              }}
            >
              <Icon name={chat ? "close" : "chat"} size={22} />
            </button>
          </div>
            <ChatPopup
              open={chat}
              session={session}
              pendingInput={pendingInput}
              pendingAttachments={pendingAttachments}
              graph={graph}
              chatModels={connection?.models || []}
              error={error}
              running={running || following}
              demo={false}
              connected={aiConnected}
              expanded={expanded}
              voice={voice.voz}
              voiceId={flow.voiceId || ""}
              onVoiceSettings={() => { if (flow.id === "new") void act(async () => { await save(); }); else setRename(true); }}
              flowId={id}
              onSend={execute}
              onChange={updateRun}
              onConnect={() => setConnect(true)}
            />
        </div>
        {history && (
          <aside className="canvas-test-panel">
            <header>
              <div>
                <Icon name="runs" size={20} />
                <h2>Execuções do fluxo</h2>
              </div>
              <IconButton
                icon="close"
                label="Fechar painel"
                onClick={() => setHistory(false)}
              />
            </header>
            <div className="flow-runs-list">
              {!runs.length ? (
                <div className="chat-empty">
                  <Icon name="runs" size={30} />
                  <h3>Nenhuma execução ainda</h3>
                  <p>Teste seu fluxo para acompanhar cada etapa.</p>
                </div>
              ) : (
                runs.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => {
                      updateRun(r);
                      setChat(true);
                      setHistory(false);
                    }}
                  >
                    <span className={"run-status-dot " + r.status} />
                    <span>
                      <strong>{r.input.slice(0, 70)}</strong>
                      <small>
                        {new Date(r.createdAt).toLocaleString("pt-BR")} ·{" "}
                        {r.demo ? "Demonstração" : "Execução real"}
                      </small>
                    </span>
                    <span>
                      {r.status === "completed"
                        ? "Concluída"
                        : r.status === "waiting"
                          ? "Aguardando"
                          : r.status === "failed"
                            ? "Falhou"
                            : "Em execução"}
                    </span>
                  </button>
                ))
              )}
            </div>
          </aside>
        )}
      </div>
      {error && (
        <div role="alert" className="canvas-toast error">
          {error}
          <button aria-label="Fechar erro" onClick={() => setError("")}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="canvas-toast success">
          <Icon name="check" size={17} />
          {notice}
        </div>
      )}
      {node && (
        <NodeDialog
          key={node.id}
          node={node}
          nodes={graph.nodes}
          models={connection?.models || []}
          connected={!!connection?.account}
          onConnect={() => setConnect(true)}
          onRename={(label) => renameBlock(node.id, label)}
          onClose={() => setEditing(null)}
          onSave={(n) => {
            commit({
              ...graph,
              nodes: graph.nodes.map((x) => (x.id === n.id ? n : x)),
              edges: graph.edges.filter((edge) => edge.source !== n.id || outputs(n.data.kind, n.data.config).some((output) => output.id === (edge.sourceHandle || null))),
            });
            setNotice("Bloco atualizado. Salve o fluxo para manter.");
          }}
        />
      )}
      {leaving && (
        <Modal title="Sair sem salvar?" onClose={() => setLeaving(false)}>
          <p>
            Há alterações não salvas em “{flow.name}”. Você pode salvar antes de
            sair ou descartar o que mudou.
          </p>
          <div className="modal-actions">
            <button
              className="studio-button danger"
              onClick={() => {
                setDirty(false);
                router.push("/");
              }}
            >
              Sair sem salvar
            </button>
            <button
              className="studio-button primary"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  if (!await save()) return;
                  router.push("/");
                })
              }
            >
              Salvar
            </button>
          </div>
        </Modal>
      )}
      {clearChat && (
        <Modal title="Limpar a conversa?" onClose={() => setClearChat(false)}>
          <p>
            As mensagens deste teste somem do chat. As execuções continuam no
            histórico do fluxo.
          </p>
          <div className="modal-actions">
            <button
              className="studio-button destructive"
              onClick={() => {
                setSession([]);
                setRun(null);
                setClearChat(false);
                setNotice("Conversa limpa.");
              }}
            >
              Limpar conversa
            </button>
          </div>
        </Modal>
      )}
      {info && (
        <Modal title={BLOCKS[info].label} onClose={() => setInfo(null)}>
          <div className="node-dialog-type">
            <span style={{ background: NODE_STYLE[info].color }}>
              <Icon name={info} size={24} />
            </span>
            <div>
              <strong>{BLOCKS[info].label}</strong>
              <p>{BLOCKS[info].help}</p>
            </div>
          </div>
          <p>
            {info === "condition" ? "Adicione critérios para criar saídas numeradas. O primeiro critério atendido define o caminho; a última saída recebe os demais casos." : outputLabel(info, "yes")
              ? `Este bloco tem duas saídas (${outputLabel(info, "yes")} e ${outputLabel(info, "no")}). Conecte cada uma ao próximo passo.`
              : info === "loop"
                ? "Repetir volta a uma etapa anterior pela saída Repetir até o limite e então segue pela saída Concluir."
                : info === "end"
                  ? "A Resposta encerra o fluxo e entrega o texto final a quem chamou."
                  : "Conecte a saída deste bloco ao próximo passo do fluxo."}
          </p>
          <div className="modal-actions">
            <button
              className="studio-button primary"
              onClick={() => setInfo(null)}
            >
              Entendi
            </button>
          </div>
        </Modal>
      )}
      {generator && (
        <GeneratorDialog
          flowId={id}
          context={{ name: flow?.name || "", description: flow?.description || "", graph }}
          messages={aiConversation.flowId === id ? aiConversation.messages : []}
          onMessages={(messages) => setAiConversation({ flowId: id, messages })}
          replaces={graph.nodes.length > 1 || graph.edges.length > 0}
          connected={aiConnected}
          onConnect={() => {
            setGenerator(false);
            setConnect(true);
          }}
          onClose={() => setGenerator(false)}
          onApply={applyGenerated}
        />
      )}
      {connect && (
        <ChatGPTConnection
          onClose={() => setConnect(false)}
          onChange={setConnection}
        />
      )}
      {integration && (
        <IntegrationDialog
          flow={flow}
          onClose={() => setIntegration(false)}
        />
      )}
      {naming && (
        <Modal title="Salvar fluxo" className="flow-name-modal" onClose={() => { setNaming(false); firstName.current?.(null); firstName.current = null; }}>
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!nameDraft.trim()) return;
            setNaming(false); firstName.current?.(nameDraft.trim()); firstName.current = null;
          }}>
            <label className="flow-name-field">Nome do fluxo
              <input aria-label="Nome do fluxo" data-autofocus autoFocus required maxLength={100} value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder="Dê um nome ao seu fluxo" />
            </label>
            <div className="modal-actions">
              <button type="submit" className="studio-button primary" disabled={!nameDraft.trim()}>Salvar</button>
            </div>
          </form>
        </Modal>
      )}
      {rename && (
        <FlowSettingsDialog flow={flow} voiceAvailable={voice.voz} onClose={() => setRename(false)} onSave={async (settings) => {
          const saved = await request<Flow>("/api/flows/" + id, "PUT", { ...settings, graph });
          setFlow(saved); setDirty(false); setNotice("Configurações salvas.");
        }} />
      )}
      {confirmDelete && (
        <Modal
          title="Excluir Fluxo Agêntico"
          onClose={() => setConfirmDelete(false)}
        >
          <p>
            Excluir “{flow.name}”? O histórico de execuções será preservado.
          </p>
          <div className="modal-actions">
            <button
              className="studio-button"
              onClick={() => setConfirmDelete(false)}
            >
              Cancelar
            </button>
            <button
              className="studio-button danger"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  if (flow.id !== "new") await request("/api/flows/" + id, "DELETE");
                  setDirty(false);
                  router.push("/");
                })
              }
            >
              Excluir fluxo
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
