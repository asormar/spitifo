import { useMemo } from "react";
import { clock } from "../shared/format.js";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { useHistory } from "./history.js";
import { Icon } from "./icons.jsx";
import { Cover, Mosaic, NowBadge, SectionHead, coverOf } from "./cards.jsx";
import {
  TOP_ALL,
  TOP_HOME,
  albumHue,
  continueItems,
  entryHue,
  hueOf,
  mosaicHues,
  plural,
  recentAlbums,
  recentEntries,
  topArtists,
  topItems,
} from "./home.js";

/* ---------------------------------------------------------------------------
   INICIO DE ESCUCHAR (consulta vacia)

   Seguir escuchando, Añadido hace poco, Lo que más escuchas, Artistas, Álbumes,
   Tus listas y la puerta a Explorar la biblioteca. El HTML es uno solo: en
   telefono las secciones van en una columna con el orden de `order` (home.css)
   y desde 960 px las dos columnas se vuelven una rejilla. Cuanto hay de mas
   (10 añadidos, 8 albumes, 5 seguir) lo recorta el CSS segun el ancho.
   ------------------------------------------------------------------------- */

/* Cuantos se pintan como maximo: el CSS oculta los que sobran en telefono. */
const CONTINUE = 5;
const ADDED = 10;
const ALBUMS = 8;
const ARTISTS = 20;

/* Preguntas al motor como booleanos: con el motor emitiendo cuatro veces por
   segundo, una tarjeta solo se repinta si cambia lo suyo. */
function useNow(key) {
  const current = useEngine((s) => s.track?.key === key);
  const playing = useEngine((s) => s.track?.key === key && s.playing);
  return [current, playing];
}

/* --- Seguir escuchando ------------------------------------------------------- */

function ContinueCard({ item, items, ctx }) {
  const { entry } = item;
  const [current, playing] = useNow(entry.key);
  /* La que suena lleva el progreso en vivo; las demas, el guardado. */
  const time = useEngine((s) => (s.track?.key === entry.key ? s.time : -1));
  const live = useEngine((s) => (s.track?.key === entry.key ? s.duration : 0));
  const dur = current && live ? live : item.dur;
  const pos = current ? time : item.pos;
  const pct = dur > 0 ? Math.min(100, Math.round((pos / dur) * 100)) : 0;
  const left = Math.max(0, dur - pos);
  const done = !current && item.finished;

  return (
    <button
      type="button"
      className={`hcard ccard${current ? " is-current" : ""}`}
      aria-label={`${playing ? "Pausar" : "Seguir con"} ${entry.title}, ${entry.artist}`}
      onClick={() => (current ? engine.toggle() : ctx.resume(item, items))}
    >
      <span className="ccard__top">
        <Cover hue={entryHue(entry)} label={entry.artist} src={coverOf([entry])} className="ccard__cv" />
        <span className={`ccard__go${playing ? " is-on" : ""}`}>
          <Icon name={playing ? "Pause" : "Play"} weight="fill" size={18} />
        </span>
      </span>
      <span className="ccard__txt">
        <span className="ccard__t">{entry.title}</span>
        <span className="ccard__a">{entry.artist}</span>
        <span className="ccard__prog">
          <span className="ccard__bar">
            <span style={{ width: `${pct}%` }} />
          </span>
          <span className="ccard__left">{done ? "Escuchada" : `${clock(left)} restantes`}</span>
        </span>
      </span>
    </button>
  );
}

/* --- Añadido hace poco -------------------------------------------------------- */

function AddedCard({ entry, list, ctx }) {
  const [current, playing] = useNow(entry.key);
  return (
    <button
      type="button"
      className="acard"
      aria-label={`${playing ? "Pausar" : "Reproducir"} ${entry.title}, ${entry.artist}`}
      onClick={(e) => (current ? engine.toggle() : ctx.play(entry, e.currentTarget, list))}
    >
      <Cover hue={entryHue(entry)} label={entry.artist} src={coverOf([entry])} className="acard__cv">
        {current && <NowBadge on={playing} />}
      </Cover>
      <span className={`acard__t${current ? " is-current" : ""}`}>{entry.title}</span>
      <span className="acard__a">{entry.artist}</span>
    </button>
  );
}

/* --- Listas ------------------------------------------------------------------- */

function ListCard({ list, byKey, ctx }) {
  const hues = useMemo(() => mosaicHues(list.keys, byKey), [list.keys, byKey]);
  const count = useMemo(() => list.keys.filter((k) => byKey.has(k)).length, [list.keys, byKey]);
  return (
    <button
      type="button"
      className="hcard lcard"
      aria-label={`${list.name}, ${plural(count, "canción", "canciones")}`}
      onClick={() => ctx.open({ type: "list", id: list.id })}
    >
      <Mosaic hues={hues} className="lcard__mos" />
      <span className="lcard__txt">
        <span className="lcard__t">{list.name}</span>
        <span className="lcard__c">{plural(count, "canción", "canciones")}</span>
      </span>
    </button>
  );
}

export default function HomeFeed({ index, byKey, lists, listsReady, ctx }) {
  const hist = useHistory();
  const entries = index.entries;

  const cont = useMemo(() => continueItems(hist, byKey, CONTINUE), [hist, byKey]);
  const top = useMemo(() => topItems(hist, byKey, TOP_ALL), [hist, byKey]);
  const added = useMemo(() => recentEntries(entries, ADDED), [entries]);
  const artists = useMemo(() => topArtists(index.artists, ARTISTS), [index]);
  const albums = useMemo(() => recentAlbums(index.albums, ALBUMS), [index]);

  const contEntries = useMemo(() => cont.map((i) => i.entry), [cont]);
  const topEntries = useMemo(() => top.map((i) => i.entry), [top]);

  const open = (what) => () => ctx.open({ type: "all", what });

  return (
    <div className="hfeed">
      <div className="hcol hcol--main">
        {cont.length > 0 && (
          <section className="hsec hsec--cont" aria-labelledby="h-cont">
            <SectionHead id="h-cont" title="Seguir escuchando" />
            <div className="hs ccards">
              {cont.map((item) => (
                <ContinueCard key={item.entry.key} item={item} items={cont} ctx={ctx} />
              ))}
            </div>
          </section>
        )}

        {added.length > 0 && (
          <section className="hsec hsec--added" aria-labelledby="h-rec">
            <SectionHead id="h-rec" title="Añadido hace poco" onAll={open("recent")} />
            <div className="hs acards">
              {added.map((entry) => (
                <AddedCard key={entry.key} entry={entry} list={added} ctx={ctx} />
              ))}
            </div>
          </section>
        )}

        {albums.length > 0 && (
          <section className="hsec hsec--albums" aria-labelledby="h-alb">
            <SectionHead id="h-alb" title="Álbumes" onAll={open("albums")} />
            <div className="agrid">
              {albums.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="alb"
                  aria-label={`Abrir álbum ${g.name}, ${g.artist}`}
                  onClick={() => ctx.open({ type: "album", id: g.id })}
                >
                  <Cover hue={albumHue(g.artist, g.name)} label={g.artist} src={coverOf(g.entries)} className="alb__cv" />
                  <span className="alb__t">{g.name}</span>
                  <span className="alb__a">{g.artist}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>

      <div className="hcol hcol--side">
        {top.length > 0 && (
          <section className="hsec hsec--top" aria-labelledby="h-top">
            <SectionHead id="h-top" title="Lo que más escuchas" onAll={open("top")} />
            <div className="lpanel">
              {top.slice(0, TOP_HOME).map(({ entry, plays }, i) =>
                ctx.song(entry, topEntries, {
                  rank: i + 1,
                  sub: `${entry.artist} · ${plural(plays, "reproducción", "reproducciones")}`,
                })
              )}
            </div>
          </section>
        )}

        {listsReady && (
          <section className="hsec hsec--lists" aria-labelledby="h-lis">
            <SectionHead id="h-lis" title="Tus listas" onAll={lists.length ? open("lists") : undefined} />
            {lists.length ? (
              <div className="hs lcards">
                {lists.slice(0, 6).map((p) => (
                  <ListCard key={p.id} list={p} byKey={byKey} ctx={ctx} />
                ))}
              </div>
            ) : (
              <button
                type="button"
                className="hcard lcta"
                onClick={() => ctx.open({ type: "all", what: "lists", naming: true })}
              >
                <Icon name="Plus" size={18} />
                Crear tu primera lista
              </button>
            )}
          </section>
        )}
      </div>

      <section className="hsec hsec--artists" aria-labelledby="h-art">
        <SectionHead id="h-art" title="Artistas" onAll={open("artists")} />
        <div className="hs artists">
          {artists.map((g) => (
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

      <button type="button" className="hcard xcard" onClick={() => ctx.open({ type: "library" })}>
        <span className="xcard__ico">
          <Icon name="HardDrives" size={22} />
        </span>
        <span className="xcard__txt">
          <span className="xcard__t">Explorar la biblioteca</span>
          <span className="xcard__s">
            {plural(entries.length, "tema", "temas")} · A–Z, recientes, artista
          </span>
        </span>
        <Icon name="CaretRight" size={20} className="xcard__go" />
      </button>
    </div>
  );
}
