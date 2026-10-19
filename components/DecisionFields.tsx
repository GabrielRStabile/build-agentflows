"use client";
import { useEffect, useState } from "react";
import { Icon, IconButton, request } from "./StudioUI";
import { ReferenceField, type Reference } from "./ReferenceField";
import { ToolCredentialDialog } from "./ToolCredentialDialog";
import type { SavedToolCredential } from "@/lib/tool-credential-store";
import { aiCredentialProvider } from "@/lib/ai-providers";
import { formatCredentialExpiry } from "@/lib/credential-expiry";
import { DECISION_MODELS, DECISION_PROVIDERS, DECISION_TYPES, YES_NO, decisionProvider, defaultDecisionQuestions, type DecisionOption, type DecisionQuestion, type DecisionType } from "@/lib/flow-decisions";

const NEW_CREDENTIAL = "__nova_credencial__";
const optionId = () => "opt_" + crypto.randomUUID();
function parse(value: string | undefined): DecisionQuestion[] {
  try { const rows = JSON.parse(value || "[]"); return Array.isArray(rows) && rows.length ? rows : defaultDecisionQuestions(); } catch { return defaultDecisionQuestions(); }
}
function optionsFor(type: DecisionType, current: DecisionOption[]): DecisionOption[] {
  if (type === "yesno") return YES_NO.map((o, i) => ({ ...o, description: current[i]?.description || "" }));
  if (type === "score") return ["Baixa", "Média", "Alta"].map((value) => ({ id: optionId(), value, description: "" }));
  return [{ id: optionId(), value: "", description: "" }, { id: optionId(), value: "", description: "" }];
}
// Campos do bloco Decisão: fornecedor (OpenRouter ou OpenAI), credencial e modelo de decisão, o conteúdo avaliado e as perguntas fechadas.
// A primeira pergunta define as saídas; as demais só guardam respostas em variáveis do fluxo.
export function DecisionFields({ config, references, variables, onChange }: {
  config: Record<string, string>; references: Reference[]; variables: string[]; onChange: (values: Record<string, string>) => void;
}) {
  const [credentials, setCredentials] = useState<SavedToolCredential[]>([]);
  const [editor, setEditor] = useState<SavedToolCredential | "new" | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void request<SavedToolCredential[]>("/api/tool-credentials").then((items) => { if (alive) setCredentials(items); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  const questions = parse(config.questions);
  const save = (next: DecisionQuestion[]) => onChange({ questions: JSON.stringify(next) });
  const update = (id: string, values: Partial<DecisionQuestion>) => save(questions.map((q) => q.id === id ? { ...q, ...values } : q));
  // Modelo fora da lista (por exemplo, de uma versão anterior) mantém o fornecedor padrão até ser trocado.
  const provider = decisionProvider(config.model) || DECISION_MODELS[0].provider;
  const credentialProvider = aiCredentialProvider(provider);
  const providerName = DECISION_PROVIDERS.find((p) => p.id === provider)!.name;
  const available = credentials.filter((c) => c.provider === credentialProvider);
  const credentialId = config.modelCredentialId || "";
  const selected = available.find((c) => c.id === credentialId);
  return <>
    <div className="node-field"><span className="field-title">Fornecedor</span>
      <select aria-label="Fornecedor da decisão" value={provider} onChange={(e) => onChange({ model: DECISION_MODELS.find((m) => m.provider === e.target.value)!.id, modelCredentialId: "" })}>
        {DECISION_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
    <div className="node-field">
      <span className="field-title">Credencial {providerName}</span>
      <div className="provider-credential-row">
        {/* The last option is an action: it opens the dialog and the controlled value stays unchanged. */}
        <select aria-label={`Credencial ${providerName}`} value={credentialId} onChange={(e) => e.target.value === NEW_CREDENTIAL ? setEditor("new") : onChange({ modelCredentialId: e.target.value })}>
          <option value="">{available.length ? "Selecione uma credencial" : "Conecte uma credencial"}</option>
          {available.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          {credentialId && !selected && <option value={credentialId}>Credencial indisponível</option>}
          <option value={NEW_CREDENTIAL}>+ Conectar nova credencial…</option>
        </select>
        {selected && !selected.readOnly && <IconButton icon="pencil" label={`Editar credencial ${providerName}`} onClick={() => setEditor(selected)} />}
      </div>
      {selected?.expiresAt && <small>Credencial gratuita, válida até {formatCredentialExpiry(selected.expiresAt)}. Depois disso, cadastre sua própria chave.</small>}
      {error && <small role="alert">{error}</small>}
    </div>
    <div className="node-field"><span className="field-title">Modelo de decisão</span>
      <select aria-label="Modelo de decisão" value={config.model || ""} onChange={(e) => onChange({ model: e.target.value })}>
        {DECISION_MODELS.filter((m) => m.provider === provider).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        {config.model && !decisionProvider(config.model) && <option value={config.model}>{config.model} · indisponível</option>}
      </select>
      <small>Modelos de decisão respondem só perguntas fechadas, com probabilidades, sem gerar texto. Cobrados por token de entrada na sua chave.</small>
    </div>
    <div className="node-field"><span className="field-title">Conteúdo a avaliar</span>
      <ReferenceField multiline rows={3} ariaLabel="Conteúdo a avaliar" value={config.input || ""} references={references} onChange={(input) => onChange({ input })} />
      <small>Texto que o modelo lê para responder. Anexos não são enviados.</small>
    </div>
    <section className="condition-criteria decision-questions">
      <p>A primeira pergunta define o caminho: cada opção vira uma saída. As demais podem guardar a resposta em uma variável do fluxo.</p>
      {questions.map((q, index) => <div className="condition-criterion" role="group" aria-label={`Pergunta ${index + 1}`} key={q.id}>
        <div className="condition-criterion-heading"><span>Pergunta {index + 1}{index === 0 && <small>define as saídas</small>}</span>
          <IconButton icon="trash" label={`Remover pergunta ${index + 1}`} disabled={questions.length === 1} onClick={() => save(questions.filter((item) => item.id !== q.id))} />
        </div>
        <label>Nome da resposta<input aria-label={`Nome da pergunta ${index + 1}`} value={q.name} maxLength={61} placeholder="Ex.: categoria" onChange={(e) => update(q.id, { name: e.target.value })} /></label>
        <label>Tipo<select aria-label={`Tipo da pergunta ${index + 1}`} value={q.type} onChange={(e) => { const type = e.target.value as DecisionType; update(q.id, { type, options: optionsFor(type, q.options) }); }}>
          {DECISION_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Pergunta<ReferenceField multiline rows={2} ariaLabel={`Texto da pergunta ${index + 1}`} value={q.instructions} references={references} placeholder="Ex.: Qual equipe deve cuidar desta solicitação?" onChange={(instructions) => update(q.id, { instructions })} /></label>
        <div className="decision-options">
          {q.options.map((o, i) => <div className="decision-option" key={o.id}>
            {q.type === "yesno"
              ? <strong>{o.value}</strong>
              : <input aria-label={`${q.type === "score" ? "Nível" : "Opção"} ${i + 1} da pergunta ${index + 1}`} value={o.value} maxLength={200} placeholder={q.type === "score" ? `Nível ${i + 1}` : "Ex.: financeiro"} onChange={(e) => update(q.id, { options: q.options.map((x) => x.id === o.id ? { ...x, value: e.target.value } : x) })} />}
            <input aria-label={q.type === "yesno" ? `Quando é ${o.value.toLowerCase()} na pergunta ${index + 1}` : `Descrição do ${q.type === "score" ? "nível" : "item"} ${i + 1} na pergunta ${index + 1}`} value={o.description} maxLength={2000} placeholder={q.type === "yesno" ? `Quando a resposta é ${o.value.toLowerCase()} (opcional)` : "Quando escolher (opcional)"} onChange={(e) => update(q.id, { options: q.options.map((x) => x.id === o.id ? { ...x, description: e.target.value } : x) })} />
            {q.type !== "yesno" && <IconButton icon="trash" label={`Remover ${q.type === "score" ? "nível" : "opção"} ${i + 1} da pergunta ${index + 1}`} disabled={q.options.length <= 2} onClick={() => update(q.id, { options: q.options.filter((x) => x.id !== o.id) })} />}
          </div>)}
          {q.type !== "yesno" && <button type="button" className="tool-text-button" disabled={q.options.length >= (q.type === "score" ? 10 : 255)} onClick={() => update(q.id, { options: [...q.options, { id: optionId(), value: "", description: "" }] })}><Icon name="plus" size={14} />{q.type === "score" ? "Adicionar nível" : "Adicionar opção"}</button>}
          {q.type === "score" && <small>Do menor para o maior. O nível mais provável é a resposta.</small>}
        </div>
        <label>Guardar resposta em<select aria-label={`Variável da pergunta ${index + 1}`} value={q.variable || ""} onChange={(e) => update(q.id, { variable: e.target.value || undefined })}>
          <option value="">Não guardar</option>
          {variables.map((key) => <option key={key} value={key} disabled={questions.some((other) => other.id !== q.id && other.variable === key)}>{key}</option>)}
          {q.variable && !variables.includes(q.variable) && <option value={q.variable}>{q.variable} · não existe no Início</option>}
        </select>{!variables.length && <small>Crie variáveis no Início para guardar respostas.</small>}</label>
      </div>)}
      <button type="button" className="studio-button" disabled={questions.length >= 20} onClick={() => save([...questions, { id: "q_" + crypto.randomUUID(), name: "", type: "yesno", instructions: "", options: optionsFor("yesno", []) }])}><Icon name="plus" size={16} />Adicionar pergunta</button>
    </section>
    <div className="node-field"><span className="field-title">Confiança mínima (%)</span>
      <input aria-label="Confiança mínima" type="number" min={0} max={100} step={1} placeholder="Sem mínimo" value={config.minConfidence || ""} onChange={(e) => onChange({ minConfidence: e.target.value })} />
      <small>Abaixo deste valor na primeira pergunta, o fluxo segue pela saída Incerta, por exemplo para uma aprovação humana.</small>
    </div>
    {editor && <ToolCredentialDialog provider={credentialProvider} credential={editor === "new" ? undefined : editor} onClose={() => setEditor(null)}
      onSaved={(c) => { setCredentials((items) => [...items.filter((i) => i.id !== c.id), c]); setEditor(null); onChange({ modelCredentialId: c.id }); }} />}
  </>;
}
