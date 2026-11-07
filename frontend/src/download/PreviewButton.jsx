import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import Ico from "./ico.jsx";

/* ---------------------------------------------------------------------------
   30 S DE UN RESULTADO

   El boton de auriculares de la fila. No tiene reproductor propio: manda el
   preview al motor y el mini-reproductor (o la barra de abajo) lleva el
   progreso. Es una vista del motor: lee booleanos (ver useEngine.js) para que
   sonar uno no repinte las otras filas.
   ------------------------------------------------------------------------- */

/* `text`: la version de la ficha, un boton con su etiqueta. */
export default function PreviewButton({ t, text = false }) {
  const key = `preview:${t.preview_url}`;
  const current = useEngine((s) => s.track?.key === key);
  const playing = useEngine((s) => s.track?.key === key && s.playing);
  const failed = useEngine((s) => s.track?.key === key && s.failed);
  const title = t.title || "sin título";

  const toggle = () => {
    if (current) engine.toggle();
    /* Sin cola: el motor la completa con este track. La clave lleva la URL para
       que dos filas con el mismo preview no choquen. */
    else {
      engine.play({
        key,
        src: t.preview_url,
        title,
        label: `el preview de ${title}`,
        meta: `${t.artist || "artista desconocido"} · preview de 30 s`,
        duration: 30,
        artwork: t.artwork_url,
        kind: "preview",
      });
    }
  };

  return (
    <button
      type="button"
      className={text ? "btn btn--ghost" : "pre"}
      disabled={failed}
      aria-pressed={playing}
      aria-label={text ? undefined : `Escuchar 30 s de ${title}`}
      title={text ? undefined : "Escuchar 30 s"}
      onClick={toggle}
    >
      <Ico n={playing ? "pause" : "hp"} size={20} />
      {text && "Escuchar 30 s"}
    </button>
  );
}
