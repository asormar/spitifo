import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNav } from "../app/useNav.js";
import { useListen } from "../listen/ListenProvider.jsx";
import { useShow } from "../listen/Notice.jsx";
import { initial } from "../listen/rows.jsx";
import { coverTone, toneClass, toneVars } from "../shared/cover.js";
import { cx } from "../shared/ui.jsx";
import Sheet from "../shared/Sheet.jsx";
import Ico from "../shared/ico.jsx";
import { thumbUrl } from "./artwork.js";
import { loadAlbumChunk } from "./albumChunk.js";
import { fetchAlbumMatch } from "./albumApi.js";
import { loadQueue } from "./queueBoot.js";
import { ownedSlots } from "./albumText.js";
import { fetchArtist } from "./artistApi.js";
import {
  albumOwnership,
  artistHero,
  buildChecklist,
  checklistTotals,
  downloadButton,
  initialSelections,
  runDiscography,
} from "./artistLogic.js";
import "./artistChunk.css";

/* ---------------------------------------------------------------------------
   PAGINA DEL ARTISTA Y LISTA DE DISCOGRAFIA (chunk perezoso)

   La pagina sale de /api/artist/{id}: portada redonda, hero, boton principal
   y los cuatro grupos de discos en rejilla. Tocar un disco abre la MISMA
   ficha de album de Buscar. La lista de descarga es una hoja con casillas:
   solo Estudio empieza marcado y el total se calcula con lo que te falta.
   ------------------------------------------------------------------------- */

const SECTIONS = [
  { key: "albums", title: "Álbumes" },
  { key: "live", title: "En vivo" },
  { key: "compilations", title: "Recopilatorios" },
  { key: "singles", title: "Sencillos" },
];

function Cover({ name, url, className, round }) {
  const [broken, setBroken] = useState(false);
  const tone = coverTone(name, "");
  return (
    <span
      className={cx("acv", className, "cv", toneClass(tone), round && "acv--round")}
      style={toneVars(tone)}
      aria-hidden="true"
    >
      <span>{initial(name)}</span>
      {url && !broken && (
        <img
          src={thumbUrl(url)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
        />
      )}
    </span>
  );
}

/* La hoja de «Descargar discografía». Vive en la pila de navegacion: atras,
   Escape y el atras de Android la cierran; Sheet atrapa el foco. */
function DiscographySheet({ artist, data, entries, anchor, onClose }) {
  const show = useShow();
  const sections = useMemo(
    () => ({
      albums: data.albums || [],
      live: data.live || [],
      compilations: data.compilations || [],
      singles: data.singles || [],
    }),
    [data]
  );
  const [groups] = useState(() => buildChecklist(sections, entries));
  const [sel, setSel] = useState(() => initialSelections(groups));
  const totals = checklistTotals(groups, sel);
  const btn = downloadButton(totals);
  /* Un doble toque antes de que la hoja se desmonte lanzaria dos vueltas. */
  const started = useRef(false);

  /* Cerrar PRIMERO y despues emparejar: cada disco tarda 5-15 s en YouTube y
     la hoja no se queda abierta esperando. Las pistas que ya estan en la
     biblioteca y las que no tienen version completa ni se encolan. */
  const confirm = () => {
    const selected = groups
      .flatMap((g) => g.rows)
      .filter((r) => sel[r.release.id] && !r.disabled)
      .map((r) => r.release);
    if (!selected.length || started.current) return;
    started.current = true;
    const owned = {};
    for (const r of selected) owned[r.id] = ownedSlots(entries, r.id);
    onClose();
    runDiscography({
      selected,
      owned,
      fetchMatch: (id) => fetchAlbumMatch(id),
      enqueue: async (batch) => (await loadQueue()).queueStore.enqueue(batch),
      queryFor: (r) => `${artist} ${r.title}`,
      onFail: (r) => show(`No se pudo preparar ${r.title}`),
    }).catch(() => {});
  };

  return (
    <Sheet title="Descargar discografía" onClose={onClose} anchor={anchor}>
      <div className="dsh">
        <div className="dsh__top">
          <h2 className="sh2">Descargar discografía</h2>
          <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar" data-autofocus onClick={onClose}>
            <Ico n="x" size={18} />
          </button>
        </div>
        <p className="dsh__sub">Solo se bajan las canciones con versión completa que todavía no tienes.</p>

        <div className="dsh__body">
          {groups.map((g) => (
            <section className="dgrp" key={g.id} aria-labelledby={`dgr-${g.id}`}>
              <h3 className="dgrp__h" id={`dgr-${g.id}`}>{g.label}</h3>
              <div className="dgrp__rows">
                {g.rows.map((row) => {
                  const on = Boolean(sel[row.release.id]);
                  return (
                    <button
                      key={row.release.id}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      className="dcrow"
                      disabled={row.disabled}
                      onClick={() => setSel((s) => ({ ...s, [row.release.id]: !s[row.release.id] }))}
                    >
                      <Cover name={row.release.artist || artist} url={row.release.artwork_url} className="dcrow__cv" />
                      <span className="dcrow__t">
                        <b>{row.release.title}</b>
                        <span>{row.sub}</span>
                      </span>
                      <span className={cx("dcrow__box", on && "is-on")} aria-hidden="true">
                        {on && <Ico n="check" size={16} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <div className="dsh__foot">
          <p className="dsh__total" aria-live="polite">
            <b>{totals.songs} {totals.songs === 1 ? "canción" : "canciones"}</b>
            {" · "}unos {totals.mb} MB
          </p>
          <button type="button" className="dsh__btn" disabled={btn.disabled} onClick={confirm}>
            {btn.text}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

export function ArtistPage({ view, active }) {
  const nav = useNav();
  const { model } = useListen();
  const [state, setState] = useState({ status: "loading", data: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setState({ status: "loading", data: null });
    fetchArtist(view.id, ac.signal)
      .then((data) => setState({ status: "ok", data }))
      .catch((e) => {
        if (e.name !== "AbortError") setState({ status: "error", data: null });
      });
    return () => ac.abort();
  }, [view.id, attempt]);

  /* Lo que tienes de cada disco recorre toda la biblioteca: se calcula una vez
     por respuesta y biblioteca, no en cada render (abrir la hoja re-renderiza). */
  const data = state.data;
  const owns = useMemo(() => {
    const out = new Map();
    if (!data) return out;
    for (const s of SECTIONS) for (const r of data[s.key] || []) out.set(r.id, albumOwnership(r, model.entries));
    return out;
  }, [data, model.entries]);
  const hero = useMemo(() => (data ? artistHero(data, data.name, model.entries) : ""), [data, model.entries]);

  const openAlbum = useCallback(
    (release, anchor) => {
      loadAlbumChunk();
      /* La ficha del disco comparte entrada con la que abre Escuchar, asi que
         atras la cierra y Buscar no intenta buscar el album en su estante. */
      nav.open({
        type: "albumsheet",
        id: String(release.id),
        from: "listen",
        album: {
          id: release.id,
          title: release.title,
          artist: release.artist || state.data?.name,
          year: release.year,
          track_count: release.track_count,
          artwork_url: release.artwork_url,
        },
        anchor,
      });
    },
    [nav.open, state.data]
  );

  if (state.status === "loading") {
    return (
      <div className="apage apage--msg" aria-busy="true">
        <p className="sr-only">Cargando el artista…</p>
        <span className="sp" aria-hidden="true" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="apage apage--msg" role="alert">
        <p>No se pudo cargar el artista.</p>
        <button type="button" className="apbtn" onClick={() => setAttempt((n) => n + 1)}>Reintentar</button>
      </div>
    );
  }

  const groups = SECTIONS.map((s) => ({ ...s, items: data[s.key] || [] }));
  if (!groups.some((g) => g.items.length)) {
    return (
      <div className="apage apage--msg">
        <p>No hay discos de {data.name} en iTunes.</p>
      </div>
    );
  }

  const top = nav.stack.at(-1);
  const sheet = top?.type === "discsheet" ? top : null;

  return (
    <div className="apage">
      <header className="aphero">
        <Cover name={data.name} url={data.artwork_url} className="apcv" round />
        <div className="aphero__t">
          <h1>{data.name}</h1>
          {hero && <p>{hero}</p>}
        </div>
      </header>

      <button
        type="button"
        className="apdl"
        data-autofocus
        onClick={(e) => nav.open({ type: "discsheet", anchor: e.currentTarget })}
      >
        <Ico n="dl" size={18} />
        Descargar discografía
      </button>

      {groups.filter((g) => g.items.length).map((g) => (
        <section className="aps" key={g.key} aria-labelledby={`aph-${g.key}`}>
          <h2 className="sh2" id={`aph-${g.key}`}>{g.title}</h2>
          <div className="apgrid">
            {g.items.map((r) => {
              const own = owns.get(r.id);
              return (
                <button
                  type="button"
                  className="apcard"
                  key={r.id}
                  onPointerEnter={loadAlbumChunk}
                  onFocus={loadAlbumChunk}
                  onClick={(e) => openAlbum(r, e.currentTarget)}
                  aria-label={`Abrir el álbum ${r.title}`}
                >
                  <Cover name={r.artist || data.name} url={r.artwork_url} className="apcard__cv" />
                  <b className="apcard__t">{r.title}</b>
                  {own.label ? (
                    <span className={cx("apcard__pill", own.full && "is-full")}>{own.label}</span>
                  ) : (
                    <span className="apcard__m">{r.year || "—"}</span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {sheet && (
        <DiscographySheet
          artist={data.name}
          data={data}
          entries={model.entries}
          anchor={sheet.anchor}
          onClose={nav.back}
        />
      )}
    </div>
  );
}
