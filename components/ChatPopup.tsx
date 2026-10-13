"use client";
import { modelProviderId } from "@/lib/ai-providers";
import { graphMediaModels } from "@/lib/media-models";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { INITIAL_VOICE, VoiceSession, type VoiceState } from "@/lib/voice-session";
import { openVoiceAudio } from "@/lib/voice-browser";
import type { Graph, Run } from "@/lib/flow-types";
import { ATTACHMENT_ACCEPT, MAX_ATTACHMENTS, MAX_FILE_BYTES, MAX_TOTAL_BYTES, type Attachment } from "@/lib/attachment-types";
import { imageIssues, type ModelCapability } from "@/lib/model-capabilities";
import { ChatAttachments } from "./ChatAttachments";
import type { RouterModel } from "./ModelPicker";
import { ChatEvidence } from "./ChatEvidence";
import { formatCost, runCost } from "@/lib/token-usage";
import { queueExplanation, queueLabel } from "@/lib/queue-status";
import { TraceDetails, TraceRow } from "./TraceDetails";
import { Icon, pollRun, request, RequestError } from "./StudioUI";
const STATUS: Record<Run["status"], string> = {
  running: "Em execução",
  waiting: "Aguardando sua decisão",
  completed: "Concluída",
  failed: "Falhou",
  cancelled: "Cancelada",
};
function MessageTime({ date, active }: { date: string; active: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const refresh = () => setNow(Date.now());
    const initial = setTimeout(refresh, 0);
    const timer = setInterval(refresh, 30000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [active]);
  const timestamp = new Date(date);
  if (!Number.isFinite(timestamp.getTime())) return null;
  const minutes = Math.max(0, Math.floor((now - timestamp.getTime()) / 60000));
  const hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  const label = minutes < 1 ? "Agora" : minutes < 60 ? `${minutes} min atrás`
    : hours < 24 ? `${hours} h atrás` : days === 1 ? "Ontem"
    : days < 7 ? `${days} dias atrás` : timestamp.toLocaleDateString("pt-BR");
  const full = timestamp.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  return <time dateTime={date} title={full} aria-label={full}>{label}</time>;
}
// Resposta do fluxo em formato de balão, com as etapas executadas, o estado e a aprovação em linha.
function BotMessage({
  run,
  active,
  onChange,
}: {
  run: Run;
  active: boolean;
  onChange: (r: Run) => void;
}) {
  const [selectedTrace, setSelectedTrace] = useState<number | null>(null);
  const cost = runCost(run.trace);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function act(action: string, decision?: string) {
    setBusy(true);
    setError("");
    try {
      onChange(
        await request<Run>("/api/runs/" + run.id, "POST", { action, decision }),
      );
    } catch (e) {
      // The first click may have landed although its response was lost: show the run as it is now.
      const latest = e instanceof RequestError && e.status === 409 ? await pollRun<Run>(run.id).catch(() => null) : null;
      if (latest && latest.status !== run.status) onChange(latest);
      else setError(e instanceof Error ? e.message : "Não foi possível continuar.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={"chat-msg bot " + run.status}>
      {selectedTrace !== null && run.trace[selectedTrace] && <TraceDetails trace={run.trace[selectedTrace]} kind={run.graph.nodes.find((node) => node.id === run.trace[selectedTrace].nodeId)?.data.kind} onClose={() => setSelectedTrace(null)} />}
      <span className="chat-avatar">
        <Icon name="agent" size={16} />
      </span>
      <div className="chat-bubble">
        {run.trace.length > 0 && (
          <details className="chat-steps">
            <summary>
              <Icon name="runs" size={13} />
              Etapas executadas
              <span>{run.trace.length}</span>
            </summary>
            <ol>
              {run.trace.map((t, i) => (
                <li key={i}>
                  <TraceRow trace={t} onOpen={() => setSelectedTrace(i)} />
                </li>
              ))}
            </ol>
            {Object.keys(run.state).length > 0 && (
              <pre className="chat-state">
                {JSON.stringify(run.state, null, 2)}
              </pre>
            )}
          </details>
        )}
        <div className="chat-text">
          {run.queued && run.status === "running"
            ? <p className="chat-queue" role="status"><span className="studio-spinner" />{queueExplanation(run.queue)}</p>
            : <ChatEvidence run={run} onOpenTool={setSelectedTrace} />}
        </div>
        {run.error && (
          <p className="studio-error" role="alert">
            {run.error}
          </p>
        )}
        {error && (
          <p className="studio-error" role="alert">
            {error}
          </p>
        )}
        {run.status === "waiting" && (
          <div className="chat-approval">
            <p>Este fluxo precisa da sua decisão.</p>
            <button
              className="studio-button primary"
              disabled={busy}
              onClick={() => act("resume", "yes")}
            >
              Aprovar e continuar
            </button>
            <button
              className="studio-button"
              disabled={busy}
              onClick={() => act("resume", "no")}
            >
              Rejeitar
            </button>
          </div>
        )}
        <footer>
          <MessageTime date={run.updatedAt || run.createdAt} active={active} />
          {cost !== undefined && <span className="chat-run-cost" title="Soma dos custos informados pelos provedores nesta execução">{formatCost(cost)}</span>}
          {run.status !== "completed" && <span>{run.queued && run.status === "running" ? queueLabel(run.queue) : STATUS[run.status]}</span>}
          {["waiting", "running"].includes(run.status) && (
            <button disabled={busy} onClick={() => act("cancel")}>
              Cancelar execução
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
export function ChatPopup({
  open,
  session,
  pendingInput,
  pendingAttachments,
  graph,
  chatModels,
  error,
  running,
  demo,
  connected,
  expanded,
  voice = false,
  voiceId,
  onVoiceSettings,
  flowId,
  onSend,
  onChange,
  onConnect,
}: {
  open: boolean;
  session: Run[];
  pendingInput: string;
  pendingAttachments: Attachment[];
  graph: Graph;
  chatModels: ModelCapability[];
  error: string;
  running: boolean;
  demo: boolean;
  connected: boolean;
  expanded: boolean;
  voice?: boolean;
  voiceId: string;
  onVoiceSettings: () => void;
  flowId: string;
  onSend: (input: string, attachments: Attachment[]) => Promise<Run | null>;
  onChange: (r: Run) => void;
  onConnect: () => void;
}) {
  const [input, setInput] = useState(""),
    [recording, setRecording] = useState(false),
    [transcribing, setTranscribing] = useState(false),
    [voiceError, setVoiceError] = useState(""),
    recorder = useRef<MediaRecorder | null>(null),
    scroll = useRef<HTMLDivElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [directModels, setDirectModels] = useState<ModelCapability[]>([]);
  const [routerModels, setRouterModels] = useState<ModelCapability[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const uploadLock = useRef(false);
  const sendLock = useRef(false);
  const recordingAllowed = useRef(open);
  const dictationAbort = useRef<AbortController | null>(null);
  const hasImages = attachments.some((a) => a.kind === "image");
  const issues = hasImages ? imageIssues(graph, [...chatModels, ...routerModels, ...directModels, ...graphMediaModels(graph.nodes.map((n) => n.data.config.model))]) : [];
  const [voiceState, setVoiceState] = useState<VoiceState>({ ...INITIAL_VOICE });
  const conversation = useRef<VoiceSession | null>(null);
  const latest = useRef({ onSend, attachments, voiceId });
  useEffect(() => { latest.current = { onSend, attachments, voiceId }; }, [onSend, attachments, voiceId]);
  const voiceMode = voiceState.phase !== "idle";
  const voiceBusy = ["connecting", "transcribing", "thinking", "waiting", "error"].includes(voiceState.phase);
  const canSend = !voiceBusy && !running && !sending && !uploading && !recording && !transcribing && (demo || connected) && !issues.length && !(demo && attachments.length);
  function endVoice() { conversation.current?.stop(); conversation.current = null; }
  function beginVoice() {
    if (!voice || !connected || demo || running || recording || transcribing || uploading || issues.length) return;
    endVoice(); setVoiceError("");
    const engine = new VoiceSession({
      openAudio: openVoiceAudio,
      onChange: setVoiceState,
      transcribe: async (blob, signal) => {
        const form = new FormData(); form.set("audio", blob);
        const response = await fetch("/api/voz/transcrever", { method: "POST", body: form, signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Não foi possível transcrever.");
        return data.texto || "";
      },
      respond: async (text) => {
        setInput(text);
        const result = await latest.current.onSend(text, latest.current.attachments);
        if (result) { setInput(""); setAttachments([]); }
        return result;
      },
      synthesize: async (text, signal) => {
        const response = await fetch("/api/voz/falar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texto: text, voz: latest.current.voiceId }), signal });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Não foi possível falar a resposta.");
        return response.arrayBuffer();
      },
    });
    conversation.current = engine;
    void engine.start();
  }
  useEffect(() => {
    if (!open) conversation.current?.stop();
  }, [open]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) conversation.current?.stop(); };
    const stop = () => conversation.current?.stop();
    document.addEventListener("visibilitychange", hidden); window.addEventListener("pagehide", stop);
    return () => { stop(); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", stop); };
  }, []);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void request<{ conectado: boolean; modelos: RouterModel[] }>("/api/conexoes/modelos").then((r) => {
      if (alive) setRouterModels(r.conectado ? r.modelos.map((m) => ({ id: `openrouter:${m.id}`, name: m.nome, inputModalities: m.inputModalities || ["text"] })) : []);
    }).catch(() => { if (alive) setRouterModels([]); });
    const direct = graph.nodes.filter(n => ["llm", "agent"].includes(n.data.kind)).map(n => ({ provider: modelProviderId(n.data.config.model), credentialId: n.data.config.modelCredentialId || "" })).filter(p => ["openai", "google", "anthropic", "groq"].includes(p.provider));
    void Promise.all(direct.map(p => request<{ models: ModelCapability[] }>(`/api/conexoes/provedores?${new URLSearchParams(p)}`).then(r => r.models).catch(() => []))).then(models => { if (alive) setDirectModels(models.flat()); });
    textarea.current?.focus();
    return () => { alive = false; };
  }, [open, graph]);
  useEffect(() => {
    recordingAllowed.current = open;
    if (!open) dictationAbort.current?.abort();
    if (!open && recorder.current?.state === "recording") recorder.current.stop();
  }, [open]);
  useEffect(() => () => {
    recordingAllowed.current = false;
    dictationAbort.current?.abort();
    const rec = recorder.current;
    if (rec) {
      rec.onstop = null;
      if (rec.state !== "inactive") rec.stop();
      rec.stream.getTracks().forEach((t) => t.stop());
    }
  }, []);
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    const resize = () => {
      const style = getComputedStyle(el);
      const maxHeight = 3 * parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    };
    resize();
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        resize();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [input, open]);
  async function attach(files: File[]) {
    if (!files.length || uploadLock.current || sendLock.current || running) return;
    setAttachmentError("");
    if (demo) { setAttachmentError("Conecte um modelo de IA para analisar anexos. A simulação aceita apenas mensagens de texto."); return; }
    if (attachments.length + files.length > MAX_ATTACHMENTS) { setAttachmentError("Use até 5 arquivos por mensagem."); return; }
    if (files.some((f) => f.size > MAX_FILE_BYTES) || [...attachments, ...files].reduce((sum, f) => sum + f.size, 0) > MAX_TOTAL_BYTES) {
      setAttachmentError("Use até 10 MB por arquivo e 20 MB por mensagem."); return;
    }
    uploadLock.current = true; setUploading(true);
    const errors: string[] = [];
    for (const file of files) {
      try {
        const form = new FormData(); form.set("file", file);
        const response = await fetch(`/api/flows/${flowId}/attachments`, { method: "POST", body: form });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Não foi possível anexar.");
        setAttachments((items) => [...items, data as Attachment]);
      } catch (e) { errors.push(`${file.name}: ${e instanceof Error ? e.message : "Não foi possível anexar."}`); }
    }
    setAttachmentError(errors.join(" ")); uploadLock.current = false; setUploading(false);
  }
  async function toggleRecording() {
    setVoiceError("");
    if (recording) {
      recorder.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!recordingAllowed.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        if (!recordingAllowed.current) return;
        setTranscribing(true);
        const abort = new AbortController(); dictationAbort.current = abort;
        try {
          const form = new FormData();
          form.set("audio", new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
          const r = await fetch("/api/voz/transcrever", { method: "POST", body: form, signal: abort.signal });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || "Não foi possível transcrever.");
          if (data.texto && !abort.signal.aborted) setInput((v) => (v ? v + " " : "") + data.texto);
        } catch (e) {
          if (!abort.signal.aborted) setVoiceError(e instanceof Error ? e.message : "Não foi possível transcrever.");
        } finally {
          setTranscribing(false);
        }
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setVoiceError("Permita o uso do microfone para falar com o fluxo.");
    }
  }
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [session, running, voiceMode]);
  async function send() {
    if ((!input.trim() && !attachments.length) || !canSend || sendLock.current) return;
    if (voiceMode) { await conversation.current?.sendText(input.trim() || "Analise os anexos enviados."); return; }
    sendLock.current = true; setSending(true); setAttachmentError("");
    try {
      if (await onSend(input.trim() || "Analise os anexos enviados.", attachments)) {
        setInput(""); setAttachments([]);
      }
    } finally { sendLock.current = false; setSending(false); }
  }
  return (
    <section
      hidden={!open}
      className={"chat-popup" + (expanded ? " expanded" : "")}
      aria-label="Testar Fluxo Agêntico"
    >
      {voiceMode ? <div className={"voice-conversation " + voiceState.phase} aria-label="Conversa por voz">
        <div className="voice-mode-heading"><Icon name="wave" size={16} />Conversa por voz</div>
        <button className="voice-orb" type="button" aria-label={voiceState.phase === "speaking" ? "Interromper resposta e falar" : "Atividade da voz"} disabled={voiceState.phase !== "speaking"} onClick={() => conversation.current?.interrupt()} style={{ "--voice-level": voiceState.level } as CSSProperties}><span /><span /><span /></button>
        <div className="voice-status" role="status" aria-live="polite">
          <strong>{{ idle: "", connecting: "Ativando microfone…", listening: "Pode falar", hearing: "Estou ouvindo…", transcribing: "Entendendo sua mensagem…", thinking: "Preparando a resposta…", speaking: "Falando…", muted: "Microfone silenciado", waiting: "Sua aprovação é necessária", error: "Conversa pausada" }[voiceState.phase]}</strong>
          <p>{voiceState.phase === "speaking" ? "Fale para interromper ou toque na esfera." : voiceState.phase === "waiting" ? "Volte ao chat para revisar e aprovar a próxima etapa." : voiceState.phase === "muted" ? "Ative o microfone quando quiser continuar." : voiceState.phase === "listening" ? "Faça uma pausa ao terminar. Eu respondo em voz." : voiceState.phase === "error" ? voiceState.error : ""}</p>
        </div>
        {voiceState.transcript && <p className="voice-transcript">{voiceState.transcript}</p>}
        {voiceState.phase === "error" && <button type="button" className="studio-button" onClick={beginVoice}>Tentar novamente</button>}
        {voiceState.phase === "waiting" && <button type="button" className="studio-button" onClick={endVoice}>Voltar ao chat para aprovar</button>}
      </div> : <div className="chat-scroll" ref={scroll}>
        {!session.length && !running ? (
          <div className="chat-empty">
            <div className="chat-empty-icon">
              <Icon name="agent" size={34} />
            </div>
            <h3>Converse com seu fluxo</h3>
            <p>
              Envie uma mensagem para testar seus agentes e acompanhar o caminho
              percorrido.
            </p>
            {!connected && !demo && (
              <div className="chat-connect">
                <button type="button" className="studio-button connection-button" onClick={onConnect}>
                  <Icon name="spark" size={20} />
                  <span>Conectar ChatGPT</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            {session.map((r) => (
              <div key={r.id} className="chat-exchange">
                <div className="chat-msg user">
                  <div className="chat-bubble"><ChatAttachments items={r.attachments || []} />{r.input}</div>
                </div>
                <BotMessage run={r} active={open} onChange={onChange} />
              </div>
            ))}
            {running && !session.some((r) => r.status === "running") && (
              <div className="chat-exchange">
                <div className="chat-msg user">
                  <div className="chat-bubble"><ChatAttachments items={pendingAttachments} />{pendingInput}</div>
                </div>
                <div className="chat-msg bot">
                  <span className="chat-avatar">
                    <Icon name="agent" size={16} />
                  </span>
                  <div className="chat-bubble chat-thinking">
                    <span className="studio-spinner" />
                    Executando as etapas…
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>}
      <div className="chat-composer">
        {voiceError && (
          <p className="studio-error" role="alert">
            {voiceError}
          </p>
        )}
        {error && <p className="studio-error" role="alert">{error}</p>}
        {attachmentError && <p className="studio-error" role="alert">{attachmentError}</p>}
        {issues.length > 0 && <div className="chat-attachment-warning" role="status"><strong>Este fluxo precisa de um modelo que aceite imagens.</strong>{issues.map((issue) => <p key={issue.nodeId}>{issue.label}: {issue.reason}</p>)}<small>Edite o modelo do bloco ou remova as imagens para continuar.</small></div>}
        {demo && attachments.length > 0 && <p className="studio-error" role="alert">Desative a simulação e conecte um modelo para enviar estes anexos.</p>}
        <form
          className={"chat-input-box" + (dragging ? " dragging" : "")}
          onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.stopPropagation(); setDragging(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(false); void attach(Array.from(e.dataTransfer.files)); }}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <ChatAttachments items={attachments} disabled={running || sending || uploading} onRemove={(id) => { setAttachments((items) => items.filter((a) => a.id !== id)); setAttachmentError(""); }} />
          <textarea
            ref={textarea}
            aria-label="Mensagem para testar"
            placeholder={voiceMode ? "Digite durante a conversa…" : "Digite sua mensagem…"}
            rows={1}
            maxLength={20000}
            value={input}
            disabled={running || sending}
            onPaste={(e) => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); void attach(files); } }}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="chat-input-actions">
          <input ref={fileInput} hidden type="file" accept={ATTACHMENT_ACCEPT} multiple onChange={(e) => { void attach(Array.from(e.target.files || [])); e.target.value = ""; }} />
          <button type="button" className="chat-attach" aria-label="Anexar arquivos ou imagens" title="Anexar arquivos ou imagens" disabled={running || sending || uploading || demo} onClick={() => fileInput.current?.click()}><Icon name="paperclip" size={18} /></button>
          {voice && !voiceMode && (
            <button
              type="button"
              className={"chat-mic" + (recording ? " recording" : "")}
              title={recording ? "Parar gravação" : "Falar em vez de digitar"}
              aria-label={recording ? "Parar gravação" : "Falar em vez de digitar"}
              disabled={running || transcribing}
              onClick={toggleRecording}
            >
              {transcribing ? (
                <span className="studio-spinner" />
              ) : (
                <Icon name={recording ? "stop" : "mic"} size={17} />
              )}
            </button>
          )}
          {voiceMode && <button type="button" className={"chat-mic" + (voiceState.muted ? " muted" : "")} aria-label={voiceState.muted ? "Ativar microfone" : "Silenciar microfone"} title={voiceState.muted ? "Ativar microfone" : "Silenciar microfone"} aria-pressed={voiceState.muted} disabled={voiceState.phase === "connecting" || voiceState.phase === "error"} onClick={() => conversation.current?.setMuted(!voiceState.muted)}><Icon name={voiceState.muted ? "mic-off" : "mic"} size={18} /></button>}
          <span className="chat-input-hint" role="status">{uploading ? "Preparando anexos…" : transcribing ? "Transcrevendo…" : recording ? "Gravando…" : ""}</span>
          <button
            type="submit"
            className="chat-send"
            title="Enviar mensagem"
            aria-label="Enviar mensagem"
            disabled={!canSend || (!input.trim() && !attachments.length)}
          >
            {running || sending ? <span className="studio-spinner" /> : <Icon name="send" size={19} />}
          </button>
          {voiceMode ? <button type="button" className="chat-voice-end" aria-label="Encerrar conversa por voz" title="Encerrar conversa por voz" onClick={endVoice}><Icon name="close" size={20} /></button> : <button type="button" className="chat-voice-start" aria-label="Iniciar conversa por voz" title={voice ? "Iniciar conversa por voz" : "Configure a voz do fluxo"} disabled={voice && (!connected || demo || running || recording || transcribing || uploading || !!issues.length)} onClick={voice ? beginVoice : onVoiceSettings}><Icon name="wave" size={20} /></button>}
          </div>
        </form>
        {demo && <small>Demonstração · nenhuma ação externa</small>}
      </div>
    </section>
  );
}
