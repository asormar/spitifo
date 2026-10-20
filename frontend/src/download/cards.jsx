import React, { useCallback, useState } from "react";
import {
  ArrowUpRight,
  CaretRight,
  Check,
  CircleNotch,
  DownloadSimple,
  ListBullets,
  MusicNotes,
  Prohibit,
} from "@phosphor-icons/react";
import { API, errMsg, rowKey } from "../shared/api.js";
import { fmtSize, fmtTime } from "../shared/format.js";
import { ExtLink } from "../shared/ui.jsx";
import Player from "../player/Player.jsx";
import { NODL_TITLE, STATE_UI, trackState } from "./constants.js";
import { Artwork, StatusChip, provenance } from "./status.jsx";
import { VerifyPanel } from "./VerifyPanel.jsx";
import { DlButton, VideoSplitDownload } from "./controls.jsx";

export const ShowGroup = React.memo(function ShowGroup({ t, query, onDownload, busyIds, downloadedIds }) {
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState(null);
  const [loading, setLoading] = useState(false);
  /* Error aparte de `tracks`: antes un fallo dejaba tracks = [] y al reabrir
     ya no se reintentaba nunca. */
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const ids = (t.extra?.item_ids || [t.source_id]).join(",");
      const r = await fetch(
        `${API}/setlist?source_ids=${encodeURIComponent(ids)}&q=${encodeURIComponent(query)}`
      );
      const d = await r.json();
      if (!r.ok) throw new Error(errMsg(d, "no se pudo leer el setlist"));
      setTracks(d.tracks);
    } catch (e) {
      setTracks(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [t.extra?.item_ids, t.source_id, query]);

  /* El setlist se queda montado una vez abierto: si se desmontara al cerrar no
     habria altura que animar. Antes de la primera apertura no existe. */
  const [everOpened, setEverOpened] = useState(false);

  const toggle = useCallback(() => {
    const n = !open;
    setOpen(n);
    if (n) setEverOpened(true);
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
          <StatusChip tone={STATE_UI[st].tone} key={st}>
            {STATE_UI[st].label}
          </StatusChip>
        </div>
        <div className="card__facts">
          <span className="meta">
            Concierto en vivo, {t.extra?.track_count || 1} pistas
          </span>
          <span className="src">{prov.archivo}</span>
          <ExtLink className="ext" url={t.extra?.item_url}>
            procedencia <ArrowUpRight size={12} />
          </ExtLink>
        </div>
        <button className="disclosure" onClick={toggle} aria-expanded={open}>
          <CaretRight size={13} className="disclosure__caret" />
          <ListBullets size={13} />
          {open ? "ocultar las canciones" : "ver qué canciones hay"}
        </button>

        {everOpened && (
          <div className="fold" data-open={open ? "" : undefined} inert={open ? undefined : ""}>
            <div className="fold__in">
              <ul className="setlist">
                {loading && <li className="tr tr--dim">leyendo las etiquetas de cada pista</li>}
                {!loading && error && (
                  <li className="tr tr--dim">
                    no pude leer las pistas
                    <button type="button" className="vf vf--retry" onClick={load}>
                      Reintentar
                    </button>
                  </li>
                )}
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
                    <li className="tr" key={s.source_id} style={{ "--i": n }}>
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
                        <StatusChip tone={tone} key={s.match || "unknown"}>
                          {s.match_label || "?"}
                        </StatusChip>
                        <span className="meta">{fmtTime(s.duration_s)}</span>
                      </div>
                      <button
                        className="dl dl--sm"
                        disabled={busyIds.has(rowKey(s))}
                        onClick={() => onDownload(s)}
                        title={
                          downloadedIds.has(rowKey(s))
                            ? "Descargado: pulsa para volver a descargarlo"
                            : "Descargar a la biblioteca"
                        }
                        aria-label={
                          downloadedIds.has(rowKey(s))
                            ? `Descargado: ${s.real_title || s.filename}`
                            : `Descargar ${s.real_title || s.filename}`
                        }
                      >
                        {busyIds.has(rowKey(s)) ? (
                          <span className="swap" key="busy">
                            <CircleNotch size={16} className="spin" />
                          </span>
                        ) : downloadedIds.has(rowKey(s)) ? (
                          <span className="swap" key="done">
                            <Check size={16} weight="bold" />
                          </span>
                        ) : (
                          <span className="swap" key="idle">
                            <DownloadSimple size={16} weight="bold" />
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
      </div>
    </li>
  );
});

export const Track = React.memo(function Track({
  t,
  query,
  media,
  onDownload,
  onBotCheck,
  menuOpen,
  setMenuOpen,
  busy,
  downloaded,
  index,
}) {
  const st = trackState(t);
  const ui = STATE_UI[st];
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
          <ExtLink className="ext" url={web}>
            vídeo <ArrowUpRight size={12} />
          </ExtLink>
          <ExtLink className="ext" url={t.extra?.item_url}>
            procedencia <ArrowUpRight size={12} />
          </ExtLink>
        </div>
        {t.preview_url && (
          <Player
            variant="compact"
            src={t.preview_url}
            label={`el preview de ${t.title || "este resultado"}`}
            title={t.title || "sin título"}
            meta={`${t.artist || "artista desconocido"} · preview de 30 s`}
            duration={30}
            artwork={t.artwork_url}
          />
        )}
        {t.source === "archive" && <VerifyPanel t={t} query={query} />}
        <div className="card__foot">
          <StatusChip tone={ui.tone} key={st}>
            {ui.label}
          </StatusChip>
          {st === "full" ? (
            t.source === "ytdlp" && media !== "audio" && t.extra?.webpage_url ? (
              <VideoSplitDownload
                t={t}
                busy={busy}
                downloaded={downloaded}
                onDownload={onDownload}
                onBotCheck={onBotCheck}
                menuOpen={menuOpen}
                setMenuOpen={setMenuOpen}
              />
            ) : (
              <DlButton
                busy={busy}
                downloaded={downloaded}
                title={
                  downloaded
                    ? "Descargado: pulsa para volver a descargarlo"
                    : "Descargar a la biblioteca"
                }
                ariaLabel={
                  downloaded
                    ? `Descargado: ${t.title || "este resultado"}`
                    : `Descargar ${t.title || "este resultado"}`
                }
                onClick={() => onDownload(t)}
              />
            )
          ) : (
            <>
              {/* Texto visible (tactil y teclado no tienen tooltip). Ya lo lee
                  el lector de pantalla, asi que el icono se oculta para no
                  anunciarlo dos veces. */}
              <span className="nodl" title={NODL_TITLE[st]}>
                {NODL_TITLE[st]}
              </span>
              <span className="dl dl--off" aria-hidden="true">
                <Prohibit size={19} />
              </span>
            </>
          )}
        </div>
      </div>
    </li>
  );
});
/* Esqueleto con la forma real de una tarjeta, nunca un spinner generico. */
export function SkeletonRow({ i }) {
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
