import { useEffect, useMemo, useState } from "react";
import { keyUrl } from "../shared/api.js";
import { cx } from "../shared/ui.jsx";
import { toneClass, toneVars } from "../shared/cover.js";
import { Icon } from "./icons.jsx";
import { Bars, initial } from "./rows.jsx";
import { albumTone, mosaicTones, songs, toneOf } from "./home.js";
import { DOWNLOAD_FILTERS, rowArt } from "./library.js";
import { useMore } from "./useMore.js";
import { useSaved } from "./saved.js";
import { useArtRecord } from "./art.js";
import { artSrc } from "./artLogic.js";
import "../shared/pinkPlay.css";

/* ---------------------------------------------------------------------------
   PIEZAS DEL INICIO DE ESCUCHAR

   Portada, mosaico y cabecera de seccion: lo que comparten las tarjetas del
   inicio, los resultados de busqueda y las paginas. La portada es el .jpg que
   el backend deja junto a la pista (`thumbKey`); sin el, o si falla al cargar,
   se dibuja un color de genero con una trama suave y la inicial. El color y la
   trama salen de un tono estable por nombre (shared/cover.js); el CSS lo
   pinta (home.css).
   ------------------------------------------------------------------------- */

/* La primera portada real de un grupo de canciones, o null. Una guardada sin
   archivo trae la portada de la fuente en `artworkUrl`: rowArt la resuelve. */
export const coverOf = (entries) => {
  const hit = entries.find((e) => e.thumbKey || e.artworkUrl);
  return hit ? rowArt(hit, keyUrl) : null;
};

/* `size` es el lado en px (lo lee el CSS con --s); `round` = artista. `target`
   es el id de cancion/album/artista: si tiene foto propia, gana a `src`. */
export function Cover({ tone, label, src, target, size, round, className, children }) {
  const [bad, setBad] = useState(false);
  const record = useArtRecord(target);
  const shown = artSrc(record, keyUrl) || src;
  useEffect(() => setBad(false), [shown]);
  /* Sin foto, una letra sobre un color plano se confunde con el esqueleto de
     carga. En su lugar va un patron de dos tonos sacado del mismo tono. */
  const generated = !(shown && !bad);
  return (
    <span
      className={cx("cv", toneClass(tone), round && "cv--round", className)}
      style={{ ...toneVars(tone), ...(size && { "--s": `${size}px` }) }}
    >
      {generated ? (
        <span className="cv__gen" aria-hidden="true" />
      ) : (
        <span aria-hidden="true">{initial(label)}</span>
      )}
      {shown && !bad && (
        <img
          className="cv__img"
          src={shown}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBad(true)}
        />
      )}
      {children}
    </span>
  );
}

/* La pista que suena sobre una portada: el ecualizador en una pastilla. */
export const NowBadge = ({ on }) => (
  <span className="cv__now">
    <Bars on={on} />
  </span>
);

/* Cuatro tonos en cuadricula 2x2; sin ninguno, una nota sobre fondo neutro. */
export function Mosaic({ tones, className }) {
  if (!tones.length) {
    return (
      <span className={cx("mos mos--empty", className)} aria-hidden="true">
        <Icon name="MusicNotes" size="lg" />
      </span>
    );
  }
  return (
    <span className={cx("mos", className)} aria-hidden="true">
      {tones.map((t, i) => (
        <span key={i} className={cx("cv", toneClass(t))} style={toneVars(t)} />
      ))}
    </span>
  );
}

/* "Ver todo": se ve de 34 px y se toca en 44 (home.css). */
export const More = ({ onClick, label }) => (
  <button type="button" className="more" onClick={onClick} aria-label={label}>
    Ver todo
  </button>
);

/* Titulo de seccion con su "Ver todo". `id` enlaza la seccion con su titulo. */
export function SectionHead({ id, title, onAll, label }) {
  return (
    <div className="shead">
      <h2 id={id} className="sh2">
        {title}
      </h2>
      {onAll && <More onClick={onAll} label={label || `Ver todo: ${title}`} />}
    </div>
  );
}

/* Una tarjeta es UN boton: portada (o mosaico), titulo y subtitulo. La portada
   la arma quien llama (con su barra de progreso o su boton de reproducir como
   hijos). `round` = artista. */
export function Card({ cover, title, sub, round, current, label, onClick }) {
  return (
    <button
      type="button"
      className={cx("card", round && "card--art", current && "is-current")}
      aria-label={label}
      onClick={onClick}
    >
      {cover}
      <span className="card__t">{title}</span>
      {sub != null && <span className="card__s">{sub}</span>}
    </button>
  );
}

/* Las tarjetas de artista, album y lista: las mismas en Inicio, Tu biblioteca,
   los resultados y las paginas "Ver todo". `sub` solo si la vista lo pide. */
export const ArtistCard = ({ g, ctx, sub }) => (
  <Card
    round
    label={`Abrir artista ${g.name}`}
    onClick={() => ctx.open({ type: "artist", id: g.id })}
    cover={<Cover tone={toneOf(g.name)} label={g.name} src={coverOf(g.entries)} target={g.id} round />}
    title={g.name}
    sub={sub}
  />
);

export const AlbumCard = ({ g, ctx, sub = g.artist }) => (
  <Card
    label={`Abrir álbum ${g.name}, ${g.artist}`}
    onClick={() => ctx.open({ type: "album", id: g.id })}
    cover={<Cover tone={albumTone(g.artist, g.name)} label={g.name} src={coverOf(g.entries)} target={g.id} />}
    title={g.name}
    sub={sub}
  />
);

/* `sub` por defecto: cuantas canciones suyas siguen en la biblioteca. */
export function ListCard({ list, byKey, ctx, sub }) {
  const tones = useMemo(() => mosaicTones(list.keys, byKey), [list.keys, byKey]);
  const savedById = useSaved((s) => s.byId);
  const count = useMemo(
    () => list.keys.filter((k) => byKey.has(k) || savedById.has(k)).length,
    [list.keys, byKey, savedById]
  );
  const text = songs(count);
  return (
    <Card
      label={`${list.name}, ${text}`}
      onClick={() => ctx.open({ type: "list", id: list.id })}
      cover={<Mosaic tones={tones} />}
      title={list.name}
      sub={sub ? `${sub} · ${text}` : text}
    />
  );
}

/* Filtro de descargas de una lista de canciones: los mismos chips que los
   ordenes, con el activo senalado tambien para lectores de pantalla. */
export function DownloadChips({ filter, onChange }) {
  return (
    <div className="chips" role="group" aria-label="Mostrar">
      {DOWNLOAD_FILTERS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={cx("chip", filter === id && "is-on")}
          aria-pressed={filter === id}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/* Sin ninguna lista: la tarjeta que invita a crear la primera. */
export const NewListCard = ({ ctx }) => (
  <Card
    onClick={() => ctx.open({ type: "all", what: "lists", naming: true })}
    cover={
      <span className="cv card__add">
        <Icon name="Plus" size="xl" />
      </span>
    }
    title="Crear tu primera lista"
  />
);

/* Una tarjeta por elemento ({ kind, item }), de a 60 (useMore); un cambio de
   lista se resuelve con una `key` en quien la usa. `tag`: el subtitulo lleva el
   tipo ("Lista · 4 canciones"). */
export function Cards({ cards, byKey, ctx, tag }) {
  const [shown, more] = useMore(cards.length);
  return (
    <>
      {cards.slice(0, shown).map(({ kind, item }) =>
        kind === "list" ? (
          <ListCard key={item.id} list={item} byKey={byKey} ctx={ctx} sub={tag && "Lista"} />
        ) : kind === "artist" ? (
          <ArtistCard
            key={item.id}
            g={item}
            ctx={ctx}
            sub={`${tag ? "Artista · " : ""}${songs(item.entries.length)}`}
          />
        ) : (
          <AlbumCard key={item.id} g={item} ctx={ctx} sub={tag ? `Álbum · ${item.artist}` : undefined} />
        )
      )}
      {more && <div ref={more} className="sentinel" />}
    </>
  );
}

/* Todas tus canciones: cuantas hay y donde estan, y cuantas se comprobaron
   (`check`, de checkedSummary: vacio si ninguna). El cuerpo abre la pagina
   (`onOpen`); el boton rosa las baraja y, si se pide, uno suave las reproduce. */
export function AllSongs({ n, storage, check, onOpen, onPlay, onShuffle }) {
  const body = (
    <>
      <b className="num">{n}</b>
      <span>Todas tus canciones</span>
      <small>
        En {storage}
        {check && ` · ${check}`}
      </small>
    </>
  );
  return (
    <div className="allsongs">
      {onOpen ? (
        <button type="button" className="allsongs__main" onClick={onOpen}>
          {body}
        </button>
      ) : (
        <div className="allsongs__main">{body}</div>
      )}
      {onPlay && (
        <button type="button" className="cbtn cbtn--soft allsongs__play" aria-label="Reproducir todo" onClick={onPlay}>
          <Icon name="Play" weight="fill" size="lg" />
        </button>
      )}
      <button type="button" className="pk" aria-label="Reproducir en aleatorio" onClick={onShuffle}>
        <Icon name="Shuffle" size="lg" />
      </button>
    </div>
  );
}

/* Telefono: carrusel horizontal. Escritorio (`grid`): rejilla de cinco; los
   artistas, de seis (`wide`). */
export const Shelf = ({ grid, wide, children }) => (
  <div className={grid ? cx("grid", wide && "grid--6") : "shelf"}>{children}</div>
);

/* Progreso de "Seguir escuchando" sobre la portada: solo transform. */
export const Prog = ({ p }) => (
  <span className="pbar">
    <i style={{ transform: `scaleX(${p})` }} />
  </span>
);

/* Boton rosa que aparece sobre la portada con el raton (solo escritorio). */
export const PlayOverlay = () => (
  <span className="po" aria-hidden="true">
    <Icon name="Play" weight="fill" size="lg" />
  </span>
);
