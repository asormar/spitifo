import { useState } from "react";
import { Icon } from "./icons.jsx";
import { cx } from "../shared/ui.jsx";
import { SOURCE_LABEL } from "./constants.js";

/* Etiqueta de estado: contorno fino del tono, icono y texto. Cada tono lleva el
   suyo (bien, solo preview, mal, sin veredicto) para que el estado no dependa
   solo del color. El `key` lo pone quien la usa: al cambiar de estado se
   remonta y repite su entrada. */
const CHIP_ICON = {
  ok: "Check",
  warn: "Headphones",
  bad: "X",
  mute: "Question",
};

export function StatusChip({ tone, children }) {
  const name = CHIP_ICON[tone] || "Question";
  return (
    <span className={`st st--${tone}`}>
      <Icon name={name} size={13} weight="bold" aria-hidden="true" />
      <span className="st__t">{children}</span>
    </span>
  );
}

/* La portada viene de iTunes y a veces no carga (o no existe). Sin onError el
   navegador pinta su icono roto de imagen. Con esto, si falla, sale el
   placeholder con la nota musical. */
export function Artwork({ t }) {
  const [broken, setBroken] = useState(false);
  /* Las miniaturas de YouTube son 16:9: recortarlas a cuadrado se comia
     media imagen (y el texto que suelen llevar). */
  const video = t.source === "ytdlp";
  if (!t.artwork_url || broken) {
    return (
      <div className={cx("card__art card__art--ph", video && "card__art--video")} aria-hidden="true">
        <Icon name="Waveform" size={26} />
      </div>
    );
  }
  return (
    <img
      className={cx("card__art", video && "card__art--video")}
      src={t.artwork_url}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

/* De donde sale la FICHA y de donde sale el ARCHIVO. En modo Música no
   son la misma cosa: iTunes pone los datos y la portada, YouTube pone el
   audio que se descarga. Sin esto, "iTunes | 3:07" se lee como si el archivo
   entero fuera de iTunes, y es falso. */
export function provenance(t) {
  const label = SOURCE_LABEL[t.source] || t.source;
  const ficha = label;
  const archivo = t.extra?.webpage_url ? SOURCE_LABEL.ytdlp : label;
  return { ficha, archivo, split: ficha !== archivo };
}
