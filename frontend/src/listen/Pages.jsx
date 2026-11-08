import { memo, useEffect, useMemo, useRef, useState } from "react";
import { NavIcon } from "../app/navIcons.jsx";
import { cx } from "../shared/ui.jsx";
import { usePc } from "../shared/viewport.js";
import { useHistory } from "./history.js";
import { Icon } from "./icons.jsx";
import { playlists } from "./playlists.js";
import { NameField } from "./PlaylistPicker.jsx";
import VirtualList from "./VirtualList.jsx";
import { Thead } from "./rows.jsx";
import { AllSongs, Cards } from "./cards.jsx";
import {
  SORTS,
  TOP_ALL,
  plural,
  sortEntries,
  topItems,
} from "./home.js";
import { subscribeReveal, takeReveal } from "./revealRequest.js";

/* ---------------------------------------------------------------------------
   PAGINAS DE LA BIBLIOTECA

   Lo que se apila sobre una pestana (la pila de useNav): una pagina de "Ver
   todo" y Todas tus canciones (la ficha de un album, un artista o una lista es
   Detail.jsx). Todas llevan su "Volver". Las canciones van en una lista virtual
   (filas en el telefono, tabla en escritorio); artistas, albumes y listas, en una
   rejilla de tarjetas que se pinta de a poco.
   ------------------------------------------------------------------------- */

/* El foco entra en la pagina por su "Volver": con teclado se sigue desde ahi.
   En escritorio el de la pagina no se ve y el foco va al de la barra de arriba. */
export function useFocusBack(ref, on = true) {
  useEffect(() => {
    if (!on) return;
    const back = ref.current?.getClientRects().length ? ref.current : document.querySelector(".topbar .cbtn--soft");
    back?.focus({ preventScroll: true });
  }, [ref, on]);
}

export const Back = ({ bref, onClick, className = "hback" }) => (
  <button ref={bref} type="button" className={className} aria-label="Volver" onClick={onClick}>
    <NavIcon name="back" size={22} />
  </button>
);

/* --- Ver todo ------------------------------------------------------------------------ */

const TITLES = {
  recent: "Añadido hace poco",
  top: "Lo que más escuchas",
  artists: "Artistas",
  albums: "Álbumes",
  lists: "Tus listas",
  "r-songs": "Canciones",
  "r-artists": "Artistas",
  "r-albums": "Álbumes",
  "r-lists": "Listas",
};

export const AllPage = memo(function AllPage({ view, index, byKey, lists, listsReady, r, active, ctx }) {
  const { what } = view;
  const pc = usePc();
  const hist = useHistory();
  const backRef = useRef(null);
  const newRef = useRef(null);
  const [naming, setNaming] = useState(Boolean(view.naming));
  useFocusBack(backRef);

  /* Lo que se lista, sin depender de `ctx`: ordenar miles de canciones no puede
     repetirse por eso. El historial solo cuenta en "top": las demas no se
     reordenan con cada escucha. */
  const items = useMemo(() => {
    switch (what) {
      case "recent":
        return sortEntries(index.entries, "recent");
      case "r-songs":
        return r.songs;
      case "top":
        return topItems(hist, byKey, TOP_ALL);
      case "artists":
        return index.artists;
      case "r-artists":
        return r.artists;
      case "albums":
        return index.albums;
      case "r-albums":
        return r.albums;
      case "lists":
        return lists;
      default:
        return r.lists;
    }
  }, [what, index, byKey, lists, r, what === "top" ? hist : null]);
  const topEntries = useMemo(() => (what === "top" ? items.map((t) => t.entry) : null), [what, items]);

  /* Artistas, albumes o listas: una tarjeta cada uno. */
  const kind = what.replace("r-", "").slice(0, -1);
  const cards = useMemo(() => items.map((item) => ({ kind, item })), [items, kind]);

  const isTop = what === "top";
  const isSongs = isTop || what === "recent" || what === "r-songs";
  const row = (i, enter) =>
    isTop
      ? ctx.song(items[i].entry, topEntries, {
          enter,
          rank: i + 1,
          table: pc,
          sub: `${items[i].entry.artist} · ${plural(items[i].plays, "reproducción", "reproducciones")}`,
        })
      : ctx.song(items[i], items, { enter, table: pc && "lib" });

  const isLists = what === "lists";
  const endNaming = () => {
    setNaming(false);
    requestAnimationFrame(() => newRef.current?.focus({ preventScroll: true }));
  };

  return (
    <div className="lpage">
      <div className="phead">
        <Back bref={backRef} onClick={ctx.back} />
        <h1 className="phead__h">{TITLES[what]}</h1>
        <span className="count">{items.length}</span>
      </div>

      {isLists && (
        <div className="phead__act">
          {naming ? (
            <NameField
              label="Nombre de la nueva lista"
              submit="Crear"
              onSubmit={(name) => {
                playlists.create(name);
                ctx.show(`Lista «${name}» creada`);
                endNaming();
              }}
              onCancel={endNaming}
            />
          ) : (
            <button ref={newRef} type="button" className="lbtn lbtn--go" onClick={() => setNaming(true)}>
              <NavIcon name="plus" size={16} />
              Nueva lista
            </button>
          )}
        </div>
      )}

      {isLists && !listsReady ? (
        <p className="lnote">Cargando listas…</p>
      ) : !items.length ? (
        <p className="lnote">{isLists ? "Todavía no tienes listas." : "No hay nada que mostrar."}</p>
      ) : isSongs ? (
        <>
          {pc && <Thead lib={!isTop} sticky />}
          <VirtualList
            active={active}
            count={items.length}
            getKey={(i) => (isTop ? items[i].entry.key : items[i].key)}
            renderRow={row}
          />
        </>
      ) : (
        <div className={cx("grid", kind === "artist" && "grid--6")}>
          <Cards cards={cards} byKey={byKey} ctx={ctx} />
        </div>
      )}
    </div>
  );
});

/* --- Todas tus canciones ----------------------------------------------------------------- */

/* "Ver en tu biblioteca" (requestReveal): la pagina centra la fila pedida en
   cuanto esta a la vista. Se espera un momento: si el pedido llego al cerrar
   "Ahora suena" (un atras del historial), el navegador restaura despues el
   scroll de la entrada y pisaria este. */
function useReveal(rows, active, listRef) {
  useEffect(() => {
    if (!active) return undefined;
    let timer = 0;
    const run = () => {
      const key = takeReveal();
      if (key == null) return;
      const i = rows.findIndex((e) => e.key === key);
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
  }, [active, rows, listRef]);
}

export function LibraryPage({ view, index, storage, active, ctx }) {
  const pc = usePc();
  const backRef = useRef(null);
  const listRef = useRef(null);
  const [sort, setSort] = useState(view.sort ?? "recent");
  useFocusBack(backRef);
  const rows = useMemo(() => sortEntries(index.entries, sort), [index, sort]);
  useReveal(rows, active, listRef);

  const play = () => ctx.playGroup(rows);
  const shuffle = () => ctx.playGroup(rows, true);

  return (
    <div className="lpage">
      {pc ? (
        <div className="ph1">
          <div>
            <h1 className="phead__h">Todas tus canciones</h1>
            <p className="dmeta">
              {plural(rows.length, "tema", "temas")} · En {storage}
            </p>
          </div>
          <div className="ph1__act">
            <button
              type="button"
              className="cbtn cbtn--soft"
              aria-label="Reproducir en aleatorio"
              title="Reproducir en aleatorio"
              onClick={shuffle}
            >
              <Icon name="Shuffle" size={24} />
            </button>
            <button type="button" className="pk pk--l" aria-label="Reproducir todo" title="Reproducir todo" onClick={play}>
              <Icon name="Play" weight="fill" size={28} />
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="phead">
            <Back bref={backRef} onClick={ctx.back} />
            <h1 className="sr-only">Todas tus canciones</h1>
          </div>
          <AllSongs n={rows.length} storage={storage} onPlay={play} onShuffle={shuffle} />
        </>
      )}
      <div className="chips chips--sort" role="group" aria-label="Ordenar por">
        <span className="lbl" aria-hidden="true">
          Ordenar
        </span>
        {SORTS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={cx("chip", sort === id && "is-on")}
            aria-pressed={sort === id}
            onClick={() => setSort(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {pc && <Thead lib sticky />}
      <VirtualList
        key={sort}
        ref={listRef}
        active={active}
        count={rows.length}
        getKey={(i) => rows[i].key}
        renderRow={(i, enter) => ctx.song(rows[i], rows, { enter, table: pc && "lib" })}
      />
    </div>
  );
}
