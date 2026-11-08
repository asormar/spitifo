import { useMemo } from "react";
import { useNav } from "../app/useNav.js";
import { requestSearch } from "../download/searchRequest.js";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { Icon } from "./icons.jsx";
import { AlbumCard, ArtistCard, Cover, Mosaic, SectionHead, Shelf, coverOf } from "./cards.jsx";
import { albumTone, entryTone, toneOf, minutes, mosaicTones, songs } from "./home.js";

/* ---------------------------------------------------------------------------
   RESULTADOS AGRUPADOS

   Lo que se ve mientras hay una consulta: el mejor resultado y, debajo,
   canciones, artistas, albumes y listas, cada grupo con su "Ver todo" (una
   pagina de filas que conserva la consulta). Los datos los decide
   home.searchLibrary; aqui solo se pintan.
   ------------------------------------------------------------------------- */

const SHOWN = { songs: 5, artists: 6, albums: 6, lists: 3 };

const TYPES = { artist: "Artista", album: "Álbum", song: "Canción" };

function Best({ best, all, ctx }) {
  const { kind, item } = best;
  const curKey = useEngine((s) => s.track?.key);
  const sounding = useEngine((s) => s.playing);

  const song = kind === "song";
  const artist = kind === "artist";
  const name = song ? item.title : item.name;
  const entries = song ? [item] : item.entries;
  const sub = artist
    ? songs(entries.length)
    : song
      ? item.album
        ? `${item.artist} · ${item.album}`
        : item.artist
      : `${item.artist} · ${songs(entries.length)}`;
  const tone = artist ? toneOf(name) : song ? entryTone(item) : albumTone(item.artist, name);

  const inside = entries.some((e) => e.key === curKey);
  const on = inside && sounding;

  /* Una cancion suena o se pausa; un artista o un album, entero. */
  const play = (e) => {
    if (song) ctx.tap(item, e.currentTarget, all);
    else if (inside) engine.toggle();
    else ctx.playGroup(entries);
  };

  return (
    <div className="best">
      <button
        type="button"
        className="best__main"
        aria-label={song ? `Reproducir ${name}` : `Abrir ${TYPES[kind].toLowerCase()} ${name}`}
        onClick={(e) => (song ? play(e) : ctx.open({ type: kind, id: item.id }))}
      >
        <Cover
          tone={tone}
          label={song ? item.artist : name}
          src={artist ? null : coverOf(entries)}
          round={artist}
          size={70}
          className="best__cv"
        />
        <span className="best__txt">
          <span className="best__name">{name}</span>
          <span className="best__sub">
            {TYPES[kind]} · {sub}
          </span>
        </span>
      </button>
      <button type="button" className="pk pk--s" aria-label={`${on ? "Pausar" : "Reproducir"} ${name}`} onClick={play}>
        <Icon name={on ? "Pause" : "Play"} weight="fill" size={22} />
      </button>
    </div>
  );
}

export default function SearchResults({ r, query, byKey, ctx }) {
  const nav = useNav();
  const q = query.trim();
  const open = (what) => () => ctx.open({ type: "all", what });
  const shownSongs = useMemo(() => r.songs.slice(0, SHOWN.songs), [r.songs]);

  if (r.empty) {
    return (
      <div className="hnone">
        <div role="status">
          <p className="hnone__t">Sin resultados para «{q}»</p>
          <p className="hnone__s">Prueba con otro título, artista o álbum.</p>
        </div>
        <button
          type="button"
          className="lbtn lbtn--go"
          onClick={() => {
            requestSearch(q);
            nav.goTab("search");
          }}
        >
          Buscar para descargar
        </button>
      </div>
    );
  }

  return (
    <div className="hres">
      {r.best && (
        <section aria-label="Mejor resultado">
          <h2 className="sh2">Mejor resultado</h2>
          <Best best={r.best} all={r.songs} ctx={ctx} />
        </section>
      )}

      {r.songs.length > 0 && (
        <section aria-label="Canciones">
          <SectionHead title="Canciones" onAll={open("r-songs")} label="Ver todas las canciones" />
          {shownSongs.map((e) => ctx.song(e, r.songs))}
        </section>
      )}

      {r.artists.length > 0 && (
        <section aria-label="Artistas">
          <SectionHead title="Artistas" onAll={open("r-artists")} label="Ver todos los artistas" />
          <Shelf>
            {r.artists.slice(0, SHOWN.artists).map((g) => (
              <ArtistCard key={g.id} g={g} ctx={ctx} />
            ))}
          </Shelf>
        </section>
      )}

      {r.albums.length > 0 && (
        <section aria-label="Álbumes">
          <SectionHead title="Álbumes" onAll={open("r-albums")} label="Ver todos los álbumes" />
          <Shelf>
            {r.albums.slice(0, SHOWN.albums).map((g) => (
              <AlbumCard key={g.id} g={g} ctx={ctx} />
            ))}
          </Shelf>
        </section>
      )}

      {r.lists.length > 0 && (
        <section aria-label="Listas">
          <SectionHead title="Listas" onAll={open("r-lists")} label="Ver todas las listas" />
          {r.lists.slice(0, SHOWN.lists).map((p) => (
            <ListResult key={p.id} list={p} byKey={byKey} ctx={ctx} />
          ))}
        </section>
      )}
    </div>
  );
}

function ListResult({ list, byKey, ctx }) {
  const tones = useMemo(() => mosaicTones(list.keys, byKey), [list.keys, byKey]);
  const entries = useMemo(() => list.keys.map((k) => byKey.get(k)).filter(Boolean), [list.keys, byKey]);
  const mins = minutes(entries);
  const sub = `${songs(entries.length)}${mins ? ` · ${mins} min` : ""}`;
  return (
    <div className="srow">
      <button
        type="button"
        className="srow__main"
        aria-label={`${list.name}, ${sub}`}
        onClick={() => ctx.open({ type: "list", id: list.id })}
      >
        <Mosaic tones={tones} className="mos--row" />
        <span className="srow__txt">
          <span className="srow__t">{list.name}</span>
          <span className="srow__m">{sub}</span>
        </span>
      </button>
    </div>
  );
}
