"use client";
import { useEffect, useRef, useState } from "react";
import type { Attachment } from "@/lib/attachment-types";
import { type EmbedTurn, type PageCommand } from "@/lib/embed-protocol";
import "./embed-chat.css";
class EmbedApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
type Snapshot = { sessionId: string; turns: EmbedTurn[]; commands: PageCommand[] };
type Wire = { channel: string; version: number; type: string; [key:string]: unknown };
export function EmbedChat({ agentName, avatarUrl, title, welcome }: { agentName: string; avatarUrl: string; title: string; welcome: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [confirmNew, setConfirmNew] = useState(false);
  const [avatarError, setAvatarError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [confirmation, setConfirmation] = useState<{ runId:string; decision:string } | null>(null);
  const state = useRef({ token: "", sessionId: "", parent: "", init: null as Wire | null, handled: new Set<string>(), polling: false, handshake: false, pendingMessage: null as {requestId:string; input:string} | null });
  const messages = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    const resize = () => {
      const style = getComputedStyle(el);
      const max = 3 * parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    };
    resize();
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) { width = el.clientWidth; resize(); }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [draft]);
  function post(type: string, data: Record<string, unknown> = {}) { if (state.current.parent) window.parent.postMessage({ channel: "agentflows", version: 1, type, ...data }, state.current.parent); }
  async function downloadImage(id: string, name: string) {
    try {
      const response = await fetch(`/api/embed/attachments/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(state.current.sessionId)}`, {
        headers: { Authorization: "Bearer " + state.current.token }, credentials: "omit", cache: "no-store",
      });
      if (!response.ok) throw new Error((await response.json()).error || "Não foi possível baixar a imagem.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { setError(error instanceof Error ? error.message : "Não foi possível baixar a imagem."); }
  }
  async function api(payload?: Record<string, unknown>, path = "/api/embed/session", form?: FormData) {
    const res = await fetch(payload || form ? path : path + "?id=" + encodeURIComponent(state.current.sessionId), {
      method: payload || form ? "POST" : "GET", cache: "no-store", credentials: "omit",
      headers: { Authorization: "Bearer " + state.current.token, ...(payload ? { "Content-Type": "application/json" } : {}) },
      body: form || (payload ? JSON.stringify({ sessionId: state.current.sessionId, ...payload }) : undefined),
    });
    const data = await res.json();
    if (!res.ok) { if (res.status === 401) { setConnected(false); post("refreshToken"); } throw new EmbedApiError(data.error || "Não foi possível conectar. Tente novamente.", res.status); }
    return data;
  }
  async function upload(file: Blob, name: string) {
    const form = new FormData(); form.set("sessionId", state.current.sessionId); form.set("file", file, name);
    return await api(undefined, "/api/embed/attachments", form) as Attachment;
  }
  async function refresh() {
    if (!state.current.sessionId || state.current.polling) return;
    state.current.polling = true;
    const sessionId = state.current.sessionId;
    try {
      const s: Snapshot = await api();
      if (state.current.sessionId !== sessionId) return;
      setSnapshot(s); setConnected(true);
      post("cancelCommands", { ids: s.commands.map(c => c.id) });
      for (const c of s.commands) {
        if (state.current.handled.has(c.id)) continue;
        state.current.handled.add(c.id);
        if (c.status === "delivered") {
          // A reload must never replay a click whose effect is unknown.
          await api({ action: "result", commandId: c.id, success: false, result: { error: "A página recarregou durante a ação. O efeito não foi confirmado; não repita automaticamente." } });
          continue;
        }
        await api({ action: "claim", commandId: c.id });
        post("command", { command: c });
      }
    } catch { setConnected(false); }
    finally { state.current.polling = false; }
  }
  useEffect(() => {
    const parent = new URLSearchParams(location.search).get("parent");
    if (!parent || window.parent === window) return;
    try { if (new URL(parent).origin !== parent) return; } catch { return; }
    state.current.parent = parent;
    async function receive(event: MessageEvent<Wire>) {
      if (event.source !== window.parent || event.origin !== parent || event.data?.channel !== "agentflows" || event.data.version !== 1) return;
      const m = event.data;
      try {
        if (m.type === "resetConnection") {
          state.current.sessionId = ""; state.current.handled.clear(); state.current.pendingMessage = null;
          setSnapshot(null); setDraft(""); setFiles([]); setConnected(false);
        } else if (m.type === "init") {
          if (state.current.handshake) return;
          state.current.handshake = true;
          try {
            state.current.token = String(m.token || ""); state.current.init = m;
            const s: Snapshot = await api({ action: "connect", origin: parent, sessionId: state.current.sessionId || m.sessionId || "", tabId: m.tabId, capabilities: m.capabilities });
            state.current.sessionId = s.sessionId; setSnapshot(s); setConnected(true); setError("");
            post("session", { sessionId: s.sessionId }); post("connected");
          } finally { state.current.handshake = false; }
        } else if (m.type === "draft") setDraft(String(m.value || ""));
        else if (m.type === "connectionError") { setError("Não foi possível conectar. Entre na aplicação e tente novamente."); setConnected(false); }
        else if (m.type === "heartbeat" && state.current.sessionId) await api({ action: "heartbeat" });
        else if (m.type === "attachment" && m.file instanceof Blob && state.current.sessionId) {
          const a = await upload(m.file, String(m.name || "captura.png")); setFiles(prev => prev.length < 5 ? [...prev, a] : prev);
          await api({ action: "event", name: "page.attachmentShared", data: { attachmentId: a.id } });
        }
        else if (m.type === "event" && state.current.sessionId) await api({ action: "event", name: m.name, data: m.data });
        else if (m.type === "result" && state.current.sessionId) {
          let result = m.result as Record<string, unknown>;
          if (result?.blob instanceof Blob) {
            const a = await upload(result.blob, "captura.png"); result = { attachmentId: a.id, context: result.context };
          }
          await api({ action: "result", commandId: m.commandId, success: m.success, result });
          post("resultAccepted", { commandId: m.commandId, navigate: result?.navigationRequested });
          await refresh();
        }
      } catch (e) {
        // A cancelled/expired command may finish locally after the server has closed it.
        if (m.type === "result" && e instanceof EmbedApiError && e.status === 409) return;
        setError(e instanceof Error ? e.message : "Não foi possível concluir.");
      }
    }
    window.addEventListener("message", receive); post("ready");
    const timer = setInterval(() => { void refresh(); }, 1200);
    return () => { clearInterval(timer); window.removeEventListener("message", receive); };
    // The bridge reads mutable credentials from a ref; listener identity stays stable across messages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const el = messages.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 180) el.scrollTop = el.scrollHeight;
  }, [snapshot]);
  const active = snapshot?.turns.findLast(t => t.status === "running" || t.status === "waiting");
  async function act(fn: () => Promise<void>) { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Não foi possível concluir."); } finally { setBusy(false); } }
  async function send() {
    if (!draft.trim() || busy || active || !connected) return;
    await act(async () => {
      const pending = state.current.pendingMessage;
      const requestId = pending?.input === draft ? pending.requestId : crypto.randomUUID();
      state.current.pendingMessage = { requestId, input: draft };
      await api({ action: "message", input: draft, requestId, attachments: files.map(f => f.id) });
      state.current.pendingMessage = null; setDraft(""); setFiles([]); post("draft", { value: "" }); await refresh();
    });
  }
  async function decision(runId: string, value: string) { await act(async () => { await api({ action: "decision", runId, decision: value }); setConfirmation(null); await refresh(); }); }
  async function newSession() {
    await act(async () => {
      const init = state.current.init; if (!init) return;
      const s: Snapshot = await api({ action: "connect", origin: state.current.parent, sessionId: "", tabId: init.tabId, capabilities: init.capabilities });
      state.current.sessionId = s.sessionId; state.current.handled.clear(); state.current.pendingMessage = null;
      setSnapshot(s); setDraft(""); setFiles([]); setConfirmNew(false); post("session", { sessionId: s.sessionId }); post("draft", { value: "" });
    });
  }
  function tempoRelativo(value: string) {
    const minutos = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
    if (minutos < 1) return "agora";
    if (minutos < 60) return `há ${minutos} min`;
    const horas = Math.floor(minutos / 60);
    if (horas < 24) return `há ${horas} h`;
    const dias = Math.floor(horas / 24);
    if (dias < 7) return `há ${dias} ${dias === 1 ? "dia" : "dias"}`;
    return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }
  function marcadorData(value: string) {
    const data = new Date(value), hoje = new Date(now);
    const meiaNoite = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dias = Math.round((meiaNoite(hoje) - meiaNoite(data)) / 86_400_000);
    const chave = `${data.getFullYear()}-${data.getMonth()}-${data.getDate()}`;
    if (dias <= 0) return { chave, texto: "Hoje" };
    if (dias === 1) return { chave, texto: "Ontem" };
    if (dias < 7) {
      const dia = new Intl.DateTimeFormat("pt-BR", { weekday: "long" }).format(data);
      return { chave, texto: dia[0].toLocaleUpperCase("pt-BR") + dia.slice(1) };
    }
    return { chave, texto: new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: "numeric" }).format(data) };
  }
  let diaAnterior = "";
  const nomeVisivel = agentName.trim() || "Assistente";
  return <main className="embed-chat">
    <header className="embed-header"><span className="embed-avatar" aria-hidden="true">{avatarUrl && !avatarError ? <img src={avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setAvatarError(true)}/> : <span className="embed-avatar-initial">{Array.from(nomeVisivel)[0]?.toLocaleUpperCase("pt-BR") || "A"}</span>}</span><div><strong>{nomeVisivel}</strong><small>{title.trim() || (connected ? "Aqui para ajudar" : "Conectando…")}</small></div><button className="embed-header-action embed-clear" title="Limpar conversa" aria-label="Limpar conversa" onClick={() => setConfirmNew(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 21 9.6-9.6a2.1 2.1 0 0 0 0-3l-2-2a2.1 2.1 0 0 0-3 0L3 18v3h4Z"/><path d="m5 16 5 5M13 8l4 4M7 21h14"/></svg></button><button className="embed-header-action embed-close" title="Fechar conversa" aria-label="Fechar conversa" onClick={() => post("close")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
    <div className="embed-messages" ref={messages}>
      {!snapshot?.turns.length && <div className="embed-welcome"><span aria-hidden="true">✧</span><h1>Vamos melhorar juntos?</h1><p>{welcome}</p><div className="embed-suggestions">Você pode descrever uma melhoria ou mostrar algo que não funcionou.</div></div>}
      {snapshot?.turns.map(t => {
        const entradaDia = marcadorData(t.createdAt);
        const mostrarEntradaDia = entradaDia.chave !== diaAnterior;
        diaAnterior = entradaDia.chave;
        const respostaVisivel = !!t.output && (t.status === "completed" || t.status === "waiting");
        const respostaHora = t.updatedAt || t.createdAt;
        const respostaDia = respostaVisivel ? marcadorData(respostaHora) : null;
        const mostrarRespostaDia = !!respostaDia && respostaDia.chave !== diaAnterior;
        if (respostaDia) diaAnterior = respostaDia.chave;
        return <div className="embed-turn" key={t.id}>
          {mostrarEntradaDia && <div className="embed-date-separator"><span>{entradaDia.texto}</span></div>}
          <div className="embed-chat-message user"><div className="embed-message user">{t.input}</div><time className="embed-time" dateTime={t.createdAt} title={new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeStyle: "short" }).format(new Date(t.createdAt))}>{tempoRelativo(t.createdAt)}</time></div>
          {respostaVisivel && <>{mostrarRespostaDia && respostaDia && <div className="embed-date-separator"><span>{respostaDia.texto}</span></div>}<div className="embed-chat-message assistant"><div className="embed-message assistant">{t.images?.length ? t.output.replace(/!\[[^\]]*\]\(\/api\/attachments\/[0-9a-f-]{36}( "video")?\)/g, (_, video) => video ? "Vídeo gerado." : "Imagem gerada.") : t.output}{t.images?.map(image => <p key={image.id}><button onClick={() => void downloadImage(image.id, image.name)}>Baixar {image.name}</button></p>)}</div><time className="embed-time" dateTime={respostaHora} title={new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeStyle: "short" }).format(new Date(respostaHora))}>{tempoRelativo(respostaHora)}</time></div></>}
          {t.status === "waiting" && <div className="embed-approval"><strong>{"Sua decisão faz parte do próximo passo"}</strong><p>{"Revise o resultado acima e escolha como seguir."}</p><div><button disabled={busy || !connected} onClick={() => void decision(t.id, "yes")}>Aprovar e continuar</button>{<button className="secondary" disabled={busy || !connected} onClick={() => void decision(t.id, "no")}>Não aprovar</button>}</div></div>}
          {t.status === "failed" && <p className="embed-error">{t.error || "Não foi possível concluir esta tarefa."}</p>}
          {t.status === "cancelled" && <p className="embed-note">Cancelamento solicitado. Novas etapas foram bloqueadas; ações externas já iniciadas podem terminar.</p>}
        </div>;
      })}
    </div>
    {confirmNew && <section className="embed-confirm"><strong>Limpar esta conversa?</strong><p>{active ? "Conclua ou cancele a tarefa atual antes de limpar a conversa." : "A conversa atual continuará registrada no histórico do fluxo."}</p><button disabled={!!active || busy} onClick={() => void newSession()}>Limpar conversa</button><button className="secondary" onClick={() => setConfirmNew(false)}>Voltar</button></section>}
    {confirmation && <section className="embed-confirm"><strong>{confirmation.decision === "cancel" ? "Cancelar a tarefa?" : "Retomar a etapa interrompida?"}</strong><p>{confirmation.decision === "cancel" ? "Vamos interromper o trabalho. Ações já concluídas não serão desfeitas." : "Confira se a ação anterior já aconteceu. Retomar pode repetir efeitos externos e consome uma tentativa."}</p><button disabled={busy} onClick={() => void decision(confirmation.runId, confirmation.decision)}>Confirmar</button><button className="secondary" onClick={() => setConfirmation(null)}>Voltar</button></section>}
    {snapshot && !connected && <p className="embed-note" role="status">Reconectando à conversa… sua tarefa continua no servidor.</p>}
    {error && <div className="embed-error" role="alert">{error}<button className="secondary" onClick={() => { setError(""); post("refreshToken"); }}>Reconectar</button></div>}
    <footer className="embed-footer">
      {active && <button className="embed-stop" disabled={busy} onClick={() => setConfirmation({runId:active.id,decision:"cancel"})}>■ Cancelar tarefa</button>}
      {files.length > 0 && <div className="embed-files">{files.map(f => <button key={f.id} onClick={() => setFiles(files.filter(a => a.id !== f.id))}>{f.name} ×</button>)}</div>}
      <form onSubmit={e => { e.preventDefault(); void send(); }}><textarea ref={textarea} rows={1} aria-label="Sua mensagem" placeholder="Digite aqui..." value={draft} maxLength={20000} disabled={!!active} onChange={e => { setDraft(e.target.value); post("draft", {value:e.target.value}); }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/><div className="embed-compose-actions"><button type="submit" disabled={busy || !!active || !connected || !draft.trim()} aria-label="Enviar mensagem">↑</button></div></form>
      <small className="embed-brand">Build Agentflows</small>
    </footer>
  </main>;
}
