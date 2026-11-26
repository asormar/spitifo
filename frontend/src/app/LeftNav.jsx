import { ProgressStack } from "../download/progress.jsx";
import { songs } from "../listen/home.js";
import { usePlaylists } from "../listen/playlists.js";
import BrandLogo from "./BrandLogo.jsx";
import { ITEMS } from "./Nav.jsx";
import { openNewList } from "../listen/newList.js";
import { Icon } from "../shared/icons.jsx";
import { useNav } from "./useNav.js";

const TAB_ICON = { home: "House", search: "MagnifyingGlass", library: "Books", discover: "VinylRecord" };

/* ---------------------------------------------------------------------------
   MENU LATERAL (escritorio)

   La marca, las cuatro pestanas, "Tus listas" con sus nombres, las descargas
   en curso y Ajustes al final. Es la navegacion fija de la ventana ancha: en el
   telefono lo hace la barra inferior (Nav.jsx).
   ------------------------------------------------------------------------- */

/* Las listas de reproduccion, de la primera a la ultima. La abierta se marca. */
function NavLists({ openId, onOpen, onNew }) {
  const list = usePlaylists((s) => s.list);
  const ready = usePlaylists((s) => s.ready);
  if (!ready) return null;
  if (!list.length) {
    return (
      <div className="nlist__empty">
        <p>Todavía no tienes listas.</p>
        <button type="button" onClick={onNew}>
          Crear tu primera lista
        </button>
      </div>
    );
  }
  return list.map((p) => (
    <button
      key={p.id}
      type="button"
      className="nlist"
      aria-current={p.id === openId ? "page" : undefined}
      title={p.name}
      onClick={() => onOpen(p.id)}
    >
      <b>{p.name}</b>
      <span>{songs(p.keys.length)}</span>
    </button>
  ));
}

export default function LeftNav() {
  const nav = useNav();
  const settingsOpen = nav.settings !== null;
  const page = nav.pageOf("library");
  const newList = () => openNewList(nav, null);

  return (
    <nav className="leftnav" aria-label="Modos">
      <button
        type="button"
        className="leftnav__brand"
        aria-label="spitifo, ir al inicio"
        title="Inicio"
        onClick={() => nav.goTab("home")}
      >
        <BrandLogo />
      </button>

      {ITEMS.map(({ id, label }) => {
        /* Con Ajustes abierto ninguna pestana queda marcada. */
        const active = !settingsOpen && nav.tab === id;
        return (
          <button
            key={id}
            type="button"
            className="leftnav__item"
            aria-current={active ? "page" : undefined}
            onClick={() => nav.goTab(id)}
          >
            <Icon name={TAB_ICON[id]} weight={active ? "fill" : "regular"} size="lg" />
            {label}
          </button>
        );
      })}

      <div className="leftnav__head">
        <h2>Tus listas</h2>
        <button type="button" className="cbtn" aria-label="Nueva lista" title="Nueva lista" onClick={newList}>
          <Icon name="Plus" size="md" />
        </button>
      </div>
      <div className="leftnav__lists" role="group" aria-label="Listas">
        <NavLists
          openId={page?.type === "list" ? page.id : null}
          onOpen={(id) => nav.goTo("library", { type: "list", id })}
          onNew={newList}
        />
      </div>

      <ProgressStack inline />

      <button
        type="button"
        className="leftnav__item"
        aria-pressed={settingsOpen}
        onClick={nav.toggleSettings}
      >
        <Icon name="GearSix" weight={settingsOpen ? "fill" : "regular"} size="lg" />
        Ajustes
      </button>
    </nav>
  );
}
