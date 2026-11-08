import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useNav } from "../app/useNav.js";
import SearchField from "../shared/SearchField.jsx";
import { usePc } from "../shared/viewport.js";
import { useListen } from "./ListenProvider.jsx";
import LibraryGate from "./LibraryGate.jsx";
import LibraryHome from "./LibraryHome.jsx";
import PageHost from "./PageHost.jsx";
import SearchResults from "./SearchResults.jsx";
import { searchLibrary } from "./home.js";
import { Icon } from "./icons.jsx";
import "./home.css";

/* ---------------------------------------------------------------------------
   TU BIBLIOTECA

   El panel de tu musica: Todas tus canciones, listas, albumes y artistas, con
   un buscador instantaneo (en memoria) en el telefono; en escritorio la barra
   de arriba hace de buscador. La busqueda activa es una entrada de la pila,
   debajo de las paginas: el atras la cierra y, al cerrarse, la consulta se
   vacia (tambien al cambiar de pestana, que vacia la pila).
   ------------------------------------------------------------------------- */

const NO_STACK = [];

export default function LibraryScreen({ ready, error, errorCode, active, onRetry }) {
  const nav = useNav();
  const pc = usePc();
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

  if (page && ready) return <PageHost view={page} tab="library" active={active} results={results} />;

  return (
    <section className="listen" aria-label="Tu biblioteca">
      <header className="lhead">
        <h1 className="lhead__h" id="library-title">
          Tu biblioteca
        </h1>
        <button
          type="button"
          className={pc ? "lbtn lbtn--go" : "lhead__new"}
          aria-label={pc ? undefined : "Nueva lista"}
          title="Nueva lista"
          onClick={() => ctx.open({ type: "all", what: "lists", naming: true })}
        >
          <Icon name="Plus" size={pc ? 16 : 18} />
          {pc && "Nueva lista"}
        </button>
      </header>
      <LibraryGate ready={ready} error={error} errorCode={errorCode} onRetry={onRetry}>
        {!pc && (
          <div className="lstick">
            <SearchField
              big
              inputRef={searchRef}
              value={q}
              onChange={onSearch}
              placeholder="Buscar en tu biblioteca"
              label="Buscar en tu biblioteca"
              clearLabel="Borrar búsqueda"
            />
          </div>
        )}
        {searching ? (
          <SearchResults r={results} query={dq} byKey={model.byKey} ctx={ctx} />
        ) : (
          <LibraryHome model={model} ctx={ctx} />
        )}
      </LibraryGate>
    </section>
  );
}
