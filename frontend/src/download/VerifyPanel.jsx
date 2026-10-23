import { useCallback, useState } from "react";
import { Icon } from "./icons.jsx";
import { API, errMsg, fetchErr } from "../shared/api.js";
import { fmtSize, fmtTime } from "../shared/format.js";
import { ExtLink } from "../shared/ui.jsx";
import { StatusChip } from "./status.jsx";

/* Verificacion: lee los tags reales del audio y compara con lo buscado. */
export function VerifyPanel({ t, query }) {
  const [state, setState] = useState("idle");
  const [data, setData] = useState(null);

  const verify = useCallback(async () => {
    setState("loading");
    try {
      const r = await fetch(
        `${API}/verify?q=${encodeURIComponent(query)}&source=${t.source}&source_id=${encodeURIComponent(
          t.source_id
        )}`
      );
      const d = await r.json();
      if (!r.ok) throw new Error(errMsg(d, "no se pudo verificar"));
      setData(d);
      setState("done");
    } catch (e) {
      setState("error");
      setData({ error: fetchErr(e, e.message) });
    }
  }, [t.source, t.source_id, query]);

  if (state === "idle") {
    return (
      <button className="vf" onClick={verify}>
        <Icon name="Sparkle" size={14} />
        ¿Es esta la canción?
      </button>
    );
  }
  if (state === "loading") {
    return (
      <button className="vf" onClick={verify} disabled aria-live="polite">
        <Icon name="CircleNotch" size={14} className="spin" />
        leyendo las etiquetas del audio
      </button>
    );
  }
  if (state === "error") {
    return (
      <button type="button" className="vf vf--retry" onClick={verify}>
        <Icon name="WarningCircle" size={14} />
        no pude verificar: {data?.error}. Reintentar
      </button>
    );
  }

  const m = data.extra || {};
  const tone = m.match === "match" ? "ok" : m.match === "partial" ? "warn" : m.match === "mismatch" ? "bad" : "mute";
  const norm = (x) => (x || "").trim().toLowerCase();
  /* El titulo del archivo solo se repite si NO es el de la tarjeta: cuando
     coincide, volver a escribirlo era ruido (salia tres veces en la misma
     tarjeta). Cuando no coincide es justo lo que hay que ver. */
  const otherTitle = m.real_title && norm(m.real_title) !== norm(t.title) ? m.real_title : null;
  const otherArtist = m.real_artist && norm(m.real_artist) !== norm(t.artist) ? m.real_artist : null;
  const specs = [m.format, fmtSize(m.size_mb), m.duration_s ? fmtTime(m.duration_s) : null].filter(Boolean);
  return (
    <section className="vfbox" aria-label="Verificación del archivo">
      <div className="vfbox__head">
        <StatusChip tone={tone} key={m.match || "unknown"}>
          {m.match_label || "Sin veredicto"}
        </StatusChip>
        {m.match_score != null && (
          <span className="vfbox__score">{Math.round(m.match_score * 100)}% de coincidencia</span>
        )}
      </div>
      <dl className="vfbox__facts">
        {(otherTitle || !m.real_title) && (
          <>
            <dt>En el archivo</dt>
            <dd className="vfbox__strong">{m.real_title || "sin título"}</dd>
          </>
        )}
        {otherArtist && (
          <>
            <dt>Artista</dt>
            <dd>{otherArtist}</dd>
          </>
        )}
        {m.filename && (
          <>
            <dt>Archivo</dt>
            <dd>
              <code>{m.filename}</code>
            </dd>
          </>
        )}
        {specs.length > 0 && (
          <>
            <dt>Audio</dt>
            <dd>{specs.join(" · ")}</dd>
          </>
        )}
        {m.uploader && (
          <>
            <dt>Subido por</dt>
            <dd>{m.uploader}</dd>
          </>
        )}
      </dl>
      {m.title_source === "item-title" && (
        <p className="vfbox__note">El archivo no trae etiquetas: el título viene de la ficha del item.</p>
      )}
      {m.item_url && (
        <ExtLink className="ext vfbox__link" url={m.item_url}>
          ver en Internet Archive <Icon name="ArrowUpRight" size={12} />
        </ExtLink>
      )}
    </section>
  );
}
