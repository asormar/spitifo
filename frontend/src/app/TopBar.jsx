import { useRef } from "react";
import { Icon } from "../shared/icons.jsx";
import { useTheme } from "../shared/theme.js";
import { PLACEHOLDER } from "../download/constants.js";
import { useSearchDraft } from "../download/searchDraft.js";
import { requestSearch } from "../download/searchRequest.js";
import { NavIcon } from "./navIcons.jsx";
import { useNav } from "./useNav.js";

/* ---------------------------------------------------------------------------
   BARRA DE ARRIBA (escritorio)

   "Volver" mientras hay una pagina abierta (en escritorio las paginas no
   pintan el suyo), EL buscador de la app y el tema. El buscador comparte el
   texto con Buscar (searchDraft): enfocarlo lleva a Buscar y Enter lanza la
   busqueda. Escape borra el texto y, con el campo vacio, suelta el foco.
   ------------------------------------------------------------------------- */

export default function TopBar() {
  const nav = useNav();
  const [q, setQ] = useSearchDraft();
  const [theme, chooseTheme] = useTheme();
  const inputRef = useRef(null);
  const dark = theme === "dark";
  const toggle = `Cambiar al tema ${dark ? "claro" : "oscuro"}`;

  const submit = (e) => {
    e.preventDefault();
    requestSearch(q);
    nav.goTab("search");
  };

  const onKeyDown = (e) => {
    if (e.key !== "Escape") return;
    /* Lo consume el campo: no cierra tambien la pagina de debajo. */
    e.stopPropagation();
    if (q) setQ("");
    else e.currentTarget.blur();
  };

  return (
    <header className="topbar">
      {nav.stack.length > 0 && (
        <button type="button" className="cbtn cbtn--soft" aria-label="Volver" title="Volver" onClick={nav.back}>
          <NavIcon name="back" size={22} />
        </button>
      )}

      <form className="topbar__search" role="search" onSubmit={submit}>
        <NavIcon name="search" size={20} />
        <input
          ref={inputRef}
          type="text"
          name="q"
          data-field="search"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          value={q}
          placeholder={PLACEHOLDER.default}
          aria-label="Qué quieres escuchar"
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => nav.goTab("search")}
          onKeyDown={onKeyDown}
        />
        {q && (
          <button
            type="button"
            className="cbtn cbtn--sm"
            aria-label="Borrar"
            title="Borrar"
            onClick={() => {
              setQ("");
              inputRef.current.focus();
            }}
          >
            <Icon name="X" size={16} />
          </button>
        )}
        <button type="submit" className="topbar__go">
          Buscar
        </button>
      </form>

      <button
        type="button"
        className="cbtn topbar__theme"
        aria-label={toggle}
        title={toggle}
        onClick={() => chooseTheme(dark ? "light" : "dark")}
      >
        <Icon name={dark ? "Sun" : "Moon"} weight="fill" size={22} />
      </button>
    </header>
  );
}
