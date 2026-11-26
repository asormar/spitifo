import { coverTone } from "../shared/cover.js";
import { Cover } from "../listen/cards.jsx";
import { Icon } from "./icons.jsx";
import { VerdictPill } from "../shared/Verdict.jsx";
import { thumbUrl } from "./artwork.js";
import { loadArtistChunk } from "./artistChunk.js";
import { bestResultSong } from "./bestResultSong.js";
import { useResultPlayback } from "./resultPlayback.js";
import "../shared/pinkPlay.css";
import "./bestResult.css";

/* ---------------------------------------------------------------------------
   MEJOR RESULTADO (Buscar)

   Tarjeta encima del estante de albumes. Antes solo existia si el texto nombraba
   entero a un artista y siempre dibujaba una portada redonda; ahora la elige
   bestPick.js entre cancion, album y artista, y dibuja el tipo que gano con su
   etiqueta. El boton rosa reproduce la primera cancion que se pueda tocar, por
   el mismo camino que una fila. Tocar la tarjeta abre la ficha del tipo.
   ------------------------------------------------------------------------- */

const KIND_LABEL = { song: "Canción", album: "Álbum", artist: "Artista" };

export function playableSong(best, results = []) {
  if (!best) return null;
  if (best.kind === "song") return best.item;
  if (best.kind === "artist") return bestResultSong(results, best.item);
  return results.find((t) => t?.album && best.item?.title && t.album === best.item.title) || null;
}

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
      className="pk pk--s"
      aria-label={`${on ? "Pausar" : "Reproducir"} ${title}, de ${artist}`}
      onClick={play}
    >
      <Icon name={on ? "Pause" : "Play"} weight="fill" size="lg" />
    </button>
  );
}

/* El hueco de la tarjeta mientras llega el catalogo: las mismas cajas (y alto),
   quietas y sin texto. Los estilos .shk viven con el estante de albumes. */
export function BestResultSkeleton() {
  return (
    <div className="bestsec shk" aria-hidden="true">
      <span className="sh2">Mejor resultado</span>
      <div className="bestc">
        <span className="bestc__main">
          <span className="cv bestc__cv" />
          <span className="bestc__txt">
            <span className="bestc__t">&nbsp;</span>
            <span className="bestc__m">&nbsp;</span>
          </span>
        </span>
      </div>
    </div>
  );
}

export default function BestResult({ best, results = [], query = "", onOpen }) {
  if (!best) return null;
  const song = playableSong(best, results);
  const source = query ? `search:${query}` : null;
  const round = best.kind === "artist";
  return (
    <div className="bestc">
      <button
        type="button"
        className="bestc__main"
        aria-label={`Abrir ${KIND_LABEL[best.kind] || "resultado"} ${best.title}`}
        onPointerEnter={round ? loadArtistChunk : undefined}
        onFocus={round ? loadArtistChunk : undefined}
        onClick={(e) => onOpen(best, e.currentTarget)}
      >
        <Cover
          tone={coverTone(best.title, best.sub)}
          label={best.title}
          src={best.artwork_url ? thumbUrl(best.artwork_url) : undefined}
          round={round}
          className="bestc__cv"
        />
        <span className="bestc__txt">
          <span className="bestc__kind">{KIND_LABEL[best.kind] || "Resultado"}</span>
          <span className="bestc__t">{best.title}</span>
          <span className="bestc__m">
            {best.sub}
            {best.verdict === "match" && <VerdictPill v="match" />}
          </span>
        </span>
      </button>
      {song && <BestPlay song={song} query={query} queue={results} source={source} />}
    </div>
  );
}
