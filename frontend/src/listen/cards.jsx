import { useMemo, useState } from "react";
import { keyUrl } from "../shared/api.js";
import Ico from "../shared/ico.jsx";
import { cx } from "../shared/ui.jsx";
import { toneClass, toneVars } from "../shared/cover.js";
import { NavIcon } from "../app/navIcons.jsx";
import { Icon } from "./icons.jsx";
import { Bars, initial } from "./rows.jsx";
import { albumTone, mosaicTones, plural, toneOf } from "./home.js";
import { useMore } from "./useMore.js";

/* ---------------------------------------------------------------------------
   PIEZAS DEL INICIO DE ESCUCHAR

   Portada, mosaico y cabecera de seccion: lo que comparten las tarjetas del
   inicio, los resultados de busqueda y las paginas. La portada es el .jpg que
   el backend deja junto a la pista (`thumbKey`); sin el, o si falla al cargar,
   se dibuja un color de genero con una trama suave y la inicial. El color y la
   trama salen de un tono estable por nombre (shared/cover.js); el CSS lo
   pinta (home.css).
   ------------------------------------------------------------------------- */

/* La primera portada real de un grupo de canciones, o null. */
export const coverOf = (entries) => {
  const hit = entries.find((e) => e.thumbKey);
  return hit ? keyUrl(hit.thumbKey) : null;
};

/* `size` es el lado en px (lo lee el CSS con --s); `round` = artista. */
export function Cover({ tone, label, src, size, round, className, children }) {
  const [bad, setBad] = useState(false);
  return (
    <span
      className={cx("cv", toneClass(tone), round && "cv--round", className)}
      style={{ ...toneVars(tone), ...(size && { "--s": `${size}px` }) }}
    >
      <span aria-hidden="true">{initial(label)}</span>
      {src && !bad && (
        <img
          className="cv__img"
          src={src}
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
        <Ico n="music" size={22} />
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
    cover={<Cover tone={toneOf(g.name)} label={g.name} round />}
    title={g.name}
    sub={sub}
  />
);

export const AlbumCard = ({ g, ctx, sub = g.artist }) => (
  <Card
    label={`Abrir álbum ${g.name}, ${g.artist}`}
    onClick={() => ctx.open({ type: "album", id: g.id })}
    cover={<Cover tone={albumTone(g.artist, g.name)} label={g.name} src={coverOf(g.entries)} />}
    title={g.name}
    sub={sub}
  />
);

/* `sub` por defecto: cuantas canciones suyas siguen en la biblioteca. */
export function ListCard({ list, byKey, ctx, sub }) {
  const tones = useMemo(() => mosaicTones(list.keys, byKey), [list.keys, byKey]);
  const count = useMemo(() => list.keys.filter((k) => byKey.has(k)).length, [list.keys, byKey]);
  const text = plural(count, "canción", "canciones");
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

/* Sin ninguna lista: la tarjeta que invita a crear la primera. */
export const NewListCard = ({ ctx }) => (
  <Card
    onClick={() => ctx.open({ type: "all", what: "lists", naming: true })}
    cover={
      <span className="cv card__add">
        <NavIcon name="plus" size={28} />
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
            sub={`${tag ? "Artista · " : ""}${plural(item.entries.length, "canción", "canciones")}`}
          />
        ) : (
          <AlbumCard key={item.id} g={item} ctx={ctx} sub={tag ? `Álbum · ${item.artist}` : undefined} />
        )
      )}
      {more && <div ref={more} className="sentinel" />}
    </>
  );
}

/* Todas tus canciones: cuantas hay y donde estan. El cuerpo abre la pagina
   (`onOpen`); el boton rosa las baraja y, si se pide, uno suave las reproduce. */
export function AllSongs({ n, storage, onOpen, onPlay, onShuffle }) {
  const body = (
    <>
      <b className="num">{n}</b>
      <span>Todas tus canciones</span>
      <small>En {storage}</small>
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
          <Icon name="Play" weight="fill" size={24} />
        </button>
      )}
      <button type="button" className="pk" aria-label="Reproducir en aleatorio" onClick={onShuffle}>
        <Icon name="Shuffle" size={26} />
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
    <Icon name="Play" weight="fill" size={22} />
  </span>
);
