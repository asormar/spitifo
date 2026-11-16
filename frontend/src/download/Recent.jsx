import { useMemo } from "react";
import { normalizeLibrary } from "../listen/library.js";
import { useListen } from "../listen/ListenProvider.jsx";
import { SongRow } from "../listen/rows.jsx";

/* ---------------------------------------------------------------------------
   DESCARGADO HACE POCO

   La biblioteca asoma en Buscar: las ultimas descargas para oirlas sin cambiar
   de pantalla y una salida a la biblioteca para ver el resto. Reusa SongRow y el
   `ctx.play` de la biblioteca (la cola son las recientes de audio y un video
   se abre en el VideoHost) para que titulos, artistas y reproduccion sean los
   mismos. El backend ya entrega la lista de mas nueva a mas vieja. La pastilla
   de cada fila es el veredicto guardado del archivo (con «Coincide»); un archivo
   sin registro no lleva ninguna.
   ------------------------------------------------------------------------- */

const RECENT = 5;

export default function Recent({ files, onOpen }) {
  const { ctx } = useListen();
  const total = files.length;
  /* Solo se normalizan las que se ven: la lista puede tener miles. */
  const recent = useMemo(() => normalizeLibrary(files.slice(0, RECENT)), [files]);

  if (!total) return null;

  return (
    <section className="recent" aria-labelledby="recent-h">
      <header className="recent__head">
        <h2 className="sh2" id="recent-h">
          Descargado hace poco
        </h2>
        <button type="button" className="recent__all" onClick={onOpen}>
          <span className="only-phone">Ver todo</span>
          <span className="only-pc">
            Tu biblioteca · {total} {total === 1 ? "tema" : "temas"}
          </span>
        </button>
      </header>
      <div className="lpanel">
        {recent.map((entry, i) => (
          <SongRow
            key={entry.key}
            entry={entry}
            list={recent}
            enter={i}
            from="library:Descargado hace poco"
            onPlay={ctx.play}
            all
          />
        ))}
      </div>
    </section>
  );
}
