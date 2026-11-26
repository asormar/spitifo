import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../shared/ui.jsx";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { useHistory } from "./history.js";
import { Icon } from "./icons.jsx";
import { entryTone, shortcutEntries } from "./home.js";
import { Cover, coverOf } from "./cards.jsx";
import { MIXES, mixEntries, mixName, mixReady, mixSub } from "./mixes.js";

/* ---------------------------------------------------------------------------
   LA MEZCLA DE INICIO

   El hero compacto: una pildora con la mezcla que suena y su boton de play, un
   disco pequeno de adorno y, debajo, una rejilla de atajos a lo mas escuchado y
   lo mas reciente. Tocar un chip ya NO deja un estado elegido que no suena:
   cambia la cola en el momento (Decision 1). Pregunta al motor con primitivos
   (source y playing): no se repinta con cada tick del tiempo.
   ------------------------------------------------------------------------- */

/* La mezcla elegida sobrevive a abrir una pagina y volver (el inicio se
   desmonta mientras tanto). */
let lastKey = "all";

const keyOf = (source) => (source?.startsWith("mix:") ? source.slice(4) : null);

export default function Mezcla({ entries, byKey, ctx, top, recent }) {
  const hist = useHistory();
  const [key, setKey] = useState(() => keyOf(engine.getState().source) || lastKey);
  const source = useEngine((s) => s.source);
  const sounding = useEngine((s) => s.playing);
  const ref = useRef(null);

  const n = useMemo(() => mixEntries(key, entries, hist, byKey).length, [key, entries, hist, byKey]);
  const shortcuts = useMemo(() => shortcutEntries(top, recent, 8), [top, recent]);
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
    /* Elegir una mezcla la reproduce: nunca un chip que nombra una cola que
       todavia no existe. Si esta vacia, no cortamos lo que suena. */
    if (mixReady(k, entries, hist, byKey)) ctx.playMix(k);
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
        <div className="mz__pill">
          <div className="mz__txt">
            <b>{name}</b>
            <small>{mixSub(key, n)}</small>
          </div>
          <button
            type="button"
            className="mz__play"
            aria-label={on ? "Pausar la mezcla" : `Reproducir la mezcla: ${name}`}
            aria-disabled={n ? undefined : true}
            onClick={press}
          >
            <Icon name={on ? "Pause" : "Play"} weight="fill" size="md" className={on ? undefined : "mz__play-i"} />
          </button>
        </div>
        <div className="mz__rec" aria-hidden="true">
          <span className="mz__spin" />
        </div>
      </section>
      {shortcuts.length > 0 && (
        <div className="shortcuts" role="group" aria-label="Atajos de inicio">
          {shortcuts.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className="shortcut"
              aria-label={`Reproducir ${entry.title}, ${entry.artist}`}
              onClick={(e) => ctx.play(entry, e.currentTarget, shortcuts, "library:Atajos")}
            >
              <Cover tone={entryTone(entry)} label={entry.title} src={coverOf([entry])} target={entry.key} />
              <span className="shortcut__t">{entry.title}</span>
            </button>
          ))}
        </div>
      )}
      {chips}
    </>
  );
}
