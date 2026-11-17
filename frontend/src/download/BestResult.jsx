import { useState } from "react";
import { coverTone, toneClass, toneVars } from "../shared/cover.js";
import { cx } from "../shared/ui.jsx";
import { thumbUrl } from "./artwork.js";
import { loadArtistChunk } from "./artistChunk.js";
import "./bestResult.css";

/* ---------------------------------------------------------------------------
   MEJOR RESULTADO (Buscar, modo Musica)

   Una tarjeta pequena encima del estante de albumes. El nombre y el genero
   vienen de /api/artists/search; la portada redonda es del disco mas nuevo del
   mismo artista entre los resultados de albumes, o la inicial. El chunk de la
   pagina se adelanta al enfocarla. No pide nada por su cuenta: si la busqueda
   de artistas fallo, simplemente no se pinta.
   ------------------------------------------------------------------------- */

const initial = (label) => (String(label || "").trim()[0] || "?").toUpperCase();

export default function BestResult({ artist, onOpen }) {
  const [broken, setBroken] = useState(false);
  const tone = coverTone(artist.name, "");
  return (
    <button
      type="button"
      className="best"
      aria-label={`Abrir artista ${artist.name}`}
      onPointerEnter={loadArtistChunk}
      onFocus={loadArtistChunk}
      onClick={(e) => onOpen(artist, e.currentTarget)}
    >
      <span className={cx("best__cv", "cv", toneClass(tone))} style={toneVars(tone)} aria-hidden="true">
        <span>{initial(artist.name)}</span>
        {artist.artwork_url && !broken && (
          <img
            src={thumbUrl(artist.artwork_url)}
            alt=""
            loading="lazy"
            decoding="async"
            width={72}
            height={72}
            onError={() => setBroken(true)}
          />
        )}
      </span>
      <span className="best__txt">
        <span className="best__t">{artist.name}</span>
        <span className="best__m">Artista · {artist.genre || "—"}</span>
      </span>
    </button>
  );
}
