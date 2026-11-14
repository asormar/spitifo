import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Ico from "../shared/ico.jsx";
import { API, errMsg, fetchErr } from "../shared/api.js";
import { candidateMeta, finderReducer, initialFinder, previewUrl } from "./coverFinder.js";
import "./coverFinder.css";

/* ---------------------------------------------------------------------------
   BUSCAR PORTADAS

   Herramienta opcional para los temas bajados antes de que Spitifo guardara
   portadas. Va de a un tema: busca en iTunes, muestra las candidatas y SOLO
   guarda la que el usuario elige y confirma. Nada viene preseleccionado y no
   hay "aplicar a todas". Vive en su propio chunk: Ajustes no la carga hasta
   que se toca el boton. Ver backend/app/cover_finder.py.
   ------------------------------------------------------------------------- */

/* Una candidata: la portada real de iTunes y sus datos. Si la imagen no carga
   queda el hueco gris, nunca una portada inventada. */
function Candidate({ c, on, onPick }) {
  const [broken, setBroken] = useState(false);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className="cf__cand"
      onClick={() => onPick(c.artwork_url)}
    >
      <span className="cf__art">
        {!broken && (
          <img
            src={previewUrl(c.artwork_url)}
            alt=""
            width={200}
            height={200}
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
          />
        )}
        <span className="cf__chk" aria-hidden="true">
          <Ico n="check" size={14} sw={3} />
        </span>
      </span>
      <span className="cf__ct">{c.title}</span>
      <span className="cf__cm">{candidateMeta(c)}</span>
    </button>
  );
}

function Summary({ st, onClose }) {
  const left = st.items.length - st.saved - st.taken;
  return (
    <div className="cf__end">
      <p className="cf__lead">
        {st.saved
          ? "Las portadas nuevas ya se ven en la biblioteca."
          : "No se guardó ninguna portada."}
      </p>
      <dl className="cf__stats">
        <div>
          <dt>Portadas guardadas</dt>
          <dd>{st.saved}</dd>
        </div>
        <div>
          <dt>Temas saltados</dt>
          <dd>{st.skipped}</dd>
        </div>
        {st.taken > 0 && (
          <div>
            <dt>Ya tenían portada</dt>
            <dd>{st.taken}</dd>
          </div>
        )}
        <div>
          <dt>Siguen sin portada</dt>
          <dd>{left}</dd>
        </div>
      </dl>
      <p className="settings__note">
        Los temas saltados vuelven a aparecer la próxima vez que abras esta herramienta.
      </p>
      <div className="cf__acts">
        <button type="button" className="settings__btn settings__btn--acc" onClick={onClose}>
          Volver a Ajustes
        </button>
      </div>
    </div>
  );
}

export default function CoverFinder({ onClose, onSaved }) {
  const [st, dispatch] = useReducer(finderReducer, initialFinder);
  const [query, setQuery] = useState("");
  const [cands, setCands] = useState(null); // null: buscando
  const [picked, setPicked] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const searchRef = useRef(null);
  const headRef = useRef(null);
  const item = st.status === "ready" ? st.items[st.idx] : null;

  const close = onClose;

  /* La cola: los temas de audio sin portada, en el orden de la biblioteca. */
  useEffect(() => {
    const ctl = new AbortController();
    (async () => {
      try {
        const r = await fetch(`${API}/covers/missing`, { signal: ctl.signal });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(errMsg(d, "No se pudo leer la biblioteca."));
        dispatch({ type: "loaded", items: d.items });
      } catch (e) {
        if (e.name === "AbortError") return;
        dispatch({ type: "failed", error: fetchErr(e, e.message || "No se pudo leer la biblioteca.") });
      }
    })();
    headRef.current?.focus({ preventScroll: true });
    return () => ctl.abort();
  }, []);

  const search = useCallback(async (key, q) => {
    searchRef.current?.abort();
    const ctl = new AbortController();
    searchRef.current = ctl;
    setCands(null);
    setPicked(null);
    setErr(null);
    try {
      const params = new URLSearchParams({ key, q });
      const r = await fetch(`${API}/covers/candidates?${params}`, { signal: ctl.signal });
      const d = await r.json().catch(() => ({}));
      if (ctl.signal.aborted) return;
      /* Ya tiene portada (otro dispositivo) o ya no esta: se pasa al siguiente. */
      if (r.status === 409) return dispatch({ type: "taken" });
      if (r.status === 404) return dispatch({ type: "skip" });
      if (!r.ok) throw new Error(errMsg(d, "iTunes no respondió. Prueba de nuevo."));
      setCands(Array.isArray(d.candidates) ? d.candidates : []);
    } catch (e) {
      if (e.name === "AbortError") return;
      setCands([]);
      setErr(fetchErr(e, e.message || "iTunes no respondió. Prueba de nuevo."));
    }
  }, []);

  /* Cada tema nuevo arranca con su busqueda sugerida. */
  useEffect(() => {
    if (!item) return;
    setQuery(item.query);
    search(item.key, item.query);
  }, [item, search]);

  useEffect(() => () => searchRef.current?.abort(), []);

  const onSearch = (e) => {
    e.preventDefault();
    const q = query.trim();
    if (item && q) search(item.key, q);
  };

  const save = async () => {
    if (!item || !picked || saving) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch(`${API}/covers/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: item.key, artwork_url: picked }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        onSaved?.();
        return dispatch({ type: "saved" });
      }
      if (r.status === 409) return dispatch({ type: "taken" });
      /* La oferta vencio (paso mucho rato): se vuelve a buscar lo mismo. */
      if (r.status === 400) {
        setErr("La búsqueda caducó. Vuelve a elegir la portada.");
        return search(item.key, query.trim() || item.query);
      }
      setErr(errMsg(d, "No se pudo guardar la portada."));
    } catch (e) {
      setErr(fetchErr(e, "No se pudo guardar la portada."));
    } finally {
      setSaving(false);
    }
  };

  const total = st.items.length;
  const title = item ? item.title || item.filename : "";
  const sub = item ? [item.artist || "Sin etiquetas", item.filename].join(" · ") : "";

  return (
    <div className="settings cf">
      <header className="cf__head">
        <button
          type="button"
          className="settings__back cbtn cbtn--soft cbtn--l"
          aria-label="Volver a Ajustes"
          onClick={close}
        >
          <Ico n="back" size={20} sw={2.2} />
        </button>
        <h1 className="settings__title cf__title" ref={headRef} tabIndex={-1}>
          Buscar portadas
        </h1>
        {item && (
          <span className="cf__count" aria-live="polite">
            {st.idx + 1} de {total}
          </span>
        )}
      </header>

      {st.status === "loading" && <p className="cf__lead">Buscando temas sin portada…</p>}

      {st.status === "error" && (
        <p className="settings__err" role="alert">
          {st.error}
        </p>
      )}

      {st.status === "empty" && (
        <div className="cf__end">
          <p className="cf__lead">Todos los temas de audio ya tienen portada.</p>
          <div className="cf__acts">
            <button type="button" className="settings__btn settings__btn--acc" onClick={close}>
              Volver a Ajustes
            </button>
          </div>
        </div>
      )}

      {st.status === "done" && <Summary st={st} onClose={close} />}

      {item && (
        <>
          <div className="cf__bar" aria-hidden="true">
            <i style={{ transform: `scaleX(${st.idx / total})` }} />
          </div>

          <div className="cf__file">
            <span className="cf__noart" aria-hidden="true">
              <Ico n="music" size={22} />
            </span>
            <span className="cf__fi">
              <b>{title}</b>
              <span>{sub}</span>
            </span>
          </div>

          <form className="cf__search" onSubmit={onSearch} role="search">
            <input
              id="cover-finder-q"
              className="cf__q"
              type="search"
              value={query}
              maxLength={200}
              aria-label="Buscar en iTunes"
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" className="settings__btn settings__btn--ghost" disabled={!query.trim()}>
              Buscar
            </button>
          </form>

          {cands === null ? (
            <div className="cf__grid" aria-busy="true" aria-label="Buscando en iTunes">
              {[0, 1, 2].map((n) => (
                <span key={n} className="cf__skel" />
              ))}
            </div>
          ) : cands.length ? (
            <>
              <p className="settings__note cf__hint">
                Resultados de iTunes. Elige la que corresponde a este tema.
              </p>
              <div className="cf__grid" role="radiogroup" aria-label="Portadas de iTunes">
                {cands.map((c) => (
                  <Candidate
                    key={c.artwork_url}
                    c={c}
                    on={picked === c.artwork_url}
                    onPick={setPicked}
                  />
                ))}
              </div>
            </>
          ) : (
            !err && (
              <div className="cf__none">
                <b>iTunes no devolvió canciones</b>
                <span>Prueba con otra búsqueda o salta este tema.</span>
              </div>
            )
          )}

          {err && (
            <p className="settings__err" role="alert">
              {err}
            </p>
          )}

          <div className="cf__acts cf__acts--sticky">
            <button
              type="button"
              className="settings__btn settings__btn--ghost"
              onClick={() => dispatch({ type: "skip" })}
              disabled={saving}
            >
              Saltar
            </button>
            <button
              type="button"
              className="settings__btn settings__btn--acc"
              onClick={save}
              disabled={!picked || saving}
            >
              {saving ? "Guardando…" : "Guardar portada"}
            </button>
          </div>
          <button type="button" className="settings__act cf__finish" onClick={() => dispatch({ type: "finish" })}>
            Terminar por ahora
          </button>
        </>
      )}
    </div>
  );
}
