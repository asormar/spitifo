import { memo, useState } from "react";
import { Bars, initial } from "../listen/rows.jsx";
import { rowKey } from "../shared/api.js";
import { coverTone, toneClass, toneVars } from "../shared/cover.js";
import { fmtSize, fmtTime } from "../shared/format.js";
import { cx } from "../shared/ui.jsx";
import { SOURCE_CODE, provenance } from "./constants.js";
import { thumbUrl } from "./artwork.js";
import DlRing, { useDl } from "./DlRing.jsx";
import Ico from "../shared/ico.jsx";
import SaveHeart from "../listen/SaveHeart.jsx";
import { V_LABEL, VerdictPill } from "../shared/Verdict.jsx";
import { useVerdict, verdictKey, verdictOf } from "./verdict.js";
import { dlWaiting } from "./searchPlan.js";
import { rowPlayPlan } from "./rowPlayPlan.js";
import { useResultPlayback } from "./resultPlayback.js";

/* ---------------------------------------------------------------------------
   UN RESULTADO

   Una sola marca para el telefono (fila) y el escritorio (tabla, desde 960 px:
   lo decide el CSS). Las dos formas de la fuente (codigo corto / nombre entero)
   y de los datos estan en el DOM; el CSS enseña una. Tocar el cuerpo reproduce,
   el corazon guarda y el ⋯ abre el menu: la descarga ya no manda en la fila.
   ------------------------------------------------------------------------- */

/* La portada de iTunes/YouTube; sin ella (o si no carga) la generada. */
export function Thumb({ t }) {
  const [broken, setBroken] = useState(false);
  const video = t.source === "ytdlp";
  const tone = coverTone(t.artist, t.album);
  return (
    <span className={cx("thumb", video && "thumb--wide")}>
      {t.artwork_url && !broken ? (
        <img
          src={thumbUrl(t.artwork_url)}
          alt=""
          loading="lazy"
          decoding="async"
          width={video ? 96 : 58}
          height={video ? 54 : 58}
          onError={() => setBroken(true)}
        />
      ) : (
        <span className={cx("cv", toneClass(tone))} style={toneVars(tone)}>
          <span>{initial(t.artist || t.title)}</span>
        </span>
      )}
    </span>
  );
}

export const factsOf = (t) =>
  [t.duration_s ? fmtTime(t.duration_s) : null, fmtSize(t.extra?.size_mb), t.extra?.format]
    .filter(Boolean)
    .join(" · ");

export const ResultRow = memo(function ResultRow({ t, i, query, busy, downloaded, onDl, onMenu, queue, source, variant, albumArtist }) {
  const v = verdictOf(t, useVerdict(verdictKey(t, query)));
  /* «Sin verificar» y «Solo 30 s» no son veredictos: solo se pintan los que
     dicen algo despues de mirar el archivo. */
  const realV = v === "match" || v === "partial" || v === "mismatch" ? v : null;
  const title = t.title || "sin título";
  const prov = provenance(t);
  const facts = factsOf(t);
  const artist = t.artist || "artista desconocido";
  const alb = t.album && t.album !== t.title ? t.album : null;
  const year = t.year;
  /* En una pista de album no se repite la portada ni «Artista, Album, año»:
     solo el artista cuando no es el del disco (colaboraciones, recopilatorios).
     El nombre accesible de abajo sigue siendo el completo. */
  const track = variant === "track";
  const sub = track
    ? albumArtist && t.artist && t.artist !== albumArtist ? t.artist : ""
    : [variant === "popular" ? null : artist, alb, year].filter(Boolean).join(", ");
  const plan = rowPlayPlan(t);
  const { play, isCurrent, playing, resolving } = useResultPlayback({ t, query, queue, source });
  const dls = useDl(t, busy, downloaded);
  const progress = dlWaiting(dls);

  /* El nombre accesible empieza por lo que hace el toque. Las comas separan las
     partes (lector encadena "Let Down Radiohead" sin ellas) y el nombre entero
     de la fuente sustituye a la sigla, que se oye como letras sueltas. */
  const people = [artist, alb, year].filter(Boolean).join(", ");
  const aria = [
    `${isCurrent && playing ? "Pausar" : "Reproducir"} ${title}, ${people}`,
    realV && V_LABEL[realV],
    resolving ? "buscando la canción completa" : null,
    plan === "preview" && !resolving ? "vista previa de 30 s" : null,
    downloaded ? "descargada" : null,
    prov.split ? `ficha de ${prov.ficha}, archivo de ${prov.archivo}` : prov.archivo,
    facts || null,
  ].filter(Boolean).join(", ");

  return (
    <li className={cx("res", isCurrent && "is-current", resolving && "is-resolving")} style={{ "--i": i }}>
      <span className="res__n num" aria-hidden="true">
        {i + 1}
      </span>
      <button
        type="button"
        className="res__main"
        aria-label={aria}
        aria-current={isCurrent ? "true" : undefined}
        aria-busy={resolving || undefined}
        onClick={play}
      >
        {!track && <Thumb t={t} />}
        <span className="res__txt">
          <span className="res__t">{title}</span>
          {sub && <span className="res__s">{sub}</span>}
          <span className="res__m">
            {isCurrent && <Bars on={playing} />}
            {plan === "preview" && !resolving && <span className="res__30">30 s</span>}
            {realV && <VerdictPill v={realV} />}
            {resolving && (
              <span className="res__wait" role="status" aria-live="polite">
                <span className="sp" aria-hidden="true" />
                buscando la canción completa…
              </span>
            )}
            {downloaded && <span className="res__dl" aria-hidden="true" />}
            {!track && (
              <>
                <span className="sr-only">
                  , {prov.split ? `ficha de ${prov.ficha}, archivo de ${prov.archivo}` : prov.archivo},{" "}
                </span>
                <span
                  className="src"
                  aria-hidden="true"
                  title={prov.split ? `ficha: ${prov.ficha} · archivo: ${prov.archivo}` : prov.archivo}
                >
                  {SOURCE_CODE[t.source] || prov.ficha}
                </span>
              </>
            )}
            {facts && <span className="num">{facts}</span>}
          </span>
        </span>
      </button>
      <span className="res__src">
        <b>{prov.ficha}</b>
        {prov.split && <span>audio: {prov.archivo}</span>}
      </span>
      <span className="res__f num">{facts}</span>
      <span className="res__acts">
        <SaveHeart t={t} query={query} />
        {progress && <DlRing t={t} busy={busy} downloaded={downloaded} onDl={onDl} small />}
        <button
          type="button"
          className="res__more"
          aria-label={`Más opciones de ${title}`}
          title="Más opciones"
          aria-haspopup="menu"
          onClick={(e) => onMenu(t, e.currentTarget)}
        >
          <Ico n="dots" size={20} />
        </button>
      </span>
    </li>
  );
});

/* Esqueleto con la forma de una fila, nunca un spinner generico. En una lista
   de pistas se cuenta el numero real y no se dibuja la portada. */
export function Skeleton({ count = 4, className, track }) {
  return (
    <ul className={cx("rlist", className)} aria-label="Buscando" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="res skel" style={{ "--i": i }} aria-hidden="true">
          {!track && <span className="skel__a" />}
          <span className="skel__b">
            <i />
            <i />
          </span>
        </li>
      ))}
    </ul>
  );
}
