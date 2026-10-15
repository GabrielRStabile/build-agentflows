"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./StudioUI";
export type ActionOption = { id: string; name: string; description?: string };
const normalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
/** Busca com lista suspensa; cada ação escolhida vira uma etiqueta removível. A lista é carregada ao abrir, sem botão obrigatório. */
export function ActionPicker({ actions, selected, prefix = "", busy, loaded, disabled, disabledHint, onLoad, onChange }: {
  actions: ActionOption[]; selected: string[]; prefix?: string; busy: boolean; loaded: boolean; disabled: boolean; disabledHint: string;
  onLoad: () => void; onChange: (ids: string[]) => void;
}) {
  const id = useId(), input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [active, setActive] = useState(0);
  const label = (name: string) => prefix && name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
  const byId = new Map(actions.map((action) => [action.id, action]));
  const options = actions.filter((action) => !selected.includes(action.id) && normalize(`${action.name} ${action.description || ""}`).includes(normalize(query)));
  useEffect(() => { if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [id, active, open]);
  function show() {
    if (disabled) return;
    setOpen(true);
    if (!loaded && !busy) onLoad();
  }
  function add(ids: string[]) {
    onChange([...selected, ...ids.filter((item) => !selected.includes(item))]);
    setActive((index) => Math.max(0, Math.min(index, options.length - 1 - ids.length)));
    input.current?.focus();
  }
  function remove(target: string) { onChange(selected.filter((item) => item !== target)); input.current?.focus(); }
  return <div className="action-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <div className="action-picker-heading">
      <span>Ações permitidas{selected.length > 0 && <small>{selected.length} {selected.length === 1 ? "selecionada" : "selecionadas"}</small>}
        {selected.length > 1 && <button type="button" className="tool-text-button" onClick={() => { onChange([]); input.current?.focus(); }}>Remover todas</button>}</span>
      <button type="button" className={"action-picker-refresh" + (busy ? " busy" : "")} disabled={disabled || busy} title="Atualizar lista de ações" aria-label="Atualizar lista de ações" onClick={() => { onLoad(); setOpen(true); input.current?.focus(); }}>
        <Icon name="loop" size={14} /><span>{busy ? "Atualizando…" : "Atualizar lista"}</span>
      </button>
    </div>
    {selected.length > 0 && <ul className="action-tags" aria-label="Ações selecionadas">
      {selected.map((item) => {
        const action = byId.get(item), missing = loaded && !action;
        return <li key={item} className={missing ? "missing" : undefined} title={missing ? "Ação não encontrada na última consulta ao serviço" : action?.description || undefined}>
          <span>{label(action?.name || item)}</span>
          <button type="button" aria-label={`Remover ${label(action?.name || item)}`} onClick={() => remove(item)}><Icon name="close" size={12} /></button>
        </li>;
      })}
    </ul>}
    <div className="action-picker-search">
      <div className="tool-select-input">
        <Icon name="search" size={16} />
        <input ref={input} disabled={disabled} role="combobox" aria-label="Buscar ações" aria-expanded={open} aria-controls={id} aria-autocomplete="list" aria-activedescendant={open && options[active] ? `${id}-${active}` : undefined}
          placeholder={disabled ? disabledHint : "Buscar e adicionar ação…"} value={query}
          onFocus={show} onClick={show}
          onChange={(event) => { setQuery(event.target.value); setActive(0); show(); }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); setActive((index) => Math.max(0, Math.min(options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))); }
            if (event.key === "Enter" && open) { event.preventDefault(); if (options[active]) add([options[active].id]); }
            if (event.key === "Backspace" && !query && selected.length) { event.preventDefault(); remove(selected[selected.length - 1]); }
          }} />
        <button type="button" disabled={disabled} aria-label={open ? "Fechar lista" : "Abrir lista"} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (open) setOpen(false); else { input.current?.focus(); show(); } }}><Icon name="chevron" size={16} /></button>
      </div>
      {open && <div className="tool-select-options action-picker-options">
        {busy && <p role="status">Consultando as ações do serviço…</p>}
        {!busy && options.length > 1 && <div className="action-picker-bulk"><small>{options.length} {query ? "encontradas" : "disponíveis"}</small><button type="button" className="tool-text-button" onMouseDown={(event) => event.preventDefault()} onClick={() => add(options.map((action) => action.id))}>Adicionar {query ? "encontradas" : "todas"}</button></div>}
        <div id={id} role="listbox" aria-label="Ações disponíveis" aria-multiselectable="true">
          {!busy && options.map((action, index) => <button id={`${id}-${index}`} key={action.id} type="button" role="option" aria-selected="false" className={index === active ? "active" : ""} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => add([action.id])}>
            <span><strong>{label(action.name)}</strong>{action.description && <small>{action.description}</small>}</span><Icon name="plus" size={14} />
          </button>)}
        </div>
        {!busy && !options.length && <p>{!loaded ? "Clique em Atualizar lista para consultar as ações." : !actions.length ? "O serviço não disponibilizou ações. Confira a credencial e atualize." : query ? "Nenhuma ação encontrada para essa busca." : "Todas as ações já foram adicionadas."}</p>}
      </div>}
    </div>
  </div>;
}
