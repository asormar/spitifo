import { useMemo } from "react";
import { keyUrl } from "../shared/api.js";
import { engine } from "../player/engine.js";
import { openVideo } from "../player/videoStore.js";
import { normalizeLibrary, toQueue, toTrack } from "../listen/library.js";
import { SongRow } from "../listen/rows.jsx";
import { Icon } from "../listen/icons.jsx";
import "./recent.css";

/* ---------------------------------------------------------------------------
   DESCARGADO HACE POCO

   La biblioteca asoma en Descargar: las ultimas descargas para oirlas sin
   cambiar de pantalla y una salida a Escuchar para ver el resto. Reusa SongRow
   y los helpers de Escuchar para que titulos, artistas y el registro con el
   motor (el mini-reproductor se aparta mientras la fila esta a la vista) sean
   los mismos. El backend ya entrega la lista de mas nueva a mas vieja.
   ------------------------------------------------------------------------- */

const RECENT = 5;

const temas = (n) => `${n} ${n === 1 ? "tema" : "temas"}`;

/* Con resultados de busqueda el protagonista son ellos: la biblioteca queda
   en una sola linea. */
export function LibraryLink({ count, onOpen }) {
  if (!count) return null;
  return (
    <button type="button" className="rlink" onClick={onOpen}>
      Tu biblioteca · {temas(count)}
      <Icon name="CaretRight" size={14} />
    </button>
  );
}

export function RecentSection({ files, onOpen }) {
  const total = files.length;
  /* Solo se normalizan las que se ven: la lista puede tener miles. */
  const recent = useMemo(() => normalizeLibrary(files.slice(0, RECENT)), [files]);

  if (!total) return null;

  /* La cola son las recientes de audio: al acabar una suena la siguiente. Un
     video no entra en la cola, se abre en el VideoHost. */
  const play = (entry, el) => {
    if (entry.kind === "video") {
      openVideo(
        { src: keyUrl(entry.key), title: entry.title, artist: entry.artist, hasAudio: entry.hasAudio },
        el
      );
      return;
    }
    const queue = toQueue(recent, keyUrl);
    engine.play(toTrack(entry, keyUrl), {
      queue,
      index: queue.findIndex((t) => t.key === entry.key),
    });
  };

  return (
    <section className="recent" aria-labelledby="recent-title">
      <header className="recent__head">
        <h2 className="recent__h" id="recent-title">
          Descargado hace poco
        </h2>
        <span className="recent__n">Tu biblioteca · {temas(total)}</span>
      </header>
      <div className="lpanel">
        {recent.map((entry, i) => (
          <SongRow key={entry.key} entry={entry} enter={i} onPlay={play} />
        ))}
        <button type="button" className="recent__more" onClick={onOpen}>
          {total > RECENT ? "Ver más" : "Abrir en Escuchar"}
          <Icon name="CaretRight" size={14} />
        </button>
      </div>
    </section>
  );
}
