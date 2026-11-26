import { useState } from "react";
import { useShow } from "../listen/Notice.jsx";
import { Icon } from "./icons.jsx";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { auditionKey, auditionTrack } from "./streamTrack.js";
import { verdictKey, verdictStore } from "./verdict.js";

/* ---------------------------------------------------------------------------
   ESCUCHAR UN RESULTADO DE INTERNET ARCHIVE

   Antes de sonar hay que saber QUE archivo del item es la cancion: es la misma
   verificacion de «¿Es esta la cancion?», asi que escuchar tambien deja el
   veredicto a la vista. Mientras se resuelve el boton gira; si la verificacion
   falla, la ficha ya dice por que y el boton vuelve a estar listo.
   ------------------------------------------------------------------------- */

/* Pura para poder probarla: resuelve (o reusa) la URL y la manda al motor. */
export async function listenArchive(t, query, { store = verdictStore, player = engine } = {}) {
  const key = verdictKey(t, query);
  let rec = store.get(key);
  let audio = t.audio_url || rec?.audio;
  if (!audio) {
    await store.verify(t, query);
    rec = store.get(key);
    audio = rec?.audio;
  }
  /* Un item restringido (archive.org responde 403) no se intenta: el
     reproductor fallaria sin decir por que. */
  if (!audio || rec?.extra?.unreadable) return false;
  /* La verificacion eligio un archivo concreto del item: con el se puede
     construir la identidad estable de la cancion guardada. */
  const resolved = rec?.extra?.filename
    ? { ...t, extra: { ...t.extra, ...rec.extra } }
    : t;
  player.play(auditionTrack(resolved, audio));
  return true;
}

export default function ArchiveListenButton({ t, query, text = false }) {
  const key = auditionKey(t);
  const show = useShow();
  const [waiting, setWaiting] = useState(false);
  const current = useEngine((s) => s.track?.key === key);
  const playing = useEngine((s) => s.track?.key === key && s.playing);
  const buffering = useEngine((s) => s.track?.key === key && s.buffering && !s.playing);
  const title = t.title || "sin título";
  const loading = waiting || buffering;

  const toggle = async () => {
    if (current) {
      engine.toggle();
      return;
    }
    if (waiting) return;
    setWaiting(true);
    const q = query || title;
    try {
      /* Sin archivo no hay que tocar: el aviso dice por que (por ejemplo, un
         item que Internet Archive tiene restringido). */
      if (!(await listenArchive(t, q))) {
        const rec = verdictStore.get(verdictKey(t, q));
        const why = rec?.extra?.unreadable ? "archive.org no deja leer el archivo" : rec?.error;
        show?.(`No se puede escuchar «${title}»${why ? `: ${why}` : ""}`);
      }
    } finally {
      setWaiting(false);
    }
  };

  return (
    <button
      type="button"
      className={text ? "btn btn--ghost" : "pre"}
      aria-pressed={playing}
      aria-busy={loading || undefined}
      aria-label={text ? undefined : `Escuchar ${title}`}
      title={text ? undefined : "Escuchar antes de descargar"}
      onClick={toggle}
    >
      {loading ? (
        <Icon name="CircleNotch" size="md" weight="bold" className="spin" />
      ) : playing ? (
        <Icon name="Pause" size="md" weight="fill" />
      ) : (
        <Icon name="Play" size={text ? "sm" : "md"} weight="fill" />
      )}
      {text && (playing ? "Pausar" : "Escuchar")}
    </button>
  );
}
