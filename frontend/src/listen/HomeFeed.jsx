import { useMemo } from "react";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { usePc } from "../shared/viewport.js";
import Ico from "../shared/ico.jsx";
import { cx } from "../shared/ui.jsx";
import { useHistory } from "./history.js";
import { Icon } from "./icons.jsx";
import { Card, Cover, Mosaic, NowBadge, PlayOverlay, Prog, SectionHead, Shelf, coverOf } from "./cards.jsx";
import Mezcla from "./Mezcla.jsx";
import {
  TOP_ALL,
  TOP_HOME,
  albumTone,
  continueItems,
  entryTone,
  mosaicTones,
  plural,
  progressLabel,
  recentAlbums,
  recentEntries,
  toneOf,
  topArtists,
  topItems,
} from "./home.js";
import "../shared/chips.css";
import "./home.css";

/* ---------------------------------------------------------------------------
   INICIO DE ESCUCHAR (consulta vacia)

   La Mezcla, Seguir escuchando, Añadido hace poco, Lo que más escuchas, Tus
   listas, Álbumes, Artistas y la puerta a Explorar la biblioteca, en este orden
   y en un solo HTML. Telefono y escritorio comparten secciones; cuantas
   tarjetas y que variante (carrusel o rejilla, filas o tabla) lo decide
   `usePc()` aqui y no el CSS, asi no se montan las que no se ven.
   ------------------------------------------------------------------------- */

const PHONE = { cont: 5, added: 8, lists: 8, albums: 8, artists: 12 };
const PC = { cont: 5, added: 5, lists: 5, albums: 5, artists: 6 };

/* Preguntas al motor como booleanos: con el motor emitiendo cuatro veces por
   segundo, una tarjeta solo se repinta si cambia lo suyo. */
function useNow(key) {
  const current = useEngine((s) => s.track?.key === key);
  const playing = useEngine((s) => s.track?.key === key && s.playing);
  return [current, playing];
}

/* --- Seguir escuchando ------------------------------------------------------- */

function ContinueCard({ item, items, ctx, active, pc }) {
  const { entry } = item;
  const [current, playing] = useNow(entry.key);
  /* El progreso en vivo solo lo sigue la tarjeta que suena y solo con el
     inicio a la vista; las demas, el guardado. */
  const time = useEngine((s) => (active && s.track?.key === entry.key ? s.time : -1));
  const live = useEngine((s) => (active && s.track?.key === entry.key ? s.duration : 0));
  const dur = time >= 0 && live ? live : item.dur;
  const pos = time >= 0 ? time : item.pos;
  const left = Math.max(0, dur - pos);

  return (
    <Card
      current={current}
      label={`${playing ? "Pausar" : "Seguir con"} ${entry.title}, ${entry.artist}`}
      onClick={() => (current ? engine.toggle() : ctx.resume(item, items))}
      cover={
        <Cover tone={entryTone(entry)} label={entry.title} src={coverOf([entry])}>
          <Prog p={dur > 0 ? Math.min(1, pos / dur) : 0} />
          {pc && <PlayOverlay />}
        </Cover>
      }
      title={entry.title}
      sub={<span className="num">{progressLabel({ finished: item.finished, left }, current)}</span>}
    />
  );
}

/* --- Añadido hace poco -------------------------------------------------------- */

function AddedCard({ entry, list, ctx, pc }) {
  const [current, playing] = useNow(entry.key);
  return (
    <Card
      current={current}
      label={`${playing ? "Pausar" : "Reproducir"} ${entry.title}, ${entry.artist}`}
      onClick={(e) => (current ? engine.toggle() : ctx.play(entry, e.currentTarget, list))}
      cover={
        <Cover tone={entryTone(entry)} label={entry.title} src={coverOf([entry])}>
          {current && <NowBadge on={playing} />}
          {pc && <PlayOverlay />}
        </Cover>
      }
      title={entry.title}
      sub={entry.artist}
    />
  );
}

/* --- Listas ------------------------------------------------------------------- */

function ListCard({ list, byKey, ctx }) {
  const tones = useMemo(() => mosaicTones(list.keys, byKey), [list.keys, byKey]);
  const count = useMemo(() => list.keys.filter((k) => byKey.has(k)).length, [list.keys, byKey]);
  const sub = plural(count, "canción", "canciones");
  return (
    <Card
      label={`${list.name}, ${sub}`}
      onClick={() => ctx.open({ type: "list", id: list.id })}
      cover={<Mosaic tones={tones} />}
      title={list.name}
      sub={sub}
    />
  );
}

export default function HomeFeed({ index, byKey, lists, listsReady, ctx, active }) {
  const pc = usePc();
  const hist = useHistory();
  const entries = index.entries;
  const cap = pc ? PC : PHONE;

  const cont = useMemo(() => continueItems(hist, byKey, cap.cont), [hist, byKey, cap]);
  const top = useMemo(() => topItems(hist, byKey, TOP_ALL), [hist, byKey]);
  const added = useMemo(() => recentEntries(entries, cap.added), [entries, cap]);
  const artists = useMemo(() => topArtists(index.artists, cap.artists), [index, cap]);
  const albums = useMemo(() => recentAlbums(index.albums, cap.albums), [index, cap]);

  const topEntries = useMemo(() => top.map((i) => i.entry), [top]);

  const open = (what) => () => ctx.open({ type: "all", what });
  /* La seccion con el menu de una fila abierto queda por encima de las siguientes. */
  const menuKey = ctx.menu?.key;
  const topUp = menuKey != null && top.slice(0, TOP_HOME).some((t) => t.entry.key === menuKey);

  return (
    <div className="hfeed">
      <Mezcla entries={entries} ctx={ctx} />

      {cont.length > 0 && (
        <section className="sec sec--cont" aria-labelledby="h-cont">
          <SectionHead id="h-cont" title="Seguir escuchando" />
          <Shelf grid={pc}>
            {cont.map((item) => (
              <ContinueCard key={item.entry.key} item={item} items={cont} ctx={ctx} active={active} pc={pc} />
            ))}
          </Shelf>
        </section>
      )}

      {added.length > 0 && (
        <section className="sec" aria-labelledby="h-rec">
          <SectionHead id="h-rec" title="Añadido hace poco" onAll={open("recent")} />
          <Shelf grid={pc}>
            {added.map((entry) => (
              <AddedCard key={entry.key} entry={entry} list={added} ctx={ctx} pc={pc} />
            ))}
          </Shelf>
        </section>
      )}

      {top.length > 0 && (
        <section className={cx("sec", topUp && "sec--up")} aria-labelledby="h-top">
          <SectionHead id="h-top" title="Lo que más escuchas" onAll={open("top")} />
          {pc && (
            <div className="thd" aria-hidden="true">
              <span />
              <span>Título</span>
              <span>Álbum</span>
              <span className="ra">Duración</span>
              <span />
            </div>
          )}
          {top.slice(0, TOP_HOME).map(({ entry, plays }, i) =>
            ctx.song(entry, topEntries, {
              rank: i + 1,
              table: pc,
              sub: `${entry.artist} · ${plural(plays, "reproducción", "reproducciones")}`,
            })
          )}
        </section>
      )}

      {listsReady && (
        <section className="sec" aria-labelledby="h-lis">
          <SectionHead id="h-lis" title="Tus listas" onAll={lists.length ? open("lists") : undefined} />
          <Shelf grid={pc}>
            {lists.length ? (
              lists.slice(0, cap.lists).map((p) => <ListCard key={p.id} list={p} byKey={byKey} ctx={ctx} />)
            ) : (
              <Card
                onClick={() => ctx.open({ type: "all", what: "lists", naming: true })}
                cover={
                  <span className="cv card__add">
                    <Icon name="Plus" size={28} />
                  </span>
                }
                title="Crear tu primera lista"
              />
            )}
          </Shelf>
        </section>
      )}

      {albums.length > 0 && (
        <section className="sec" aria-labelledby="h-alb">
          <SectionHead id="h-alb" title="Álbumes" onAll={open("albums")} />
          <Shelf grid={pc}>
            {albums.map((g) => (
              <Card
                key={g.id}
                label={`Abrir álbum ${g.name}, ${g.artist}`}
                onClick={() => ctx.open({ type: "album", id: g.id })}
                cover={<Cover tone={albumTone(g.artist, g.name)} label={g.name} src={coverOf(g.entries)} />}
                title={g.name}
                sub={g.artist}
              />
            ))}
          </Shelf>
        </section>
      )}

      {artists.length > 0 && (
        <section className="sec" aria-labelledby="h-art">
          <SectionHead id="h-art" title="Artistas" onAll={open("artists")} />
          <Shelf grid={pc} wide>
            {artists.map((g) => (
              <Card
                key={g.id}
                round
                label={`Abrir artista ${g.name}`}
                onClick={() => ctx.open({ type: "artist", id: g.id })}
                cover={<Cover tone={toneOf(g.name)} label={g.name} round />}
                title={g.name}
              />
            ))}
          </Shelf>
        </section>
      )}

      <button type="button" className="xcard" onClick={() => ctx.open({ type: "library", sort: "recent" })}>
        <span className="xcard__ico">
          <Ico n="music" size={22} />
        </span>
        <span className="xcard__txt">
          <span className="xcard__t">Explorar la biblioteca</span>
          <span className="xcard__s">{plural(entries.length, "tema", "temas")} · A–Z, recientes, artista</span>
        </span>
        <Ico n="caret" size={18} />
      </button>
    </div>
  );
}
