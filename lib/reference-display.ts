// Puro: converte referências a blocos entre a forma gravada ({{nodes.<id>}}) e a exibida ({{Nome do bloco}}).
// O grafo e o motor só conhecem o id; o nome aparece apenas nos campos do editor.
import { REFERENCE_PATTERN } from "./reference-highlight";

/** Um apelido liga a forma gravada de uma referência ao nome mostrado no campo. */
export type ReferenceAlias = { value: string; display: string };

const BUILT_IN = /^(input|last|state\..+|fluxo\..+|nodes\..+)$/;
const strip = (token: string) => token.replace(/^\{\{\s*|\s*\}\}$/g, "");

/** Monta o apelido de um bloco; nomes com chaves ou iguais a referências nativas não ganham apelido. */
export function nodeAlias(id: string, label: string): ReferenceAlias | null {
  const name = label.trim();
  if (!name || /[{}]/.test(name) || BUILT_IN.test(name)) return null;
  return { value: `{{nodes.${id}}}`, display: `{{${name}}}` };
}

/** Forma gravada → forma exibida: cada {{nodes.<id>}} com apelido vira {{Nome}}. */
export function displayReferences(text: string, aliases: ReferenceAlias[]): string {
  const byValue = new Map(aliases.map((a) => [strip(a.value), a.display]));
  return (text || "").replace(REFERENCE_PATTERN, (token, key: string) => byValue.get(key) ?? token);
}

/**
 * Forma exibida → forma gravada. Nomes repetidos entre blocos são resolvidos pela posição: a enésima
 * ocorrência de {{Nome}} mantém o id que a enésima ocorrência tinha no texto gravado anterior;
 * sem anterior, vale o primeiro bloco com aquele nome.
 */
export function storedReferences(display: string, aliases: ReferenceAlias[], previous = ""): string {
  const byName = new Map<string, string[]>();
  for (const a of aliases) {
    const name = strip(a.display);
    byName.set(name, [...(byName.get(name) || []), strip(a.value)]);
  }
  const byValue = new Map(aliases.map((a) => [strip(a.value), strip(a.display)]));
  // Ids que cada nome tinha no texto anterior, na ordem em que apareciam.
  const earlier = new Map<string, string[]>();
  for (const [, key] of (previous || "").matchAll(REFERENCE_PATTERN)) {
    const name = byValue.get(key);
    if (name) earlier.set(name, [...(earlier.get(name) || []), key]);
  }
  const seen = new Map<string, number>();
  return (display || "").replace(REFERENCE_PATTERN, (token, key: string) => {
    if (BUILT_IN.test(key)) return token;
    const ids = byName.get(key);
    if (!ids) return token;
    const index = seen.get(key) || 0;
    seen.set(key, index + 1);
    const before = earlier.get(key)?.[index];
    return `{{${before && ids.includes(before) ? before : ids[0]}}}`;
  });
}
