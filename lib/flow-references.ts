import { FlowError } from "./flow-store";
import type { Run } from "./flow-types";
import { REFERENCE_PATTERN as REFERENCE } from "./reference-highlight";

function referenceValue(key: string, r: Run): string | undefined {
  if (key === "input") return r.input;
  if (key === "last") return r.output;
  const [prefix, ...rest] = key.split(".");
  const k = rest.join(".");
  if ((prefix === "state" || prefix === "fluxo") && Object.hasOwn(r.state, k)) return r.state[k];
  if (prefix === "nodes" && Object.hasOwn(r.outputs, k)) return r.outputs[k];
}
export function interpolate(text: string, r: Run): string {
  return (text || "").replace(REFERENCE, (_, key: string) => {
    const value = referenceValue(key, r);
    if (value === undefined) throw new FlowError(`A referência “${key}” não tem valor nesta etapa.`);
    return value;
  });
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
