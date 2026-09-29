import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  CaretDown,
  CaretRight,
  CheckCircle,
  CircleNotch,
  DownloadSimple,
  ListBullets,
  MagnifyingGlass,
  MusicNotes,
  Prohibit,
  Sparkle,
  Stack,
  Waveform,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import "./style.css";

const API = "/api";

document.title = "Spitifo: descarga música libre";

const SOURCE_LABEL = {
  itunes: "iTunes",
  archive: "Internet Archive",
  jamendo: "Jamendo",
  wikimedia: "Wikimedia",
  ytdlp: "YouTube",
};

/* Los tres modos que ve el usuario. Los nombres internos (matched, sources,
   ytdlp) no salen nunca a la pantalla. */
/* `why` explica QUE HACE el modo activo (informacion funcional, se queda).
   El aviso legal que vivia al lado ya no esta en la UI: se elimino por
   decision del usuario, no por descuido. */
const MODES = [
  {
    id: "matched",
    label: "Recomendado",
    why: "iTunes aporta la ficha limpia y la portada, YouTube aporta el audio. Es la forma más directa de descargar el tema completo.",
  },
  {
    id: "sources",
    label: "Todas las fuentes",
    why: "Consulta las cinco fuentes a la vez. Más resultados y más ruido: el primero no siempre es el mejor.",
  },
  {
    id: "ytdlp",
    label: "Solo YouTube",
    why: "Resultados solo de YouTube. Casi todo llega completo, sin el preview de 30 segundos de iTunes.",
  },
];

const MODE_IDS = MODES.map((m) => m.id);

/* Formatos que acepta el backend. El valor que viaja en el POST de descarga es
   exactamente este string, sin traducirlo. */
const FORMATS = [
  { value: "mp3", label: "mp3", title: "Convertir el audio a MP3" },
  { value: "m4a", label: "m4a", title: "Convertir el audio a M4A" },
  {
    value: "original",
    label: "original",
    title: "Descargar el archivo tal cual, sin convertir",
  },
];

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
  full: { label: "Completo", tone: "ok" },
  preview: { label: "solo preview de 30 s", tone: "warn" },
  none: { label: "no coincide", tone: "bad" },
};

/* De donde sale la FICHA y de donde sale el ARCHIVO. En modo Recomendado no
   son la misma cosa: iTunes pone los datos y la portada, YouTube pone el
   audio que se descarga. Sin esto, "iTunes | 3:07" se lee como si el archivo
   entero fuera de iTunes, y es falso. */
function provenance(t) {
  const label = SOURCE_LABEL[t.source] || t.source;
  const ficha = label;
  const archivo = t.extra?.webpage_url ? SOURCE_LABEL.ytdlp : label;
  return { ficha, archivo, split: ficha !== archivo };
}

/* Arma la query contra /api/search respetando los comportamientos reales:
   - YouTube solo filtra con mode=ytdlp&source=ytdlp (mode solo no filtra).
   - mode=matched con un source degrada el emparejamiento, asi que la fuente
     ya no es un filtro del usuario: se deriva siempre del modo. */
function buildSearchParams(q, mode) {
  const p = new URLSearchParams();
  p.set("q", q);
  p.set("limit", "40");
  p.set("mode", mode);
  if (mode === "ytdlp") p.set("source", "ytdlp");
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
        ¿Es esta la canción?
      </button>
    );
  }
  if (state === "loading") {
    return (
      <button className="vf" onClick={verify} disabled aria-live="polite">
        <CircleNotch size={14} className="prog__ico--spin" />
        leyendo las etiquetas del audio
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
        {m.title_source === "item-title" && <>el archivo no trae etiquetas, el título viene del item. </>}
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
            {loading && <li className="slrow slrow--dim">leyendo las etiquetas de cada pista</li>}
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
            {failed ? "falló la descarga" : done ? "listo, está en tu biblioteca" : "descargando con yt-dlp"}
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
            {web && (
              <a className="ext" href={web} target="_blank" rel="noreferrer">
                vídeo <ArrowUpRight size={12} />
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
                ? "De esta fuente solo sale un preview de 30 s"
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

/* Selector de formato. Son tres opciones cortas: un desplegable del sistema
   ocupa media pantalla para mostrar tres palabras, asi que va segmentado y a
   la vista, en la misma linea que el buscador. Radiogroup real, navegable con
   flechas (roving tabindex) y con el valor actual siempre visible. */
function FmtPicker({ value, onChange }) {
  const refs = useRef([]);
  const current = Math.max(
    0,
    FORMATS.findIndex((f) => f.value === value)
  );

  const move = (next) => {
    const i = (next + FORMATS.length) % FORMATS.length;
    onChange(FORMATS[i].value);
    refs.current[i]?.focus();
  };

  return (
    <div className="fmts">
      <div
        className="fmts__group"
        role="radiogroup"
        aria-label="Formato de descarga"
      >
        {FORMATS.map((f, i) => (
          <button
            key={f.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === f.value}
            tabIndex={value === f.value ? 0 : -1}
            title={f.title}
            className={`fmt ${value === f.value ? "is-on" : ""}`}
            onClick={() => onChange(f.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(current + 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(current - 1);
              } else if (e.key === "Home") {
                e.preventDefault();
                move(0);
              } else if (e.key === "End") {
                e.preventDefault();
                move(FORMATS.length - 1);
              }
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
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
  /* null = todavia no lo sabemos. Distinguir "vacia" de "sin consultar" importa:
     sin esto el boton arrancaria atenuado y el contador no apareceria hasta
     abrir el panel, que es justo cuando ya no hace falta. */
  const [lib, setLib] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [verified, setVerified] = useState({});
  const [job, setJob] = useState(null);
  const [mode, setMode] = useState("matched");
  const [searched, setSearched] = useState(false);
  const inputRef = useRef();
  const lastSig = useRef("");

  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  /* Una sola funcion de busqueda, con el texto y el modo que llegan POR
     PARAMETRO. Asi el form, los ejemplos de la pantalla vacia y el resync
     automatico comparten exactamente el mismo camino, y no importa que el
     setState de mode todavia no haya pegado cuando se la llama. */
  const runSearch = useCallback(async (text, m) => {
    const t = text.trim();
    if (!t) return;
    lastSig.current = `${m}|${t}`;
    setLoading(true);
    setErr(null);
    setDone(null);
    setVerified({});
    setSearched(true);
    setFilter("all");
    const params = buildSearchParams(t, m);
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
      runSearch(q, mode);
    },
    [q, mode, runSearch]
  );

  const runExample = useCallback(
    (text) => {
      setQ(text);
      runSearch(text, mode);
    },
    [mode, runSearch]
  );

  /* Cambiar de modo tiene que volver a consultar la API, no solo repintar el
     control. La firma evita el loop: si la peticion que corresponde al modo
     actual ya se ejecuto, no se repite. Tambien evita el doble fetch del
     arranque, que setea la misma firma. */
  useEffect(() => {
    if (!searched || !query) return;
    const sig = `${mode}|${query}`;
    if (sig === lastSig.current) return;
    runSearch(query, mode);
  }, [mode, searched, query, runSearch]);

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
              loadLib();
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
            }" y tú buscaste "${query}".`,
          });
        } else {
          setDone(j);
        }
        loadLib();
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
    setLibOpen((n) => !n);
  }, []);

  /* El contador del boton tiene que ser real desde el primer render, asi que
     /api/library se pide al montar y no solo al abrir el panel. Es una lista
     de archivos locales: no toca red. */
  useEffect(() => {
    loadLib();
  }, [loadLib]);

  /* null = la consulta sigue en vuelo. Sin esta distincion el boton
     arrancaria atenuado como si la biblioteca estuviera vacia. */
  const libFiles = lib || [];
  const libReady = lib !== null;
  const libCount = libFiles.length;
  const libTitle = libOpen
    ? "Ocultar la biblioteca"
    : libCount > 0
      ? `Abrir la biblioteca (${libCount} ${libCount === 1 ? "tema" : "temas"})`
      : "Biblioteca vacía: todavía no has descargado nada";
  const libAria = libOpen
    ? "Cerrar la biblioteca"
    : libCount > 0
      ? `Biblioteca, ${libCount} ${libCount === 1 ? "tema" : "temas"}`
      : "Biblioteca, vacía";

  /* El estado vive en la URL: el link se puede compartir y sobrevive al F5. */
  const writeUrl = useCallback((m, text) => {
    const p = new URLSearchParams();
    if (m) p.set("mode", m);
    if (text) p.set("q", text);
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, []);

  useEffect(() => {
    if (!searched) return;
    writeUrl(mode, query);
  }, [mode, query, searched, writeUrl]);

  /* Arranque: si la URL trae consulta, se recupera sola. Usa runSearch para
     que la firma quede seteada y el resync no dispare un segundo fetch.
     Los links viejos con ?src=ytdlp equivalen al modo Solo YouTube; cualquier
     otra fuente ya no se puede filtrar porque los chips se fueron. */
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const p = new URLSearchParams(window.location.search);
    const m = p.get("mode");
    const text = p.get("q");
    const mm = m && MODE_IDS.includes(m) ? m : p.get("src") === "ytdlp" ? "ytdlp" : "matched";
    setMode(mm);
    if (text) {
      setQ(text);
      runSearch(text, mm);
    }
  }, [runSearch]);

  const activeMode = MODES.find((m) => m.id === mode) || MODES[0];

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

  /* Con yt-dlp apagado el modo "Solo YouTube" no devuelve nada. No se
     deshabilita (el usuario podria estar reactivandolo desde otra pestana),
     pero se marca para que el 0 de resultados no parezca un fallo. */
  const ytOn = healthByName.ytdlp?.active;
  const ytDead = health !== null && !ytOn;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Waveform size={22} weight="bold" className="brand__mark" />
          <h1 className="brand__name">spitifo</h1>
          <span className="brand__tag">música libre para descargar</span>
        </div>
        <button
          className={[
            "libbtn",
            libOpen ? "is-on" : "",
            libReady && libCount === 0 ? "is-empty" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={toggleLib}
          aria-expanded={libOpen}
          aria-label={libAria}
          title={libTitle}
        >
          {libOpen ? <X size={15} /> : <Stack size={15} />}
          <span className="libbtn__lbl">{libOpen ? "cerrar" : "biblioteca"}</span>
          {!libOpen && libCount > 0 && <span className="count">{libCount}</span>}
        </button>
      </header>

      <form onSubmit={doSearch} className="search">
        <div className="search__field">
          <MagnifyingGlass size={17} className="search__icon" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Busca una canción, un artista, un género"
            aria-label="Qué quieres escuchar"
          />
        </div>
        <FmtPicker value={fmt} onChange={setFmt} />
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
              className={[
                "mode",
                mode === m.id ? "is-on" : "",
                m.id === "ytdlp" && ytDead ? "mode--dead" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => setMode(m.id)}
              title={
                m.id === "ytdlp" && ytDead
                  ? "YouTube está apagado en este servidor: no devolverá resultados"
                  : undefined
              }
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="why">{activeMode.why}</p>
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
              <Stack size={17} />
              Tu biblioteca
              <span className="count">{libCount}</span>
            </h2>
            {health?.library && <span className="panel__path">{health.library}</span>}
          </div>
          <div className="panel__body">
            {libCount === 0 && (
              <p className="slrow slrow--dim" style={{ margin: "10px 14px" }}>
                Todavía no has descargado nada.
              </p>
            )}
            {libFiles.map((f) => (
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
              <b>{fullCount}</b> con descarga completa
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
                descarga completa <span className="seg__n">{fullCount}</span>
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
              <h3 className="none__h">Ningún resultado con descarga completa</h3>
              <p className="none__p">
                Hay {results.length} resultados, pero todos son previews de 30 segundos o
                temas que no coinciden con lo que buscaste. Prueba con Todas las fuentes.
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
          <h2 className="intro__h">Escribe un tema y descárgalo completo</h2>
          <p className="intro__p">
            Spitifo pregunta a varias fuentes de música libre y te dice, resultado por
            resultado, si el archivo se descarga completo, si solo hay un preview de 30
            segundos, o si no hubo coincidencia.
          </p>
          <p className="intro__lbl">Prueba con alguno de estos</p>
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
            la ficha, pero de ahí solo sale un preview de 30 s. De YouTube sale el
            audio completo del tema.
          </p>
        </section>
      )}

      {!loading && !results.length && searched && !err && (
        <div className="none">
          <h3 className="none__h">No encontré nada para "{query}"</h3>
          <p className="none__p">
            Prueba con menos palabras, con el nombre del artista solo, o cambia a Todas
            las fuentes para buscar en iTunes, Internet Archive, Wikimedia y YouTube.
          </p>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
