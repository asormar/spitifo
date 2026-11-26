import { lazy, Suspense, useRef, useSyncExternalStore } from "react";
import { songs } from "../listen/home.js";
import { playlists, usePlaylists } from "../listen/playlists.js";
import { useListen } from "../listen/ListenProvider.jsx";
import BrandLogo from "./BrandLogo.jsx";
import { ITEMS } from "./Nav.jsx";
import { openNewList } from "../listen/newList.js";
import { Icon } from "../shared/icons.jsx";
import { useNav } from "./useNav.js";
import { clampRail, collapsedSetting, railSetting } from "./desktop.js";

const TAB_ICON = { home: "House", search: "MagnifyingGlass", library: "Books", discover: "VinylRecord" };
const DND = "application/x-spitifo-song";

/* Las tarjetas de descarga no pintan nada en el primer frame: su modulo viaja
   aparte, se pide al montar el shell y aparece sin spinner cuando hay trabajo. */
const ProgressStack = lazy(() =>
  import("../download/progress.jsx").then((m) => ({ default: m.ProgressStack }))
);

/* ---------------------------------------------------------------------------
   MENU LATERAL (escritorio)

   La marca, las cuatro pestanas, "Tus listas", las descargas y Ajustes. En esta
   fase el riel se colapsa a iconos, recuerda la eleccion y lleva un divisor
   arrastrable (200-320 px). Las listas son destino de arrastrar y soltar y
   abren el menu con clic derecho, igual que las filas de cancion.
   ------------------------------------------------------------------------- */

function NavLists({ openId, onOpen, onNew, onMenu, onDrop }) {
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
      className="nlist rail__drop"
      aria-current={p.id === openId ? "page" : undefined}
      title={p.name}
      data-tip={p.name}
      onClick={() => onOpen(p.id)}
      onContextMenu={(e) => onMenu(p, e)}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes(DND)) {
          e.preventDefault();
          e.currentTarget.classList.add("is-over");
        }
      }}
      onDragLeave={(e) => e.currentTarget.classList.remove("is-over")}
      onDrop={(e) => {
        e.currentTarget.classList.remove("is-over");
        onDrop(e, p);
      }}
    >
      <b>{p.name}</b>
      <span>{songs(p.keys.length)}</span>
    </button>
  ));
}

function RailDivider() {
  const dragging = useRef(false);
  const start = useRef({ x: 0, w: 232 });
  const collapsed = useSyncExternalStore(collapsedSetting.subscribe, collapsedSetting.get);
  const width = useSyncExternalStore(railSetting.subscribe, railSetting.get);

  if (collapsed) return null;
  const end = () => {
    dragging.current = false;
    document.body.classList.remove("rail-resizing");
  };
  return (
    <div
      className="rail-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Redimensionar el riel"
      aria-valuemin={200}
      aria-valuemax={320}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e) => {
        dragging.current = true;
        start.current = { x: e.clientX, w: width };
        document.body.classList.add("rail-resizing");
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (dragging.current) railSetting.set(clampRail(start.current.w + e.clientX - start.current.x));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") railSetting.set(clampRail(railSetting.get() - 12));
        else if (e.key === "ArrowRight") railSetting.set(clampRail(railSetting.get() + 12));
        else return;
        e.preventDefault();
      }}
    >
      <span className="rail-divider__grip" aria-hidden="true" />
    </div>
  );
}

export default function LeftNav() {
  const nav = useNav();
  const { ctx } = useListen();
  const collapsed = useSyncExternalStore(collapsedSetting.subscribe, collapsedSetting.get);
  const settingsOpen = nav.settings !== null;
  const page = nav.pageOf("library");
  const newList = () => openNewList(nav, null);

  const menuList = (p, e) => {
    e.preventDefault();
    ctx.openMenu(p.id, e.currentTarget, "rlmenu", {
      name: p.name,
      point: { x: e.clientX, y: e.clientY },
    });
  };

  const dropList = (e, p) => {
    const raw = e.dataTransfer?.getData(DND);
    if (!raw) return;
    e.preventDefault();
    try {
      const song = JSON.parse(raw);
      if (!song.key) return;
      playlists.addKeys(p.id, [song.key]);
      ctx.show?.(`Añadido «${song.title}» a ${p.name}`);
    } catch {
      /* Un arrastre de fuera de la app: no es una cancion nuestra. */
    }
  };

  return (
    <>
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
              className="leftnav__item rail__tip"
              aria-current={active ? "page" : undefined}
              aria-label={label}
              data-tip={label}
              onClick={() => nav.goTab(id)}
            >
              <Icon name={TAB_ICON[id]} weight={active ? "fill" : "regular"} size="lg" />
              <span className="leftnav__label">{label}</span>
            </button>
          );
        })}

        <div className="leftnav__head">
          <h2 className="leftnav__label">Tus listas</h2>
          <button type="button" className="cbtn" aria-label="Nueva lista" title="Nueva lista" onClick={newList}>
            <Icon name="Plus" size="md" />
          </button>
        </div>
        <div className="leftnav__lists" role="group" aria-label="Listas">
          <NavLists
            openId={page?.type === "list" ? page.id : null}
            onOpen={(id) => nav.goTo("library", { type: "list", id })}
            onNew={newList}
            onMenu={menuList}
            onDrop={dropList}
          />
        </div>

        <Suspense fallback={null}>
          <ProgressStack inline />
        </Suspense>

        <button
          type="button"
          className="leftnav__item rail__tip"
          aria-pressed={settingsOpen}
          aria-label="Ajustes"
          data-tip="Ajustes"
          onClick={nav.toggleSettings}
        >
          <Icon name="GearSix" weight={settingsOpen ? "fill" : "regular"} size="lg" />
          <span className="leftnav__label">Ajustes</span>
        </button>

        <button
          type="button"
          className="rail__collapse"
          aria-pressed={collapsed}
          aria-label={collapsed ? "Expandir el riel" : "Colapsar el riel"}
          title={collapsed ? "Expandir el riel" : "Colapsar el riel"}
          onClick={() => collapsedSetting.set(!collapsed)}
        >
          <Icon name={collapsed ? "CaretRight" : "CaretLeft"} size="md" weight="fill" />
          {!collapsed && <span>Colapsar</span>}
        </button>
      </nav>
      <RailDivider />
    </>
  );
}
