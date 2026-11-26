import { Icon } from "../shared/icons.jsx";
import { cx } from "../shared/ui.jsx";
import { coverTone, toneClass, toneVars } from "../shared/cover.js";
import { initial } from "../listen/rows.jsx";
import { engine } from "./engine.js";
import { useEngine } from "./useEngine.js";
import { panel } from "./panel.js";

/* ---------------------------------------------------------------------------
   CONTROLES COMPARTIDOS

   Lo que pintan igual "Ahora suena" (np) y la barra del escritorio (dock): el
   transporte, el volumen y la portada. Cambian las clases y los tamanos, no el
   comportamiento. Cada selector devuelve un primitivo: el tiempo no se lee
   aqui, asi la barra no se repinta cuatro veces por segundo.
   ------------------------------------------------------------------------- */

const REPEAT = {
  off: ["Repetir: no", "Repeat"],
  all: ["Repetir: todo", "Repeat"],
  one: ["Repetir: una", "RepeatOnce"],
};

/* Iconos laterales, de saltar y de reproducir. */
const SIZES = { np: ["lg", "xl", "xl"], dock: ["md", "lg", "lg"] };

/* El nombre accesible del boton de reproducir: mientras carga dice "Cargando
   <titulo>" (un lector de pantalla no puede ver el giro del icono), si no, lo
   de siempre. Funcion aparte para poder probarla sin montar el boton. */
export function playButtonLabel({ icon, playing, label }) {
  if (icon === "load") return `Cargando ${label}`;
  return `${playing ? "Pausar" : "Reproducir"} ${label}`;
}

/* Boton de reproducir/pausar/cargando (tres iconos, los muestra CSS segun
   data-icon). Lo comparten el mini-reproductor y los controles. Mientras
   carga, aria-busy refuerza el nombre accesible. */
export function PlayButton({ className, icon, playing, label, size }) {
  const busy = icon === "load";
  return (
    <button
      type="button"
      className={cx("pbtn", className)}
      data-icon={icon}
      onClick={() => engine.toggle()}
      aria-busy={busy || undefined}
      aria-label={playButtonLabel({ icon, playing, label })}
    >
      <span className="pbtn__ico pbtn__ico--play">
        <Icon name="Play" size={size} weight="fill" />
      </span>
      <span className="pbtn__ico pbtn__ico--pause">
        <Icon name="Pause" size={size} weight="fill" />
      </span>
      <span className="pbtn__ico pbtn__ico--load">
        <Icon name="CircleNotch" size={size} weight="bold" className="spin" />
      </span>
    </button>
  );
}

export function Controls({ dock = false }) {
  const shuffle = useEngine((s) => s.shuffle);
  const repeat = useEngine((s) => s.repeat);
  const playing = useEngine((s) => s.playing);
  const icon = useEngine((s) => (s.buffering ? "load" : s.playing ? "pause" : "play"));
  const label = useEngine((s) => s.track?.label ?? "");
  const canNext = useEngine((s) => (s.index >= 0 && s.index + 1 < s.queue.length) || s.repeat === "all");
  /* Lo que queda por sonar: la insignia del sexto boton (solo en Ahora suena,
     la barra de escritorio ya tiene su propio boton de Cola). */
  const upcoming = useEngine((s) => (s.index >= 0 ? s.queue.length - s.index - 1 : 0));
  const [repeatLabel, repeatIcon] = REPEAT[repeat];
  const [side, skip, big] = SIZES[dock ? "dock" : "np"];
  const btn = dock ? "cbtn" : "cbtn cbtn--w";

  return (
    <div className={dock ? "dock__ctl" : "np__ctl"}>
      <button
        type="button"
        className={cx(btn, shuffle && "is-on")}
        aria-pressed={shuffle}
        aria-label="Aleatorio"
        title="Aleatorio"
        onClick={() => engine.setShuffle(!shuffle)}
      >
        <Icon name="Shuffle" size={side} />
      </button>
      <button type="button" className={btn} onClick={() => engine.prev()} aria-label="Anterior" title="Anterior">
        <Icon name="SkipBack" size={skip} weight="fill" />
      </button>
      <PlayButton
        className={dock ? undefined : "np__play"}
        icon={icon}
        playing={playing}
        label={label}
        size={big}
      />
      <button
        type="button"
        className={btn}
        onClick={() => engine.next()}
        disabled={!canNext}
        aria-label="Siguiente"
        title="Siguiente"
      >
        <Icon name="SkipForward" size={skip} weight="fill" />
      </button>
      <button
        type="button"
        className={cx(btn, repeat !== "off" && "is-on")}
        onClick={() => engine.cycleRepeat()}
        aria-label={repeatLabel}
        title={repeatLabel}
      >
        <Icon name={repeatIcon} size={side} />
      </button>
      {!dock && (
        <button
          type="button"
          className={cx(btn, "np__ctl-queue")}
          onClick={() => panel.show(1)}
          aria-label="Cola"
          title="Cola"
        >
          <Icon name="Queue" size={side} />
          {upcoming > 0 && (
            <span className="np__badge" aria-hidden="true">
              {upcoming > 99 ? "99+" : upcoming}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

/* Silencio y deslizador: solo con sitio (desde 960 px); en el telefono manda
   el volumen del propio telefono. */
export function Volume({ className = "np__vol" }) {
  const volume = useEngine((s) => s.volume);
  const muted = useEngine((s) => s.muted);
  const quiet = muted || volume === 0;
  const pct = Math.round((quiet ? 0 : volume) * 100);

  return (
    <div className={className}>
      <button
        type="button"
        className="pl__mute"
        onClick={() => engine.toggleMute()}
        aria-label={quiet ? "Activar el sonido" : "Silenciar"}
        title={quiet ? "Activar el sonido" : "Silenciar"}
      >
        <Icon name={quiet ? "SpeakerSlash" : volume < 0.45 ? "SpeakerLow" : "SpeakerHigh"} size="md" />
      </button>
      <input
        type="range"
        className="vol"
        min={0}
        max={100}
        step={1}
        value={pct}
        aria-label="Volumen"
        style={{ "--v": `${pct}%` }}
        onChange={(e) => engine.setVolume(Number(e.target.value) / 100)}
      />
    </div>
  );
}

/* Portada de la pista del reproductor flotante: la imagen o, sin ella, la
   generada con la inicial del artista (misma receta que las filas). */
export function DockArt({ d, size, className }) {
  if (d.art) {
    return <img className={className} src={d.art} alt="" loading="lazy" onError={d.onArtError} />;
  }
  const tone = coverTone(d.artist, d.album);
  return (
    <span
      className={cx("cv", className, toneClass(tone))}
      style={{ ...toneVars(tone), "--s": `${size}px` }}
      aria-hidden="true"
    >
      <span>{initial(d.artist || d.info?.title)}</span>
    </span>
  );
}
