import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../shared/ui.jsx";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { usePc } from "../shared/viewport.js";
import { useHistory } from "./history.js";
import { Icon } from "./icons.jsx";
import { MIXES, mixEntries, mixName, mixSub } from "./mixes.js";

/* ---------------------------------------------------------------------------
   LA MEZCLA DE INICIO

   El disco azul de arriba: elige una de las cuatro mezclas y el boton rosa la
   pone en una cola barajada y sin fin. Cambiar de mezcla NO toca el audio: el
   disco solo deja de girar hasta que se pulsa otra vez (la cola que suena no
   es la de la mezcla elegida). Pregunta al motor con primitivos (source y
   playing): no se repinta con cada tick del tiempo.
   ------------------------------------------------------------------------- */

/* La mezcla elegida sobrevive a abrir una pagina y volver (el inicio se
   desmonta mientras tanto). */
let lastKey = "all";

const keyOf = (source) => (source?.startsWith("mix:") ? source.slice(4) : null);

export default function Mezcla({ entries, byKey, ctx }) {
  const pc = usePc();
  const hist = useHistory();
  const [key, setKey] = useState(() => keyOf(engine.getState().source) || lastKey);
  const source = useEngine((s) => s.source);
  const sounding = useEngine((s) => s.playing);
  const ref = useRef(null);

  const n = useMemo(() => mixEntries(key, entries, hist, byKey).length, [key, entries, hist, byKey]);
  const mine = source === `mix:${key}`;
  const on = mine && sounding;
  const name = mixName(key);

  /* El brillo solo gira con el disco a la vista: la pantalla oculta (o el disco
     fuera del scroll) lo pausa. data-vis es un atributo, no estado: nada se
     repinta. */
  useEffect(() => {
    const el = ref.current;
    if (typeof IntersectionObserver === "undefined") {
      el.setAttribute("data-vis", "");
      return undefined;
    }
    const io = new IntersectionObserver(([e]) => el.toggleAttribute("data-vis", e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const pick = (k) => {
    lastKey = k;
    setKey(k);
  };
  const press = () => {
    if (!n) return;
    if (mine) engine.toggle();
    else ctx.playMix(key);
  };

  const chips = (
    <div className="mixes" role="group" aria-label="Qué mezclar">
      {MIXES.map(([k, label]) => (
        <button
          key={k}
          type="button"
          className={cx("chip mix", k === key && "is-on")}
          aria-pressed={k === key}
          onClick={() => pick(k)}
        >
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <section ref={ref} className={cx("mezcla", on && "is-on")} aria-label="Mezcla">
        <div className="mz__txt">
          <h2>Mezcla</h2>
          <p>{mixSub(key, n)}</p>
          <small>{name}</small>
          {pc && chips}
        </div>
        <div className="recwrap">
          <div className="rec" aria-hidden="true">
            <span className="rec__spin" />
          </div>
          <button
            type="button"
            className="rec__label"
            aria-label={on ? "Pausar la mezcla" : `Reproducir la mezcla: ${name}`}
            aria-disabled={n ? undefined : true}
            onClick={press}
          >
            <Icon name={on ? "Pause" : "Play"} weight="fill" size={34} className={on ? undefined : "rec__play"} />
          </button>
        </div>
      </section>
      {!pc && chips}
    </>
  );
}
