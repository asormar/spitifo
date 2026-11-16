import { useState } from "react";
import { coverTone, toneClass, toneVars } from "../shared/cover.js";
import { cx } from "../shared/ui.jsx";
import { thumbUrl } from "./artwork.js";
import { loadAlbumChunk } from "./albumChunk.js";
import "./albumShelf.css";

/* ---------------------------------------------------------------------------
   ESTANTE DE ALBUMES (Buscar, modo Musica)

   Sale encima de las canciones, como en Spotify o Apple Music. Es parte del
   chunk de Buscar: solo el estante y la pildora de la cola van en el bundle de
   siempre; la ficha y la hoja de Descargas esperan en su propio chunk, que se
   adelanta al enfocar o pasar el raton por una tarjeta.
   ------------------------------------------------------------------------- */

const initial = (label) => (String(label || "").trim()[0] || "?").toUpperCase();

/* La portada de iTunes; sin ella (o si no carga) el tono generado, igual que
   Thumb. Cuadrada, como la de un disco. */
function AlbumCover({ album }) {
  const [broken, setBroken] = useState(false);
  const tone = coverTone(album.artist, album.title);
  return (
    <span className={cx("alcard__cv", "cv", toneClass(tone))} style={toneVars(tone)} aria-hidden="true">
      <span>{initial(album.artist || album.title)}</span>
      {album.artwork_url && !broken && (
        <img
          src={thumbUrl(album.artwork_url)}
          alt=""
          loading="lazy"
          decoding="async"
          width={142}
          height={142}
          onError={() => setBroken(true)}
        />
      )}
    </span>
  );
}

export function AlbumCard({ album, onOpen }) {
  return (
    <button
      type="button"
      className="alcard"
      aria-label={`Abrir el álbum ${album.title}`}
      onPointerEnter={loadAlbumChunk}
      onFocus={loadAlbumChunk}
      onClick={(e) => onOpen(album, e.currentTarget)}
    >
      <AlbumCover album={album} />
      <b className="alcard__t">{album.title || "sin título"}</b>
      <span className="alcard__m">Álbum · {album.year || "—"}</span>
    </button>
  );
}

export default function AlbumShelf({ albums, onOpen }) {
  if (!albums?.length) return null;
  return (
    <section className="alsec" aria-labelledby="al-h">
      <div className="alhead">
        <h2 className="sh2" id="al-h">Álbumes</h2>
        <span className="alcount num" aria-hidden="true">{albums.length}</span>
      </div>
      <div className="alshelf">
        {albums.map((a) => (
          <AlbumCard key={a.id} album={a} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}
