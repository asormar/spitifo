import { fmtSize, fmtTime } from "../shared/format.js";
import Sheet from "../shared/Sheet.jsx";
import { ExtLink } from "../shared/ui.jsx";
import { provenance, trackState } from "./constants.js";
import { useDl } from "./DlRing.jsx";
import Ico from "../shared/ico.jsx";
import PreviewButton from "./PreviewButton.jsx";
import { Thumb, VerdictPill, factsOf } from "./ResultRow.jsx";
import { dlText, dlWaiting } from "./searchPlan.js";
import { useVerdict, verdictKey, verdictOf, verdictStore, vText } from "./verdict.js";
import "./ficha.css";

/* ---------------------------------------------------------------------------
   FICHA DE UN RESULTADO

   Hoja (telefono) o dialogo (escritorio) con lo que se sabe del resultado ANTES
   de bajarlo: el veredicto, de donde salen la ficha y el archivo, y, en Internet
   Archive, la verificacion «¿Es esta la cancion?». Vive en la pila de
   navegacion (ficha): Escape, atras y el atras de Android la cierran. Todo el
   estado (veredicto, descarga) sale de los almacenes, no de aqui: cerrar y
   reabrir no pierde nada y la fila de debajo se entera sola.
   ------------------------------------------------------------------------- */

/* Pares termino/valor; las filas sin valor no se pintan. [clave, valor, clase]. */
const Facts = ({ rows }) => (
  <dl className="facts">
    {rows.map(([k, v, cls]) => v && [<dt key={k}>{k}</dt>, <dd key={k + 1} className={cls}>{v}</dd>])}
  </dl>
);

/* «¿Es esta la cancion?»: lee las etiquetas del audio sin bajarlo. */
function Verify({ t, query }) {
  const rec = useVerdict(verdictKey(t, query));
  const run = () => verdictStore.verify(t, query);

  /* Sin hacer, haciendose o fallida: un solo boton que dice en que esta. */
  if (rec?.from !== "verify") {
    const wait = rec?.phase === "loading";
    const fail = rec?.phase === "error";
    return (
      <div className="ver" aria-live="polite">
        <button type="button" className={wait ? "vbtn vbtn--wait" : "vbtn"} aria-disabled={wait || undefined} onClick={() => !wait && run()}>
          {wait ? <span className="sp" aria-hidden="true" /> : <Ico n={fail ? "retry" : "spark"} size={16} />}
          {wait
            ? "Leyendo las etiquetas del audio"
            : fail
            ? `No pude verificar: ${rec.error}. Reintentar`
            : "¿Es esta la canción?"}
        </button>
      </div>
    );
  }

  const x = rec.extra || {};
  const audio = [x.format, fmtSize(x.size_mb), x.duration_s ? fmtTime(x.duration_s) : null].filter(Boolean).join(" · ");
  const other = x.real_artist && x.real_artist.trim().toLowerCase() !== (t.artist || "").trim().toLowerCase();
  return (
    <section className="ver" aria-label="Verificación del archivo">
      <div className="ver__top">
        <VerdictPill v={verdictOf(t, rec)} />
        {rec.score != null && <span className="num">{Math.round(rec.score * 100)} % de coincidencia</span>}
      </div>
      <Facts
        rows={[
          ["Artista", other && x.real_artist],
          ["Archivo", x.filename, "mono"],
          ["Audio", audio, "num"],
          ["Subido por", x.uploader],
        ]}
      />
      {x.title_source === "item-title" && (
        <p className="note">El archivo no trae etiquetas: el título viene de la ficha del item.</p>
      )}
      <ExtLink className="fl__a" url={x.item_url}>
        ver en Internet Archive <Ico n="ext" size={12} />
      </ExtLink>
    </section>
  );
}

export default function Ficha({ t, query, busy, downloaded, onDl, onClose, anchor }) {
  const st = trackState(t);
  const rec = useVerdict(verdictKey(t, query));
  const done = rec?.phase === "done" ? rec : null;
  const v = verdictOf(t, done);
  const dls = useDl(t, busy, downloaded);
  const wait = dlWaiting(dls);
  const prov = provenance(t);
  const title = t.title || "sin título";
  const sub = [t.artist, t.album && t.album !== t.title ? t.album : null].filter(Boolean).join(" · ");
  const audio = factsOf(t);

  return (
    <Sheet title={`Ficha de ${title}`} onClose={onClose} anchor={anchor}>
      <div className="fh">
        <Thumb t={t} />
        <span className="fh__t">
          <h2>{title}</h2>
          {sub && <span>{sub}</span>}
        </span>
        <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar la ficha" onClick={onClose}>
          <Ico n="x" size={18} />
        </button>
      </div>
      <div className="fb">
        {v && (
          <div className="vcard">
            <VerdictPill v={v} />
            <p>{vText(v, { untested: !done })}</p>
            <Facts
              rows={[
                ["Buscaste", `«${query}»`],
                [done?.by === "video" ? "Título del vídeo" : "En el archivo", done?.real && `«${done.real}»`],
              ]}
            />
          </div>
        )}
        <Facts
          rows={[
            ["Ficha", prov.ficha],
            ["Archivo", st === "full" ? prov.archivo : "Sin archivo completo"],
            ["Audio", audio, "num"],
            ["Álbum", t.album],
          ]}
        />
        {t.source === "archive" && <Verify t={t} query={query} />}
        <p className="fl">
          <ExtLink className="fl__a" url={t.extra?.webpage_url}>
            vídeo <Ico n="ext" size={12} />
          </ExtLink>
          <ExtLink className="fl__a" url={t.extra?.item_url}>
            procedencia <Ico n="ext" size={12} />
          </ExtLink>
        </p>
        <div className="fa">
          {t.preview_url && <PreviewButton t={t} text />}
          {st === "full" && (
            <button
              type="button"
              className="btn btn--acc"
              data-s={dls.id}
              aria-disabled={wait || undefined}
              onClick={(e) => !wait && onDl(t, e.currentTarget)}
            >
              {wait ? <span className="sp" aria-hidden="true" /> : <Ico n={dls.id === "done" ? "check" : "dl"} size={18} />}
              {dlText(dls)}
            </button>
          )}
        </div>
        {st !== "full" && (
          <p className="note">
            {st === "preview" ? "Solo hay 30 s de esta fuente. No hay versión completa." : "No hay versión completa."}
          </p>
        )}
      </div>
    </Sheet>
  );
}
