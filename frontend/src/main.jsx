import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  CaretDown,
  CaretRight,
  Check,
  CheckCircle,
  CircleNotch,
  DownloadSimple,
  FolderOpen,
  Info,
  ListBullets,
  MagnifyingGlass,
  MusicNotes,
  Prohibit,
  Sparkle,
  Waveform,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import "./style.css";

const API = "/api";

document.title = "Spitifo: descargá música libre";

const SOURCE_LABEL = {
  itunes: "iTunes",
  archive: "Internet Archive",
  jamendo: "Jamendo",
  wikimedia: "Wikimedia",
  ytdlp: "YouTube",
};

/* Orden de presentacion de las fuentes, el que tiene sentido para el usuario. */
const SOURCE_ORDER = ["itunes", "archive", "wikimedia", "ytdlp", "jamendo"];

/* Los tres modos que ve el usuario. Los nombres internos (matched, sources,
   ytdlp) no salen nunca a la pantalla. */
const MODES = [
  {
    id: "matched",
    label: "Recomendado",
    why: "iTunes trae la ficha limpia y la portada, YouTube trae el archivo. Es la forma más corta de bajar algo entero.",
  },
  {
    id: "sources",
    label: "Todas las fuentes",
    why: "Pregunta a las cinco fuentes a la vez. Más resultados y más ruido: el primero no siempre es el mejor.",
  },
  {
    id: "ytdlp",
    label: "Solo YouTube",
    why: "Solo resultados de YouTube. Casi todo se baja entero, pero el riesgo legal es tuyo.",
  },
];

const MODE_IDS = MODES.map((m) => m.id);

const EXAMPLES = [
  "Nick Cave Into My Arms",
  "Chopin Nocturne",
  "Radiohead Creep",
  "Miles Davis So What",
];

function fmtTime(s) {
  if (!s) return "--:--";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function fmtSize(mb) {
  if (mb == null) return null;
  return `${Number(mb).toFixed(mb < 10 ? 1 : 0)} MB`;
}

/* El estado que domina la fila: se baja entero / solo preview / no coincide.

   OJO con el campo `downloadable` en modo Recomendado: el backend lo deja en
   False aunque el archivo exista, porque la descarga sale de webpage_url. Por
   eso NO se lee ese campo solo: se mira tambien webpage_url y needs_resolve. */
function trackState(t) {
  const full = !!(
    t.downloadable ||
    t.audio_url ||
    t.extra?.needs_resolve ||
    t.extra?.webpage_url
  );
  if (full) return "full";
  if (t.preview_url) return "preview";
  return "none";
}

const STATE_UI = {
  full: { label: "se baja entero", tone: "ok" },
  preview: { label: "solo preview de 30 s", tone: "warn" },
  none: { label: "no coincide", tone: "bad" },
};

/* La licencia larga no se repite en cada fila: el aviso entero vive una sola
   vez en la zona de fuentes. Acá va la version corta, con el texto completo
   en el title para quien lo necesite. */
const LIC_SHORT = {
  "ToS de YouTube (uso personal, riesgo legal)": "uso personal",
  "preview de iTunes (30s)": "solo 30 s",
};

function shortLic(lic) {
  if (!lic) return null;
  return LIC_SHORT[lic] || lic;
}

/* De donde sale la FICHA y de donde sale el ARCHIVO. En modo Recomendado no
   son la misma cosa: iTunes pone los datos y la portada, YouTube pone el
   audio que se baja. Sin esto, "iTunes | 3:07" se lee como si el archivo
   entero fuera de iTunes, y es falso. */
function provenance(t) {
  const label = SOURCE_LABEL[t.source] || t.source;
  const ficha = label;
  const archivo = t.extra?.webpage_url ? SOURCE_LABEL.ytdlp : label;
  return { ficha, archivo, split: ficha !== archivo };
}

/* Arma la query contra /api/search respetando los comportamientos reales:
   - YouTube solo filtra con mode=ytdlp&source=ytdlp (mode solo no filtra).
   - mode=matched con un source degrada el emparejamiento: se avisa en la UI. */
function buildSearchParams(q, mode, src) {
  const p = new URLSearchParams();
  p.set("q", q);
  p.set("limit", "40");
  if (mode === "ytdlp") {
    p.set("mode", "ytdlp");
    p.set("source", "ytdlp");
    return p;
  }
  p.set("mode", mode);
  if (src) p.set("source", src);
  return p;
}

/* Sondea el progreso de una descarga yt-dlp hasta que termine. */
async function pollJob(jobId, setJob, title) {
  for (let i = 0; i < 600; i++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fetch(`${API}/download/progress/${jobId}`);
    const d = await r.json();
    setJob({ ...d, title });
    if (d.status === "done" || d.status === "error") return d;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 700));
  }
  return null;
}

/* Verificacion: lee los tags reales del audio y compara con lo buscado. */
function VerifyPanel({ t, query, onVerified }) {
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
      if (!r.ok) throw new Error(d.detail || "no se pudo verificar");
      setData(d);
      setState("done");
      onVerified?.(t.source + t.source_id, d);
    } catch (e) {
      setState("error");
      setData({ error: e.message });
    }
  }, [t.source, t.source_id, query, onVerified]);

  if (state === "idle") {
    return (
      <button className="vf" onClick={verify}>
        <Sparkle size={14} />
        ¿es esta la canción?
      </button>
    );
  }
  if (state === "loading") {
    return (
      <button className="vf" onClick={verify} disabled aria-live="polite">
        <CircleNotch size={14} className="prog__ico--spin" />
        leyendo los tags del audio
      </button>
    );
  }
  if (state === "error") {
    return (
      <span className="vf" style={{ cursor: "default", borderStyle: "dashed" }}>
        <WarningCircle size={14} />
        no pude verificar: {data?.error}
      </span>
    );
  }

  const m = data.extra || {};
  const tone = m.match === "match" ? "ok" : m.match === "partial" ? "warn" : m.match === "mismatch" ? "bad" : "mute";
  return (
    <div className={`vfbox vfbox--${tone}`}>
      <div className="vfbox__head">
        <strong className="vfbox__title">{m.real_title || "sin título"}</strong>
        <span className={`st st--${tone}`} key={m.match || "unknown"}>
          {m.match_label || "?"}
        </span>
      </div>
      <div className="vfbox__meta">
        {m.real_artist && (
          <>
            artista real <b>{m.real_artist}</b>,{" "}
          </>
        )}
        {m.format && <>{m.format} </>}
        {fmtSize(m.size_mb) && <>{fmtSize(m.size_mb)} </>}
        {m.duration_s ? <>{fmtTime(m.duration_s)} </> : null}
        {m.match_score != null && <>coincide {Math.round(m.match_score * 100)}%</>}
      </div>
      {m.filename && (
        <div className="vfbox__file">
          archivo <code>{m.filename}</code>
        </div>
      )}
      <div className="vfbox__src">
        {m.uploader && <>subido por {m.uploader}. </>}
        {m.title_source === "item-title" && <>el archivo no trae tags, el título viene del item. </>}
        {m.item_url && (
          <a className="ext" href={m.item_url} target="_blank" rel="noreferrer">
            ver en Internet Archive <ArrowUpRight size={12} />
          </a>
        )}
      </div>
    </div>
  );
}

function ShowGroup({ t, query, onDownload, busyId }) {
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ids = (t.extra?.item_ids || [t.source_id]).join(",");
      const r = await fetch(
        `${API}/setlist?source_ids=${encodeURIComponent(ids)}&q=${encodeURIComponent(query)}`
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "no se pudo leer el setlist");
      setTracks(d.tracks);
    } catch (e) {
      setTracks([]);
    } finally {
      setLoading(false);
    }
  }, [t.extra?.item_ids, t.source_id, query]);

  const toggle = useCallback(() => {
    const n = !open;
    setOpen(n);
    if (n && !tracks) load();
  }, [open, tracks, load]);

  const st = trackState(t);
  const prov = provenance(t);
  const lic = shortLic(t.license);

  return (
    <li className={`row show row--${STATE_UI[st].tone}`}>
      {t.artwork_url ? (
        <img className="row__art" src={t.artwork_url} alt="" loading="lazy" />
      ) : (
        <div className="row__art row__art--ph">
          <MusicNotes size={20} />
        </div>
      )}
      <div className="row__main">
        <div className="row__head">
          <h3 className="row__title">{t.title}</h3>
          <span className="grp">{t.extra?.track_count || 1} pistas</span>
          <span className={`st st--${STATE_UI[st].tone}`} key={st}>
            {STATE_UI[st].label}
          </span>
        </div>
        <p className="row__sub">
          {t.artist} {t.year ? `, ${t.year}` : ""}
          <span className="sep" /> concierto en vivo
        </p>
        <div className="row__meta">
          <span className="src">{prov.archivo}</span>
          {lic && (
            <>
              <span className="sep" />
              <span className="lic" title={t.license}>
                {lic}
              </span>
            </>
          )}
          {t.extra?.item_url && (
            <a className="ext" href={t.extra.item_url} target="_blank" rel="noreferrer">
              procedencia <ArrowUpRight size={12} />
            </a>
          )}
        </div>
        <button className="disclosure" onClick={toggle} aria-expanded={open}>
          {open ? <CaretDown size={13} /> : <CaretRight size={13} />}
          <ListBullets size={13} />
          {open ? "ocultar las canciones" : "ver qué canciones hay"}
        </button>

        {open && (
          <ul className="setlist">
            {loading && <li className="slrow slrow--dim">leyendo los tags de cada pista</li>}
            {!loading && tracks && tracks.length === 0 && (
              <li className="slrow slrow--dim">no pude leer las pistas</li>
            )}
            {tracks?.map((s) => {
              const tone =
                s.match === "match"
                  ? "ok"
                  : s.match === "partial"
                  ? "warn"
                  : s.match === "mismatch"
                  ? "bad"
                  : "mute";
              return (
                <li className={`slrow slrow--${tone}`} key={s.source_id}>
                  <div className="slrow__main">
                    <div className="slrow__title">
                      {s.real_title || s.filename}
                      {s.real_artist && s.real_artist !== t.artist && (
                        <span className="meta meta--mute"> {s.real_artist}</span>
                      )}
                    </div>
                    <div className="slrow__meta">
                      <span className={`st st--${tone}`} key={s.match || "unknown"}>
                        {s.match_label || "?"}
                      </span>
                      {s.format && <span className="meta">{s.format}</span>}
                      {fmtSize(s.size_mb) && <span className="meta">{fmtSize(s.size_mb)}</span>}
                      <span className="meta">{fmtTime(s.duration_s)}</span>
                    </div>
                  </div>
                  <button
                    className="dlbtn dlbtn--sm"
                    disabled={busyId === s.source_id}
                    onClick={() => onDownload(s)}
                    title="Descargar a la biblioteca"
                    aria-label={`Descargar ${s.real_title || s.filename}`}
                  >
                    {busyId === s.source_id ? (
                      <CircleNotch size={15} className="prog__ico--spin" />
                    ) : (
                      <DownloadSimple size={15} weight="bold" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="row__acts" />
    </li>
  );
}

function ProgressBar({ job }) {
  if (!job) return null;
  const pct = Math.round(job.progress || 0);
  const done = job.status === "done";
  const failed = job.status === "error";
  const shown = done ? 100 : Math.max(pct, 2);
  return (
    <div className={`prog ${done ? "is-done" : ""}`} role="status" aria-live="polite">
      <span className={`prog__ico ${failed ? "prog__ico--fail" : ""}`}>
        {failed ? (
          <WarningCircle size={20} weight="fill" />
        ) : done ? (
          <CheckCircle size={20} weight="fill" />
        ) : (
          <CircleNotch size={20} className="prog__ico--spin" />
        )}
      </span>
      <div className="prog__body">
        <div className="prog__top">
          <span className="prog__title">{job.title}</span>
          <span className="prog__state">
            {failed ? "falló la descarga" : done ? "listo, está en tu biblioteca" : "bajando con yt-dlp"}
          </span>
        </div>
        <div
          className="prog__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={done ? 100 : pct}
        >
          <div className="prog__fill" style={{ transform: `scaleX(${shown / 100})` }} />
        </div>
      </div>
      <span className="prog__pct">{done ? "100%" : `${pct}%`}</span>
    </div>
  );
}

function Track({ t, query, onDownload, busy, verified, onVerified, index }) {
  const st = trackState(t);
  const ui = STATE_UI[st];
  const v = verified?.[t.source + t.source_id];
  const dur = t.duration_s ? fmtTime(t.duration_s) : null;
  const size = fmtSize(t.extra?.size_mb);
  const web = t.extra?.webpage_url;
  const prov = provenance(t);
  const lic = shortLic(t.license);

  return (
    <li className={`row row--${ui.tone}`} style={{ "--i": index ?? 0 }}>
      {t.artwork_url ? (
        <img className="row__art" src={t.artwork_url} alt="" loading="lazy" />
      ) : (
        <div className="row__art row__art--ph">
          <MusicNotes size={20} />
        </div>
      )}
      <div className="row__main">
        <div className="row__head">
          <h3 className="row__title">{t.title || "sin título"}</h3>
          {t.extra?.is_group && t.extra?.track_count > 1 && (
            <span className="grp">{t.extra.track_count} pistas</span>
          )}
          <span className={`st st--${ui.tone}`} key={st}>
            {ui.label}
          </span>
        </div>
        <p className="row__sub">
          {t.artist || "artista desconocido"}
          {t.album && t.album !== t.title ? `, ${t.album}` : ""}
          {t.year ? `, ${t.year}` : ""}
        </p>
        <div className="row__meta">
          <div className="row__prov">
            {prov.split ? (
              <>
                <span className="src">ficha: {prov.ficha}</span>
                <span className="sep" />
                <span className="src">archivo: {prov.archivo}</span>
              </>
            ) : (
              <span className="src">{prov.archivo}</span>
            )}
          </div>
          <div className="row__facts">
            {dur && <span className="meta">{dur}</span>}
            {dur && size && <span className="meta meta--mute">/</span>}
            {size && <span className="meta">{size}</span>}
            {t.extra?.format && <span className="meta">{t.extra.format}</span>}
            {lic && (
              <>
                <span className="sep" />
                <span className="lic" title={t.license}>
                  {lic}
                </span>
              </>
            )}
            {web && (
              <a className="ext" href={web} target="_blank" rel="noreferrer">
                video <ArrowUpRight size={12} />
              </a>
            )}
            {t.extra?.item_url && (
              <a className="ext" href={t.extra.item_url} target="_blank" rel="noreferrer">
                procedencia <ArrowUpRight size={12} />
              </a>
            )}
          </div>
        </div>
        {v && (
          <div
            className={`realinfo realinfo--${
              v.extra?.match === "match"
                ? "ok"
                : v.extra?.match === "partial"
                ? "warn"
                : v.extra?.match === "mismatch"
                ? "bad"
                : "mute"
            }`}
          >
            <span className="realinfo__k">en el archivo</span>
            <b>{v.extra?.real_title || "?"}</b>
            {v.extra?.real_artist && v.extra.real_artist !== t.artist && (
              <span className="meta meta--mute">{v.extra.real_artist}</span>
            )}
          </div>
        )}
        {t.source === "archive" && <VerifyPanel t={t} query={query} onVerified={onVerified} />}
      </div>
      <div className="row__acts">
        {t.preview_url && (
          <audio controls preload="metadata" src={t.preview_url} className="preview" />
        )}
        {st === "full" ? (
          <button
            className="dlbtn"
            disabled={busy}
            onClick={() => onDownload(t)}
            title="Descargar a la biblioteca"
            aria-label={`Descargar ${t.title || "este resultado"}`}
          >
            {busy ? (
              <CircleNotch size={18} className="prog__ico--spin" />
            ) : (
              <DownloadSimple size={18} weight="bold" />
            )}
          </button>
        ) : (
          <span
            className="row__nodl"
            title={
              st === "preview"
                ? "De esta fuente sólo sale un preview de 30 s"
                : "No encontramos una versión completa de este tema"
            }
          >
            <Prohibit size={17} />
          </span>
        )}
      </div>
    </li>
  );
}

function SkeletonRow({ i }) {
  return (
    <li className="skel skel--pulse" style={{ "--i": i }} aria-hidden="true">
      <div className="skelrow">
        <div className="skel__art" />
        <div className="skelrow__main">
          <div className="skel__t skelrow__t" />
          <div className="skel__m skelrow__m" />
        </div>
        <div className="skel__btn" />
      </div>
    </li>
  );
}

function App() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  const [health, setHealth] = useState(null);
  const [fmt, setFmt] = useState("mp3");
  const [filter, setFilter] = useState("all");
  const [libOpen, setLibOpen] = useState(false);
  const [lib, setLib] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [verified, setVerified] = useState({});
  const [job, setJob] = useState(null);
  const [mode, setMode] = useState("matched");
  const [src, setSrc] = useState("");
  const [searched, setSearched] = useState(false);
  const inputRef = useRef();
  const libRef = useRef(false);
  const lastSig = useRef("");
  const srcBeforeYtdlp = useRef("");

  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  /* Una sola funcion de busqueda, con el texto, el modo y la fuente que
     llegan POR PARAMETRO. Asi el form, los ejemplos de la pantalla vacia y el
     resync automatico comparten exactamente el mismo camino, y no importa que
     el setState de mode/src todavia no haya pegado cuando se la llama. */
  const runSearch = useCallback(async (text, m, s) => {
    const t = text.trim();
    if (!t) return;
    lastSig.current = `${m}|${s}|${t}`;
    setLoading(true);
    setErr(null);
    setDone(null);
    setVerified({});
    setSearched(true);
    setFilter("all");
    const params = buildSearchParams(t, m, s);
    try {
      const r = await fetch(`${API}/search?${params.toString()}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "error de búsqueda");
      setResults(d.results || []);
      setQuery(t);
    } catch (e) {
      setErr(e.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const doSearch = useCallback(
    (e) => {
      e?.preventDefault();
      runSearch(q, mode, src);
    },
    [q, mode, src, runSearch]
  );

  const runExample = useCallback(
    (text) => {
      setQ(text);
      runSearch(text, mode, src);
    },
    [mode, src, runSearch]
  );

  /* Cambiar el modo o la fuente tiene que volver a consultar la API, no solo
     repintar el control. La firma evita el loop: si la peticion que corresponde
     al modo/fuente actual ya se ejecuto, no se repite. Tambien evita el doble
     fetch del arranque, que setea la misma firma. */
  useEffect(() => {
    if (!searched || !query) return;
    const sig = `${mode}|${src}|${query}`;
    if (sig === lastSig.current) return;
    runSearch(query, mode, src);
  }, [mode, src, searched, query, runSearch]);

  const onDownload = useCallback(
    async (t) => {
      setBusyId(t.source + t.source_id);
      setErr(null);
      setDone(null);
      setJob(null);
      try {
        let track = { ...t };
        delete track.downloadable;
        // Las pistas del setlist ya vienen resueltas por /api/setlist.
        // En modo "matched" el video de YouTube ya viene en webpage_url:
        // no hay nada que resolver, la descarga va directo a yt-dlp.
        const isMatched = t.source === "itunes" && t.extra?.webpage_url;
        if (
          !track.audio_url &&
          !isMatched &&
          t.source !== "ytdlp" &&
          t.extra?.needs_resolve
        ) {
          const rr = await fetch(
            `${API}/resolve?query=${encodeURIComponent(query)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(track),
            }
          );
          if (!rr.ok) {
            const d = await rr.json();
            throw new Error(d.detail || "no se pudo resolver");
          }
          track = await rr.json();
          delete track.downloadable;
        }
        // /api/setlist devuelve el veredicto en la raiz, /api/resolve en extra
        const vmatch = t.match || track.extra?.match || track.match;
        const vtitle = t.real_title || track.extra?.real_title || track.real_title;
        const rd = await fetch(
          `${API}/download?query=${encodeURIComponent(query)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: track.source, track, fmt }),
          }
        );
        const j = await rd.json();
        if (!rd.ok) throw new Error(j.detail || "falló la descarga");

        // yt-dlp devuelve job_id: la descarga corre en background, hacer polling
        if (j.job_id) {
          setJob({ status: "pending", progress: 0, title: t.title });
          const finished = await pollJob(j.job_id, setJob, t.title);
          if (finished) {
            if (finished.status === "error") {
              setErr(finished.error || "la descarga falló");
            } else {
              setDone({
                ...j, ...finished,
                filename: finished.filename || finished.path,
                size_mb: finished.size_mb,
                match: finished.match || j.match,
                real_title: finished.real_title || j.real_title,
              });
              if (libRef.current) loadLib();
            }
          }
          return;
        }

        // avisar si lo que se bajo no es lo que se busco
        const finalMatch = j.match || vmatch;
        const finalTitle = j.real_title || vtitle;
        if (finalMatch === "mismatch" || finalMatch === "unknown") {
          setDone({
            ...j,
            warning: `Ojo: en el archivo dice "${
              finalTitle || "sin título"
            }" y vos buscaste "${query}".`,
          });
        } else {
          setDone(j);
        }
        if (libRef.current) loadLib();
      } catch (e) {
        setErr(e.message);
      } finally {
        setBusyId(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fmt, query, setQuery]
  );

  const loadLib = useCallback(async () => {
    const r = await fetch(`${API}/library`);
    const d = await r.json();
    setLib(d.files || []);
  }, []);

  const toggleLib = useCallback(() => {
    const n = !libOpen;
    setLibOpen(n);
    libRef.current = n;
    if (n) loadLib();
  }, [libOpen, loadLib]);

  /* El estado vive en la URL: el link se puede compartir y sobrevive al F5. */
  const writeUrl = useCallback((m, s, text) => {
    const p = new URLSearchParams();
    if (m) p.set("mode", m);
    if (s) p.set("src", s);
    if (text) p.set("q", text);
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, []);

  useEffect(() => {
    if (!searched) return;
    writeUrl(mode, src, query);
  }, [mode, src, query, searched, writeUrl]);

  /* Arranque: si la URL trae consulta, se recupera sola. Usa runSearch para
     que la firma quede seteada y el resync no dispare un segundo fetch. */
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const p = new URLSearchParams(window.location.search);
    const m = p.get("mode");
    const s = p.get("src");
    const text = p.get("q");
    const mm = m && MODE_IDS.includes(m) ? m : "matched";
    const ss = s && SOURCE_ORDER.includes(s) ? s : "";
    if (m && MODE_IDS.includes(m)) setMode(mm);
    if (s && SOURCE_ORDER.includes(s)) setSrc(ss);
    if (text) {
      setQ(text);
      runSearch(text, mm, ss);
    }
  }, [runSearch]);

  const activeMode = MODES.find((m) => m.id === mode) || MODES[0];

  /* Modo Recomendado + filtro de fuente: el backend corta el emparejamiento con
     YouTube y devuelve resultados crudos de esa fuente. Se deriva del estado,
     no del resultado, para avisar antes de que el usuario busque. */
  const degraded = mode === "matched" && !!src;

  const sourceCounts = useMemo(() => {
    const c = {};
    results.forEach((t) => {
      c[t.source] = (c[t.source] || 0) + 1;
    });
    return c;
  }, [results]);

  const fullCount = useMemo(
    () => results.filter((t) => trackState(t) === "full").length,
    [results]
  );

  const shown = useMemo(
    () => (filter === "full" ? results.filter((t) => trackState(t) === "full") : results),
    [results, filter]
  );

  const healthByName = useMemo(() => {
    const m = {};
    (health?.sources || []).forEach((s) => {
      m[s.name] = s;
    });
    return m;
  }, [health]);

  const sources = useMemo(() => {
    const names = SOURCE_ORDER.filter((n) => healthByName[n]);
    const extra = (health?.sources || []).map((s) => s.name).filter((n) => !names.includes(n));
    return [...names, ...extra];
  }, [health, healthByName]);

  const ytOn = healthByName.ytdlp?.active;
  const forced = mode === "ytdlp";

  const pickSource = useCallback(
    (name) => {
      if (forced) return;
      setSrc((cur) => (cur === name ? "" : name));
    },
    [forced]
  );

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Waveform size={22} weight="bold" className="brand__mark" />
          <h1 className="brand__name">spitifo</h1>
          <span className="brand__tag">música libre, en el momento</span>
        </div>
        <button className="btn btn--ghost" onClick={toggleLib} aria-expanded={libOpen}>
          {libOpen ? <X size={15} /> : <FolderOpen size={15} />}
          {libOpen ? "cerrar biblioteca" : "biblioteca"}
          {!libOpen && lib.length > 0 && <span className="btn__count">{lib.length}</span>}
        </button>
      </header>

      <form onSubmit={doSearch} className="search">
        <div className="search__field">
          <MagnifyingGlass size={17} className="search__icon" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscá una canción, un artista, un género"
            aria-label="Qué querés escuchar"
          />
        </div>
        <select value={fmt} onChange={(e) => setFmt(e.target.value)} aria-label="Formato del archivo">
          <option value="mp3">mp3</option>
          <option value="m4a">m4a</option>
          <option value="original">original</option>
        </select>
        <button type="submit" className="search__go" disabled={loading}>
          {loading ? "buscando" : "buscar"}
        </button>
      </form>

      <section className="controls" aria-label="Cómo buscar">
        <div className="modes" role="radiogroup" aria-label="Modo de búsqueda">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              className={`mode ${mode === m.id ? "is-on" : ""}`}
              onClick={() => {
                if (m.id === "ytdlp") {
                  // Solo YouTube manda source=ytdlp siempre. Se guarda el
                  // filtro previo para restaurarlo al salir del modo.
                  if (mode !== "ytdlp") srcBeforeYtdlp.current = src;
                  setSrc("ytdlp");
                } else if (mode === "ytdlp") {
                  setSrc(srcBeforeYtdlp.current);
                }
                setMode(m.id);
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="why">{activeMode.why}</p>

        <div className="sources">
          <span className="sources__label">Fuentes</span>
          {sources.map((name) => {
            const info = healthByName[name];
            const isOff = !info?.active;
            const on = forced ? name === "ytdlp" : src === name;
            const disabled = isOff || (forced && name !== "ytdlp");
            const label = SOURCE_LABEL[name] || name;
            return (
              <button
                key={name}
                type="button"
                className={`chip ${on ? "is-on" : ""}`}
                disabled={disabled}
                aria-pressed={on}
                title={
                  isOff
                    ? `apagada, necesita ${info?.needs_key || "una clave"}`
                    : forced && name !== "ytdlp"
                    ? "en Solo YouTube no se mezclan otras fuentes"
                    : on
                    ? "tocá para quitar el filtro"
                    : `filtrar por ${label}`
                }
                onClick={() => pickSource(name)}
              >
                {on && <Check size={12} weight="bold" />}
                {label}
                {isOff && <span className="chip__n">sin clave</span>}
                {!isOff && sourceCounts[name] ? <span className="chip__n">{sourceCounts[name]}</span> : null}
              </button>
            );
          })}
        </div>

        {degraded && (
          <p className="note note--warn" role="status">
            <WarningCircle size={14} weight="fill" />
            <span>
              Estás en Recomendado con un filtro de{" "}
              {SOURCE_LABEL[src] || src}. El emparejamiento con YouTube se desactiva y
              vas a ver resultados crudos de esa fuente: más ruido y más previews de 30 s.
            </span>
          </p>
        )}

        {ytOn && (
          <p className="note">
            <Info size={14} />
            <span>
              YouTube no es una fuente libre. Lo que sale de ahí se baja con yt-dlp y
              el riesgo legal es tuyo. iTunes solo aporta la ficha y 30 segundos de audio.
            </span>
          </p>
        )}
      </section>

      {err && (
        <div className="msg msg--err" role="alert">
          <WarningCircle size={17} weight="fill" />
          <span>{err}</span>
        </div>
      )}
      <ProgressBar job={job} />
      {done && (
        <div className={`msg ${done.warning ? "msg--warn" : "msg--ok"}`} role="status">
          {done.warning ? (
            <WarningCircle size={17} weight="fill" />
          ) : (
            <CheckCircle size={17} weight="fill" />
          )}
          <span>
            {done.warning
              ? done.warning
              : `${done.filename} está en tu biblioteca${
                  done.size_mb ? ` (${fmtSize(done.size_mb)})` : ""
                }.`}
            {!done.warning && done.real_title && done.match === "match" && (
              <span className="msg__sub">verificado: {done.real_title}</span>
            )}
          </span>
        </div>
      )}

      {libOpen && (
        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">
              <FolderOpen size={17} />
              Tu biblioteca
              <span className="btn__count">{lib.length}</span>
            </h2>
            {health?.library && <span className="panel__path">{health.library}</span>}
          </div>
          <div className="panel__body">
            {lib.length === 0 && (
              <p className="slrow slrow--dim" style={{ margin: "10px 14px" }}>
                Todavía no bajaste nada.
              </p>
            )}
            {lib.map((f) => (
              <div key={f.path} className="librow">
                <audio controls preload="metadata" src={`${API}/audio?path=${encodeURIComponent(f.path)}`} />
                <div style={{ minWidth: 0 }}>
                  <div className="librow__name" title={f.filename}>
                    {f.filename}
                  </div>
                  <div className="librow__meta" title={f.folder}>
                    {f.folder}
                    {f.size_mb != null && ` \u00b7 ${fmtSize(f.size_mb)}`}
                    {f.duration_s ? ` \u00b7 ${fmtTime(f.duration_s)}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {results.length > 0 && (
        <>
          <div className="results__head">
            <span className="results__count">
              <b>{results.length}</b> resultados para <b>{query}</b>,{" "}
              <b>{fullCount}</b> se bajan enteros
            </span>
            <div className="segs" role="group" aria-label="Filtrar resultados">
              <button
                type="button"
                className={`seg ${filter === "all" ? "is-on" : ""}`}
                aria-pressed={filter === "all"}
                onClick={() => setFilter("all")}
              >
                todos <span className="seg__n">{results.length}</span>
              </button>
              <button
                type="button"
                className={`seg ${filter === "full" ? "is-on" : ""}`}
                aria-pressed={filter === "full"}
                onClick={() => setFilter("full")}
              >
                se baja entero <span className="seg__n">{fullCount}</span>
              </button>
            </div>
          </div>
          <ul className="rows">
            {shown.map((t, i) =>
              t.extra?.is_group && t.extra?.track_count > 1 ? (
                <ShowGroup
                  key={t.source + t.source_id}
                  t={t}
                  query={query}
                  onDownload={onDownload}
                  busyId={busyId}
                />
              ) : (
                <Track
                  key={t.source + t.source_id}
                  t={t}
                  query={query}
                  busy={busyId === t.source + t.source_id}
                  onDownload={onDownload}
                  verified={verified}
                  onVerified={(k, d) => setVerified((s) => ({ ...s, [k]: d }))}
                  index={i}
                />
              )
            )}
          </ul>
          {shown.length === 0 && (
            <div className="none">
              <h3 className="none__h">Nada se baja entero en esta búsqueda</h3>
              <p className="none__p">
                Hay {results.length} resultados, pero todos son previews de 30 segundos o
                temas que no coinciden con lo que buscaste. Probá con Todas las fuentes.
              </p>
            </div>
          )}
        </>
      )}

      {loading && (
        <ul className="rows" aria-label="Buscando" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <SkeletonRow key={i} i={i} />
          ))}
        </ul>
      )}

      {!loading && !results.length && !err && !searched && (
        <section className="intro">
          <Sparkle size={26} weight="fill" className="intro__mark" />
          <h2 className="intro__h">Escribí un tema y bajalo entero</h2>
          <p className="intro__p">
            Spitifo pregunta a varias fuentes de música libre y te dice, resultado por
            resultado, si el archivo se baja completo, si solo hay un preview de 30
            segundos, o si no hubo coincidencia.
          </p>
          <p className="intro__lbl">Probá con alguno de estos</p>
          <ul className="examples">
            {EXAMPLES.map((ex) => (
              <li key={ex}>
                <button type="button" className="example" onClick={() => runExample(ex)}>
                  <Waveform size={13} />
                  {ex}
                </button>
              </li>
            ))}
          </ul>
          <p className="intro__fine">
            Internet Archive y Wikimedia liberan archivos. iTunes sirve para encontrar
            la ficha, pero de ahí solo sale un preview de 30 s. YouTube se baja con
            yt-dlp y el riesgo legal es tuyo.
          </p>
        </section>
      )}

      {!loading && !results.length && searched && !err && (
        <div className="none">
          <h3 className="none__h">No encontré nada para "{query}"</h3>
          <p className="none__p">
            Probá con menos palabras, con el nombre del artista solo, o cambiá a Todas
            las fuentes para buscar en iTunes, Internet Archive, Wikimedia y YouTube.
          </p>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
