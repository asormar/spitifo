import { useMemo } from "react";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { Icon } from "./icons.jsx";
import { Cover, Mosaic, SectionHead, coverOf } from "./cards.jsx";
import { albumHue, entryHue, hueOf, minutes, mosaicHues, plural } from "./home.js";

/* ---------------------------------------------------------------------------
   RESULTADOS AGRUPADOS

   Lo que se ve mientras hay una consulta: el mejor resultado y, debajo,
   canciones, artistas, albumes y listas, cada grupo con su "Ver todo" (una
   pagina de filas que conserva la consulta). Los datos los decide
   home.searchLibrary; aqui solo se pintan.
   ------------------------------------------------------------------------- */

const SHOWN = { songs: 5, artists: 6, albums: 6, lists: 3 };

const songs = (n) => plural(n, "canción", "canciones");

function Best({ best, all, ctx }) {
  const { kind, item } = best;
  const curKey = useEngine((s) => s.track?.key);
  const sounding = useEngine((s) => s.playing);

  const view =
    kind === "artist"
      ? {
          name: item.name,
          type: "Artista",
          sub: songs(item.entries.length),
          hue: hueOf(item.name),
          label: item.name,
          round: true,
          src: null,
          entries: item.entries,
          open: () => ctx.open({ type: "artist", id: item.id }),
          openLabel: `Abrir artista ${item.name}`,
          playLabel: `Reproducir canciones de ${item.name}`,
        }
      : kind === "album"
        ? {
            name: item.name,
            type: "Álbum",
            sub: `${item.artist} · ${songs(item.entries.length)}`,
            hue: albumHue(item.artist, item.name),
            label: item.name,
            src: coverOf(item.entries),
            entries: item.entries,
            open: () => ctx.open({ type: "album", id: item.id }),
            openLabel: `Abrir álbum ${item.name}`,
            playLabel: `Reproducir el álbum ${item.name}`,
          }
        : {
            name: item.title,
            type: "Canción",
            sub: item.album ? `${item.artist} · ${item.album}` : item.artist,
            hue: entryHue(item),
            label: item.artist,
            src: coverOf([item]),
            entries: [item],
            open: (el) => ctx.tap(item, el, all),
            openLabel: `Reproducir ${item.title}`,
            playLabel: `${curKey === item.key && sounding ? "Pausar" : "Reproducir"} ${item.title}`,
          };

  const inside = view.entries.some((e) => e.key === curKey);
  const on = inside && sounding;

  const play = (e) => {
    if (kind === "song") ctx.tap(item, e.currentTarget, all);
    else if (inside) engine.toggle();
    else ctx.playGroup(view.entries);
  };

  return (
    <div className="best">
      <button
        type="button"
        className="best__main"
        aria-label={view.openLabel}
        onClick={(e) => view.open(e.currentTarget)}
      >
        <Cover hue={view.hue} label={view.label} src={view.src} round={view.round} className="best__cv" />
        <span className="best__txt">
          <span className="best__name">{view.name}</span>
          <span className="best__row">
            <span className="best__type">{view.type}</span>
            <span className="best__sub">{view.sub}</span>
          </span>
        </span>
      </button>
      <button type="button" className="best__play" aria-label={view.playLabel} onClick={play}>
        <Icon name={on ? "Pause" : "Play"} weight="fill" size={22} />
      </button>
    </div>
  );
}

export default function SearchResults({ r, query, byKey, ctx }) {
  const q = query.trim();
  const open = (what) => () => ctx.open({ type: "all", what });
  const shownSongs = useMemo(() => r.songs.slice(0, SHOWN.songs), [r.songs]);

  if (r.empty) {
    return (
      <div className="hnone" role="status">
        <p className="hnone__t">Sin resultados para «{q}»</p>
        <p className="hnone__s">Prueba con otro título, artista o álbum.</p>
      </div>
    );
  }

  return (
    <div className="hres">
      <div className="rgrid">
        {r.best && (
          <section className="hsec" aria-label="Mejor resultado">
            <h2 className="hsec__h hsec__h--solo">Mejor resultado</h2>
            <Best best={r.best} all={r.songs} ctx={ctx} />
          </section>
        )}

        {r.songs.length > 0 && (
          <section className="hsec" aria-label="Canciones">
            <SectionHead title="Canciones" onAll={open("r-songs")} label="Ver todas las canciones" />
            <div className="lpanel">{shownSongs.map((e) => ctx.song(e, r.songs))}</div>
          </section>
        )}
      </div>

      {r.artists.length > 0 && (
        <section className="hsec" aria-label="Artistas">
          <SectionHead title="Artistas" onAll={open("r-artists")} label="Ver todos los artistas" />
          <div className="hs artists artists--sm">
            {r.artists.slice(0, SHOWN.artists).map((g) => (
              <button
                key={g.id}
                type="button"
                className="art-c"
                aria-label={`Abrir artista ${g.name}`}
                onClick={() => ctx.open({ type: "artist", id: g.id })}
              >
                <Cover hue={hueOf(g.name)} label={g.name} round className="art-c__cv" />
                <span className="art-c__t">{g.name}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {r.albums.length > 0 && (
        <section className="hsec" aria-label="Álbumes">
          <SectionHead title="Álbumes" onAll={open("r-albums")} label="Ver todos los álbumes" />
          <div className="hs agrid agrid--res">
            {r.albums.slice(0, SHOWN.albums).map((g) => (
              <button
                key={g.id}
                type="button"
                className="alb"
                aria-label={`Abrir álbum ${g.name}, ${g.artist}`}
                onClick={() => ctx.open({ type: "album", id: g.id })}
              >
                <Cover hue={albumHue(g.artist, g.name)} label={g.name} src={coverOf(g.entries)} className="alb__cv" />
                <span className="alb__t">{g.name}</span>
                <span className="alb__a">{g.artist}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {r.lists.length > 0 && (
        <section className="hsec" aria-label="Listas">
          <SectionHead title="Listas" onAll={open("r-lists")} label="Ver todas las listas" />
          <div className="lres">
            {r.lists.slice(0, SHOWN.lists).map((p) => (
              <ListResult key={p.id} list={p} byKey={byKey} ctx={ctx} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ListResult({ list, byKey, ctx }) {
  const hues = useMemo(() => mosaicHues(list.keys, byKey), [list.keys, byKey]);
  const entries = useMemo(() => list.keys.map((k) => byKey.get(k)).filter(Boolean), [list.keys, byKey]);
  const mins = minutes(entries);
  const sub = `${songs(entries.length)}${mins ? ` · ${mins} min` : ""}`;
  return (
    <button
      type="button"
      className="lres__it"
      aria-label={`${list.name}, ${sub}`}
      onClick={() => ctx.open({ type: "list", id: list.id })}
    >
      <Mosaic hues={hues} className="lres__mos" />
      <span className="lres__txt">
        <span className="lres__t">{list.name}</span>
        <span className="lres__s">{sub}</span>
      </span>
      <Icon name="CaretRight" size={18} className="srow__go" />
    </button>
  );
}
