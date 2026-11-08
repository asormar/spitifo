import { useEffect, useMemo, useRef, useState } from "react";
import { NavIcon } from "../app/navIcons.jsx";
import { cx } from "../shared/ui.jsx";
import { toneVars } from "../shared/cover.js";
import { usePc } from "../shared/viewport.js";
import { useHistory } from "./history.js";
import { Icon } from "./icons.jsx";
import { groupAlbums } from "./library.js";
import { playlists } from "./playlists.js";
import { NameField } from "./PlaylistPicker.jsx";
import PlaylistSongs from "./PlaylistSongs.jsx";
import VirtualList from "./VirtualList.jsx";
import { RowMenu, Thead } from "./rows.jsx";
import { AlbumCard, AllSongs, ArtistCard, Cover, ListCard, Mosaic, coverOf } from "./cards.jsx";
import {
  SORTS,
  TOP_ALL,
  albumTone,
  albumOrder,
  entryTone,
  toneOf,
  minutes,
  mosaicTones,
  plural,
  sortEntries,
  topItems,
} from "./home.js";
import { subscribeReveal, takeReveal } from "./revealRequest.js";
import { useMore } from "./useMore.js";

/* ---------------------------------------------------------------------------
   PAGINAS DE LA BIBLIOTECA

   Lo que se apila sobre una pestana (la pila de useNav): una pagina de "Ver
   todo", Todas tus canciones y la ficha de un album, un artista o una lista.
   Todas llevan su "Volver". Las canciones van en una lista virtual (filas en el
   telefono, tabla en escritorio); artistas, albumes y listas, en una rejilla de
   tarjetas que se pinta de a poco.
   ------------------------------------------------------------------------- */

const songs = (n) => plural(n, "canción", "canciones");

const LIST_ITEMS = [
  ["rename", "Renombrar"],
  ["delete", "Borrar lista"],
];

/* El foco entra en la pagina por su "Volver": con teclado se sigue desde ahi.
   En escritorio el de la pagina no se ve y el foco va al de la barra de arriba. */
function useFocusBack(ref, on = true) {
  useEffect(() => {
    if (!on) return;
    const back = ref.current?.getClientRects().length ? ref.current : document.querySelector(".topbar .cbtn--soft");
    back?.focus({ preventScroll: true });
  }, [ref, on]);
}

const Back = ({ bref, onClick }) => (
  <button ref={bref} type="button" className="hback" aria-label="Volver" onClick={onClick}>
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

/* De artistas, albumes o listas: una tarjeta cada uno, de a 60 (useMore). */
function Grid({ what, items, byKey, ctx }) {
  const [shown, more] = useMore(items.length);
  const kind = what.replace("r-", "");
  return (
    <div className={cx("grid", kind === "artists" && "grid--6")}>
      {items.slice(0, shown).map((g) =>
        kind === "artists" ? (
          <ArtistCard key={g.id} g={g} ctx={ctx} sub={songs(g.entries.length)} />
        ) : kind === "albums" ? (
          <AlbumCard key={g.id} g={g} ctx={ctx} />
        ) : (
          <ListCard key={g.id} list={g} byKey={byKey} ctx={ctx} />
        )
      )}
      {more && <div ref={more} className="sentinel" />}
    </div>
  );
}

export function AllPage({ view, index, byKey, lists, listsReady, r, active, ctx }) {
  const { what } = view;
  const pc = usePc();
  const hist = useHistory();
  const backRef = useRef(null);
  const newRef = useRef(null);
  const [naming, setNaming] = useState(Boolean(view.naming));
  useFocusBack(backRef);

  /* Lo que se lista, sin depender de `ctx` (que se rehace en cada render con el
     menu abierto): ordenar miles de canciones no puede repetirse por eso. */
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
  }, [what, index, byKey, lists, r, hist]);
  const topEntries = useMemo(() => (what === "top" ? items.map((t) => t.entry) : null), [what, items]);

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
                endNaming();
              }}
              onCancel={endNaming}
            />
          ) : (
            <button ref={newRef} type="button" className="lbtn lbtn--go" onClick={() => setNaming(true)}>
              <Icon name="Plus" size={16} />
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
            menuKey={ctx.menu?.key}
            renderRow={row}
          />
        </>
      ) : (
        <Grid key={what} what={what} items={items} byKey={byKey} ctx={ctx} />
      )}
    </div>
  );
}

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
        menuKey={ctx.menu?.key}
        renderRow={(i, enter) => ctx.song(rows[i], rows, { enter, table: pc && "lib" })}
      />
    </div>
  );
}

/* --- Album, artista o lista ----------------------------------------------------------------- */

export function DetailPage({ view, index, byKey, lists, listsReady, active, ctx }) {
  const backRef = useRef(null);
  const [naming, setNaming] = useState(false);
  useFocusBack(backRef);

  const group =
    view.type === "album"
      ? index.albums.find((g) => g.id === view.id)
      : view.type === "artist"
        ? index.artists.find((g) => g.id === view.id)
        : null;
  const pl = view.type === "list" ? lists.find((p) => p.id === view.id) : null;

  const rows = useMemo(() => {
    if (pl) return pl.keys.map((k) => byKey.get(k)).filter(Boolean);
    if (!group) return [];
    return view.type === "album" ? albumOrder(group.entries) : sortEntries(group.entries, "az");
  }, [pl, group, view.type, byKey]);

  const albums = useMemo(
    () => (view.type === "artist" && group ? groupAlbums(group.entries) : []),
    [view.type, group]
  );

  const loading = view.type === "list" && !pl && !listsReady;
  const missing = view.type === "list" ? !pl : !group;
  if (missing) {
    return (
      <div className="lpage">
        <div className="phead">
          <button ref={backRef} type="button" className="hback" aria-label="Volver" onClick={ctx.back}>
            <Icon name="ArrowLeft" size={20} />
          </button>
        </div>
        <p className="lnote">
          {loading
            ? "Cargando la lista…"
            : view.type === "list"
              ? "Esta lista ya no existe."
              : "Ya no está en tu biblioteca."}
        </p>
      </div>
    );
  }

  const name = pl ? pl.name : group ? group.name : "";
  const kind = view.type === "album" ? "Álbum" : view.type === "artist" ? "Artista" : "Lista";
  const mins = minutes(rows);
  const tone = pl
    ? rows.length
      ? entryTone(rows[0])
      : toneOf(pl.name)
    : view.type === "album"
      ? albumTone(group?.artist, name)
      : toneOf(name);
  const meta = pl
    ? `Lista · ${songs(rows.length)}${mins ? ` · ${mins} min` : ""}`
    : view.type === "album"
      ? `${group?.artist} · ${songs(rows.length)}${mins ? ` · ${mins} min` : ""}`
      : `${plural(albums.length, "álbum", "álbumes")} · ${songs(rows.length)}`;

  const art = pl ? (
    <Mosaic tones={mosaicTones(pl.keys, byKey)} className="mos--big" />
  ) : (
    <Cover
      tone={tone}
      label={view.type === "album" ? group?.artist : name}
      src={view.type === "album" ? coverOf(rows) : null}
      round={view.type === "artist"}
      className="dhead__cv"
    />
  );

  const endNaming = () => {
    setNaming(false);
    requestAnimationFrame(() => backRef.current?.focus({ preventScroll: true }));
  };

  return (
    <div className="lpage lpage--detail">
      <header className="dhead" style={toneVars(tone)}>
        <button ref={backRef} type="button" className="dhead__back" onClick={ctx.back}>
          <Icon name="ArrowLeft" size={16} />
          Volver
        </button>
        {pl && !naming && (
          <div className="dhead__tools">
            <button
              type="button"
              className="srow__more"
              aria-label={`Más opciones de ${pl.name}`}
              title="Más opciones"
              aria-haspopup="menu"
              aria-expanded={ctx.menu?.key === pl.id}
              onClick={(e) => ctx.onMenu(pl.id, e.currentTarget)}
            >
              <Icon name="DotsThree" weight="bold" size={22} />
            </button>
            {ctx.menu?.key === pl.id && (
              <RowMenu
                items={LIST_ITEMS}
                onPick={(kindPicked) =>
                  kindPicked === "rename" ? (ctx.closeMenu(false), setNaming(true)) : ctx.deleteList(pl)
                }
              />
            )}
          </div>
        )}
        <div className="dhead__body">
          <span className={cx("dhead__art", view.type === "artist" && "dhead__art--round")}>{art}</span>
          <div className="dhead__info">
            <p className="dhead__kind">{kind}</p>
            {naming && pl ? (
              <NameField
                value={pl.name}
                label="Nuevo nombre de la lista"
                submit="Guardar"
                onSubmit={(next) => {
                  playlists.rename(pl.id, next);
                  endNaming();
                }}
                onCancel={endNaming}
              />
            ) : (
              <h1 className="dhead__h">{name}</h1>
            )}
            <p className="dhead__meta">{meta}</p>
            <div className="dhead__acts">
              <button
                type="button"
                className="lbtn lbtn--go"
                disabled={!rows.length}
                onClick={() => ctx.playGroup(rows)}
              >
                <Icon name="Play" size={18} weight="fill" />
                Reproducir
              </button>
              <button
                type="button"
                className="lbtn"
                disabled={!rows.length}
                onClick={() => ctx.playGroup(rows, true)}
              >
                <Icon name="Shuffle" size={18} />
                Aleatorio
              </button>
            </div>
          </div>
        </div>
      </header>

      {albums.length > 0 && (
        <section className="hsec dalbums" aria-labelledby="h-dalb">
          <h2 id="h-dalb" className="hsec__h hsec__h--solo">
            Álbumes
          </h2>
          <div className="hs">
            {albums.map((g) => (
              <button
                key={g.id}
                type="button"
                className="alb alb--det"
                aria-label={`Abrir álbum ${g.name}`}
                onClick={() => ctx.open({ type: "album", id: g.id })}
              >
                <Cover tone={albumTone(g.artist, g.name)} label={g.artist} src={coverOf(g.entries)} className="alb__cv" />
                <span className="alb__t">{g.name}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {!rows.length ? (
        <p className="lnote">
          {pl
            ? pl.keys.length
              ? "Ninguna canción de esta lista sigue en tu biblioteca."
              : (
                <>
                  Esta lista está vacía. Añade canciones desde el menú{" "}
                  <Icon name="DotsThree" weight="bold" size={18} style={{ verticalAlign: "-4px" }} /> de cualquier canción.
                </>
              )
            : "No hay canciones."}
        </p>
      ) : (
        <div className="lpanel dlist">
          {pl ? (
            <PlaylistSongs playlist={pl} rows={rows} active={active} onPlay={ctx.play} />
          ) : (
            <VirtualList
              active={active}
              count={rows.length}
              getKey={(i) => rows[i].key}
              menuKey={ctx.menu?.key}
              renderRow={(i, enter) => ctx.song(rows[i], rows, { enter })}
            />
          )}
        </div>
      )}
    </div>
  );
}
