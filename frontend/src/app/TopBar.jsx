import { Icon } from "../shared/icons.jsx";
import SearchField from "../shared/SearchField.jsx";
import { useTheme } from "../shared/theme.js";
import { PLACEHOLDER } from "../download/constants.js";
import { useSearchBusy, useSearchDraft, useSearchSuggestions } from "../download/searchDraft.js";
import { requestSearch } from "../download/searchRequest.js";
import { useNav } from "./useNav.js";
import { backToLabel } from "./crossMode.js";

/* ---------------------------------------------------------------------------
   BARRA DE ARRIBA (escritorio)

   "Volver" mientras hay una pagina abierta o Ajustes (en escritorio no pintan
   el suyo; una hoja o un menu no son paginas), EL buscador de la app y el tema. El buscador comparte el
   texto con Buscar (searchDraft): enfocarlo lleva a Buscar, escribir muestra lo
   de tu biblioteca y Enter lanza la busqueda de descargas.
   ------------------------------------------------------------------------- */

export default function TopBar() {
  const nav = useNav();
  const [q, setQ] = useSearchDraft();
  const busy = useSearchBusy();
  const suggestions = useSearchSuggestions();
  const [theme, chooseTheme] = useTheme();
  const dark = theme === "dark";
  const toggle = `Cambiar al tema ${dark ? "claro" : "oscuro"}`;

  const submit = () => {
    requestSearch(q);
    nav.goTab("search");
  };

  const pick = (item) => {
    const text = item?.title || "";
    setQ(text);
    requestSearch(text);
    nav.goTab("search");
  };

  /* En PC el campo esta aqui: bajar con la lista cerrada lleva el foco a la
     primera fila de resultados en vez de no hacer nada. */
  const arrowDown = (e) => {
    const row = document.querySelector('.rlist .res__main, .rlist [role="button"]');
    if (!row) return;
    e.preventDefault();
    row.focus({ preventScroll: true });
  };

  return (
    <header className="topbar">
      {(nav.pageOf(nav.tab) || nav.settings) && (
        <button
          type="button"
          className="cbtn cbtn--soft"
          aria-label={backToLabel(nav)}
          title={backToLabel(nav)}
          onClick={nav.back}
        >
          <Icon name="CaretLeft" size="lg" />
        </button>
      )}

      <SearchField
        className="topbar__field"
        value={q}
        onChange={setQ}
        onSubmit={submit}
        onFocus={() => nav.goTab("search")}
        go="Buscar"
        ghost
        busy={busy}
        listId="topbar-combo"
        suggestions={suggestions}
        onPickSuggestion={pick}
        onArrowDown={arrowDown}
        placeholder={PLACEHOLDER.default}
        label="Qué quieres escuchar"
      />

      <button
        type="button"
        className="cbtn topbar__theme"
        aria-label={toggle}
        title={toggle}
        onClick={() => chooseTheme(dark ? "light" : "dark")}
      >
        <Icon name={dark ? "Sun" : "Moon"} weight="fill" size="lg" />
      </button>
    </header>
  );
}
