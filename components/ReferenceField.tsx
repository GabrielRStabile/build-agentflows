"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { referenceSegments } from "@/lib/reference-highlight";
import { displayReferences, storedReferences, type ReferenceAlias } from "@/lib/reference-display";
/** alias: forma mostrada no campo no lugar de value (ex.: {{Analista}} para {{nodes.a1}}). */
export type Reference = { value: string; label: string; hint?: string; alias?: string };
// A camada de destaque espelha o campo (fonte, espaçamento, bordas e posição) para colorir as
// referências sem mexer no texto digitado: o campo fica com o texto transparente por cima dela.
const MIRRORED = ["font", "lineHeight", "letterSpacing", "wordSpacing", "textIndent", "textTransform", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderRadius", "boxSizing"] as const;
// Campo de texto com autocompletar: ao digitar "{{" aparece a lista de referências (entrada,
// resultado anterior, variáveis e blocos do fluxo) e a escolha entra como {{...}} no lugar certo.
export function ReferenceField({
  value,
  onChange,
  references,
  multiline = false,
  rows = 3,
  placeholder,
  type = "text",
  spellCheck,
  ariaLabel,
  showOnFocus = false,
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  references: Reference[];
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  type?: string;
  spellCheck?: boolean;
  ariaLabel?: string;
  showOnFocus?: boolean;
  /** Marca o campo com data-autofocus para o Modal focá-lo ao abrir; o cursor vai para o fim do texto. */
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const highlight = useRef<HTMLDivElement | null>(null);
  const firstFocus = useRef(autoFocus);
  // O campo edita a forma exibida (nomes dos blocos); o que sobe por onChange é a forma gravada (ids).
  const aliases: ReferenceAlias[] = references.flatMap((r) => r.alias ? [{ value: r.value, display: r.alias }] : []);
  const shown = (r: Reference) => r.alias || r.value;
  const display = displayReferences(value, aliases);
  const commit = (next: string) => onChange(storedReferences(next, aliases, value));
  const segments = referenceSegments(display, references.map(shown));
  const highlighted = segments.some((s) => s.kind !== "text");
  useEffect(() => {
    const el = ref.current, layer = highlight.current;
    if (!el || !layer) return;
    const mirror = () => {
      const style = getComputedStyle(el);
      for (const prop of MIRRORED) layer.style[prop] = style[prop];
      layer.style.top = el.offsetTop + "px";
      layer.style.left = el.offsetLeft + "px";
      layer.style.width = el.offsetWidth + "px";
      layer.style.height = el.offsetHeight + "px";
      layer.scrollTop = el.scrollTop;
      layer.scrollLeft = el.scrollLeft;
    };
    mirror();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(mirror);
    observer?.observe(el);
    window.addEventListener("resize", mirror);
    return () => { observer?.disconnect(); window.removeEventListener("resize", mirror); };
  }, [highlighted, display]);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [start, setStart] = useState(0);
  const replacementEnd = useRef<number | null>(null);
  const options =
    query === null
      ? []
      : references.filter((r) =>
          (shown(r) + " " + r.label).toLowerCase().includes(query.toLowerCase()),
        );
  const current = options.length ? Math.min(active, options.length - 1) : 0;
  // O menu usa coordenadas da janela: dentro de um diálogo curto (ex.: Resposta), um menu absoluto
  // seria cortado pela rolagem do próprio diálogo. Abre para cima quando falta espaço abaixo.
  const menu = useRef<HTMLUListElement | null>(null);
  const menuOpen = options.length > 0;
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const place = () => {
      const el = ref.current, list = menu.current;
      if (!el || !list) return;
      const rect = el.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
      const up = below < 160 && above > below;
      const room = Math.max(96, Math.min(220, up ? above : below));
      list.style.left = rect.left + "px";
      list.style.width = rect.width + "px";
      list.style.maxHeight = room + "px";
      list.style.top = up ? "auto" : rect.bottom - 4 + "px";
      list.style.bottom = up ? window.innerHeight - rect.top + 4 + "px" : "auto";
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); };
  }, [menuOpen]);
  function detect(text: string, caret: number) {
    replacementEnd.current = null;
    const before = text.slice(0, caret);
    const open = before.lastIndexOf("{{");
    if (open === -1 || before.slice(open).includes("}}")) {
      setQuery(null);
      return;
    }
    const q = before.slice(open + 2);
    if (/[\n]/.test(q) || q.length > 40) {
      setQuery(null);
      return;
    }
    setStart(open);
    setQuery(q);
  }
  function showReferences(el: HTMLInputElement | HTMLTextAreaElement) {
    const caret = el.selectionStart ?? 0;
    detect(el.value, caret);
    if (!showOnFocus) return;
    const before = el.value.slice(0, caret), open = before.lastIndexOf("{{");
    if (open >= 0 && !before.slice(open).includes("}}")) return;
    // A click inside an existing reference replaces that reference as a whole.
    const token = [...el.value.matchAll(/\{\{[^{}]*\}\}/g)].find((match) => match.index <= caret && match.index + match[0].length >= caret);
    setStart(token ? token.index : caret);
    replacementEnd.current = token ? token.index + token[0].length : el.selectionEnd ?? caret;
    setQuery(""); setActive(0);
  }
  function pick(r: Reference) {
    const el = ref.current;
    const caret = el?.selectionStart ?? display.length;
    const next = display.slice(0, start) + shown(r) + display.slice(replacementEnd.current ?? caret);
    commit(next);
    setQuery(null);
    replacementEnd.current = null;
    const pos = start + shown(r).length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  }
  const shared = {
    value: display,
    placeholder,
    "aria-label": ariaLabel,
    "aria-autocomplete": "list" as const,
    "aria-expanded": options.length > 0,
    onChange: (
      e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>,
    ) => {
      commit(e.target.value);
      detect(e.target.value, e.target.selectionStart ?? e.target.value.length);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (!options.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((current + 1) % options.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((current - 1 + options.length) % options.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(options[current]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setQuery(null);
      }
    },
    onBlur: () => setQuery(null),
    onScroll: (e: React.UIEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      const layer = highlight.current;
      if (!layer) return;
      layer.scrollTop = e.currentTarget.scrollTop;
      layer.scrollLeft = e.currentTarget.scrollLeft;
    },
    onFocus: (e: React.FocusEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      if (firstFocus.current) {
        firstFocus.current = false;
        const end = e.currentTarget.value.length;
        e.currentTarget.setSelectionRange(end, end);
      }
      if (showOnFocus) showReferences(e.currentTarget);
    },
    "data-autofocus": autoFocus ? "" : undefined,
    onClick: (e: React.MouseEvent<HTMLTextAreaElement | HTMLInputElement>) => showReferences(e.currentTarget),
  };
  return (
    <div className={"reference-field" + (highlighted ? " has-highlight" : "")}>
      {highlighted && (
        <div ref={highlight} className={"reference-highlight" + (multiline ? "" : " single-line")} aria-hidden="true">
          {segments.map((segment, i) =>
            segment.kind === "text" ? segment.text : (
              <mark key={i} className={"reference-token" + (segment.kind === "unknown" ? " is-unknown" : "")} title={segment.kind === "unknown" ? "Esta referência não existe no fluxo" : undefined}>
                {segment.text}
              </mark>
            ),
          )}
          {"\u200b"}
        </div>
      )}
      {multiline ? (
        <textarea
          ref={(el) => {
            ref.current = el;
          }}
          rows={rows}
          spellCheck={spellCheck}
          {...shared}
        />
      ) : (
        <input
          ref={(el) => {
            ref.current = el;
          }}
          type={type}
          spellCheck={spellCheck}
          {...shared}
        />
      )}
      {menuOpen && (
        <ul ref={menu} className="reference-menu" role="listbox">
          {options.map((r, i) => (
            <li
              key={r.value}
              role="option"
              aria-selected={i === current}
              className={i === current ? "active" : ""}
              onPointerDown={(e) => e.preventDefault()}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); pick(r); }}
              onMouseEnter={() => setActive(i)}
            >
              <strong>{r.label}</strong>
              <code>{shown(r)}</code>
              {r.hint && <small>{r.hint}</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
