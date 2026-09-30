import "@fontsource-variable/outfit";
import "@fontsource-variable/figtree";
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

/* Cuanto tarda en desaparecer el aviso de descarga una vez terminada. */
const JOB_DISMISS_MS = 5000;

document.title = "Spitifo: descarga música libre";

const SOURCE_LABEL = {
  itunes: "iTunes",
  archive: "Internet Archive",
  jamendo: "Jamendo",
  wikimedia: "Wikimedia",
  ytdlp: "YouTube",
};

/* Los tres modos que ve el usuario. Los nombres internos (matched, sources,
   ytdlp) no salen nunca a la pantalla. La explicacion que vivia debajo del
   selector (y el aviso legal antes que ella) ya no esta en la UI: se
   eliminaron por decision del usuario, no por descuido. */
const MODES = [
  { id: "matched", label: "Recomendado" },
  { id: "sources", label: "Todas las fuentes" },
  { id: "ytdlp", label: "Solo YouTube" },
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
    // El backend no tiene modo "sin convertir": preferredcodec cae a mp3
    // para todo fmt que no sea mp3/m4a (ytdlp_source.py). Decir lo contrario
    // seria prometer algo que no pasa.
    title: "Se guarda en MP3, igual que la primera opcion",
  },
];

const EXAMPLES = [
  "Nick Cave Into My Arms",
  "Chopin Nocturne",
  "Radiohead Creep",
  "Miles Davis So What",
];

/* El `detail` de FastAPI no siempre es un string: en un 422 es un array de
   {loc, msg, type}. Con `new Error(detail)` eso se convierte en
   "[object Object]" y el usuario lee eso en el aviso. Aplanar a los `msg`.
   Un string se devuelve tal cual; si no hay nada util, el fallback. */
function errMsg(d, fallback) {
  const detail = d?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((e) => (typeof e === "string" ? e : e?.msg))
      .filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  return fallback;
}

/* El aviso de identidad, en un solo lugar. Antes vivia inline en el camino sin
   job_id, asi que el camino CON job_id (modo Recomendado, que es el default)
   salia con `return` antes de llegar y nunca avisaba: te bajabas la cancion
   equivocada con un cartel verde.

   "unknown" tambien avisa, y a proposito: significa que nadie pudo leer de
   donde viene el audio. "No se pudo verificar" es mas honesto que un visto
   bueno que nadie emitio. */
function mismatchNotice(d, match, realTitle, query) {
  if (match === "mismatch" || match === "unknown") {
    const donde = realTitle
      ? `en el archivo dice "${realTitle}"`
      : "no se pudo verificar de donde viene el audio";
    return { ...d, warning: `Ojo: ${donde} y tu buscaste "${query}".` };
  }
  return d;
}

/* fetch() tira TypeError con "Failed to fetch" (en ingles) cuando el server esta
   caido o se corta la red. Sin esto el usuario lee eso crudo en el aviso. */
function fetchErr(e, fallback) {
  const m = typeof e?.message === "string" ? e.message : "";
  if (/failed to fetch|networkerror|load failed/i.test(m)) {
    return "No se pudo contactar con el servidor. Esta sigue en marcha?";
  }
  return fallback;
}

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
  preview: { label: "Solo preview", tone: "warn" },
  none: { label: "No coincide", tone: "bad" },
};

/* El "30 s" ya no cabe en el chip: vive en el tooltip del icono sin descarga. */
const NODL_TITLE = {
  preview: "De esta fuente solo sale un preview de 30 s",
  none: "No encontramos una versión completa de este tema",
};

/* La portada viene de iTunes y a veces no carga (o no existe). Sin onError el
   navegador pinta su icono roto de imagen. Con esto, si falla, sale el
   placeholder con la nota musical. */
function Artwork({ t }) {
  const [broken, setBroken] = useState(false);
  if (!t.artwork_url || broken) {
    return (
      <div className="card__art card__art--ph" aria-hidden="true">
        <Waveform size={26} />
      </div>
    );
  }
  return (
    <img
      className="card__art"
      src={t.artwork_url}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

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

/* Sondea el progreso de una descarga yt-dlp hasta que termine.

   Devuelve el estado terminal, o { status: "timeout" } si se venció el tope.
   El tope existe porque el poll no puede colgar el navegador para siempre,
   pero una pista larga (un concierto de 114 min puede tardar 10 min en
   transcodificar) lo revienta sin que el usuario se entere de nada: el toast
   queda girando en "processing" para siempre. Con "timeout" el llamador puede
   al menos avisar que la descarga sigue corriendo en el servidor. */
async function pollJob(jobId, setJob, title) {
  for (let i = 0; i < 600; i++) {
    let d;
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(`${API}/download/progress/${jobId}`);
      d = await r.json();
    } catch (e) {
      // El server se cae o la red se corta: sin esto el rechazo sube sin
      // catch y el toast queda girando en "Descargando, N%" para siempre.
      // Se marca como fallido para que ProgressBar lo muestre y el aviso
      // se retire solo con el mismo temporizador que un final normal.
      const failed = { status: "error", error: "se perdió la conexión con el servidor" };
      setJob({ ...failed, title });
      return failed;
    }
    /* "unknown" es lo que devuelve el backend para un job que ya no existe
       (purgado por el TTL). Seguir sondeando 600 veces un job que no va a
       aparecer es trabajo perdido: se corta aca. */
    if (d.status === "unknown") {
      const gone = { status: "gone", error: "el servidor ya no tiene esta descarga" };
      setJob({ ...gone, title });
      return gone;
    }
    setJob({ ...d, title });
    if (d.status === "done" || d.status === "error") return d;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 700));
  }
  // El tope se vencio, pero la descarga puede seguir corriendo en el server:
  // NO se marca como error (eso diria "Falló" y seria falso). Se retira igual
  // el toast, asi que el useEffect de JOB_DISMISS_MS tiene que incluirlo.
  setJob({ status: "timeout", title });
  return { status: "timeout" };
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
      if (!r.ok) throw new Error(errMsg(d, "no se pudo verificar"));
      setData(d);
      setState("done");
      onVerified?.(t.source + t.source_id, d);
    } catch (e) {
      setState("error");
      setData({ error: fetchErr(e, e.message) });
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
        <CircleNotch size={14} className="spin" />
        leyendo las etiquetas del audio
      </button>
    );
  }
  if (state === "error") {
    return (
      <span className="vf vf--static">
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
      if (!r.ok) throw new Error(errMsg(d, "no se pudo leer el setlist"));
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
    <li className="card card--wide">
      {t.artwork_url ? (
        <Artwork t={t} />
      ) : (
        <div className="card__art card__art--ph">
          <MusicNotes size={52} />
        </div>
      )}
      <div className="card__body">
        <div className="wide__head">
          <div className="wide__titles">
            <h3 className="card__title card__title--lg">{t.title}</h3>
            <p className="card__sub">{[t.artist, t.year].filter(Boolean).join(", ")}</p>
          </div>
          <span className={`st st--${STATE_UI[st].tone}`} key={st}>
            {STATE_UI[st].label}
          </span>
        </div>
        <div className="card__facts">
          <span className="meta">
            Concierto en vivo, {t.extra?.track_count || 1} pistas
          </span>
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
            {loading && <li className="tr tr--dim">leyendo las etiquetas de cada pista</li>}
            {!loading && tracks && tracks.length === 0 && (
              <li className="tr tr--dim">no pude leer las pistas</li>
            )}
            {tracks?.map((s, n) => {
              const tone =
                s.match === "match"
                  ? "ok"
                  : s.match === "partial"
                  ? "warn"
                  : s.match === "mismatch"
                  ? "bad"
                  : "mute";
              const otherArtist = s.real_artist && s.real_artist !== t.artist;
              return (
                <li className="tr" key={s.source_id}>
                  <span className="tr__n">{String(n + 1).padStart(2, "0")}</span>
                  <div className="tr__main">
                    <div className="tr__title">{s.real_title || s.filename}</div>
                    {(otherArtist || s.format || fmtSize(s.size_mb)) && (
                      <div className="tr__meta">
                        {otherArtist && <span>{s.real_artist}</span>}
                        {s.format && <span>{s.format}</span>}
                        {fmtSize(s.size_mb) && <span>{fmtSize(s.size_mb)}</span>}
                      </div>
                    )}
                  </div>
                  <div className="tr__info">
                    <span className={`st st--${tone}`} key={s.match || "unknown"}>
                      {s.match_label || "?"}
                    </span>
                    <span className="meta">{fmtTime(s.duration_s)}</span>
                  </div>
                  <button
                    className="dl dl--sm"
                    disabled={busyId === s.source_id}
                    onClick={() => onDownload(s)}
                    title="Descargar a la biblioteca"
                    aria-label={`Descargar ${s.real_title || s.filename}`}
                  >
                    {busyId === s.source_id ? (
                      <CircleNotch size={16} className="spin" />
                    ) : (
                      <DownloadSimple size={16} weight="bold" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </li>
  );
}

function ProgressBar({ job }) {
  if (!job) return null;
  const pct = Math.round(job.progress || 0);
  const done = job.status === "done";
  const failed = job.status === "error";
  /* El tope de espera se vencio o el job ya no existe: no fallo, pero tampoco
     se puede seguir mirando. No es "descargando" porque ya no lo sabemos. */
  const halted = job.status === "timeout" || job.status === "gone";
  const shown = done ? 100 : Math.max(pct, 2);
  return (
    <div
      className={`prog ${done ? "is-done" : ""} ${failed || halted ? "is-failed" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="prog__top">
        <span className="prog__ico">
          {failed || halted ? (
            <WarningCircle size={19} weight="fill" />
          ) : done ? (
            <CheckCircle size={19} weight="fill" />
          ) : (
            <CircleNotch size={19} className="spin" />
          )}
        </span>
        <span className="prog__title">{job.title}</span>
        <span className="prog__state">
          {failed
            ? "Falló la descarga"
            : done
            ? "Listo, está en tu biblioteca"
            : halted
            ? job.status === "gone"
              ? "El servidor ya no tiene esta descarga"
              : "Sigue descargando en el servidor"
            : `Descargando, ${pct}%`}
        </span>
      </div>
      <div
        className="prog__bar"
        role="progressbar"
        aria-label="Progreso de la descarga"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={done ? 100 : pct}
      >
        <div className="prog__fill" style={{ transform: `scaleX(${shown / 100})` }} />
      </div>
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
    <li className="card" style={{ "--i": index ?? 0 }}>
      {t.artwork_url ? (
        <Artwork t={t} />
      ) : (
        <div className="card__art card__art--ph">
          <MusicNotes size={44} />
        </div>
      )}
      <div className="card__body">
        <h3 className="card__title">{t.title || "sin título"}</h3>
        <p className="card__sub">
          {t.artist || "artista desconocido"}
          {t.album && t.album !== t.title ? `, ${t.album}` : ""}
          {t.year ? `, ${t.year}` : ""}
        </p>
        <div className="card__prov">
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
        <div className="card__facts">
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
        {t.preview_url && (
          <audio controls preload="metadata" src={t.preview_url} className="preview" />
        )}
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
        <div className="card__foot">
          <span className={`st st--${ui.tone}`} key={st}>
            {ui.label}
          </span>
          {st === "full" ? (
            <button
              className="dl"
              disabled={busy}
              onClick={() => onDownload(t)}
              title="Descargar a la biblioteca"
              aria-label={`Descargar ${t.title || "este resultado"}`}
            >
              {busy ? (
                <CircleNotch size={19} className="spin" />
              ) : (
                <DownloadSimple size={19} weight="bold" />
              )}
            </button>
          ) : (
            <span
              className="dl dl--off"
              role="img"
              title={NODL_TITLE[st]}
              aria-label={NODL_TITLE[st]}
            >
              <Prohibit size={19} />
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

/* Esqueleto con la forma real de una tarjeta, nunca un spinner generico. */
function SkeletonRow({ i }) {
  return (
    <li className="card skel skel--pulse" style={{ "--i": i }} aria-hidden="true">
      <div className="skel__art" />
      <div className="skel__body">
        <div className="skel__t" />
        <div className="skel__m" />
        <div className="skel__foot">
          <div className="skel__chip" />
          <div className="skel__btn" />
        </div>
      </div>
    </li>
  );
}

/* Selector de formato. Son tres opciones cortas: un desplegable del sistema
   ocupa media pantalla para mostrar tres palabras, asi que va segmentado y a
   la vista, en la segunda fila del panel de busqueda, junto al modo. Radiogroup
   real, navegable con flechas (roving tabindex) y con el valor actual siempre
   visible. La etiqueta "Formato" es solo visual: el nombre accesible ya lo
   lleva el radiogroup. */
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
      <span className="fmts__lbl" aria-hidden="true">
        Formato
      </span>
      <div
        className="segs"
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
            className={`seg ${value === f.value ? "is-on" : ""}`}
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

/* El selector de modo es el mismo componente visual que el de formato (.seg) y
   comparte rol, asi que comparte tambien el patron: radiogroup navegable con
   flechas y roving tabindex. Sin esto el patron ARIA prometia flechas que no
   existian, y el teclado necesitaba tres tab stops para recorrer tres modos. */
function ModePicker({ value, onChange, ytDead }) {
  const refs = useRef([]);
  const current = Math.max(
    0,
    MODES.findIndex((m) => m.id === value)
  );

  const move = (next) => {
    const i = (next + MODES.length) % MODES.length;
    onChange(MODES[i].id);
    refs.current[i]?.focus();
  };

  return (
    <div className="segs" role="radiogroup" aria-label="Modo de búsqueda">
      {MODES.map((m, i) => (
        <button
          key={m.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === m.id}
          tabIndex={value === m.id ? 0 : -1}
          className={[
            "seg",
            value === m.id ? "is-on" : "",
            m.id === "ytdlp" && ytDead ? "mode--dead" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => onChange(m.id)}
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
              move(MODES.length - 1);
            }
          }}
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
  const searchSeq = useRef(0);

  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  /* El aviso de descarga se retira solo unos segundos despues de terminar
     (bien o mal). Mientras corre no se toca. Si arranca otra descarga, onDownload
     lo resetea y el cleanup cancela el temporizador pendiente. */
  useEffect(() => {
    if (job?.status !== "done"
        && job?.status !== "error"
        && job?.status !== "timeout"
        && job?.status !== "gone") return undefined;
    const id = setTimeout(() => setJob(null), JOB_DISMISS_MS);
    return () => clearTimeout(id);
  }, [job?.status]);

  /* La franja de exito/aviso (.msg) NO se retiraba nunca: se quedaba en
     pantalla hasta que otra accion la limpiara, mientras el toast de progreso
     si se va solo a los 5 s. Se usa el mismo temporizador.

     NO se retira el aviso de ERROR ni el de "esto no es lo que buscabas": esos
     son informacion que el usuario necesita leer, y desaparecen al buscar de
     nuevo o al descargar otra cosa (setDone(null) / setErr(null) en
     onDownload). */
  useEffect(() => {
    if (!done || done.warning) return undefined;
    const id = setTimeout(() => setDone(null), JOB_DISMISS_MS);
    return () => clearTimeout(id);
  }, [done]);

  /* Una sola funcion de busqueda, con el texto y el modo que llegan POR
     PARAMETRO. Asi el form, los ejemplos de la pantalla vacia y el resync
     automatico comparten exactamente el mismo camino, y no importa que el
     setState de mode todavia no haya pegado cuando se la llama. */
  const runSearch = useCallback(async (text, m) => {
    const t = text.trim();
    if (!t) return;
    /* Cada busqueda toma un numero. Dos overlapping (o el resync)(devuelven
       en cualquier orden: si la lenta llega despues no puede pisar a la que
       el usuario acaba de pedir, ni la URL, ni disparar una tercera peticion
       con el setQuery de la respuesta vieja. */
    const seq = ++searchSeq.current;
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
      if (!r.ok) throw new Error(errMsg(d, "error de búsqueda"));
      if (seq !== searchSeq.current) return;
      setResults(d.results || []);
      setQuery(t);
    } catch (e) {
      if (seq !== searchSeq.current) return;
      setErr(e.message);
      setResults([]);
    } finally {
      if (seq === searchSeq.current) setLoading(false);
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
            throw new Error(errMsg(d, "no se pudo resolver"));
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
        if (!rd.ok) throw new Error(errMsg(j, "falló la descarga"));

        // yt-dlp devuelve job_id: la descarga corre en background, hacer polling
        if (j.job_id) {
          setJob({ status: "pending", progress: 0, title: t.title });
          const finished = await pollJob(j.job_id, setJob, t.title);
          if (finished?.status === "timeout" || finished?.status === "gone") {
            setErr(
              finished.error
                || "Esta descarga sigue corriendo en el servidor y va a aparecer en tu biblioteca cuando termine."
            );
          } else if (finished) {
            if (finished.status === "error") {
              setErr(finished.error || "la descarga falló");
            } else {
              // El veredicto lo publica el backend DENTRO del job (lo calcula
              // en download contra el titulo real del video). Antes este
              // camino hacia `return` y el `match` nunca llegaba a la UI.
              const d = {
                ...j,
                ...finished,
                filename: finished.filename || finished.path,
                size_mb: finished.size_mb,
                match: finished.match || j.match,
                real_title: finished.real_title || j.real_title,
              };
              setDone(
                mismatchNotice(d, d.match || vmatch, d.real_title || vtitle, query)
              );
              loadLib();
            }
          }
          return;
        }

        setDone(mismatchNotice(j, j.match || vmatch, j.real_title || vtitle, query));
        loadLib();
      } catch (e) {
        setErr(fetchErr(e, e.message));
      } finally {
        setBusyId(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fmt, query, setQuery]
  );

  /* Si el server no responde, el contador queda en null (consultando) en vez
     de romperse: el panel se abre vacio y el error se ve en la consola. */
  const loadLib = useCallback(async () => {
    try {
      const r = await fetch(`${API}/library`);
      if (!r.ok) return; // un 500 no puede pisar el contador
      const d = await r.json();
      setLib(d.files || []);
    } catch (e) {
      /* ACA NO se toca `lib`. Setearlo a [] convierte "no se pudo consultar"
         en "biblioteca vacia", que es justo lo que `lib === null` servia para
         distinguir. Un 500 con 22 archivos en disco llegaba como "vacia". */
    }
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

  /* Con yt-dlp apagado, el modo Recomendado es el que se abre por defecto y
     devuelve "30 resultados, 0 descargables" sin decir por que: iTunes solo
     tiene previews de 30 s y el audio completo sale de YouTube. El aviso
     existia para el modo que se elige a mano (.mode--dead), no para el que
     arranca solo. Sin esto, con el server sin YTDLP_ENABLED=1, la primera
     pantalla parece una app rota. */
  const matchedDead =
    ytDead && mode === "matched" && results.length > 0 && fullCount === 0;

  return (
    <div className="app">
      <div className="blob blob--coral" aria-hidden="true" />
      <div className="blob blob--sky" aria-hidden="true" />
      <header className="top">
        <div className="brand">
          <Waveform size={24} weight="bold" className="brand__mark" />
          <span className="brand__name">spitifo</span>
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
          {libOpen ? <X size={17} /> : <Stack size={17} />}
          <span className="libbtn__lbl">{libOpen ? "Cerrar" : "Biblioteca"}</span>
          {!libOpen && libCount > 0 && <span className="count">{libCount}</span>}
        </button>
      </header>

      <section className="hero">
        <h1 className="hero__title">Descarga música de forma libre</h1>

        <div className="finder">
          <form onSubmit={doSearch} className="search">
            <MagnifyingGlass size={22} className="search__icon" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Busca una canción, un artista, un género"
              aria-label="Qué quieres escuchar"
            />
            <button type="submit" className="search__go" disabled={loading}>
              {loading ? "Buscando" : "Buscar"}
            </button>
          </form>

          <section className="controls" aria-label="Cómo buscar">
            <ModePicker value={mode} onChange={setMode} ytDead={ytDead} />
            <FmtPicker value={fmt} onChange={setFmt} />
          </section>
        </div>
      </section>

      {err && (
        <div className="msg msg--err" role="alert">
          <WarningCircle size={17} weight="fill" />
          <span>{err}</span>
        </div>
      )}
      <ProgressBar job={job} />
      {matchedDead && (
        <div className="msg msg--warn" role="status">
          <WarningCircle size={17} weight="fill" />
          <span>
            YouTube está apagado en el servidor, y es de ahí de donde sale el
            audio completo. Por eso estos {results.length} resultados no se
            pueden descargar: iTunes solo tiene previews de 30 segundos.
          </span>
        </div>
      )}
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
              <p className="panel__empty">Todavía no has descargado nada.</p>
            )}
            {libFiles.map((f) => (
              <div key={f.path} className="librow">
                <audio controls preload="metadata" src={`${API}/audio?path=${encodeURIComponent(f.path)}`} />
                <div className="librow__text">
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
              <b>{fullCount} descargables</b>
            </span>
            <div className="segs" role="group" aria-label="Filtrar resultados">
              <button
                type="button"
                className={`seg ${filter === "all" ? "is-on" : ""}`}
                aria-pressed={filter === "all"}
                onClick={() => setFilter("all")}
              >
                Todos <span className="seg__n">{results.length}</span>
              </button>
              <button
                type="button"
                className={`seg ${filter === "full" ? "is-on" : ""}`}
                aria-pressed={filter === "full"}
                onClick={() => setFilter("full")}
              >
                Descarga completa <span className="seg__n">{fullCount}</span>
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
          {[0, 1, 2, 3].map((i) => (
            <SkeletonRow key={i} i={i} />
          ))}
        </ul>
      )}

      {!loading && !results.length && !err && !searched && (
        <section className="intro">
          <Sparkle size={26} weight="fill" className="intro__mark" />
          <h2 className="intro__h">Escribe un tema y descárgalo completo</h2>
          <p className="intro__p">
            Spitifo busca a la vez en varias fuentes de música libre y te dice, resultado
            por resultado, si el archivo se descarga completo.
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
            Internet Archive y Wikimedia liberan los archivos. iTunes sirve para
            encontrar la ficha y la portada. De YouTube sale el audio completo del tema.
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
