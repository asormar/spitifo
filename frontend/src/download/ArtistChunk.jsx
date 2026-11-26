import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNav } from "../app/useNav.js";
import { useListen } from "../listen/ListenProvider.jsx";
import { useShow } from "../listen/Notice.jsx";
import { coverTone } from "../shared/cover.js";
import { Cover } from "../listen/cards.jsx";
import { cx } from "../shared/ui.jsx";
import { Icon } from "../shared/icons.jsx";
import Sheet from "../shared/Sheet.jsx";
import Ico from "../shared/ico.jsx";
import { thumbUrl } from "./artwork.js";
import { loadAlbumChunk } from "./albumChunk.js";
import { fetchAlbumMatch } from "./albumApi.js";
import { loadQueue } from "./queueBoot.js";
import { ownedSlots } from "./albumText.js";
import { fetchArtist } from "./artistApi.js";
import ArtistPopulares from "./ArtistPopulares.jsx";
import { MenuSurface } from "./ResultMenu.jsx";
import { useResultPlayback } from "./resultPlayback.js";
import { queueStore } from "./queueStore.js";
import {
  albumOwnership,
  artistHero,
  buildChecklist,
  checklistTotals,
  downloadButton,
  initialSelections,
  runDiscography,
} from "./artistLogic.js";
import "../shared/pinkPlay.css";
import "./rows.css";
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

/* El play grande del artista: la primera de Populares, con la MISMA cola que
   las filas. Envuelve el hook aparte para poder montarlo solo si hay canciones. */
function ArtistPlay({ songs, name, query, btnRef }) {
  const source = `artist:${name}`;
  const { play, isCurrent, playing } = useResultPlayback({ t: songs[0], query, queue: songs, source });
  const on = isCurrent && playing;
  return (
    <button
      ref={btnRef}
      type="button"
      className="pk pk--l"
      data-autofocus=""
      aria-label={`${on ? "Pausar" : "Reproducir"} ${name}`}
      onClick={play}
    >
      <Icon name={on ? "Pause" : "Play"} size={28} weight="fill" />
    </button>
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
                      <Cover
                        tone={coverTone(row.release.artist || artist, "")}
                        label={row.release.artist || artist}
                        src={row.release.artwork_url ? thumbUrl(row.release.artwork_url) : undefined}
                        className="acv dcrow__cv"
                      />
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
          <button type="button" className="btn btn--acc btn--wide dsh__btn" disabled={btn.disabled} onClick={confirm}>
            {btn.text}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

export function ArtistPage({ view, active }) {
  const nav = useNav();
  const { model, ctx } = useListen();
  const [state, setState] = useState({ status: "loading", data: null });
  const [attempt, setAttempt] = useState(0);
  /* La lista de Populares vive en ArtistPopulares; aqui solo guardamos las
     filas para que el play grande de la cabecera suene lo mismo. */
  const [populares, setPopulares] = useState([]);

  useEffect(() => {
    let vivo = true;
    setState({ status: "loading", data: null });
    fetchArtist(view.id)
      .then((data) => {
        if (vivo) setState({ status: "ok", data });
      })
      .catch(() => {
        if (vivo) setState({ status: "error", data: null });
      });
    return () => {
      vivo = false;
    };
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
  const playRef = useRef(null);
  const titleRef = useRef(null);
  const menuAt = nav.stack.at(-1)?.type === "downmenu" ? nav.stack.at(-1) : null;
  /* El foco de entrada va al play; si no hay Populares, al titulo. Nunca al
     boton de descargar, que ademas ya no existe en la cabecera. */
  useEffect(() => {
    if (!state.data) return undefined;
    const id = requestAnimationFrame(() =>
      (playRef.current || titleRef.current)?.focus({ preventScroll: true })
    );
    return () => cancelAnimationFrame(id);
  }, [state.data]);

  const artistGroups = [
    {
      label: "Artista",
      items: [{ kind: "discography", icon: "dl", text: "Descargar discografía…" }],
    },
  ];
  const pickArtistMenu = (kind) => {
    const anchor = menuAt?.anchor;
    nav.back();
    if (kind === "discography") nav.open({ type: "discsheet", anchor });
  };

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
    <>
    <div className="apage">
      <header className="aphero">
        <Cover
          tone={coverTone(data.name, "")}
          label={data.name}
          src={data.artwork_url ? thumbUrl(data.artwork_url) : undefined}
          className="acv apcv acv--round"
        />
        <div className="aphero__t">
          <h1 ref={titleRef} tabIndex={-1}>{data.name}</h1>
          {hero && <p>{hero}</p>}
        </div>
      </header>

      <div className="apacts">
        <button
          type="button"
          className="cbtn cbtn--l cbtn--soft"
          aria-label={`Más opciones de ${data.name}`}
          title="Más opciones"
          aria-haspopup="menu"
          onClick={(e) => nav.open({ type: "downmenu", kind: "artist", anchor: e.currentTarget })}
        >
          <Ico n="dots" size={22} />
        </button>
        {populares.length > 0 && (
          <ArtistPlay songs={populares} name={data.name} query={view.name || data.name} btnRef={playRef} />
        )}
      </div>

      <ArtistPopulares
        name={data.name}
        artistId={view.id}
        results={view.songs}
        query={view.name || data.name}
        onSongs={setPopulares}
      />

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
                  <Cover
                    tone={coverTone(r.artist || data.name, "")}
                    label={r.artist || data.name}
                    src={r.artwork_url ? thumbUrl(r.artwork_url) : undefined}
                    className="acv apcard__cv"
                  />
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
    {menuAt?.kind === "artist" && (
      <MenuSurface
        groups={artistGroups}
        title={data.name}
        anchor={menuAt.anchor}
        onPick={pickArtistMenu}
        onClose={nav.back}
      />
    )}
    </>
  );
}
