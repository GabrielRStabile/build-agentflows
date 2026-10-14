"use client";
import { KnowledgeAgentFields } from "./KnowledgeAgentFields";
import { knowledgeSettings } from "@/lib/knowledge-settings";
import { useEffect, useState } from "react";
import { conditionCriteria, COMPARISONS, type Criterion } from "@/lib/flow-conditions";
import { BLOCKS, DEFAULT_SYSTEM, type Block, type Kind } from "@/lib/flow-types";
import { NODE_STYLE } from "@/lib/flow-presets";
import { Icon, IconButton, Modal, request } from "./StudioUI";
import { ReferenceField, type Reference } from "./ReferenceField";
import { loopTargets } from "@/lib/flow-graph";
import { BUILT_IN_ALIASES, nodeAlias } from "@/lib/reference-display";
import { ToolPicker } from "./ToolPicker";
import { ModelPicker } from "./ModelPicker";
import { memorySettings } from "@/lib/memory-settings";
import { isMediaModel, MEDIA_PROMPT, validateMediaConfig } from "@/lib/media-models";
import { modelSettings } from "@/lib/ai-providers";
import { MemoryFields } from "./MemoryFields";
const fields: Record<Kind, string[]> = {
  start: [],
  llm: ["model", "system", "memoryType", "prompt"],
  agent: ["model", "system", "memoryType", "prompt", "tools"],
  condition: [],
  state: ["key", "value"],
  http: ["url", "method", "body", "credential"],
  tool: ["tool", "args"],
  approval: ["prompt"],
  loop: ["target", "limit", "limitMessage"],
  whatsapp: ["to", "text"],
  call: ["to", "context"],
  end: ["text"],
};
const labels: Record<string, [string, string]> = {
  system: ["Instruções", ""],
  memoryType: ["Memória", ""],
  prompt: [
    "Mensagem (opcional)",
    "",
  ],
  model: ["Modelo de IA", ""],
  tools: ["Ferramentas", ""],
  state: ["Estado inicial", "Objeto JSON com valores de texto, opcional."],
  value: ["Valor", "Texto que será comparado."],
  operator: ["Comparação", ""],
  compare: ["Comparar com", ""],
  key: ["Nome da variável", "Letras e números, sem espaços."],
  url: ["Endereço do serviço", "Endereço fixo, definido por você."],
  method: ["Método", ""],
  body: ["Conteúdo enviado", "JSON enviado ao serviço."],
  credential: [
    "Nome da credencial",
    "Nome FLOW_SECRET_ definido no servidor. Não cole o segredo aqui.",
  ],
  tool: ["Ferramenta", "Ferramenta do serviço conectado."],
  args: ["Argumentos", "JSON com os parâmetros da ferramenta."],
  target: ["Voltar para", "Bloco executado novamente a cada passagem. O caminho segue dele até chegar aqui de novo."],
  limit: ["Máximo de repetições", "Entre 1 e 20 passagens."],
  limitMessage: ["Mensagem ao atingir o limite", "Entregue como resultado quando o limite chega sem concluir. Em branco, mantém o resultado anterior."],
  text: ["Resposta final", "Texto entregue a quem chamou o fluxo."],
  to: ["Número de destino", "Com DDI e DDD, ex.: 5511999990000. Aceita {{fluxo.telefone}}."],
  context: ["Contexto da ligação", "O que o agente de voz deve saber e fazer nesta chamada."],
};
const TEXTAREAS = ["system", "prompt", "state", "body", "args", "text", "context", "limitMessage"];
const REFERENCES = ["system", "prompt", "value", "compare", "body", "args", "text", "to", "context", "limitMessage"];


type ToolInfo = {
  id: string;
  name: string;
  description: string;
  category?: string;
  configured?: boolean;

  setup?: string;
};
type ToolGroup = { id: string; name: string; kind: "builtin" | "mcp"; tools: ToolInfo[]; error?: string };
// Diálogo de edição do bloco, no formato do Flowise: ícone colorido, nome editável em linha
// e a lista de campos do tipo. Referências e ferramentas entram por clique, sem digitar código.
export function NodeDialog({
  node,
  nodes,
  models,
  onClose,
  onSave,
  onRename,
  connected,
  onConnect,
}: {
  node: Block;
  nodes: Block[];
  models: { id: string; name: string }[];
  onClose: () => void;
  onSave: (n: Block) => void;
  onRename: (label: string) => void;
  connected: boolean;
  onConnect: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(node)),
    [groups, setGroups] = useState<ToolGroup[] | null>(null),
    [savedName, setSavedName] = useState(node.data.label),
    [nameSaved, setNameSaved] = useState(false);
  const [nameEditing, setNameEditing] = useState(false);
  const [criteria, setCriteria] = useState<Criterion[]>(() => node.data.kind === "condition" ? conditionCriteria(node.data.config) : []);
  const [closeError, setCloseError] = useState("");
  const [variables, setVariables] = useState<{ key: string; value: string }[]>(() => {
    try { return Object.entries(JSON.parse(node.data.config.state || "{}")).map(([key, value]) => ({ key, value: String(value) })); } catch { return []; }
  });
  const [updates, setUpdates] = useState<{ key: string; value: string }[]>(() => {
    try { const rows = JSON.parse(node.data.config.stateUpdates || "[]"); return Array.isArray(rows) ? rows.filter((u) => u && typeof u.key === "string" && typeof u.value === "string") : []; } catch { return []; }
  });
  const invalidVariables = variables.some((v) => !/^[a-zA-Z][a-zA-Z0-9_]{0,60}$/.test(v.key)) || new Set(variables.map((v) => v.key)).size !== variables.length;
  const c = draft.data.config,
    k = draft.data.kind;
  // Image/video models: one PROMPT in, media out. Message, memory and bases are hidden and ignored.
  const media = (k === "llm" || k === "agent") && isMediaModel(c.model);
  useEffect(() => {
    if (k !== "tool") return;
    let alive = true;
    void request<ToolGroup[]>("/api/tools")
      .then((g) => alive && setGroups(g))
      .catch(() => alive && setGroups([]));
    return () => {
      alive = false;
    };
  }, [k]);
  function changeModel(values: Record<string, string>) {
    setDraft((d) => {
      const config = { ...d.data.config, ...values };
      const was = isMediaModel(d.data.config.model), now = isMediaModel(config.model);
      // Instructions written for a text assistant do not describe an image; the PROMPT starts from the chat message.
      if (now && !was) config.system = MEDIA_PROMPT;
      if (was && !now && config.system === MEDIA_PROMPT) config.system = DEFAULT_SYSTEM;
      return { ...d, data: { ...d.data, config } };
    });
  }
  function change(key: string, value: string) {
    setDraft((d) => ({
      ...d,
      data: { ...d.data, config: { ...d.data.config, [key]: value } },
    }));
  }
  // Enter ou o check no título salvam só o nome; o diálogo continua aberto.
  function saveName() {
    const label = draft.data.label.trim();
    if (!label) return;
    setNameEditing(false);
    if (label === savedName) return;
    onRename(label);
    setSavedName(label);
    setNameSaved(true);
    setTimeout(() => setNameSaved(false), 1800);
  }
  function saveAndClose() {
    if ((k === "agent" || k === "llm") && !media) {
      try { knowledgeSettings(c); } catch (error) {
        setCloseError((error as Error).message);
        return false;
      }
    }
    if (k === "agent" || k === "llm") {
      try { if (!media) memorySettings(c); modelSettings(c); validateMediaConfig(c); } catch (error) {
        setCloseError((error as Error).message);
        return false;
      }
    }
    if (!draft.data.label.trim() || (k === "start" && invalidVariables) || updates.some((u) => !updateKeys.has(u.key)) || new Set(updates.map((u) => u.key)).size !== updates.length) {
      setCloseError("Confira o nome do bloco e use nomes únicos e válidos nas variáveis antes de fechar.");
      return false;
    }
    onSave({
      ...draft,
      data: { ...draft.data, label: k === "start" ? "Início" : draft.data.label.trim(), config: { ...c, ...(k === "condition" ? { criteria: JSON.stringify(criteria) } : {}), ...(k === "start" ? { state: JSON.stringify(Object.fromEntries(variables.map((v) => [v.key, v.value]))) } : {}), ...(["agent", "llm"].includes(k) ? { stateUpdates: JSON.stringify(updates) } : {}) } },
    });
    onClose();
    return true;
  }
  const known = new Set((groups || []).flatMap((g) => g.tools.map((t) => t.id)));
  const stateKeys = new Set<string>();
  for (const n of nodes) {
    if (n.data.kind === "state" && n.data.config.key)
      stateKeys.add(n.data.config.key);
    if (n.data.kind === "start")
      try {
        Object.keys(JSON.parse(n.data.config.state || "{}")).forEach((k) =>
          stateKeys.add(k),
        );
      } catch {}
  }
  const updateKeys = new Set<string>();
  try { Object.keys(JSON.parse(nodes.find((n) => n.data.kind === "start")?.data.config.state || "{}")).forEach((key) => updateKeys.add(key)); } catch {}
  const alias = (value: string) => BUILT_IN_ALIASES.find((a) => a.value === value)?.display;
  const references: Reference[] = [
    { value: "{{input}}", label: "Conversa", hint: "o que a pessoa enviou", alias: alias("{{input}}") },
    { value: "{{last}}", label: "Etapa anterior", hint: "resultado do bloco anterior", alias: alias("{{last}}") },
    ...[...stateKeys].map((k) => ({
      value: `{{fluxo.${k}}}`,
      label: "Variável " + k,
    })),
    { value: "{{state.approval}}", label: "Decisão da aprovação", hint: "yes ou no", alias: alias("{{state.approval}}") },
    { value: "{{currentDateTime}}", label: "Data e hora atual", hint: "no momento da execução, horário de Brasília", alias: alias("{{currentDateTime}}") },
    ...nodes
      .filter(
        (o) => o.id !== node.id && !["start", "end"].includes(o.data.kind),
      )
      .map((o) => ({
        value: `{{nodes.${o.id}}}`,
        label: o.data.label,
        hint: BLOCKS[o.data.kind].label,
        alias: nodeAlias(o.id, o.data.label)?.display,
      })),
  ];
  return (
    <Modal
      title={k === "start" ? "Início" :
        <div className="modal-title-input">
          <input
            value={draft.data.label}
            maxLength={100}
            aria-label="Nome do bloco"
            onClick={() => { setNameEditing(true); setNameSaved(false); }}
            placeholder={BLOCKS[k].label}
            onChange={(e) => {
              setNameEditing(true); setNameSaved(false);
              setDraft({ ...draft, data: { ...draft.data, label: e.target.value } });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && draft.data.label.trim()) {
                e.preventDefault();
                saveName();
                e.currentTarget.blur();
              }
            }}
          />
          {nameSaved ? (
            <span className="modal-title-saved">
              <Icon name="check" size={14} />
              Nome salvo
            </span>
          ) : nameEditing ? (
            <IconButton
              icon="check"
              label="Salvar nome"
              disabled={
                !draft.data.label.trim()
              }
              onClick={saveName}
            />
          ) : null}
        </div>
      }
      onClose={saveAndClose}
      autoFocus={false}
    >
      <div className="node-dialog-type">
        <span style={{ background: NODE_STYLE[k].color }}>
          <Icon name={k} size={24} />
        </span>
        <div>
          <strong>{BLOCKS[k].label}</strong>
          <p>{BLOCKS[k].help}</p>
        </div>
      </div>
      {!["start", "agent", "llm"].includes(k) && <p className="reference-tip">
        Digite <code>{"{{"}</code> em qualquer campo para inserir a conversa, o
        resultado anterior ou uma variável como <code>{"{{fluxo.Resumo}}"}</code>.
      </p>}
      <div className="node-fields">
        {k === "start" && <section className="node-fields">
          <strong>Variáveis do fluxo</strong>
          <small>Defina um nome e um valor inicial, que pode ficar em branco. Os agentes podem atualizar esses valores durante o fluxo.</small>
          {variables.map((v, i) => <div className="node-field node-variable-card" key={i}>
            <div className="node-variable-heading"><strong>Variável {i + 1}</strong><IconButton icon="trash" label={`Excluir variável ${i + 1}`} onClick={() => setVariables(variables.filter((_, j) => j !== i))} /></div>
            <label>Nome da variável<input aria-label={`Nome da variável ${i + 1}`} value={v.key} maxLength={61} placeholder="Ex.: Resumo" onChange={(e) => setVariables(variables.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} /></label>
            <label>Valor inicial<textarea aria-label={`Valor inicial ${i + 1}`} value={v.value} maxLength={20000} rows={2} onChange={(e) => setVariables(variables.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} /></label>
          </div>)}
          <button className="studio-button" disabled={variables.length >= 50} onClick={() => setVariables([...variables, { key: "", value: "" }])}>Adicionar variável</button>
          {invalidVariables && <small role="alert">Use nomes únicos, começando com uma letra, sem espaços ou acentos.</small>}
        </section>}

        {k === "condition" && <section className="condition-criteria">
          <p>O primeiro critério atendido define o caminho. Quando nenhum é atendido, o fluxo segue pela última saída.</p>
          {criteria.map((row, index) => <div className="condition-criterion" key={row.id}>
            <div className="condition-criterion-heading"><span>Critério {index + 1} <small>Saída {index + 1}</small></span>
              <IconButton icon="trash" label={`Remover critério ${index + 1}`} disabled={criteria.length === 1} onClick={() => setCriteria(criteria.filter((item) => item.id !== row.id))} />
            </div>
            <label>Valor a avaliar<ReferenceField ariaLabel={`Valor do critério ${index + 1}`} value={row.value} references={references} placeholder="Ex.: {{Etapa anterior}}" onChange={(value) => setCriteria(criteria.map((item) => item.id === row.id ? { ...item, value } : item))} /></label>
            <label>Comparação<select aria-label={`Comparação do critério ${index + 1}`} value={row.operator} onChange={(event) => setCriteria(criteria.map((item) => item.id === row.id ? { ...item, operator: event.target.value } : item))}>
              {COMPARISONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
            {!['empty', 'notEmpty'].includes(row.operator) && <label>Comparar com<ReferenceField ariaLabel={`Comparar critério ${index + 1} com`} value={row.compare} references={references} placeholder="Texto ou valor" onChange={(compare) => setCriteria(criteria.map((item) => item.id === row.id ? { ...item, compare } : item))} /></label>}
          </div>)}
          <button className="studio-button" disabled={criteria.length >= 119} onClick={() => setCriteria([...criteria, { id: 'criterion_' + crypto.randomUUID(), value: '{{last}}', operator: 'equals', compare: '' }])}><Icon name="plus" size={16} />Adicionar critério</button>
        </section>}

        {fields[k].filter((key) => !media || !["memoryType", "prompt"].includes(key)).map((key) => (
          <div className="node-field" key={key}>
            {key !== "memoryType" && <span className="field-title">
              {k === "approval" && key === "prompt"
                ? "O que a pessoa deve revisar"
                : media && key === "system" ? "PROMPT" : labels[key][0]}
              {key === "prompt" && (k === "agent" || k === "llm") && <span className="field-role" title="Enviada ao modelo como mensagem da pessoa (role user)">role: user</span>}
            </span>}
            {key === "memoryType" ? (
              <MemoryFields config={c} onChange={change} />
            ) : key === "model" ? (
              <>
              <ModelPicker
                value={c[key] || ""}
                kind={k}
                chatModels={models}
                connected={connected}
                config={c}
                onConfigChange={changeModel}
                onConnect={onConnect}
              />
              {media && <small>Recebe texto e gera imagem ou vídeo. Descreva o resultado no PROMPT; para pesquisar ou consultar bases, use um bloco de texto anterior e cite {"{{Etapa anterior}}"}.</small>}
              </>
            ) : key === "operator" || key === "method" ? (
              <select
                value={c[key] || ""}
                onChange={(e) => change(key, e.target.value)}
              >
                {(key === "operator"
                  ? COMPARISONS
                  : ["GET", "POST", "PUT", "PATCH", "DELETE"].map(
                      (v): [string, string] => [v, v],
                    )
                ).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            ) : key === "target" ? (
              <select
                value={c[key] || ""}
                onChange={(e) => change(key, e.target.value)}
              >
                <option value="">Escolha um bloco</option>
                {loopTargets({ nodes, edges: [] }, node.id).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.data.label} · {BLOCKS[o.data.kind].label}
                  </option>
                ))}
                {c.target && !nodes.some((o) => o.id === c.target) && (
                  <option value={c.target}>{c.target} · não encontrado</option>
                )}
              </select>
            ) : key === "tools" ? (
              <ToolPicker value={c.tools || ""} cardsValue={c.toolCards || ""} onChange={(tools, toolCards) => setDraft((d) => ({
                ...d, data: { ...d.data, config: { ...d.data.config, tools, toolCards } },
              }))} />
            ) : key === "tool" ? (
              <select
                value={c[key] || ""}
                onChange={(e) => change(key, e.target.value)}
              >
                <option value="">Escolha uma ferramenta</option>
                {(groups || []).map((g) => (
                  <optgroup key={g.id} label={g.name}>
                    {g.tools.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
                {c.tool && !known.has(c.tool) && (
                  <option value={c.tool}>
                    {c.tool.split(":").pop()} · fora do ar
                  </option>
                )}
              </select>
            ) : TEXTAREAS.includes(key) ? (
              <ReferenceField
                multiline
                rows={key === "system" ? 5 : 3}
                ariaLabel={media && key === "system" ? "PROMPT" : labels[key][0]}
                placeholder={media && key === "system" ? "Descreva a imagem ou o vídeo. {{Conversa}} é a mensagem do chat; {{Etapa anterior}}, o resultado anterior." : key === "prompt" && (k === "agent" || k === "llm") ? "Define a mensagem desta etapa, sem uma chamada extra à IA. Use {{Etapa anterior}} para incluir a resposta anterior. Em branco, usa a conversa ou o resultado anterior." : undefined}
                spellCheck={key === "system" || key === "prompt"}
                value={c[key] || ""}
                references={references}
                onChange={(v) => change(key, v)}
              />
            ) : REFERENCES.includes(key) ? (
              <ReferenceField
                value={c[key] || ""}
                references={references}
                onChange={(v) => change(key, v)}
              />
            ) : (
              <input
                type={key === "limit" ? "number" : "text"}
                min={key === "limit" ? 1 : undefined}
                max={key === "limit" ? 20 : undefined}
                value={c[key] || ""}
                onChange={(e) => change(key, e.target.value)}
              />
            )}
            {k === "approval" && key === "prompt" ? (
              <small>Mostrado junto com o resultado, antes da decisão.</small>
            ) : k === "whatsapp" && key === "text" ? (
              <small>Mensagem enviada. Em branco não envia nada.</small>
            ) : key === "prompt" && (k === "agent" || k === "llm") ? (
              <small>Enviada ao modelo com o papel user, depois das Instruções (system). Em branco, usa a conversa ou o resultado anterior.</small>
            ) : (
              labels[key][1] && <small>{labels[key][1]}</small>
            )}
          </div>
        ))}
        {(k === "agent" || k === "llm") && !media && <KnowledgeAgentFields config={c} onChange={change} />}
        {(k === "agent" || k === "llm") && <section className="node-fields node-completion">
          <span className="node-completion-title">Ao concluir esta etapa</span>
          {updates.map((u, i) => <div className="node-field node-variable-card" role="group" aria-label={`Atualização de variável ${i + 1}`} key={i}>
            <div className="node-variable-heading"><strong>Variável {i + 1}</strong><IconButton icon="trash" label={`Excluir atualização ${i + 1}`} onClick={() => setUpdates(updates.filter((_, j) => j !== i))} /></div>
            <label>Nome da variável<select aria-label={`Variável a atualizar ${i + 1}`} value={u.key} onChange={(e) => setUpdates(updates.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}>
              <option value="">Escolha uma variável</option>
              {[...updateKeys].map((key) => <option key={key} value={key} disabled={updates.some((update, index) => index !== i && update.key === key)}>{key}</option>)}
            </select></label>
            <label>Novo valor<ReferenceField showOnFocus multiline rows={2} value={u.value} ariaLabel={`Novo valor ${i + 1}`} onChange={(value) => setUpdates(updates.map((x, j) => j === i ? { ...x, value } : x))} references={[{ value: `{{nodes.${node.id}}}`, label: "Resposta deste agente", alias: nodeAlias(node.id, draft.data.label)?.display }, ...references.filter((r) => r.value !== "{{last}}")]} /></label>
          </div>)}
          <button className="studio-button" disabled={!updateKeys.size || updates.length >= updateKeys.size} onClick={() => setUpdates([...updates, { key: [...updateKeys].find((key) => !updates.some((u) => u.key === key)) || "", value: `{{nodes.${node.id}}}` }])}>Atualizar variável de estado</button>
        </section>}
      </div>
      {closeError && <p className="studio-error" role="alert">{closeError}</p>}
    </Modal>
  );
}
