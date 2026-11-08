import { useMemo, useState } from "react";
import Ico from "../shared/ico.jsx";
import { cx } from "../shared/ui.jsx";
import { usePc } from "../shared/viewport.js";
import { AlbumCard, AllSongs, ArtistCard, Cards, ListCard, NewListCard, SectionHead, Shelf } from "./cards.jsx";
import { libraryCounts, libraryGrid, toggleFilter, topArtists } from "./home.js";
import "../shared/chips.css";
import "./home.css";

/* ---------------------------------------------------------------------------
   TU BIBLIOTECA (consulta vacia)

   Telefono: la tarjeta de Todas tus canciones, cuatro cifras que llevan a su
   "Ver todo" y los carruseles de listas y artistas. Escritorio: las cifras en
   fila, los filtros y una rejilla de seis. Las dos listas largas (todas tus
   canciones, cada "Ver todo") viven en sus paginas.
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
    {icon ? <Ico n={icon} size={24} /> : <b className="num">{n}</b>}
    <span>{label}</span>
  </button>
);

export default function LibraryHome({ model, ctx }) {
  const pc = usePc();
  const { index, lists, listsReady } = model;
  const [filter, setFilter] = useState("all");
  const count = libraryCounts(index, lists);
  const nLists = listsReady ? count.lists : "–";
  const open = (what) => () => ctx.open({ type: "all", what });

  const allSongs = (
    <AllSongs
      n={count.songs}
      storage={model.storage}
      onOpen={() => ctx.open({ type: "library", sort: "recent" })}
      onShuffle={() => ctx.playGroup(model.entries, true)}
    />
  );
  const cards = useMemo(() => (pc ? libraryGrid(index, lists, filter) : []), [pc, index, lists, filter]);
  const artists = useMemo(() => topArtists(index.artists, PHONE_SHELF), [index]);

  if (pc) {
    const counts = { lists: nLists, artists: count.artists, albums: count.albums };
    return (
      <div className="lhome">
        <div className="tiles">
          {allSongs}
          <Tile icon="stats" label="Lo que más escuchas" onClick={open("top")} />
          <Tile icon="clock" label="Añadido hace poco" onClick={open("recent")} />
        </div>
        <div className="chips" role="group" aria-label="Qué mostrar">
          {FILTERS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cx("chip", filter === id && "is-on")}
              aria-pressed={filter === id}
              onClick={() => setFilter((cur) => toggleFilter(cur, id))}
            >
              {label}
              {id !== "all" && <span className="chip__n">{counts[id]}</span>}
            </button>
          ))}
        </div>
        <div className="grid grid--6">
          {filter === "lists" && listsReady && !lists.length && <NewListCard ctx={ctx} />}
          <Cards key={filter} cards={cards} byKey={model.byKey} ctx={ctx} tag />
        </div>
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
        <Tile icon="stats" label="Lo que más escuchas" onClick={open("top")} />
      </div>
      {listsReady && (
        <section className="sec" aria-labelledby="l-lis">
          <SectionHead id="l-lis" title="Tus listas" />
          <Shelf>
            {lists.length ? (
              lists.slice(0, PHONE_SHELF).map((p) => <ListCard key={p.id} list={p} byKey={model.byKey} ctx={ctx} />)
            ) : (
              <NewListCard ctx={ctx} />
            )}
          </Shelf>
        </section>
      )}
      {artists.length > 0 && (
        <section className="sec" aria-labelledby="l-art">
          <SectionHead id="l-art" title="Artistas" />
          <Shelf>
            {artists.map((g) => (
              <ArtistCard key={g.id} g={g} ctx={ctx} />
            ))}
          </Shelf>
        </section>
      )}
    </div>
  );
}
