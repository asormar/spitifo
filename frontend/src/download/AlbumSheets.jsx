import { useCallback, useEffect, useRef, useState } from "react";
import { cx } from "../shared/ui.jsx";
import { coverTone, toneClass, toneVars } from "../shared/cover.js";
import { rowKey } from "../shared/api.js";
import { useShow } from "../listen/Notice.jsx";
import Sheet from "../shared/Sheet.jsx";
import Ico from "../shared/ico.jsx";
import { VerdictPill } from "../shared/Verdict.jsx";
import DlRing from "./DlRing.jsx";
import PreviewButton from "./PreviewButton.jsx";
import { thumbUrl } from "./artwork.js";
import { fetchAlbumDetail, fetchAlbumMatch } from "./albumApi.js";
import { downloadTrack } from "./downloadTrack.js";
import { albumButton, groupToast, missingSentence } from "./albumText.js";
import { groupSummary, queueStore, useQueue } from "./queueStore.js";
import "./album.css";

/* ---------------------------------------------------------------------------
   FICHA DEL ALBUM Y HOJA DE DESCARGAS

   Las dos viven en el mismo chunk perezoso (albumChunk.js), que se adelanta al
   enfocar una tarjeta de album o la pildora de la cola. La ficha muestra la
   lista real de iTunes en cuanto llega, mientras /match busca el video de cada
   pista. Todo el estado de descarga sale de queueStore y de jobsStore: cerrar y
   volver a abrir no pierde nada, y la pildora sigue contando en cualquier modo.
   ------------------------------------------------------------------------- */

const initial = (label) => (String(label || "").trim()[0] || "?").toUpperCase();
const verdict = (result) =>
  result?.match === "match"
    ? "match"
    : result?.match === "partial"
    ? "partial"
    : result?.match === "mismatch"
    ? "mismatch"
    : "unv";

function Cover({ album, className = "als__cv" }) {
  const [broken, setBroken] = useState(false);
  const tone = coverTone(album?.artist, album?.title);
  return (
    <span className={cx(className, "cv", toneClass(tone))} style={toneVars(tone)} aria-hidden="true">
      <span>{initial(album?.artist || album?.title)}</span>
      {album?.artwork_url && !broken && (
        <img
          src={thumbUrl(album.artwork_url)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
        />
      )}
    </span>
  );
}

/* La pastilla del estado de una pista, antes y despues de emparejar. */
function TrackPill({ track, item, failed, onRetry }) {
  if (track.extra?.has_full === false) return <span className="alp alp--mut">Solo 30 s</span>;
  if (track.extra?.has_full == null) {
    return <span className="alp alp--mut">{failed ? "Sin verificar" : "Buscando…"}</span>;
  }
  if (item?.state === "done") return <VerdictPill v={verdict(item.result)} />;
  if (item?.state === "failed" || item?.state === "cancelled") {
    return (
      <button type="button" className="alp alp--bad alp--btn" onClick={onRetry}>
        Reintentar
      </button>
    );
  }
  if (item?.state === "queued") return <span className="alp alp--mut">En cola</span>;
  if (item?.state === "running") return <span className="alp alp--acc">Descargando</span>;
  return <span className="alp alp--acc">Completa</span>;
}

export function AlbumSheet({ album, query, anchor, onClose, onLibraryChanged, downloadedIds }) {
  const show = useShow();
  const [detail, setDetail] = useState(null);
  const [detailErr, setDetailErr] = useState(null);
  const [match, setMatch] = useState(null);
  const [matching, setMatching] = useState(true);
  const [err, setErr] = useState(null);
  const matchAbort = useRef(null);
  const queue = useQueue();
  const gid = `album:${album.id}`;
  const group = queue.find((g) => g.id === gid);
  const items = group?.items || [];
  const done = items.filter((i) => i.state === "done").length;
  const running = items.some((i) => i.state === "queued" || i.state === "running");
  const tracks = match?.tracks || detail?.tracks || [];
  const fullTracks = tracks.filter((t) => t.extra?.has_full === true);
  const missing = tracks.filter((t) => t.extra?.has_full === false);
  const full = match ? match.full : fullTracks.length;

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
    fetchAlbumMatch(album.id, ac.signal)
      .then((d) => {
        if (ac.signal.aborted) return;
        setMatch(d);
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

  /* La cola recibe la MISMA funcion de descarga que usa una fila. La credito
     por grupo para que el toast final y el progreso de la pildora salgan de un
     solo sitio, aunque la ficha se cierre antes de que terminen. */
  const enqueue = useCallback(
    (list, id, title) => {
      queueStore.addGroup({
        id,
        title,
        artwork_url: album.artwork_url,
        tracks: list,
        /* Igual que una fila: cada pista bajada refresca la biblioteca, asi el
           album va apareciendo en Escuchar mientras la cola sigue. */
        run: async (t) => {
          const res = await downloadTrack(t, { query: query || `${album.artist} ${album.title}` });
          onLibraryChanged?.();
          return res;
        },
        onFinish: (g, s) => show(groupToast(g.title, s)),
        downloaded: downloadedIds,
      });
    },
    [album.artwork_url, album.artist, album.title, query, show, onLibraryChanged, downloadedIds]
  );

  const btn = albumButton({ matching, full, done, running });
  const ytOff = match && match.ytdlp === false;
  const header = match?.album || detail?.album || album;
  const meta = [header.artist, header.year, `${album.track_count ?? tracks.length} ${album.track_count === 1 ? "canción" : "canciones"}`]
    .filter(Boolean)
    .join(" · ");

  return (
    <Sheet title={`Álbum ${album.title}`} onClose={onClose} anchor={anchor}>
      <div className="als">
        <div className="als__top">
          <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar el álbum" onClick={onClose}>
            <Ico n="x" size={18} />
          </button>
        </div>
        <div className="als__head">
          <Cover album={header} />
          <h2 className="als__title">{header.title || album.title}</h2>
          <p className="als__meta">{meta}</p>
          {!matching && match && (
            <div className="als__sums">
              <span className="alp alp--acc">{full} {full === 1 ? "completa" : "completas"}</span>
              {missing.length > 0 && (
                <span className="alp alp--mut">{missing.length} solo 30 s</span>
              )}
            </div>
          )}
        </div>

        <div className="als__body">
          {ytOff ? (
            <p className="als__note">Las descargas necesitan YouTube activado en este servidor.</p>
          ) : (
            <button
              type="button"
              className="als__btn"
              data-busy={running || undefined}
              aria-disabled={btn.disabled || undefined}
              onClick={() => !btn.disabled && enqueue(fullTracks, gid, album.title)}
            >
              {running ? <span className="sp" aria-hidden="true" /> : <Ico n="dl" size={18} />}
              {btn.text}
            </button>
          )}

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
            <ol className="als__list" aria-label="Canciones del álbum" aria-busy={matching || undefined}>
              {tracks.map((t, i) => {
                const key = rowKey(t);
                const item = queueStore.getItem(gid, key);
                return (
                  <li className={cx("altr", t.extra?.has_full === false && "is-miss")} key={key}>
                    <span className="altr__no num" aria-hidden="true">{i + 1}</span>
                    <span className="altr__tt">
                      <b>{t.title || "sin título"}</b>
                      <TrackPill
                        track={t}
                        item={item}
                        failed={Boolean(err)}
                        onRetry={() => queueStore.retry(gid, key)}
                      />
                    </span>
                    <span className="altr__acts">
                      {t.preview_url && <PreviewButton t={t} />}
                      {t.extra?.has_full === true && (
                        <DlRing
                          t={t}
                          name={t.title}
                          small
                          busy={item?.state === "running" || item?.state === "queued"}
                          downloaded={item?.state === "done"}
                          onDl={(one) => enqueue([one], `single:${rowKey(one)}`, one.title)}
                        />
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          {!matching && !err && missing.length > 0 && (
            <p className="als__note">{missingSentence(missing.map((t) => t.title))}</p>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/* La hoja que abre la pildora: grupos, sus pistas y cancelar lo que falta. */
export function QueueSheet({ anchor, onClose }) {
  const queue = useQueue();
  const groups = queue.filter((g) => g.items.length);

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
          {!groups.length && <p className="als__note">No hay descargas en curso.</p>}
          {groups.map((g) => {
            const s = groupSummary(g);
            const f = s.total ? s.done / s.total : 0;
            const state = s.ended
              ? s.failed
                ? `Terminado · ${s.failed} ${s.failed === 1 ? "falló" : "fallaron"}`
                : "Terminado"
              : s.running
              ? `Bajando · ${s.done} de ${s.total}`
              : "Esperando turno";
            return (
              <section className="qgrp" key={g.id}>
                <header className="qgrp__h">
                  <Cover album={g} className="qgrp__cv" />
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
                    <li key={i.key}>
                      <span className="ql__tt">
                        <b>{i.track.title}</b>
                        <span>
                          {i.state === "done"
                            ? i.result?.match === "partial"
                              ? "Parecido: otra versión"
                              : "Descargada"
                            : i.state === "running"
                            ? "Descargando…"
                            : i.state === "queued"
                            ? "En cola"
                            : i.state === "cancelled"
                            ? "Cancelada"
                            : "Falló"}
                        </span>
                      </span>
                      {(i.state === "failed" || i.state === "cancelled") && (
                        <button
                          type="button"
                          className="ql__retry"
                          aria-label={`Reintentar ${i.track.title}`}
                          onClick={() => queueStore.retry(g.id, i.key)}
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
                    onClick={() => queueStore.cancelPending(g.id)}
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
