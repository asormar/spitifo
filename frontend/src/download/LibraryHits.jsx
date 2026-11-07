import { useListen } from "../listen/ListenProvider.jsx";
import useLibraryHits from "./useLibraryHits.js";

/* ---------------------------------------------------------------------------
   EN TU BIBLIOTECA

   Las canciones de la biblioteca que casan con lo que se escribe, bajo el campo
   y en vivo (desde 2 letras, sin tocar la red). Son las mismas filas de la
   biblioteca: tocar suena, el menu de los tres puntos y el selector de listas
   ya los trae el ListenProvider. Mas de SHOWN: «Ver las N canciones» abre la
   pagina de resultados. Sin canciones no se pinta nada.
   ------------------------------------------------------------------------- */

const SHOWN = 4;

export default function LibraryHits({ active }) {
  const { ctx } = useListen();
  const lib = useLibraryHits(active);
  if (!lib || !lib.songs.length) return null;

  const { songs } = lib;
  return (
    <section className="lhits" aria-labelledby="lhits-h">
      <h2 className="sh2" id="lhits-h">
        En tu biblioteca
      </h2>
      <div className="lpanel">{songs.slice(0, SHOWN).map((e) => ctx.song(e, songs))}</div>
      {songs.length > SHOWN && (
        <button type="button" className="lhits__all" onClick={() => ctx.open({ type: "all", what: "r-songs" })}>
          Ver las {songs.length} canciones
        </button>
      )}
    </section>
  );
}
