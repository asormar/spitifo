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

function Track({ t, onDownload, busy }) {
  const status = t.extra?.needs_resolve
    ? "resoluble"
    : t.downloadable
    ? "descargable"
    : "solo preview";
  const cls = t.extra?.needs_resolve
    ? "res"
    : t.downloadable
    ? "dl"
    : "pv";

  return (
    <div className="track">
      {t.artwork_url ? (
        <img className="art" src={t.artwork_url} alt="" loading="lazy" />
      ) : (
        <div className="art art-ph">{t.artist?.charAt(0) || "♪"}</div>
      )}
      <div className="meta">
        <div className="title">{t.title || "—"}</div>
        <div className="sub">
          {t.artist || "—"}
          {t.album && t.album !== t.title ? ` · ${t.album}` : ""}
          {t.year ? ` · ${t.year}` : ""}
        </div>
        <div className="badges">
          <span className={`badge ${cls}`}>{status}</span>
          <span className="badge src">{SOURCE_LABEL[t.source] || t.source}</span>
          {t.license && <span className="badge lic">{t.license}</span>}
          {t.extra?.format && <span className="badge">{t.extra.format}</span>}
          {t.extra?.size_mb != null && (
            <span className="badge">{t.extra.size_mb} MB</span>
          )}
        </div>
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
  const inputRef = useRef();

  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  const doSearch = useCallback(async (e) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setLoading(true);
    setErr(null);
    setDone(null);
    try {
      const r = await fetch(`${API}/search?q=${encodeURIComponent(q)}&limit=40`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "error de búsqueda");
      setResults(d.results);
      if (!d.results.length) setErr("Sin resultados.");
    } catch (e) {
      setErr(e.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [q]);

  const onDownload = useCallback(
    async (t) => {
      setBusyId(t.source + t.source_id);
      setErr(null);
      setDone(null);
      try {
        // resolver primero si la fuente lo necesita
        let track = { ...t };
        delete track.downloadable;
        if (t.extra?.needs_resolve) {
          const rr = await fetch(`${API}/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(track),
          });
          if (!rr.ok) {
            const d = await rr.json();
            throw new Error(d.detail || "no se pudo resolver");
          }
          track = await rr.json();
          delete track.downloadable;
        }
        const rd = await fetch(`${API}/download`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: track.source, track, fmt }),
        });
        const j = await rd.json();
        if (!rd.ok) throw new Error(j.detail || "falló la descarga");
        setDone(j);
        if (libOpen) loadLib();
      } catch (e) {
        setErr(e.message);
      } finally {
        setBusyId(null);
      }
    },
    [fmt, libOpen]
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
        <select value={fmt} onChange={(e) => setFmt(e.target.value)} title="Formato">
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
            <span key={s.name} className="chip off" title={`requiere ${s.needs_key}`}>
              {SOURCE_LABEL[s.name] || s.name} (off)
            </span>
          ))}
        </div>
      )}

      {err && <div className="err">{err}</div>}
      {done && (
        <div className="ok">
          ✓ {done.filename} · {done.size_mb} MB → descargado
        </div>
      )}

      {libOpen && (
        <div className="lib">
          <h3>Tu biblioteca ({lib.length})</h3>
          {lib.length === 0 && <p className="empty">Todavía no descargaste nada.</p>}
          {lib.map((f) => (
            <div key={f.path} className="librow">
              <audio controls preload="none" src={`${API}/audio?path=${encodeURIComponent(f.path)}`} />
              <div>
                <div>{f.filename}</div>
                <small>{f.folder} · {f.size_mb} MB</small>
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
              se puede bajar ({results.filter((t) => t.downloadable || t.extra?.needs_resolve).length})
            </button>
          </div>
          <div className="list">
            {shown.map((t) => (
              <Track
                key={t.source + t.source_id}
                t={t}
                busy={busyId === t.source + t.source_id}
                onDownload={onDownload}
              />
            ))}
            {!shown.length && <p className="empty">Nada descargable en esta búsqueda.</p>}
          </div>
        </>
      )}

      {!results.length && !loading && (
        <div className="hero">
          <p>Escribí algo arriba. Cada resultado dice de dónde sale y si podés bajarlo entero.</p>
          <p className="fine">
            Fuentes con licencia libre (Internet Archive, Wikimedia, Jamendo). El catálogo de iTunes
            aparece para encontrar el tema, pero de ahí sólo sale un preview de 30 s.
          </p>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
