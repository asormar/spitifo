import { useState } from "react";
import { Icon } from "../shared/icons.jsx";
import Ico from "../shared/ico.jsx";
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
  let audio = t.audio_url || store.get(key)?.audio;
  if (!audio) {
    await store.verify(t, query);
    audio = store.get(key)?.audio;
  }
  if (!audio) return false;
  player.play(auditionTrack(t, audio));
  return true;
}

export default function ArchiveListenButton({ t, query, text = false }) {
  const key = auditionKey(t);
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
    try {
      await listenArchive(t, query || title);
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
        <Icon name="CircleNotch" size={text ? 18 : 20} weight="bold" className="spin" />
      ) : playing ? (
        <Ico n="pause" size={text ? 18 : 20} />
      ) : (
        <Icon name="Play" size={text ? 16 : 18} weight="fill" />
      )}
      {text && "Escuchar"}
    </button>
  );
}
