import { coverTone } from "../shared/cover.js";
import { Cover } from "../listen/cards.jsx";
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

export default function BestResult({ artist, onOpen }) {
  return (
    <button
      type="button"
      className="best"
      aria-label={`Abrir artista ${artist.name}`}
      onPointerEnter={loadArtistChunk}
      onFocus={loadArtistChunk}
      onClick={(e) => onOpen(artist, e.currentTarget)}
    >
      <Cover
        tone={coverTone(artist.name, "")}
        label={artist.name}
        src={artist.artwork_url ? thumbUrl(artist.artwork_url) : undefined}
        className="best__cv"
      />
      <span className="best__txt">
        <span className="best__t">{artist.name}</span>
        <span className="best__m">Artista · {artist.genre || "—"}</span>
      </span>
    </button>
  );
}
