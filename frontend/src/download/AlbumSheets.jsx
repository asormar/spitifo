import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNav } from "../app/useNav.js";
import { coverTone } from "../shared/cover.js";
import { rowKey } from "../shared/api.js";
import { Cover } from "../listen/cards.jsx";
import { useListen } from "../listen/ListenProvider.jsx";
import Sheet from "../shared/Sheet.jsx";
import Ico from "../shared/ico.jsx";
import { useDownloadFormat } from "../settings/downloadPrefs.js";
import { thumbUrl } from "./artwork.js";
import { fetchAlbumDetail, mergeMatchedTracks, streamAlbumMatch } from "./albumApi.js";
import { Icon } from "../shared/icons.jsx";
import { loadArtistChunk } from "./artistChunk.js";
import { resolveArtistLink } from "./artistLink.js";
import { ResultRow } from "./ResultRow.jsx";
import { MenuSurface } from "./ResultMenu.jsx";
import { resultMenuGroups } from "./resultMenu.js";
import { pickResultAction } from "./resultMenuActions.js";
import { albumPlayable, albumQueue, matchProgress } from "./albumPlay.js";
import "../shared/pinkPlay.css";
import "./rows.css";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { streamTrack } from "./streamTrack.js";
import { toTrack } from "../listen/library.js";
import { keyUrl } from "../shared/api.js";
import { songFromResult } from "../shared/songId.js";
import { saved, useSaved } from "../listen/saved.js";
import { maybeAutoDownloadMany } from "../listen/saveSong.js";
import { albumSaveButton, albumSaveSelection, saveNotice } from "../listen/saveLogic.js";
import { albumButton, missingSentence, OFFLINE_BANNER, ownedEntries, ownedSlots, pausedText, resumingText, trackSlot, trackSpec } from "./albumText.js";
import { BUSY_STATES, groupSummary as serverSummary, queueStore, useQueueState } from "./queueStore.js";
import "./album.css";

/* ---------------------------------------------------------------------------
   FICHA DEL ALBUM Y HOJA DE DESCARGAS

   Las dos viven en el mismo chunk perezoso (albumChunk.js). La ficha muestra la
   lista real de iTunes en cuanto llega, mientras /match busca el video de cada
   pista. Todo el estado de descarga sale del espejo de la cola del servidor:
   cerrar y volver a abrir no pierde nada, y la pildora sigue contando en
   cualquier modo.
   ------------------------------------------------------------------------- */

export function AlbumSheet({ album, query, anchor, onClose }) {
  const [detail, setDetail] = useState(null);
  const [detailErr, setDetailErr] = useState(null);
  const [match, setMatch] = useState(null);
  const [matched, setMatched] = useState([]);
  const [matching, setMatching] = useState(true);
  const [err, setErr] = useState(null);
  const matchAbort = useRef(null);
  const queue = useQueueState();
  const gid = `album:${album.id}`;
  const group = queue.groups.find((g) => g.id === gid);
  const items = group?.items || [];
  const done = items.filter((i) => i.status === "done").length;
  const running = items.some((i) => BUSY_STATES.has(i.status));
  /* La lista sale de /detail y cada lote del stream reemplaza su fila en
     cuanto llega: esa pista ya se puede bajar sin esperar a las demas. */
  const tracks = useMemo(
    () => mergeMatchedTracks(detail?.tracks || [], matched),
    [detail, matched]
  );
  /* Lo que ya esta en la biblioteca (mismo album de iTunes, mismo disco y
     numero) no se vuelve a bajar ni se vuelve a guardar. */
  const listen = useListen();
  const entries = listen?.model?.entries;
  const savedById = useSaved((s) => s.byId);
  const owned = useMemo(() => ownedSlots(entries, album.id), [entries, album.id]);
  const isOwned = (t) => owned.has(trackSlot(t.extra?.disc_number, t.extra?.track_number));
  const ownedCount = tracks.filter(isOwned).length;
  const fullTracks = tracks.filter((t) => t.extra?.has_full === true && !isOwned(t));
  const missing = tracks.filter((t) => t.extra?.has_full === false && !isOwned(t));
  const full = fullTracks.length;
  const ask = query || `${album.artist} ${album.title}`;
  const source = `album:${album.title}`;
  const nav = useNav();
  const [fmt] = useDownloadFormat();
  const menuAt = nav.stack.at(-1)?.type === "downmenu" ? nav.stack.at(-1) : null;
  /* Un solo PUT con las pistas completas que todavia no estan guardadas: el
     match del disco ya les dio id a las que se pueden guardar. */
  const toSave = useMemo(
    () => albumSaveSelection(tracks, { savedIds: savedById, owned }),
    [tracks, savedById, owned]
  );
  const savedHere = useMemo(
    () => tracks.map(songFromResult).filter((s) => s && savedById.has(s.id)).map((s) => s.id),
    [tracks, savedById]
  );
  const isSaved = !matching && tracks.length > 0 && toSave.length === 0;
  const saveBtn = matching
    ? { text: "Buscando versiones…", disabled: true }
    : albumSaveButton(toSave.length);
  const saveAlbum = async () => {
    if (saveBtn.disabled) return;
    const pairs = toSave.map((t) => [songFromResult(t), t]).filter(([song]) => song);
    if (!pairs.length || !(await saved.saveAll(pairs.map(([song]) => song)))) {
      listen?.show?.(`No se pudo guardar «${album.title}»`);
      return;
    }
    maybeAutoDownloadMany(pairs.map(([song, t]) => [song, t, { downloaded: false }]));
    listen?.show?.(saveNotice.album(pairs.length, album.title));
  };
  const toggleSave = async () => {
    if (!isSaved) return saveAlbum();
    if (await saved.remove(savedHere)) listen?.show?.(`Se quitó «${album.title}» de tu biblioteca`);
    else listen?.show?.(`No se pudo quitar «${album.title}»`);
  };
  /* El disco en orden: lo que ya esta en la biblioteca suena desde el archivo
     propio y lo emparejado con video, en streaming, sin bajarlo. Crece con cada
     lote del match, asi el play se activa con la PRIMERA pista lista. */
  const mine = useMemo(() => ownedEntries(entries, album.id), [entries, album.id]);
  const playable = useMemo(() => albumQueue(tracks), [tracks]);
  const lista = tracks.flatMap((t) => {
    const e = mine.get(trackSlot(t.extra?.disc_number, t.extra?.track_number));
    if (e) return [toTrack(e, keyUrl)];
    return t.extra?.webpage_url && t.extra?.has_full !== false ? [streamTrack(t, source)] : [];
  });
  const onAir = useEngine((s) => s.source === source && s.playing);
  const escuchar = () => {
    if (!lista.length) return;
    engine.play(lista[0], { queue: lista, index: 0, source });
  };
  const playPause = () => (onAir ? engine.toggle() : escuchar());
  /* El mismo shuffle de la ficha de la biblioteca: se enciende antes de play y
     el motor deja la elegida primero y baraja el resto de la cola. */
  const aleatorio = () => {
    if (!lista.length) return;
    engine.setShuffle(true);
    engine.play(lista[0], { queue: lista, index: 0, source });
  };

  useEffect(() => {
    const ac = new AbortController();
    fetchAlbumDetail(album.id, ac.signal)
      .then(setDetail)
      .catch((e) => {
        if (e.name !== "AbortError") setDetailErr(e.message);
      });
    return () => ac.abort();
  }, [album.id]);

  const runMatch = useCallback(() => {
    matchAbort.current?.abort();
    const ac = new AbortController();
    matchAbort.current = ac;
    setMatching(true);
    setErr(null);
    setMatched([]);
    streamAlbumMatch(album.id, {
      signal: ac.signal,
      onTracks: (lote) => {
        if (ac.signal.aborted) return;
        setMatched((prev) => mergeMatchedTracks(prev, lote));
      },
    })
      .then((d) => {
        if (ac.signal.aborted) return;
        setMatch(d);
        setMatched(d.tracks);  // el `done` trae todas, incluso las que no matchearon
        setMatching(false);
      })
      .catch((e) => {
        if (e.name === "AbortError" || ac.signal.aborted) return;
        setErr(e.message);
        setMatching(false);
      });
  }, [album.id]);

  useEffect(() => {
    runMatch();
    return () => matchAbort.current?.abort();
  }, [runMatch]);

  const spec = useCallback((t) => trackSpec(t, ask), [ask]);

  /* Un solo POST con todas las pistas y el grupo: el servidor deduce lo que
     falta encolar y dedupe por archivo de salida. */
  const enqueue = useCallback(
    (list) =>
      queueStore.enqueue({
        items: list.map(spec),
        group: { id: gid, title: album.title, artwork_url: album.artwork_url },
      }),
    [album.artwork_url, album.title, gid, spec]
  );

  /* Mientras baja, el boton cuenta el grupo entero («3 de 12»): lo ya bajado
     pasa enseguida a la biblioteca y saldria de `full`. Parado, lo bajado ya es
     de la biblioteca (`owned`) y no se resta dos veces. */
  const btn = running
    ? albumButton({ matching, full: items.length, done, running, owned: ownedCount })
    : albumButton({ matching, full, done: 0, running, owned: ownedCount + done });
  const ytOff = match && match.ytdlp === false;
  const header = match?.album || detail?.album || album;
  const meta = [header.artist, header.year, `${album.track_count ?? tracks.length} ${album.track_count === 1 ? "canción" : "canciones"}`]
    .filter(Boolean)
    .join(" · ");

  /* El menu del album: la descarga (con el formato de Ajustes o el avance) y
     la pagina del artista, cuando hay nombre con el que abrirla. */
  const downloadSub = ytOff ? "YouTube desactivado" : running ? btn.text : full ? fmt : btn.text;
  const albumGroups = [
    {
      label: "Álbum",
      items: [
        {
          kind: "download",
          icon: "dl",
          text: "Descargar álbum",
          sub: downloadSub,
          disabled: ytOff || full === 0,
        },
      ],
    },
  ];
  if (header.artist) {
    albumGroups.push({
      label: "Ir a",
      items: [{ kind: "artist", icon: "user", text: `Ir a ${header.artist}` }],
    });
  }
  const songGroups = (t) => {
    const item = queueStore.itemFor(rowKey(t), gid);
    return resultMenuGroups(t, { fmt, downloaded: isOwned(t) || item?.status === "done" });
  };

  const pickAlbum = async (kind) => {
    nav.back();
    if (kind === "download") return enqueue(fullTracks);
    if (kind === "artist") {
      loadArtistChunk();
      const view = await resolveArtistLink(
        header.artist,
        tracks.map((t) => ({ artist: t.artist, artist_id: t.extra?.artist_id }))
      );
      if (view) nav.goTo("search", view);
      else listen?.show?.(`No se encontró la página de ${header.artist}`);
    }
  };

  const pickSong = (kind) =>
    pickResultAction(kind, {
      t: menuAt?.t,
      query: ask,
      name: header.artist,
      enqueue: (one) => queueStore.enqueue({ items: [spec(one)] }),
      show: listen?.show,
      nav,
      anchor: menuAt?.anchor,
    });

  return (
    <>
    <Sheet title={`Álbum ${album.title}`} onClose={onClose} anchor={anchor}>
      <div className="als">
        <div className="als__top">
          <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar el álbum" onClick={onClose}>
            <Ico n="x" size={18} />
          </button>
        </div>
        <div className="als__head">
          <Cover
            tone={coverTone(header.artist, header.title)}
            label={header.artist || header.title}
            src={header.artwork_url ? thumbUrl(header.artwork_url) : undefined}
            className="als__cv"
          />
          <h2 className="als__title">{header.title || album.title}</h2>
          <p className="als__meta">{meta}</p>
          {!matching && match && (
            <div className="als__sums">
              {ownedCount > 0 && <span className="alp alp--ok">{ownedCount} en tu biblioteca</span>}
              {full > 0 && <span className="alp alp--acc">{full} {full === 1 ? "completa" : "completas"}</span>}
              {missing.length > 0 && (
                <span className="alp alp--mut">{missing.length} solo 30 s</span>
              )}
            </div>
          )}
          {/* La fila de acciones manda: guardar, ⋯, aleatorio y play. La descarga
              ya no tiene boton ancho, vive en ⋯. */}
          <div className="als__acts">
            <button
              type="button"
              className="als__act"
              aria-label={isSaved ? "Quitar el álbum de tu biblioteca" : "Guardar el álbum"}
              aria-pressed={isSaved || undefined}
              title={isSaved ? "Quitar de tu biblioteca" : "Guardar en tu biblioteca"}
              disabled={saveBtn.disabled && !isSaved ? true : undefined}
              onClick={toggleSave}
            >
              <Ico n={isSaved ? "heart-fill" : "heart"} size={22} />
            </button>
            <button
              type="button"
              className="als__act"
              aria-label={`Más opciones de ${header.title || album.title}`}
              title="Más opciones"
              aria-haspopup="menu"
              onClick={(e) => nav.open({ type: "downmenu", kind: "album", anchor: e.currentTarget })}
            >
              <Ico n="dots" size={22} />
            </button>
            {running && <span className="sp" aria-hidden="true" />}
            {lista.length > 0 && (
              <button
                type="button"
                className="als__act"
                aria-label="Reproducir en aleatorio"
                title="Aleatorio"
                onClick={aleatorio}
              >
                <Icon name="Shuffle" size={20} />
              </button>
            )}
            {lista.length > 0 && (
              <button
                type="button"
                className="pk pk--l"
                data-autofocus=""
                aria-label={`${onAir ? "Pausar" : "Reproducir"} ${header.title || album.title}`}
                onClick={playPause}
              >
                <Icon name={onAir ? "Pause" : "Play"} size={28} weight="fill" />
              </button>
            )}
          </div>
          {matching && tracks.length > 0 && (
            <p className="als__match" role="status" aria-live="polite">
              <span className="sp" aria-hidden="true" />
              Buscando versiones completas: {matchProgress(tracks, playable.length)}
            </p>
          )}
        </div>

        <div className="als__body">
          {queue.offline && <p className="qsh__net" role="status">{OFFLINE_BANNER}</p>}
          {ytOff && <p className="als__note">Las descargas necesitan YouTube activado en este servidor.</p>}

          {err && (
            <div className="als__err" role="alert">
              <p>No se pudieron buscar las versiones completas.</p>
              <button type="button" className="als__retry" onClick={runMatch}>
                Reintentar
              </button>
            </div>
          )}
          {detailErr && <p className="als__note" role="alert">No se pudo abrir el álbum.</p>}

          {tracks.length > 0 && (
            <ul className="rlist als__list" aria-label="Canciones del álbum" aria-busy={matching || undefined}>
              {tracks.map((t, i) => {
                const key = rowKey(t);
                if (!albumPlayable(t)) {
                  return (
                    <li className="altr is-searching" key={key}>
                      <span className="altr__no num" aria-hidden="true">{i + 1}</span>
                      <span className="altr__tt">
                        <b>{t.title || "sin título"}</b>
                        <span className="altr__wait">
                          <span className="sp" aria-hidden="true" />
                          buscando…
                        </span>
                      </span>
                    </li>
                  );
                }
                const item = queueStore.itemFor(key, gid);
                return (
                  <ResultRow
                    key={key}
                    t={t}
                    i={i}
                    query={ask}
                    queue={playable}
                    source={source}
                    busy={Boolean(item && BUSY_STATES.has(item.status))}
                    downloaded={isOwned(t) || item?.status === "done"}
                    onDl={(one) => queueStore.enqueue({ items: [spec(one)] })}
                    onMenu={(one, el) => nav.open({ type: "downmenu", kind: "song", t: one, anchor: el })}
                  />
                );
              })}
            </ul>
          )}

          {!matching && !err && missing.length > 0 && (
            <p className="als__note">{missingSentence(missing.map((t) => t.title))}</p>
          )}
        </div>
      </div>
    </Sheet>
    {menuAt?.kind === "album" && (
      <MenuSurface
        groups={albumGroups}
        title={header.title || album.title}
        anchor={menuAt.anchor}
        onPick={pickAlbum}
        onClose={nav.back}
      />
    )}
    {menuAt?.kind === "song" && menuAt.t && (
      <MenuSurface
        groups={songGroups(menuAt.t)}
        title={menuAt.t.title || "sin título"}
        anchor={menuAt.anchor}
        onPick={pickSong}
        onClose={nav.back}
      />
    )}
    </>
  );
}

function itemText(i, offline) {
  if (i.status === "done") return i.match === "partial" ? "Parecido: otra versión" : "Descargada";
  if (i.status === "cancelled") return "Cancelada";
  if (i.status === "error") return "Falló";
  if (i.status === "queued") return "En cola";
  if (i.resumedFrom != null) return resumingText(i.resumedFrom);
  if (offline) return pausedText(i.progress);
  return `Descargando · ${Math.round(i.progress || 0)} %`;
}

/* La hoja que abre la pildora: grupos, sus pistas y cancelar lo que falta. */
export function QueueSheet({ anchor, onClose }) {
  const queue = useQueueState();
  const groups = queue.groups.filter((g) => g.items.length);

  useEffect(() => {
    queueStore.setSheetOpen(true);
    return () => queueStore.setSheetOpen(false);
  }, []);

  return (
    <Sheet title="Descargas" onClose={onClose} anchor={anchor}>
      <div className="qsh">
        <div className="qsh__top">
          <h2 className="sh2">Descargas</h2>
          <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar descargas" onClick={onClose}>
            <Ico n="x" size={18} />
          </button>
        </div>
        <div className="qsh__body">
          {queue.offline && (
            <p className="qsh__net" role="status">{OFFLINE_BANNER}</p>
          )}
          {!groups.length && <p className="als__note">No hay descargas en curso.</p>}
          {groups.map((g) => {
            const s = serverSummary(g);
            const f = s.total ? s.done / s.total : 0;
            const state = s.ended
              ? s.failed
                ? `Terminado · ${s.failed} ${s.failed === 1 ? "falló" : "fallaron"}`
                : "Terminado"
              : queue.offline && s.running
              ? "En pausa hasta que vuelva la red"
              : s.running
              ? `Bajando · ${s.done} de ${s.total}`
              : "Esperando turno";
            return (
              <section className="qgrp" key={g.id}>
                <header className="qgrp__h">
                  <Cover
                    tone={coverTone(g.artist, g.title)}
                    label={g.artist || g.title}
                    src={g.artwork_url ? thumbUrl(g.artwork_url) : undefined}
                    className="qgrp__cv"
                  />
                  <div>
                    <b>{g.title}</b>
                    <span>{state}</span>
                  </div>
                </header>
                <div className="qgrp__bar" aria-hidden="true">
                  <i style={{ transform: `scaleX(${f})` }} />
                </div>
                <ol className="ql">
                  {g.items.map((i) => (
                    <li key={i.id}>
                      <span className="ql__tt">
                        <b>{i.title}</b>
                        <span>{itemText(i, queue.offline)}</span>
                      </span>
                      {BUSY_STATES.has(i.status) && (
                        <button
                          type="button"
                          className="ql__x"
                          aria-label={`Cancelar ${i.title}`}
                          onClick={() => queueStore.cancel(i.id)}
                        >
                          <Ico n="x" size={18} />
                        </button>
                      )}
                      {(i.status === "failed" || i.status === "error" || i.status === "cancelled") && (
                        <button
                          type="button"
                          className="ql__retry"
                          aria-label={`Reintentar ${i.title}`}
                          onClick={() => queueStore.retry(i.id)}
                        >
                          Reintentar
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
                {!s.ended && (
                  <button
                    type="button"
                    className="ql__cancel"
                    onClick={() => queueStore.cancelGroup(g.id)}
                  >
                    Cancelar las que faltan
                  </button>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}
