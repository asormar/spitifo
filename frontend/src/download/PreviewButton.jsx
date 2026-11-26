import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { Icon } from "./icons.jsx";
import { previewKey, previewTrack } from "./streamTrack.js";

/* ---------------------------------------------------------------------------
   30 S DE UN RESULTADO

   El boton de auriculares de la fila. No tiene reproductor propio: manda el
   preview al motor y el mini-reproductor (o la barra de abajo) lleva el
   progreso. Es una vista del motor: lee booleanos (ver useEngine.js) para que
   sonar uno no repinte las otras filas.
   ------------------------------------------------------------------------- */

/* `text`: la version de la ficha, un boton con su etiqueta. */
export default function PreviewButton({ t, text = false }) {
  const key = previewKey(t);
  const current = useEngine((s) => s.track?.key === key);
  const playing = useEngine((s) => s.track?.key === key && s.playing);
  const loading = useEngine((s) => s.track?.key === key && s.buffering && !s.playing);
  const failed = useEngine((s) => s.track?.key === key && s.failed);
  const title = t.title || "sin título";

  const toggle = () => {
    if (current) engine.toggle();
    /* Sin cola: el motor la completa con este track. La clave lleva la URL para
       que dos filas con el mismo preview no choquen. */
    else engine.play(previewTrack(t));
  };

  return (
    <button
      type="button"
      className={text ? "btn btn--ghost" : "pre"}
      disabled={failed}
      aria-pressed={playing}
      aria-busy={loading || undefined}
      aria-label={text ? undefined : loading ? `Cargando muestra de ${title}` : `Escuchar 30 s de ${title}`}
      title={text ? undefined : "Escuchar 30 s"}
      onClick={toggle}
    >
      {/* En la fila no hay sitio para la etiqueta: «30 s» dice lo que dura, que
          es lo que lo separa de escuchar la cancion entera. Mismo spinner que
          sus hermanos (StreamButton, ArchiveListenButton) mientras carga. */}
      {loading ? (
        <Icon name="CircleNotch" size="md" weight="bold" className="spin" />
      ) : playing ? (
        <Icon name="Pause" size="md" weight="fill" />
      ) : text ? (
        <Icon name="Headphones" size="md" />
      ) : (
        <span className="pre__30">30 s</span>
      )}
      {text && (playing ? "Pausar" : "Escuchar 30 s")}
    </button>
  );
}
