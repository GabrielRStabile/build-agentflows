// Puro e compartilhado entre o motor (interpolate) e o editor (destaque das referências nos campos).
// Uma referência é {{chave}}; espaços internos são ignorados, como em {{ input }}.
export const REFERENCE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export type ReferenceSegment = { text: string; kind: "text" | "known" | "unknown" };

/** Forma canônica de uma chave: o motor aceita state.<variável> como apelido de fluxo.<variável>. */
export function canonicalReference(key: string) {
  const k = key.trim();
  return k.startsWith("state.") && k !== "state.approval" ? "fluxo." + k.slice("state.".length) : k;
}

/** Divide o texto em trechos comuns e referências, marcando as que não existem na lista conhecida. */
export function referenceSegments(text: string, known: Iterable<string>): ReferenceSegment[] {
  const values = new Set<string>();
  for (const value of known) values.add(canonicalReference(value.replace(/^\{\{|\}\}$/g, "")));
  const segments: ReferenceSegment[] = [];
  let last = 0;
  for (const match of (text || "").matchAll(REFERENCE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ text: text.slice(last, index), kind: "text" });
    segments.push({ text: match[0], kind: values.has(canonicalReference(match[1])) ? "known" : "unknown" });
    last = index + match[0].length;
  }
  if (last < (text || "").length) segments.push({ text: text.slice(last), kind: "text" });
  return segments;
}
