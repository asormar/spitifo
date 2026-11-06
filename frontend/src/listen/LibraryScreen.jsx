import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useNav } from "../app/useNav.js";
import { useListen } from "./ListenProvider.jsx";
import LibraryGate from "./LibraryGate.jsx";
import HomeFeed from "./HomeFeed.jsx";
import PageHost from "./PageHost.jsx";
import SearchResults from "./SearchResults.jsx";
import { searchLibrary } from "./home.js";
import { Icon } from "./icons.jsx";
import "./home.css";

/* ---------------------------------------------------------------------------
   TU BIBLIOTECA

   La biblioteca con su buscador (instantaneo, en memoria) y sus paginas. La
   busqueda activa es una entrada de la pila, debajo de las paginas: el atras la
   cierra y, al cerrarse, la consulta se vacia (tambien al cambiar de pestana,
   que vacia la pila).
   ------------------------------------------------------------------------- */

const NO_STACK = [];

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
          <HomeFeed
            index={model.index}
            byKey={model.byKey}
            lists={model.lists}
            listsReady={model.listsReady}
            ctx={ctx}
          />
        )}
      </LibraryGate>
    </section>
  );
}
