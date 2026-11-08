import { memo, useMemo } from "react";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { usePc } from "../shared/viewport.js";
import Ico from "../shared/ico.jsx";
import { useHistory } from "./history.js";
import {
  AlbumCard,
  ArtistCard,
  Card,
  Cover,
  ListCard,
  NewListCard,
  NowBadge,
  PlayOverlay,
  Prog,
  SectionHead,
  Shelf,
  coverOf,
} from "./cards.jsx";
import Mezcla from "./Mezcla.jsx";
import { Thead } from "./rows.jsx";
import {
  TOP_ALL,
  TOP_HOME,
  continueItems,
  entryTone,
  plural,
  progressLabel,
  recentAlbums,
  recentEntries,
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

/* Memo: un menu abierto cambia la pila de navegacion y repinta la pantalla; el
   feed no cambia con ello. */
export default memo(function HomeFeed({ index, byKey, lists, listsReady, ctx, active }) {
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

  return (
    <div className="hfeed">
      <Mezcla entries={entries} byKey={byKey} ctx={ctx} />

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
        <section className="sec" aria-labelledby="h-top">
          <SectionHead id="h-top" title="Lo que más escuchas" onAll={open("top")} />
          {pc && <Thead />}
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
              <NewListCard ctx={ctx} />
            )}
          </Shelf>
        </section>
      )}

      {albums.length > 0 && (
        <section className="sec" aria-labelledby="h-alb">
          <SectionHead id="h-alb" title="Álbumes" onAll={open("albums")} />
          <Shelf grid={pc}>
            {albums.map((g) => (
              <AlbumCard key={g.id} g={g} ctx={ctx} />
            ))}
          </Shelf>
        </section>
      )}

      {artists.length > 0 && (
        <section className="sec" aria-labelledby="h-art">
          <SectionHead id="h-art" title="Artistas" onAll={open("artists")} />
          <Shelf grid={pc} wide>
            {artists.map((g) => (
              <ArtistCard key={g.id} g={g} ctx={ctx} />
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
});
