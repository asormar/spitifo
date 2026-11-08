import { Icon } from "../shared/icons.jsx";
import SearchField from "../shared/SearchField.jsx";
import { useTheme } from "../shared/theme.js";
import { PLACEHOLDER } from "../download/constants.js";
import { useSearchBusy, useSearchDraft } from "../download/searchDraft.js";
import { requestSearch } from "../download/searchRequest.js";
import { NavIcon } from "./navIcons.jsx";
import { useNav } from "./useNav.js";

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
  const [theme, chooseTheme] = useTheme();
  const dark = theme === "dark";
  const toggle = `Cambiar al tema ${dark ? "claro" : "oscuro"}`;

  const submit = () => {
    requestSearch(q);
    nav.goTab("search");
  };

  return (
    <header className="topbar">
      {(nav.pageOf(nav.tab) || nav.settings) && (
        <button type="button" className="cbtn cbtn--soft" aria-label="Volver" title="Volver" onClick={nav.back}>
          <NavIcon name="back" size={22} />
        </button>
      )}

      <SearchField
        className="topbar__field"
        value={q}
        onChange={setQ}
        onSubmit={submit}
        onFocus={() => nav.goTab("search")}
        go="Buscar"
        busy={busy}
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
        <Icon name={dark ? "Sun" : "Moon"} weight="fill" size={22} />
      </button>
    </header>
  );
}
