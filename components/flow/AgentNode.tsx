"use client";
import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Handle,
  useNodesData,
  useUpdateNodeInternals,
  NodeToolbar,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { Block } from "@/lib/flow-types";
import { NODE_STYLE } from "@/lib/flow-presets";
import { outputs } from "@/lib/flow-graph";
import { Icon, IconButton } from "../StudioUI";
import { ToolLogo } from "../ToolSelect";
import { toolTitle } from "@/lib/tool-presentation";
import { knowledgeBaseIds } from "@/lib/knowledge-settings";
import { modelLabel, modelProvider } from "../ModelPicker";
import { DECISION_MODELS, decisionProvider } from "@/lib/flow-decisions";
export type VisualData = Block["data"] & {
  execution?: string;
  /** Shown under the block while the run waits in the queue. */
  executionLabel?: string;
  connected?: (string | null)[];
  edit?: () => void;
  duplicate?: () => void;
  remove?: () => void;
  info?: () => void;
  rename?: (label: string) => void;
};
export type VisualNode = Node<VisualData, "block">;
// Seta em círculo usada nas saídas (mesmo desenho do Flowise Agentflows v2).
export const CHEVRON =
  "M12 2c5.523 0 10 4.477 10 10a10 10 0 0 1 -20 0c0 -5.523 4.477 -10 10 -10m-.293 6.293a1 1 0 0 0 -1.414 0l-.083 .094a1 1 0 0 0 .083 1.32l2.292 2.293l-2.292 2.293a1 1 0 0 0 1.414 1.414l3 -3a1 1 0 0 0 0 -1.414z";
function AgentNodeView({ id, data, selected }: NodeProps<VisualNode>) {
  const [hover, setHover] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showOptions = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setHover(true);
  };
  const hideOptions = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHover(false), 150);
  };
  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);
  const [editing, setEditing] = useState<string | null>(null);
  const outs = outputs(data.kind, data.config);
  // Repetir não tem setas: o destino aparece como etiqueta no próprio bloco.
  const loopTarget = useNodesData<VisualNode>(data.kind === "loop" && data.config.target ? data.config.target : "");
  const updateNodeInternals = useUpdateNodeInternals();
  const outputSignature = outs.map((output) => output.id).join(',');
  useEffect(() => { updateNodeInternals(id); }, [id, outputSignature, updateNodeInternals]);
  const finishRename = () => {
    const label = (editing ?? "").trim();
    if (label && label !== data.label) data.rename?.(label);
    setEditing(null);
  };
  const tools = data.kind === "agent" ? [...new Set((data.config.tools || "").split(",").map(id => id.trim()).filter(Boolean))] : [];
  let knowledgeCount = 0;
  if (["agent", "llm"].includes(data.kind)) {
    try { knowledgeCount = knowledgeBaseIds(data.config).length; } catch { /* Incomplete drafts are validated in the editor. */ }
  }
  return (
    <div
      className={
        "af-node" +
        (data.kind === "condition" ? " af-condition" : "") +
        (selected ? " selected" : "") +
        (hover ? " hover" : "") +
        (data.execution ? " execution-" + data.execution : "")
      }
      style={{ "--node-color": NODE_STYLE[data.kind].color, "--output-count": outs.length } as CSSProperties}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") showOptions(); }}
      onPointerLeave={(event) => { if (event.pointerType !== "touch") hideOptions(); }}
    >
      <NodeToolbar className="af-toolbar" offset={8} isVisible={!!selected || hover}
        onPointerEnter={(event) => { if (event.pointerType !== "touch") showOptions(); }}
        onPointerLeave={(event) => { if (event.pointerType !== "touch") hideOptions(); }}>
        <IconButton
          icon="settings"
          label="Editar bloco"
          onClick={() => data.edit?.()}
        />
        {data.kind !== "start" && (
          <IconButton
            icon="copy"
            label="Duplicar bloco"
            onClick={() => data.duplicate?.()}
          />
        )}
        <IconButton
          icon="trash"
          label="Excluir bloco"
          onClick={() => data.remove?.()}
        />
        <IconButton
          icon="info"
          label="Sobre este bloco"
          onClick={() => data.info?.()}
        />
      </NodeToolbar>
      {data.kind !== "start" && (
        <Handle type="target" position={Position.Left} className="af-handle-in" title="Entrada: conecte a saída de outro bloco aqui" aria-label={`Entrada de ${data.label}`}>
          <span />
        </Handle>
      )}
      <div className="af-node-body">
        <span className="af-node-icon">
          <Icon name={data.kind} size={24} />
        </span>
        <div className="af-node-text">
          {editing === null ? (
            <span className="af-node-title">
              <strong>{data.kind === "start" ? "Início" : data.label}</strong>
              {data.kind !== "start" && <button
                type="button"
                className="af-node-pencil nodrag"
                title="Renomear bloco"
                aria-label="Renomear bloco"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(data.label);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <Icon name="pencil" size={12} />
              </button>}
            </span>
          ) : (
            <span className="af-node-title">
              <input
                autoFocus
                className="af-node-rename nodrag nopan"
                value={editing}
                maxLength={100}
                aria-label="Nome do bloco"
                onChange={(e) => setEditing(e.target.value)}
                onBlur={finishRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur(); }
                  if (e.key === "Escape") setEditing(null);
                  e.stopPropagation();
                }}
                onDoubleClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              />
              <button
                type="button"
                className="af-node-pencil af-node-ok nodrag"
                title="Salvar nome"
                aria-label="Salvar nome"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  finishRename();
                }}
              >
                <Icon name="check" size={13} />
              </button>
            </span>
          )}
          {(data.kind === "agent" || data.kind === "llm") && (
            <span className="af-pill" title={modelProvider(data.config.model)}>
              <Icon name={modelProvider(data.config.model) === "ChatGPT" ? "spark" : "link"} size={13} />
              {modelLabel(data.config.model)}
            </span>
          )}
          {data.kind === "decision" && (
            <span className="af-pill" title={decisionProvider(data.config.model) === "openai" ? "OpenAI" : "OpenRouter"}>
              <Icon name="link" size={13} />
              {DECISION_MODELS.find((m) => m.id === data.config.model)?.name || modelLabel(data.config.model)}
            </span>
          )}
          {data.kind === "loop" && (
            <span className="af-pill" title={loopTarget ? `Volta para ${loopTarget.data.label}` : "Escolha o bloco para onde voltar"}>
              <Icon name="loop" size={13} />
              {loopTarget ? loopTarget.data.label : "Escolha o destino"}
            </span>
          )}
          {data.kind === "start" && (
            <span className="af-pill">
              <Icon name="chat" size={13} />
              Conversa
            </span>
          )}
          {data.kind === "tool" && data.config.tool && (
            <span className="af-pill">
              <Icon name="tool" size={12} />
              {data.config.tool.split(":").pop()}
            </span>
          )}
          {(tools.length > 0 || knowledgeCount > 0) && (
            <span className="af-pills">
              {tools.map(id => {
                const title = toolTitle({ id, name: id.split(":").pop() || id });
                return <span key={id} className="af-tool-icon" title={title} role="img" aria-label={title}><ToolLogo id={id} /></span>;
              })}
              {knowledgeCount > 0 && <span className="af-tool-icon" title={`${knowledgeCount} ${knowledgeCount === 1 ? "base de conhecimento" : "bases de conhecimento"}`} role="img" aria-label={`${knowledgeCount} ${knowledgeCount === 1 ? "base de conhecimento" : "bases de conhecimento"}`}><Icon name="book" size={15} /></span>}
            </span>
          )}
        </div>
      </div>
      {outs.map((o, i) => (
        <Handle
          key={o.id || "out"}
          type="source"
          position={Position.Right}
          id={o.id || undefined}
          className="af-handle-out"
          title={data.kind === "condition" ? `Saída ${i + 1}: ${i === outs.length - 1 ? "quando nenhum critério é atendido" : `critério ${i + 1}`}` : data.connected?.includes(o.id) ? "Saída conectada. Selecione a linha para remover a conexão." : "Arraste até a entrada de outro bloco para conectar"}
          aria-label={`Saída${o.label ? " " + o.label : ""} de ${data.label}`}
          style={{ top: `${(100 * (i + 1)) / (outs.length + 1)}%` }}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d={CHEVRON} fill="currentColor" />
          </svg>
          {o.label && !data.connected?.includes(o.id) && (
            <span className="af-handle-label">{o.label}</span>
          )}
        </Handle>
      ))}
      {data.execution && (
        <span
          className={"node-execution-badge " + data.execution}
          title={
            data.execution === "running"
              ? "Em execução"
              : data.execution === "queued"
                ? data.executionLabel || "Na fila"
              : data.execution === "failed"
                ? "Falhou nesta etapa"
                : data.execution === "waiting"
                  ? "Aguardando decisão"
                  : "Concluído"
          }
        >
          {data.execution === "running" || data.execution === "queued" ? (
            <span className="studio-spinner" />
          ) : (
            <Icon
              name={
                data.execution === "failed"
                  ? "close"
                  : data.execution === "waiting"
                    ? "approval"
                    : "check"
              }
              size={13}
            />
          )}
        </span>
      )}
      {data.execution === "queued" && (
        <span className="node-execution-label" role="status">{data.executionLabel || "Na fila"}</span>
      )}
    </div>
  );
}
export const AgentNode = memo(AgentNodeView);
