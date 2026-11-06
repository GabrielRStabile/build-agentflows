"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { BLOCKS } from "@/lib/flow-types";
import { NODE_STYLE, PRESETS, presetSteps, type Preset } from "@/lib/flow-presets";
import { Icon, Modal } from "./StudioUI";

const AREAS = [...new Set(PRESETS.map((p) => p.category))].sort((a, b) => a.localeCompare(b, "pt-BR"));
// Busca sem acento e sem caixa: "reuniao" acha "reunião".
const plain = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Biblioteca de modelos: áreas na coluna lateral, busca e detalhe do modelo dentro do mesmo diálogo. */
export function PresetLibrary({
  busy,
  onPick,
  onBlank,
  onClose,
}: {
  busy: boolean;
  onPick: (id: string) => void;
  onBlank: () => void;
  onClose: () => void;
}) {
  const [area, setArea] = useState(""),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState<Preset | null>(null);
  const searchField = useRef<HTMLInputElement>(null),
    back = useRef<HTMLButtonElement>(null),
    opened = useRef(false);
  const steps = useMemo(() => Object.fromEntries(PRESETS.map((p) => [p.id, presetSteps(p)])), []);
  useEffect(() => {
    // O Modal já foca a busca ao abrir; daqui em diante o foco acompanha a troca entre lista e detalhe.
    if (!opened.current) {
      opened.current = true;
      return;
    }
    (selected ? back : searchField).current?.focus();
  }, [selected]);
  const query = plain(search.trim());
  const found = PRESETS.filter((p) =>
    !query ||
    plain([p.name, p.description, p.category, p.input, ...steps[p.id].map((s) => BLOCKS[s.kind].label + " " + s.label)].join(" ")).includes(query),
  );
  const visible = found.filter((p) => !area || p.category === area);
  const groups = !area && !query
    ? [
        { title: "Sugeridos para começar", items: PRESETS.filter((p) => p.suggested) },
        { title: "Todos os modelos", items: PRESETS.filter((p) => !p.suggested) },
      ]
    : visible.length
      ? [{ title: query ? "Resultados" : area, items: visible }]
      : [];
  const areas = [{ id: "", label: "Todas", count: found.length }, ...AREAS.map((a) => ({ id: a, label: a, count: found.filter((p) => p.category === a).length }))]
    .filter((a) => !a.id || a.count || a.id === area);
  const chosen = selected ? steps[selected.id] : [];
  return (
    <Modal title="Comece com um modelo" onClose={onClose} wide className="preset-library">
      {selected ? (
        <>
          <div className="preset-detail">
            <button ref={back} type="button" className="preset-back" onClick={() => setSelected(null)}>
              <Icon name="arrow" size={16} />
              Voltar aos modelos
            </button>
            <div className="preset-detail-head">
              <h3>{selected.name}</h3>
              <span className="preset-category">{selected.category}</span>
            </div>
            <p>{selected.description}</p>
            <div className="preset-detail-columns">
              <section>
                <h4>Como funciona</h4>
                <ol className="preset-steps">
                  {chosen.map((s) => (
                    <li key={s.id}>
                      <span className="preset-node" style={{ background: NODE_STYLE[s.kind].color }}>
                        <Icon name={s.kind} size={15} />
                      </span>
                      <div>
                        <strong>
                          {s.label}
                          <em>{BLOCKS[s.kind].label}</em>
                        </strong>
                        <span>{s.help}</span>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
              <section>
                <h4>Você informa</h4>
                <p className="preset-box">{selected.input}</p>
                <h4>Você vai precisar</h4>
                <p className="preset-box">
                  {chosen.some((s) => s.kind === "decision")
                    ? "Sua conexão de IA para os agentes e uma credencial do OpenRouter ou da OpenAI para o bloco Decisão."
                    : "Sua conexão de IA (ChatGPT ou OpenRouter)."}
                </p>
              </section>
            </div>
          </div>
          <footer className="preset-footer">
            <span>Todos os blocos podem ser ajustados depois.</span>
            <button type="button" className="studio-button primary" disabled={busy} onClick={() => onPick(selected.id)}>
              <Icon name="plus" size={18} />
              Usar este modelo
            </button>
          </footer>
        </>
      ) : (
        <>
          <div className="preset-browser">
            <nav className="preset-areas" aria-label="Áreas">
              <span>Áreas</span>
              {areas.map((a) => (
                <button key={a.id || "todas"} type="button" className={a.id === area ? "active" : ""} aria-pressed={a.id === area} onClick={() => setArea(a.id)}>
                  {a.label}
                  <b>{a.count}</b>
                </button>
              ))}
            </nav>
            <div className="preset-main">
              <label className="studio-search">
                <Icon name="search" size={18} />
                <input
                  ref={searchField}
                  data-autofocus
                  type="search"
                  aria-label="Buscar modelos"
                  placeholder="Busque por tarefa (ex.: contrato, reunião)"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <div className="preset-list">
                {groups.map((g) => (
                  <section key={g.title}>
                    <h4>{g.title}</h4>
                    {g.items.map((p) => (
                      <button key={p.id} type="button" className="preset-row" onClick={() => setSelected(p)}>
                        <span className="preset-row-chain">
                          {steps[p.id].filter((s) => s.kind !== "start").slice(0, 4).map((s) => (
                            <span key={s.id} className="preset-node" title={`${BLOCKS[s.kind].label}: ${s.label}`} style={{ background: NODE_STYLE[s.kind].color }}>
                              <Icon name={s.kind} size={15} />
                            </span>
                          ))}
                        </span>
                        <span className="preset-row-text">
                          <strong>{p.name}</strong>
                          <span>{p.description}</span>
                        </span>
                        {!area && <span className="preset-category">{p.category}</span>}
                        <Icon name="chevron" size={16} />
                      </button>
                    ))}
                  </section>
                ))}
                {!groups.length && (
                  <div className="preset-empty">
                    <strong>Nenhum modelo para “{search.trim()}”</strong>
                    <p>Tente outra palavra ou comece um fluxo do zero.</p>
                    <button type="button" className="studio-button" onClick={() => { setSearch(""); setArea(""); }}>
                      Limpar busca
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          <footer className="preset-footer">
            <span>{visible.length === 1 ? "1 modelo" : `${visible.length} modelos`}</span>
            <button type="button" className="studio-button" disabled={busy} onClick={onBlank}>
              <Icon name="plus" size={18} />
              Começar do zero
            </button>
          </footer>
        </>
      )}
    </Modal>
  );
}
