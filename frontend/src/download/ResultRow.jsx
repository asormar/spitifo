import { memo, useRef, useState } from "react";
import { initial } from "../listen/rows.jsx";
import { rowKey } from "../shared/api.js";
import { coverTone, toneClass, toneVars } from "../shared/cover.js";
import { fmtSize, fmtTime } from "../shared/format.js";
import { cx } from "../shared/ui.jsx";
import { NODL_TITLE, SOURCE_CODE, provenance, trackState } from "./constants.js";
import DlRing from "./DlRing.jsx";
import Ico from "./ico.jsx";
import PreviewButton from "./PreviewButton.jsx";
import { V_LABEL, V_TONE, useVerdict, verdictKey, verdictOf } from "./verdict.js";

/* ---------------------------------------------------------------------------
   UN RESULTADO

   Una sola marca para el telefono (fila) y el escritorio (tabla, desde 960 px:
   lo decide el CSS). Las dos formas de la fuente (codigo corto / nombre entero)
   y de los datos estan en el DOM; el CSS enseña una.
   ------------------------------------------------------------------------- */

/* La pastilla de veredicto. Al cambiar (una verificacion, una descarga) se
   remonta y repite su entrada; la primera pintura no se anima. */
export function VerdictPill({ v }) {
  const first = useRef(v);
  return (
    <span key={v} className={`vb vb--${V_TONE[v]}`} data-up={v !== first.current ? "" : undefined}>
      {V_LABEL[v]}
    </span>
  );
}

/* La portada de iTunes/YouTube; sin ella (o si no carga) la generada. */
export function Thumb({ t }) {
  const [broken, setBroken] = useState(false);
  const video = t.source === "ytdlp";
  const tone = coverTone(t.artist, t.album);
  return (
    <span className={cx("thumb", video && "thumb--wide")}>
      {t.artwork_url && !broken ? (
        <img
          src={t.artwork_url}
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

export const subOf = (t) =>
  [t.artist || "artista desconocido", t.album && t.album !== t.title ? t.album : null, t.year]
    .filter(Boolean)
    .join(", ");

export const ResultRow = memo(function ResultRow({ t, i, query, busy, downloaded, onDl, onOpen }) {
  const st = trackState(t);
  const v = verdictOf(t, useVerdict(verdictKey(t, query)));
  const title = t.title || "sin título";
  const prov = provenance(t);
  const facts = factsOf(t);

  return (
    <li className="res" style={{ "--i": i }}>
      <span className="res__n num" aria-hidden="true">
        {i + 1}
      </span>
      <button
        type="button"
        className="res__main"
        aria-label={`Ver la ficha de ${title}`}
        onClick={(e) => onOpen({ type: "ficha", key: rowKey(t), anchor: e.currentTarget })}
      >
        <Thumb t={t} />
        <span className="res__txt">
          <span className="res__t">{title}</span>
          <span className="res__s">{subOf(t)}</span>
          <span className="res__m">
            {v ? <VerdictPill v={v} /> : <span className="res__no">{NODL_TITLE.none}</span>}
            <span
              className="src"
              title={prov.split ? `ficha: ${prov.ficha} · archivo: ${prov.archivo}` : prov.archivo}
            >
              {SOURCE_CODE[t.source] || prov.ficha}
            </span>
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
        {t.preview_url && <PreviewButton t={t} />}
        {st === "full" ? (
          <DlRing t={t} busy={busy} downloaded={downloaded} onDl={onDl} />
        ) : (
          <span className="nodl" role="img" aria-label={NODL_TITLE[st]} title={NODL_TITLE[st]}>
            <Ico n="nodl" size={22} />
          </span>
        )}
      </span>
    </li>
  );
});

/* Esqueleto con la forma de una fila, nunca un spinner generico. */
export function Skeleton() {
  return (
    <ul className="rlist" aria-label="Buscando" aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="res skel" style={{ "--i": i }} aria-hidden="true">
          <span className="skel__a" />
          <span className="skel__b">
            <i />
            <i />
          </span>
        </li>
      ))}
    </ul>
  );
}
