import { memo, useCallback, useState } from "react";
import { API, errMsg, rowKey } from "../shared/api.js";
import { fmtSize, fmtTime } from "../shared/format.js";
import { ExtLink } from "../shared/ui.jsx";
import { SOURCE_CODE, provenance } from "./constants.js";
import DlRing from "./DlRing.jsx";
import Ico from "../shared/ico.jsx";
import { VerdictPill } from "../shared/Verdict.jsx";
import { Thumb } from "./ResultRow.jsx";
import { useVerdict, verdictKey, verdictOf } from "./verdict.js";

/* ---------------------------------------------------------------------------
   UN CONCIERTO

   Un item de Internet Archive con varias pistas: el titulo es el del show, asi
   que hay que leer las etiquetas de cada pista (/api/setlist) para saber cuales
   son. La lista se pide al abrir y trae el veredicto de cada una.
   ------------------------------------------------------------------------- */

/* El veredicto de la pista: lo que dijo la descarga, y si no, el del setlist. */
function Track({ s, n, parent, query, busy, downloaded, onDl }) {
  const rec = useVerdict(verdictKey(s, query));
  const v = verdictOf(s, rec?.phase === "done" ? rec : { phase: "done", match: s.match });
  const otherArtist = s.real_artist && s.real_artist !== parent.artist;
  const meta = [otherArtist ? s.real_artist : null, s.format, fmtSize(s.size_mb)].filter(Boolean).join(" · ");
  return (
    <li className="tr" style={{ "--i": n }}>
      <span className="tr__n num">{String(n + 1).padStart(2, "0")}</span>
      <div className="tr__main">
        <div className="tr__t">{s.real_title || s.filename}</div>
        {meta && <div className="tr__m">{meta}</div>}
      </div>
      <div className="tr__i">
        <VerdictPill v={v} />
        <span className="num">{fmtTime(s.duration_s)}</span>
      </div>
      <DlRing t={s} name={s.real_title || s.filename} busy={busy} downloaded={downloaded} onDl={onDl} small />
    </li>
  );
}

export default memo(function ShowGroup({ t, i, query, onDl, busyIds, downloadedIds }) {
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState(null);
  const [loading, setLoading] = useState(false);
  /* Error aparte de `tracks`: un fallo no puede dejar la lista vacia, o al
     reabrir ya no se reintentaria nunca. */
  const [error, setError] = useState(false);
  /* Montada una vez abierta: si se desmontara al cerrar no habria altura que
     animar. Antes de la primera apertura no existe. */
  const [everOpened, setEverOpened] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const ids = (t.extra?.item_ids || [t.source_id]).join(",");
      const r = await fetch(`${API}/setlist?source_ids=${encodeURIComponent(ids)}&q=${encodeURIComponent(query)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(errMsg(d, "no se pudo leer el setlist"));
      setTracks(d.tracks);
    } catch (e) {
      setTracks(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [t.extra?.item_ids, t.source_id, query]);

  const toggle = () => {
    const n = !open;
    setOpen(n);
    if (n) setEverOpened(true);
    if (n && !tracks) load();
  };

  const prov = provenance(t);
  const v = verdictOf(t, null);

  return (
    <li className="grp" style={{ "--i": i }}>
      <div className="grp__head">
        <Thumb t={t} />
        <span className="res__txt">
          <span className="res__t">{t.title}</span>
          <span className="res__s">{[t.artist, t.year].filter(Boolean).join(", ")}</span>
          <span className="res__m">
            {v && <VerdictPill v={v} />}
            <span>Concierto en vivo, {t.extra?.track_count || 1} pistas</span>
            <span className="src" title={prov.archivo}>
              {SOURCE_CODE[t.source] || prov.ficha}
            </span>
            <ExtLink className="ext" url={t.extra?.item_url}>
              procedencia <Ico n="ext" size={12} />
            </ExtLink>
          </span>
        </span>
      </div>
      <button type="button" className="disc" onClick={toggle} aria-expanded={open}>
        <Ico n="caret" size={16} />
        {open ? "ocultar las canciones" : "ver qué canciones hay"}
      </button>
      {everOpened && (
        <div className="fold" data-open={open ? "" : undefined} inert={open ? undefined : ""}>
          <div className="fold__in">
            <ul className="setl">
              {loading && <li className="tr tr--dim">leyendo las etiquetas de cada pista</li>}
              {!loading && error && (
                <li className="tr tr--dim">
                  no pude leer las pistas
                  <button type="button" className="vf vf--retry" onClick={load}>
                    Reintentar
                  </button>
                </li>
              )}
              {!loading && tracks && tracks.length === 0 && <li className="tr tr--dim">no pude leer las pistas</li>}
              {tracks?.map((s, n) => (
                <Track
                  key={s.source_id}
                  s={s}
                  n={n}
                  parent={t}
                  query={query}
                  busy={busyIds.has(rowKey(s))}
                  downloaded={downloadedIds.has(rowKey(s))}
                  onDl={onDl}
                />
              ))}
            </ul>
          </div>
        </div>
      )}
    </li>
  );
});
