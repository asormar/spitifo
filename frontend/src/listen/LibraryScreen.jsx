import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useNav } from "../app/useNav.js";
import { useListen } from "./ListenProvider.jsx";
import LibraryGate from "./LibraryGate.jsx";
import PageHost from "./PageHost.jsx";
import SearchResults from "./SearchResults.jsx";
import { LibraryPage } from "./Pages.jsx";
import { searchLibrary, sortEntries } from "./home.js";
import { subscribeReveal, takeReveal } from "./revealRequest.js";
import { Icon } from "./icons.jsx";
import "./home.css";

/* ---------------------------------------------------------------------------
   TU BIBLIOTECA

   La biblioteca entera (ordenable, con lista virtual) con su buscador
   (instantaneo, en memoria) y sus paginas. La raiz no repite el feed de
   Inicio: es la lista completa, sin "Volver". La busqueda activa es una
   entrada de la pila, debajo de las paginas: el atras la cierra y, al
   cerrarse, la consulta se vacia (tambien al cambiar de pestana, que vacia la
   pila).
   ------------------------------------------------------------------------- */

const NO_STACK = [];

/* La lista completa de la raiz. "Ver en tu biblioteca" (requestReveal) centra
   la fila pedida en cuanto la pantalla esta a la vista. Se espera un momento:
   si el pedido llego al cerrar "Ahora suena" (un atras del historial), el
   navegador restaura despues el scroll de la entrada y pisaria este. */
function LibraryRoot({ model, ctx, active }) {
  const [sort, setSort] = useState("recent");
  const listRef = useRef(null);

  useEffect(() => {
    if (!active) return undefined;
    let timer = 0;
    const run = () => {
      const key = takeReveal();
      if (key == null) return;
      const i = sortEntries(model.index.entries, sort).findIndex((e) => e.key === key);
      if (i < 0) return;
      clearTimeout(timer);
      timer = setTimeout(() => listRef.current?.scrollToIndex(i), 120);
    };
    run();
    const off = subscribeReveal(run);
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [active, model.index, sort]);

  return <LibraryPage ref={listRef} root index={model.index} sort={sort} onSort={setSort} active={active} ctx={ctx} />;
}

export default function LibraryScreen({ ready, error, errorCode, health, active, onRetry }) {
  const nav = useNav();
  const { ctx, model } = useListen();
  const [q, setQ] = useState("");
  /* Escribir no tiene que esperar a que se filtre y se pinte. */
  const dq = useDeferredValue(q);
  const searchRef = useRef(null);

  const stack = nav.tab === "library" ? nav.stack : NO_STACK;
  const page = nav.pageOf("library");
  const hasSearch = stack.some((v) => v.type === "search");
  const searching = dq.trim() !== "";
  const results = useMemo(
    () => (searching ? searchLibrary(model.index, dq, { lists: model.lists, plays: model.plays }) : null),
    [searching, model.index, dq, model.lists, model.plays]
  );

  useEffect(() => {
    if (!hasSearch) setQ((cur) => (cur ? "" : cur));
  }, [hasSearch]);

  const onSearch = (value) => {
    setQ(value);
    ctx.closeMenu();
    const has = nav.getStack().some((v) => v.type === "search");
    if (value.trim() && !has) nav.open({ type: "search" });
    else if (!value.trim() && has) nav.back();
  };

  const clearSearch = () => {
    onSearch("");
    searchRef.current?.focus({ preventScroll: true });
  };

  if (page && ready) return <PageHost view={page} tab="library" active={active} results={results} />;

  const count = model.entries.length;
  return (
    <section className="listen" aria-label="Tu biblioteca">
      <header className="lhead">
        <h1 className="lhead__h" id="library-title">
          Tu biblioteca
          {ready && count > 0 && <span className="count">{count}</span>}
        </h1>
        <div className="lhead__end">
          {health?.library && (
            <button
              type="button"
              className="panel__store"
              onClick={() => nav.openSettings("storage")}
              title="Cambiar dónde se guarda tu música"
            >
              {/^Google Drive/.test(health.library) ? (
                <Icon name="GoogleDriveLogo" size={15} aria-hidden="true" />
              ) : (
                <Icon name="HardDrives" size={15} aria-hidden="true" />
              )}
              <span className="panel__path">{health.library}</span>
            </button>
          )}
          <button
            type="button"
            className="lhead__new"
            aria-label="Nueva lista"
            title="Nueva lista"
            onClick={() => nav.goTo("library", { type: "all", what: "lists", naming: true })}
          >
            <Icon name="Plus" size={18} />
          </button>
        </div>
      </header>
      <LibraryGate ready={ready} error={error} errorCode={errorCode} onRetry={onRetry}>
        <div className="hsearch">
          <div className="hsearch__box">
            <Icon name="MagnifyingGlass" size={22} aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              inputMode="search"
              enterKeyHint="search"
              data-field="search"
              value={q}
              placeholder="¿Qué quieres escuchar?"
              aria-label="Buscar en tu biblioteca"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onSearch(e.target.value)}
            />
            {q && (
              <button type="button" className="hsearch__clear" aria-label="Borrar búsqueda" onClick={clearSearch}>
                <Icon name="X" size={16} />
              </button>
            )}
          </div>
        </div>
        {searching ? (
          <SearchResults r={results} query={dq} byKey={model.byKey} ctx={ctx} />
        ) : (
          <LibraryRoot model={model} ctx={ctx} active={active} />
        )}
      </LibraryGate>
    </section>
  );
}
