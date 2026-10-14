import { FlowError } from "./flow-store";
import type { Block, Run } from "./flow-types";
import { REFERENCE_PATTERN as REFERENCE } from "./reference-highlight";

/** Data e hora atuais em português, no horário de Brasília, para o modelo situar o pedido no tempo. */
export function currentDateTime(now = new Date()) {
  return now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "full", timeStyle: "short" }) + " (horário de Brasília)";
}
function referenceValue(key: string, r: Run): string | undefined {
  if (key === "input") return r.input;
  if (key === "last") return r.output;
  if (key === "currentDateTime") return currentDateTime();
  const [prefix, ...rest] = key.split(".");
  const k = rest.join(".");
  if ((prefix === "state" || prefix === "fluxo") && Object.hasOwn(r.state, k)) return r.state[k];
  if (prefix === "nodes") {
    if (Object.hasOwn(r.outputs, k)) return r.outputs[k];
    // Bloco do fluxo que não executou nesta execução (outro caminho da Condição, etapa posterior): vale vazio,
    // e o motor registra a observação na etapa em vez de interromper a execução.
    if (r.graph.nodes.some((n) => n.id === k)) return "";
  }
}
function missingReference(key: string) {
  if (key.startsWith("nodes.")) return `A referência “${key}” aponta para um bloco que não existe mais neste fluxo. Remova a referência ou cite outro bloco.`;
  return `A referência “${key}” não tem valor nesta etapa.`;
}
export function interpolate(text: string, r: Run): string {
  return (text || "").replace(REFERENCE, (_, key: string) => {
    const value = referenceValue(key, r);
    if (value === undefined) throw new FlowError(missingReference(key));
    return value;
  });
}
/** Blocos citados nos textos que existem no fluxo mas não executaram nesta execução: a referência valeu vazio. */
export function unexecutedReferences(r: Run, ...texts: (string | undefined)[]): Block[] {
  const found = new Map<string, Block>();
  for (const text of texts)
    for (const [, key] of (text || "").matchAll(REFERENCE)) {
      if (!key.startsWith("nodes.")) continue;
      const id = key.slice("nodes.".length);
      if (found.has(id) || Object.hasOwn(r.outputs, id)) continue;
      const node = r.graph.nodes.find((n) => n.id === id);
      if (node) found.set(id, node);
    }
  return [...found.values()];
}
/** Observação para a etapa, uma linha por bloco citado que não executou; vazio quando não há caso. */
export function unexecutedNote(r: Run, ...texts: (string | undefined)[]) {
  return unexecutedReferences(r, ...texts)
    .map((n) => `O bloco “${n.data.label}” não executou nesta execução, então a referência a ele ficou vazia.`)
    .join("\n");
}
// Values a block already cites in its own texts, by any reference ({{input}}, {{last}}, {{nodes.x}}...).
// The engine never adds these again automatically, however many references there are.
export function citedValues(r: Run, ...texts: (string | undefined)[]) {
  const values = new Set<string>();
  for (const text of texts)
    for (const [, key] of (text || "").matchAll(REFERENCE)) {
      const value = referenceValue(key, r);
      if (value?.trim()) values.add(value);
    }
  return values;
}
export const cites = (r: Run, value: string, ...texts: (string | undefined)[]) => !!value.trim() && citedValues(r, ...texts).has(value);
