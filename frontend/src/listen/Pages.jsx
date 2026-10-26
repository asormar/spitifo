import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../shared/ui.jsx";
import { useHistory } from "./history.js";
import { Icon } from "./icons.jsx";
import { groupAlbums } from "./library.js";
import { playlists } from "./playlists.js";
import { NameField } from "./PlaylistPicker.jsx";
import PlaylistSongs from "./PlaylistSongs.jsx";
import VirtualList from "./VirtualList.jsx";
import { RowMenu, GroupRow } from "./rows.jsx";
import { Cover, Mosaic, coverOf } from "./cards.jsx";
import {
  SORTS,
  TOP_ALL,
  albumHue,
  albumOrder,
  entryHue,
  hueOf,
  minutes,
  mosaicHues,
  plural,
  sortEntries,
  topItems,
} from "./home.js";

/* ---------------------------------------------------------------------------
   PAGINAS DE ESCUCHAR

   Lo que se apila sobre el inicio (useViewStack): una lista de "Ver todo", la
   biblioteca entera para explorar y la ficha de un album, un artista o una
   lista. Todas llevan su "Volver"; el cuerpo es una lista virtual de filas, la
   misma fila (SongRow) que el resto de Escuchar.
   ------------------------------------------------------------------------- */

const songs = (n) => plural(n, "canción", "canciones");

const LIST_ITEMS = [
  ["rename", "Renombrar"],
  ["delete", "Borrar lista"],
];

/* El foco entra en la pagina por su "Volver": con teclado se sigue desde ahi. */
function useFocusBack(ref) {
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [ref]);
}

/* --- Filas de grupos -------------------------------------------------------------- */

function ArtistRow({ g, enter, ctx }) {
  const albums = g.albumCount > 0 ? ` · ${plural(g.albumCount, "álbum", "álbumes")}` : "";
  return (
    <GroupRow
      title={g.name}
      meta={`${songs(g.entries.length)}${albums}`}
      art={<Cover hue={hueOf(g.name)} label={g.name} round />}
      enter={enter}
      onOpen={() => ctx.open({ type: "artist", id: g.id })}
    />
  );
}

function AlbumRow({ g, enter, ctx }) {
  return (
    <GroupRow
      title={g.name}
      meta={`${g.artist} · ${songs(g.entries.length)}`}
      art={<Cover hue={albumHue(g.artist, g.name)} label={g.artist} />}
      enter={enter}
      onOpen={() => ctx.open({ type: "album", id: g.id })}
    />
  );
}

function ListRow({ p, byKey, enter, ctx }) {
  const hues = useMemo(() => mosaicHues(p.keys, byKey), [p.keys, byKey]);
  const count = p.keys.filter((k) => byKey.has(k)).length;
  return (
    <GroupRow
      title={p.name}
      meta={songs(count)}
      art={<Mosaic hues={hues} className="mos--row" />}
      enter={enter}
      onOpen={() => ctx.open({ type: "list", id: p.id })}
    />
  );
}

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

export function AllPage({ view, index, byKey, lists, listsReady, r, active, ctx }) {
  const { what } = view;
  const hist = useHistory();
  const backRef = useRef(null);
  const newRef = useRef(null);
  const [naming, setNaming] = useState(Boolean(view.naming));
  useFocusBack(backRef);

  /* Lo que se lista, sin depender de `ctx` (que se rehace en cada render con el
     menu abierto): ordenar miles de canciones no puede repetirse por eso. */
  const page = useMemo(() => {
    switch (what) {
      case "recent":
        return { items: sortEntries(index.entries, "recent") };
      case "r-songs":
        return { items: r.songs };
      case "top":
        return { items: topItems(hist, byKey, TOP_ALL) };
      case "artists":
        return { items: index.artists };
      case "r-artists":
        return { items: r.artists };
      case "albums":
        return { items: index.albums };
      case "r-albums":
        return { items: r.albums };
      case "lists":
        return { items: lists };
      default:
        return { items: r.lists };
    }
  }, [what, index, byKey, lists, r, hist]);

  const itemKey = (item) => item.key ?? item.id ?? item.entry.key;
  const row = (item, i, enter) => {
    switch (what) {
      case "recent":
      case "r-songs":
        return ctx.song(item, page.items, { enter });
      case "top":
        return ctx.song(
          item.entry,
          page.items.map((t) => t.entry),
          {
            enter,
            rank: i + 1,
            sub: `${item.entry.artist} · ${plural(item.plays, "reproducción", "reproducciones")}`,
          }
        );
      case "artists":
      case "r-artists":
        return <ArtistRow g={item} enter={enter} ctx={ctx} />;
      case "albums":
      case "r-albums":
        return <AlbumRow g={item} enter={enter} ctx={ctx} />;
      default:
        return <ListRow p={item} byKey={byKey} enter={enter} ctx={ctx} />;
    }
  };

  const isLists = what === "lists";
  const endNaming = () => {
    setNaming(false);
    requestAnimationFrame(() => newRef.current?.focus({ preventScroll: true }));
  };

  return (
    <div className="lpage">
      <div className="phead">
        <button ref={backRef} type="button" className="hback" aria-label="Volver" onClick={ctx.back}>
          <Icon name="ArrowLeft" size={20} />
        </button>
        <h1 className="phead__h">{TITLES[what]}</h1>
        <span className="count">{page.items.length}</span>
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
      ) : page.items.length ? (
        <div className="lpanel">
          <VirtualList
            active={active}
            count={page.items.length}
            getKey={(i) => itemKey(page.items[i])}
            renderRow={(i, enter) => row(page.items[i], i, enter)}
          />
        </div>
      ) : (
        <p className="lnote">{isLists ? "Todavía no tienes listas." : "No hay nada que mostrar."}</p>
      )}
    </div>
  );
}

/* --- Explorar la biblioteca ------------------------------------------------------------- */

export const LibraryPage = forwardRef(function LibraryPage({ index, sort, onSort, active, ctx }, listRef) {
  const backRef = useRef(null);
  useFocusBack(backRef);
  const rows = useMemo(() => sortEntries(index.entries, sort), [index, sort]);

  return (
    <div className="lpage">
      <div className="libhead">
        <button ref={backRef} type="button" className="vback" onClick={ctx.back}>
          <span aria-hidden="true">‹</span> Volver
        </button>
        <div className="libhead__row">
          <div>
            <h1 className="libhead__h">Biblioteca</h1>
            <p className="libhead__n">{plural(rows.length, "tema", "temas")}</p>
          </div>
          <div className="libhead__sort" role="group" aria-label="Ordenar por">
            <span className="libhead__lbl" aria-hidden="true">
              Ordenar
            </span>
            {SORTS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={cx("lbtn", sort === id && "is-on")}
                aria-pressed={sort === id}
                onClick={() => onSort(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="lpanel">
        <VirtualList
          key={sort}
          ref={listRef}
          active={active}
          count={rows.length}
          getKey={(i) => rows[i].key}
          renderRow={(i, enter) => ctx.song(rows[i], rows, { enter })}
        />
      </div>
    </div>
  );
});

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
  const hue = pl
    ? rows.length
      ? entryHue(rows[0])
      : 200
    : view.type === "album"
      ? albumHue(group?.artist, name)
      : hueOf(name);
  const meta = pl
    ? `Lista · ${songs(rows.length)}${mins ? ` · ${mins} min` : ""}`
    : view.type === "album"
      ? `${group?.artist} · ${songs(rows.length)}${mins ? ` · ${mins} min` : ""}`
      : `${plural(albums.length, "álbum", "álbumes")} · ${songs(rows.length)}`;

  const art = pl ? (
    <Mosaic hues={mosaicHues(pl.keys, byKey)} className="mos--big" />
  ) : (
    <Cover
      hue={hue}
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
      <header className="dhead" style={{ "--h": hue }}>
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
          <span className="dhead__art">{art}</span>
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
                <Cover hue={albumHue(g.artist, g.name)} label={g.artist} src={coverOf(g.entries)} className="alb__cv" />
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
              : "Esta lista está vacía. Añade canciones desde el menú ⋯ de cualquier canción."
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
              renderRow={(i, enter) => ctx.song(rows[i], rows, { enter })}
            />
          )}
        </div>
      )}
    </div>
  );
}
