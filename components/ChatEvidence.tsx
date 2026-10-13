"use client";
import { useState } from "react";
import { toolTitle } from "@/lib/tool-presentation";
import type { Run } from "@/lib/flow-types";
import { chatReferences, referenceUrl, type KnowledgeReference } from "@/lib/knowledge-references";
import { Icon, Modal } from "./StudioUI";
import { MarkdownContent } from "./MarkdownContent";
import { traceDuration } from "./TraceDetails";

export function ChatEvidence({ run, onOpenTool }: { run: Run; onOpenTool: (index: number) => void }) {
  const [selected, setSelected] = useState<KnowledgeReference | null>(null);
  const { text, chunks } = chatReferences(run.output, run.trace.flatMap(trace => trace.knowledge ? [trace.knowledge] : []));
  const tools = run.trace.flatMap((trace, index) => trace.type === "tool" || run.graph.nodes.some(node => node.id === trace.nodeId && node.data.kind === "tool") ? [{ trace, index }] : []);
  const url = referenceUrl(selected?.source);
  return <>
    <MarkdownContent>{text || (run.status === "running" ? "Pensando…" : "Sem resposta.")}</MarkdownContent>
    {!!chunks.length && <section className="chat-evidence" aria-label="Referências">
      <h3>Referências <span>{chunks.length}</span></h3>
      <div className="chat-evidence-badges">{chunks.map((chunk, index) => <button type="button" className="chat-evidence-badge" key={JSON.stringify([chunk.baseId, chunk.id, chunk.pageContent])} onClick={() => setSelected(chunk)} title={`${chunk.baseName} · ${chunk.sourceName} · Chunk ${chunk.ordinal}`} aria-label={`Abrir referência ${index + 1}: ${chunk.sourceName}, chunk ${chunk.ordinal}`}>
        <Icon name="book" size={13} /><span className="chat-evidence-number">{index + 1}</span><span className="chat-evidence-label">{chunk.sourceName}</span><Icon name="expand" size={12} />
      </button>)}</div>
    </section>}
    {!!tools.length && <section className="chat-evidence" aria-label="Ferramentas utilizadas">
      <h3>Ferramentas utilizadas <span>{tools.length}</span></h3>
      <div className="chat-evidence-badges">{tools.map(({ trace, index }, call) => {
        const status = trace.status === "running" ? "Em execução" : trace.status === "failed" ? "Falhou" : "Concluída";
        return <button type="button" className={`chat-evidence-badge ${trace.status || "completed"}`} key={index} onClick={() => onOpenTool(index)} title={`${trace.label} · ${status} · ${traceDuration(trace.ms)}`} aria-label={`Ver chamada ${call + 1}: ${trace.label} · ${status}`}>
          <Icon name="tool" size={13} /><span className="chat-evidence-label">{trace.label.startsWith("Ferramenta: ") ? toolTitle({ name: trace.label.slice(12) }) : trace.label}</span><Icon name={trace.status === "failed" ? "close" : trace.status === "running" ? "history" : "check"} size={12} />
        </button>;
      })}</div>
    </section>}
    {selected && <Modal title={`Chunk ${selected.ordinal}`} onClose={() => setSelected(null)} wide className="chunk-reference-dialog">
      <dl className="chunk-reference-info">
        <div><dt>Base de conhecimento</dt><dd>{selected.baseName}</dd></div>
        <div><dt>Documento</dt><dd>{selected.sourceName}</dd></div>
        {selected.page !== undefined && <div><dt>Página</dt><dd>{selected.page}</dd></div>}
        {selected.source && selected.source !== "Texto adicionado" && <div><dt>Origem</dt><dd>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{selected.source}<Icon name="link" size={12} /></a> : selected.source}</dd></div>}
      </dl>
      <h3 className="chunk-reference-heading">Conteúdo completo</h3>
      <pre className="chunk-reference-content">{selected.pageContent}</pre>
    </Modal>}
  </>;
}
