import { useMemo, useState } from "react";
import { keyUrl } from "../shared/api.js";
import { cx } from "../shared/ui.jsx";
import { usePc } from "../shared/viewport.js";
import { useNav } from "../app/useNav.js";
import { useEngine } from "../player/useEngine.js";
import { Icon } from "./icons.jsx";
import { Bars } from "./rows.jsx";
import { AlbumCard, AllSongs, ArtistCard, Cards, ListCard, NewListCard, SectionHead, Shelf } from "./cards.jsx";
import { libraryCounts, libraryGrid, toggleFilter, topArtists } from "./home.js";
import { libraryView, viewOf, withView, foldersOf, looseOf, mosaicSources } from "./libraryView.js";
import { playlists } from "./playlists.js";
import { useSaved } from "./saved.js";
import { NameField } from "./PlaylistPicker.jsx";
import { FolderRow, ViewSwitch } from "./PlaylistTools.jsx";
import "../shared/chips.css";
import "./home.css";
import "./libraryTools.css";

/* ---------------------------------------------------------------------------
   TU BIBLIOTECA (consulta vacia)

   Telefono: la tarjeta de Todas tus canciones, cuatro cifras, los estantes y
   ahora tambien vista lista/cuadrícula y una fila de carpetas. Escritorio:
   cifras, filtros y rejilla; la vista se recuerda por pestaña. Lo que suena
   lleva el acento rosa y las barras del ecualizador, igual que en Inicio.
   ------------------------------------------------------------------------- */

const PHONE_SHELF = 12;
const FILTERS = [
  ["all", "Todo"],
  ["lists", "Listas"],
  ["artists", "Artistas"],
  ["albums", "Álbumes"],
];

const Tile = ({ n, icon, label, onClick }) => (
  <button type="button" className="tile" onClick={onClick}>
    {icon ? <Icon name={icon} size="lg" /> : <b className="num">{n}</b>}
    <span>{label}</span>
  </button>
);

/* Fila densa de una lista en la vista de lista. */
function LibraryRow({ list, byKey, savedById, ctx }) {
  const srcs = list.is_folder
    ? []
    : mosaicSources(list.keys, byKey, savedById, keyUrl);
  const source = useEngine((s) => s.source);
  const playing = source === `list:${list.name}`;
  const playingNow = useEngine((s) => playing && s.playing);
  const total = list.keys.filter((k) => byKey.has(k) || savedById.has(k)).length;
  const sub = list.is_folder
    ? `Carpeta · ${list.keys.length} ${list.keys.length === 1 ? "lista" : "listas"}`
    : `Lista · ${total} ${total === 1 ? "canción" : "canciones"}`;
  return (
    <button type="button" className={cx("lrow", playing && "lrow--playing")}
      aria-label={`Abrir ${list.name}, ${sub}`}
      onClick={() => ctx.open({ type: "list", id: list.id })}>
      <span className="lrow__cv">
        {srcs.length ? <img src={srcs[0]} alt="" loading="lazy" decoding="async" />
          : <span className={cx("cv", "mos")} aria-hidden="true">
            {list.is_folder ? <Icon name="Folder" weight="fill" size="lg" /> : <Icon name="MusicNotes" size="lg" />}
          </span>}
      </span>
      <span className="lrow__tx">
        <span className="lrow__t">{list.name}</span>
        <span className="lrow__s">{sub}</span>
      </span>
      {playing && <Bars on={playingNow} />}
      <span className="lrow__more" aria-hidden="true"><Icon name="CaretRight" size="md" /></span>
    </button>
  );
}

export default function LibraryHome({ model, ctx }) {
  const pc = usePc();
  const nav = useNav();
  const tab = nav?.tab || "listen";
  const { index, lists, listsReady } = model;
  const savedById = useSaved((s) => s.byId);
  const [filter, setFilter] = useState("all");
  const [map, setMap] = libraryView.use();
  const view = viewOf(map, tab, pc ? "grid" : "list");
  const setView = (next) => setMap(withView(map, tab, next));
  const [naming, setNaming] = useState(false);
  const count = libraryCounts(index, lists);
  const nLists = listsReady ? count.lists : "–";
  const open = (what) => () => ctx.open({ type: "all", what });

  const allSongs = (
    <AllSongs
      n={count.songs}
      storage={model.storage}
      check={model.check}
      onOpen={() => ctx.open({ type: "library", sort: "recent" })}
      onShuffle={() => ctx.playGroup(model.entries, true, "library:")}
    />
  );
  const cards = useMemo(() => (pc ? libraryGrid(index, looseOf(lists), filter) : []), [pc, index, lists, filter]);
  const artists = useMemo(() => topArtists(index.artists, PHONE_SHELF), [index]);
  const folders = useMemo(() => foldersOf(lists), [lists]);
  const loose = useMemo(() => looseOf(lists), [lists]);
  const newFolder = (name) => {
    const id = playlists.createFolder(name);
    if (id) ctx.show(`Carpeta «${name}» creada`);
    setNaming(false);
  };

  const folderRow = (
    <FolderRow folders={folders} onOpen={(f) => ctx.open({ type: "list", id: f.id })}
      onNew={() => setNaming(true)} />
  );
  const folderField = naming && (
    <NameField label="Nombre de la nueva carpeta" submit="Crear"
      onSubmit={newFolder} onCancel={() => setNaming(false)} />
  );

  const head = (title) => (
    <div className="scr__head">
      <h3>{title}</h3>
      <ViewSwitch view={view} onChange={setView} />
    </div>
  );

  const items = view === "list" ? (
    <div className="lrows">
      {folders.map((f) => <LibraryRow key={f.id} list={f} byKey={model.byKey} savedById={savedById} ctx={ctx} />)}
      {loose.map((p) => <LibraryRow key={p.id} list={p} byKey={model.byKey} savedById={savedById} ctx={ctx} />)}
    </div>
  ) : (
    <div className={pc ? "grid grid--6" : "grid"}>
      {filter === "lists" && listsReady && !loose.length && <NewListCard ctx={ctx} />}
      <Cards key={filter} cards={cards} byKey={model.byKey} ctx={ctx} tag />
    </div>
  );

  if (pc) {
    return (
      <div className="lhome">
        <div className="tiles">
          {allSongs}
          <Tile icon="ChartBar" label="Lo que más escuchas" onClick={open("top")} />
          <Tile icon="Clock" label="Añadido hace poco" onClick={open("recent")} />
        </div>
        {head("Tu biblioteca")}
        {folderRow}
        {folderField}
        <div className="chips" role="group" aria-label="Qué mostrar">
          {FILTERS.map(([id, label]) => (
            <button key={id} type="button"
              className={cx("chip", filter === id && "is-on")}
              aria-pressed={filter === id}
              onClick={() => setFilter((cur) => toggleFilter(cur, id))}>
              {label}
              {id !== "all" && <span className="chip__n">{countsFor(count, folders)[id]}</span>}
            </button>
          ))}
        </div>
        {items}
      </div>
    );
  }

  return (
    <div className="lhome">
      {allSongs}
      <div className="tiles">
        <Tile n={nLists} label="Listas" onClick={open("lists")} />
        <Tile n={count.albums} label="Álbumes" onClick={open("albums")} />
        <Tile n={count.artists} label="Artistas" onClick={open("artists")} />
        <Tile icon="ChartBar" label="Lo que más escuchas" onClick={open("top")} />
      </div>
      {head("Tu biblioteca")}
      {folderRow}
      {folderField}
      {listsReady && (
        <section className="sec" aria-labelledby="l-lis">
          <SectionHead id="l-lis" title="Tus listas" onAll={open("lists")} label="Ver todas tus listas" />
          {items}
        </section>
      )}
      {artists.length > 0 && (
        <section className="sec" aria-labelledby="l-art">
          <SectionHead id="l-art" title="Artistas" onAll={open("artists")} label="Ver todos los artistas" />
          <Shelf>
            {artists.map((g) => <ArtistCard key={g.id} g={g} ctx={ctx} />)}
          </Shelf>
        </section>
      )}
      {count.albums > 0 && (
        <section className="sec" aria-labelledby="l-alb">
          <SectionHead id="l-alb" title="Álbumes" onAll={open("albums")} label="Ver todos los álbumes" />
          <Shelf>
            {index.albums.slice(0, PHONE_SHELF).map((g) => <AlbumCard key={g.id} g={g} ctx={ctx} />)}
          </Shelf>
        </section>
      )}
    </div>
  );
}

const countsFor = (count, folders) => ({
  lists: count.lists - folders.length,
  artists: count.artists,
  albums: count.albums,
});
