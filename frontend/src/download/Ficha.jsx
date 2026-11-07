import { fmtSize, fmtTime } from "../shared/format.js";
import Sheet from "../shared/Sheet.jsx";
import { ExtLink } from "../shared/ui.jsx";
import { provenance, trackState } from "./constants.js";
import { useDl } from "./DlRing.jsx";
import Ico from "./ico.jsx";
import PreviewButton from "./PreviewButton.jsx";
import { Thumb, VerdictPill, factsOf } from "./ResultRow.jsx";
import { dlText } from "./searchPlan.js";
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

/* «¿Es esta la cancion?»: lee las etiquetas del audio sin bajarlo. */
function Verify({ t, query }) {
  const rec = useVerdict(verdictKey(t, query));
  const run = () => verdictStore.verify(t, query);

  if (rec?.phase === "loading") {
    return (
      <div className="ver" aria-live="polite">
        <span className="vbtn vbtn--wait">
          <span className="sp" aria-hidden="true" />
          Leyendo las etiquetas del audio
        </span>
      </div>
    );
  }
  if (rec?.phase === "error") {
    return (
      <div className="ver">
        <button type="button" className="vbtn" onClick={run}>
          <Ico n="retry" size={16} />
          No pude verificar: {rec.error}. Reintentar
        </button>
      </div>
    );
  }
  if (rec?.from !== "verify") {
    return (
      <div className="ver">
        <button type="button" className="vbtn" onClick={run}>
          <Ico n="spark" size={16} />
          ¿Es esta la canción?
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
      <dl className="facts">
        {other && (
          <>
            <dt>Artista</dt>
            <dd>{x.real_artist}</dd>
          </>
        )}
        {x.filename && (
          <>
            <dt>Archivo</dt>
            <dd className="mono">{x.filename}</dd>
          </>
        )}
        {audio && (
          <>
            <dt>Audio</dt>
            <dd className="num">{audio}</dd>
          </>
        )}
        {x.uploader && (
          <>
            <dt>Subido por</dt>
            <dd>{x.uploader}</dd>
          </>
        )}
      </dl>
      {x.title_source === "item-title" && (
        <p className="note">El archivo no trae etiquetas: el título viene de la ficha del item.</p>
      )}
      <ExtLink className="fl__a" url={x.item_url}>
        ver en Internet Archive ↗
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
  const wait = ["queued", "down", "proc", "direct"].includes(dls.id);
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
            <dl className="facts">
              <dt>Buscaste</dt>
              <dd>«{query}»</dd>
              {done?.real && (
                <>
                  <dt>{done.by === "video" ? "Título del vídeo" : "En el archivo"}</dt>
                  <dd>«{done.real}»</dd>
                </>
              )}
            </dl>
          </div>
        )}
        <dl className="facts">
          <dt>Ficha</dt>
          <dd>{prov.ficha}</dd>
          <dt>Archivo</dt>
          <dd>{st === "full" ? prov.archivo : "Sin archivo completo"}</dd>
          {audio && (
            <>
              <dt>Audio</dt>
              <dd className="num">{audio}</dd>
            </>
          )}
          {t.album && (
            <>
              <dt>Álbum</dt>
              <dd>{t.album}</dd>
            </>
          )}
        </dl>
        {t.source === "archive" && <Verify t={t} query={query} />}
        <p className="fl">
          <ExtLink className="fl__a" url={t.extra?.webpage_url}>
            vídeo ↗
          </ExtLink>
          <ExtLink className="fl__a" url={t.extra?.item_url}>
            procedencia ↗
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
