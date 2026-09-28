import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

const API = "/api";

const SOURCE_LABEL = {
  itunes: "iTunes",
  archive: "Internet Archive",
  jamendo: "Jamendo",
  wikimedia: "Wikimedia",
  ytdlp: "yt-dlp",
};

function fmtTime(s) {
  if (!s) return "--:--";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
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
        🔍 ¿es esta la canción?
      </button>
    );
  }
  if (state === "loading") {
    return <span className="vf loading">leyendo tags del audio…</span>;
  }
  if (state === "error") {
    return <span className="vf err">no pude verificar: {data?.error}</span>;
  }

  const m = data.extra || {};
  return (
    <div className={`vfbox ${m.match || "unknown"}`}>
      <div className="vfhead">
        <strong>{m.real_title || "sin título"}</strong>
        <span className={`vfpill ${m.match || "unknown"}`}>
          {m.match_label || "?"}
        </span>
      </div>
      <div className="vfmeta">
        {m.real_artist && (
          <>
            artista real: <b>{m.real_artist}</b> ·{" "}
          </>
        )}
        {m.format && <>{m.format} · </>}
        {m.size_mb != null && <>{m.size_mb} MB · </>}
        {m.duration_s ? `${fmtTime(m.duration_s)} · ` : ""}
        {m.match_score != null && `coincide ${Math.round(m.match_score * 100)}%`}
      </div>
      {m.filename && (
        <div className="vffile">
          archivo: <code>{m.filename}</code>
        </div>
      )}
      <div className="vfsrc">
        {m.uploader && <>subido por {m.uploader} · </>}
        {m.title_source === "item-title" && (
          <>el archivo no trae tags, el título viene del item · </>
        )}
        {m.item_url && (
          <a href={m.item_url} target="_blank" rel="noreferrer">
            ver en Internet Archive ↗
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

  return (
    <div className="track show">
      <div className="art art-ph">{t.artist?.charAt(0) || "♪"}</div>
      <div className="meta">
        <div className="title">
          {t.title}
          <span className="grp">{t.extra?.track_count || 1} pistas</span>
        </div>
        <div className="sub">
          {t.artist} · concierto en vivo
          {t.year ? ` · ${t.year}` : ""}
        </div>
        <div className="badges">
          <span className="badge res">concierto completo</span>
          <span className="badge src">Internet Archive</span>
          {t.extra?.item_url && (
            <a className="badge link" href={t.extra.item_url} target="_blank" rel="noreferrer">
              procedencia ↗
            </a>
          )}
        </div>
        <button className="vf" onClick={toggle}>
          {open ? "▾ ocultar setlist" : "▸ ver qué canciones hay"}
        </button>

        {open && (
          <div className="setlist">
            {loading && <div className="slrow dim">leyendo tags de cada pista…</div>}
            {!loading && tracks && tracks.length === 0 && (
              <div className="slrow dim">no pude leer las pistas</div>
            )}
            {tracks?.map((s) => (
              <div className={`slrow ${s.match || "unknown"}`} key={s.source_id}>
                <div className="slinfo">
                  <b>{s.real_title || s.filename}</b>
                  {s.real_artist && s.real_artist !== t.artist && (
                    <span className="slart"> · {s.real_artist}</span>
                  )}
                  <div className="slmeta">
                    <span className={`vfpill ${s.match || "unknown"}`}>
                      {s.match_label || "?"}
                    </span>
                    {s.format && <> {s.format} · </>}
                    {s.size_mb != null && <>{s.size_mb} MB · </>}
                    {fmtTime(s.duration_s)}
                  </div>
                </div>
                <button
                  className="dlbtn sm"
                  disabled={busyId === s.source_id}
                  onClick={() => onDownload(s)}
                >
                  ↓
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="dur"></div>
      <div className="acts"></div>
    </div>
  );
}

function ProgressBar({ job }) {
  if (!job) return null;
  const pct = Math.round(job.progress || 0);
  const done = job.status === "done";
  const failed = job.status === "error";
  return (
    <div className={`prog ${done ? "done" : ""}`}>
      <span className="lbl">
        {failed ? "✗ falló" : done ? "✓ listo" : "⬇ descargando"}
      </span>
      <div className="track-bar">
        <div className="fill" style={{ width: `${done ? 100 : pct}%` }} />
      </div>
      <span className="pct">{done ? "100%" : `${pct}%`}</span>
    </div>
  );
}

function Track({ t, query, onDownload, busy, verified, onVerified }) {
  const status = t.extra?.needs_resolve
    ? "resoluble"
    : t.downloadable
    ? "descargable"
    : "solo preview";
  const cls = t.extra?.needs_resolve ? "res" : t.downloadable ? "dl" : "pv";
  const v = verified?.[t.source + t.source_id];

  return (
    <div className="track">
      {t.artwork_url ? (
        <img className="art" src={t.artwork_url} alt="" loading="lazy" />
      ) : (
        <div className="art art-ph">{t.artist?.charAt(0) || "♪"}</div>
      )}
      <div className="meta">
        <div className="title">
          {t.title || "—"}
          {t.extra?.is_group && t.extra?.track_count > 1 && (
            <span className="grp">{t.extra.track_count} pistas</span>
          )}
        </div>
        <div className="sub">
          {t.artist || "—"}
          {t.album && t.album !== t.title ? ` · ${t.album}` : ""}
          {t.year ? ` · ${t.year}` : ""}
        </div>
        {v && (
          <div className={`realinfo ${v.extra?.match || "unknown"}`}>
            <span className="rt">en el archivo:</span>{" "}
            <b>{v.extra?.real_title || "?"}</b>
            {v.extra?.real_artist && v.extra.real_artist !== t.artist && (
              <> — {v.extra.real_artist}</>
            )}
          </div>
        )}
        <div className="badges">
          <span className={`badge ${cls}`}>{status}</span>
          <span className="badge src">{SOURCE_LABEL[t.source] || t.source}</span>
          {t.license && <span className="badge lic">{t.license}</span>}
          {t.extra?.format && <span className="badge">{t.extra.format}</span>}
          {t.extra?.size_mb != null && (
            <span className="badge">{t.extra.size_mb} MB</span>
          )}
          {t.source === "ytdlp" && (
            <a
              className="badge link"
              href={t.extra?.webpage_url}
              target="_blank"
              rel="noreferrer"
            >
              ver en YouTube ↗
            </a>
          )}
          {t.extra?.item_url && (
            <a
              className="badge link"
              href={t.extra.item_url}
              target="_blank"
              rel="noreferrer"
            >
              procedencia ↗
            </a>
          )}
        </div>
        {t.source === "archive" && (
          <VerifyPanel t={t} query={query} onVerified={onVerified} />
        )}
      </div>
      <div className="dur">{fmtTime(t.duration_s)}</div>
      <div className="acts">
        {t.preview_url && (
          <audio controls preload="none" src={t.preview_url} className="prev" />
        )}
        {t.downloadable || t.extra?.needs_resolve ? (
          <button
            className="dlbtn"
            disabled={busy}
            onClick={() => onDownload(t)}
            title="Descargar a la biblioteca"
          >
            {busy ? "…" : "↓"}
          </button>
        ) : (
          <span className="nodl" title="Solo hay preview de 30s de esta fuente">
            —
          </span>
        )}
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
  const [lib, setLib] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [verified, setVerified] = useState({});
  const [job, setJob] = useState(null);
  const inputRef = useRef();

  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  const doSearch = useCallback(
    async (e) => {
      e?.preventDefault();
      if (!q.trim()) return;
      setLoading(true);
      setErr(null);
      setDone(null);
      setVerified({});
      try {
        const r = await fetch(
          `${API}/search?q=${encodeURIComponent(q)}&limit=40`
        );
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "error de búsqueda");
        setResults(d.results);
        setQuery(q);
        if (!d.results.length) setErr("Sin resultados.");
      } catch (e) {
        setErr(e.message);
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [q]
  );

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
              if (libOpen) loadLib();
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
            }", no "${query}".`,
          });
        } else {
          setDone(j);
        }
        if (libOpen) loadLib();
      } catch (e) {
        setErr(e.message);
      } finally {
        setBusyId(null);
      }
    },
    [fmt, libOpen, query]
  );

  const loadLib = useCallback(async () => {
    const r = await fetch(`${API}/library`);
    const d = await r.json();
    setLib(d.files);
  }, []);

  const toggleLib = useCallback(() => {
    const n = !libOpen;
    setLibOpen(n);
    if (n) loadLib();
  }, [libOpen, loadLib]);

  const shown = results.filter((t) =>
    filter === "all" ? true : t.downloadable || t.extra?.needs_resolve
  );

  const activeSources = (health?.sources || []).filter((s) => s.active);
  const inactive = (health?.sources || []).filter((s) => !s.active);

  return (
    <div className="app">
      <header>
        <h1>
          <span className="logo">spitifo</span>
          <span className="tag">música libre, en el momento</span>
        </h1>
        <button className="libbtn" onClick={toggleLib}>
          {libOpen ? "cerrar" : `biblioteca`}
        </button>
      </header>

      <form onSubmit={doSearch} className="searchbar">
        <input
          ref={inputRef}
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscá una canción, un artista, un género…"
        />
        <select
          value={fmt}
          onChange={(e) => setFmt(e.target.value)}
          title="Formato"
        >
          <option value="mp3">mp3</option>
          <option value="m4a">m4a</option>
          <option value="original">original</option>
        </select>
        <button type="submit" disabled={loading}>
          {loading ? "buscando…" : "buscar"}
        </button>
      </form>

      {health && (
        <div className="srcs">
          Activas:{" "}
          {activeSources.map((s) => (
            <span key={s.name} className="chip on">
              {SOURCE_LABEL[s.name] || s.name}
            </span>
          ))}
          {inactive.map((s) => (
            <span
              key={s.name}
              className="chip off"
              title={`requiere ${s.needs_key}`}
            >
              {SOURCE_LABEL[s.name] || s.name} (off)
            </span>
          ))}
        </div>
      )}

      {err && <div className="err">{err}</div>}
      <ProgressBar job={job} />
      {done && (
        <div className={done.warning ? "warn" : "ok"}>
          {done.warning
            ? `⚠ ${done.warning}`
            : `✓ ${done.filename} · ${done.size_mb} MB → descargado`}
          {!done.warning && done.real_title && done.match === "match" && (
            <span className="okmatch"> · verificado: {done.real_title}</span>
          )}
        </div>
      )}

      {libOpen && (
        <div className="lib">
          <h3>Tu biblioteca ({lib.length})</h3>
          {lib.length === 0 && <p className="empty">Todavía no descargaste nada.</p>}
          {lib.map((f) => (
            <div key={f.path} className="librow">
              <audio
                controls
                preload="none"
                src={`${API}/audio?path=${encodeURIComponent(f.path)}`}
              />
              <div>
                <div>{f.filename}</div>
                <small>
                  {f.folder} · {f.size_mb} MB
                </small>
              </div>
            </div>
          ))}
        </div>
      )}

      {results.length > 0 && (
        <>
          <div className="filters">
            <button
              className={filter === "all" ? "on" : ""}
              onClick={() => setFilter("all")}
            >
              todo ({results.length})
            </button>
            <button
              className={filter === "dl" ? "on" : ""}
              onClick={() => setFilter("dl")}
            >
              se puede bajar (
              {
                results.filter(
                  (t) => t.downloadable || t.extra?.needs_resolve
                ).length
              }
              )
            </button>
          </div>
          <div className="list">
            {shown.map((t) =>
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
                />
              )
            )}
            {!shown.length && (
              <p className="empty">Nada descargable en esta búsqueda.</p>
            )}
          </div>
        </>
      )}

      {!results.length && !loading && (
        <div className="hero">
          <p>
            Escribí algo arriba. Cada resultado dice de dónde sale y si podés bajarlo
            entero.
          </p>
          <p className="fine">
            Fuentes con licencia libre (Internet Archive, Wikimedia, Jamendo). El
            catálogo de iTunes aparece para encontrar el tema, pero de ahí sólo sale
            un preview de 30 s.
          </p>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
