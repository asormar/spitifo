import { Icon } from "../shared/icons.jsx";
import Ico from "../shared/ico.jsx";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { streamKey, streamQueue } from "./streamTrack.js";

/* ---------------------------------------------------------------------------
   ESCUCHAR EN STREAMING

   El boton redondo de la fila cuando el resultado tiene video completo. Igual
   que el preview, no tiene <audio> propio: manda la pista al motor y la pastilla
   (o la barra) lleva el progreso. Mientras el motor cargan el primer byte, el
   icono gira; es el mismo estado `buffering` que usan los controles.
   ------------------------------------------------------------------------- */

export default function StreamButton({ t, queue, source = null, text = false }) {
  const key = streamKey(t.extra?.webpage_url);
  const current = useEngine((s) => s.track?.key === key);
  const playing = useEngine((s) => s.track?.key === key && s.playing);
  const loading = useEngine(
    (s) => s.track?.key === key && s.buffering && !s.playing
  );
  const failed = useEngine((s) => s.track?.key === key && s.failed);
  const title = t.title || "sin título";

  const toggle = () => {
    if (current) {
      engine.toggle();
      return;
    }
    const { queue: lista, index } = streamQueue(queue, t, source);
    engine.play(lista[index], { queue: lista, index, source });
  };

  return (
    <button
      type="button"
      className={text ? "btn btn--ghost" : "pre"}
      disabled={failed}
      aria-pressed={playing}
      aria-label={text ? undefined : `Escuchar ${title}`}
      title={text ? undefined : "Escuchar en streaming"}
      onClick={toggle}
    >
      {loading ? (
        <Icon name="CircleNotch" size={20} weight="bold" className="spin" />
      ) : (
        playing ? <Ico n="pause" size={20} /> : <Icon name="Play" size={18} weight="fill" />
      )}
      {text && "Escuchar"}
    </button>
  );
}
