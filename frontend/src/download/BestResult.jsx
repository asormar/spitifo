import { coverTone } from "../shared/cover.js";
import { Cover } from "../listen/cards.jsx";
import { Icon } from "../listen/icons.jsx";
import { thumbUrl } from "./artwork.js";
import { loadArtistChunk } from "./artistChunk.js";
import { bestResultSong } from "./bestResultSong.js";
import { useResultPlayback } from "./resultPlayback.js";
import "../listen/home.css";
import "./bestResult.css";

/* ---------------------------------------------------------------------------
   MEJOR RESULTADO (Buscar, modo Musica)

   Una tarjeta pequena encima del estante de albumes. El nombre y el genero
   vienen de /api/artists/search; la portada redonda es del disco mas nuevo del
   mismo artista entre los resultados de albumes, o la inicial. El chunk de la
   pagina se adelanta al enfocarla. No pide nada por su cuenta: si la busqueda
   de artistas fallo, simplemente no se pinta.

   El boton rosa reproduce la primera cancion del artista que haya entre los
   resultados y se pueda tocar, por el mismo camino que una fila. Tocar la
   tarjeta sigue abriendo la pagina del artista. Las clases llevan prefijo
   propio: .best ya es la tarjeta del mejor resultado de la biblioteca.
   ------------------------------------------------------------------------- */

/* Envuelve el hook aparte: asi solo se monta cuando hay cancion, sin condicionar
   hooks dentro de la tarjeta. */
function BestPlay({ song, query, queue, source }) {
  const { play, isCurrent, playing } = useResultPlayback({ t: song, query, queue, source });
  const on = isCurrent && playing;
  const title = song.title || "esta canción";
  const artist = song.artist || "artista desconocido";
  return (
    <button
      type="button"
      className="pk pk--s bestc__play"
      aria-label={`${on ? "Pausar" : "Reproducir"} ${title}, de ${artist}`}
      onClick={play}
    >
      <Icon name={on ? "Pause" : "Play"} weight="fill" size={22} />
    </button>
  );
}

export default function BestResult({ artist, results = [], query = "", onOpen }) {
  const song = bestResultSong(results, artist);
  const source = query ? `search:${query}` : null;
  return (
    <div className="bestc">
      <button
        type="button"
        className="bestc__main"
        aria-label={`Abrir artista ${artist.name}`}
        onPointerEnter={loadArtistChunk}
        onFocus={loadArtistChunk}
        onClick={(e) => onOpen(artist, e.currentTarget)}
      >
        <Cover
          tone={coverTone(artist.name, "")}
          label={artist.name}
          src={artist.artwork_url ? thumbUrl(artist.artwork_url) : undefined}
          className="bestc__cv"
        />
        <span className="bestc__txt">
          <span className="bestc__t">{artist.name}</span>
          <span className="bestc__m">Artista · {artist.genre || "—"}</span>
        </span>
      </button>
      {song && <BestPlay song={song} query={query} queue={results} source={source} />}
    </div>
  );
}
