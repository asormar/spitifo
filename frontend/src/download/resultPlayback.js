import { useCallback, useEffect, useRef, useState } from "react";
import { rowKey } from "../shared/api.js";
import { useShow } from "../listen/Notice.jsx";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { listenArchive } from "./ArchiveListenButton.jsx";
import { resolveResult } from "./resolveResult.js";
import { rowPlayPlan } from "./rowPlayPlan.js";
import { auditionKey, canStream, streamKey, streamQueue, streamTrack } from "./streamTrack.js";

/* ---------------------------------------------------------------------------
   TOQUE DE UNA FILA DE BUSCAR

   Los botones que habia en la fila se juntan aqui: la misma cola de StreamButton,
   la misma verificacion de ArchiveListenButton y la misma pista de PreviewButton.
   La decision de cual usar vive en rowPlayPlan.js (puro). Resolver es asincrono:
   un numero de intento descarta respuestas viejas y desmontar aborta la peticion,
   asi una busqueda nueva no deja la fila «buscando…» colgada.
   ------------------------------------------------------------------------- */

export const previewKey = (t) => `preview:${t?.preview_url}`;

/* Exactamente la pista que mandaba PreviewButton: el mini-reproductor ya dice
   «preview de 30 s» en su linea de datos. */
export function previewTrackOf(t) {
  const title = t.title || "sin título";
  return {
    key: previewKey(t),
    src: t.preview_url,
    title,
    label: `el preview de ${title}`,
    meta: `${t.artist || "artista desconocido"} · preview de 30 s`,
    duration: 30,
    artwork: t.artwork_url || null,
    kind: "preview",
    result: t,
  };
}

/* Clave del motor para esta fila, segun lo que vaya a sonar. */
export function rowTrackKey(t) {
  const plan = rowPlayPlan(t);
  if (plan === "stream") return streamKey(t.extra?.webpage_url);
  if (plan === "archive") return auditionKey(t);
  if (plan === "preview") return previewKey(t);
  return null;
}

/* La misma pista, pero para la cola del menu ⋯: resuelve primero si hace falta
   y deja que el motor decida si la pone a continuacion o al final. */
export async function resultTrackFor(t, { query = "", source = null } = {}) {
  const plan = rowPlayPlan(t);
  if (plan === "stream") return streamTrack(t, source);
  if (plan === "preview") return previewTrackOf(t);
  if (plan === "archive") {
    let track = null;
    const ok = await listenArchive(t, query || t.title, {
      player: { play: (pista) => { track = pista; } },
    });
    return ok ? track : null;
  }
  if (plan === "resolve") {
    const full = await resolveResult(t, query);
    if (canStream(full)) return streamTrack(full, source);
    if (full?.preview_url || t.preview_url) {
      return previewTrackOf({ ...t, preview_url: full?.preview_url || t.preview_url });
    }
  }
  return null;
}

export function useResultPlayback({ t, query = "", queue = [], source = null }) {
  const show = useShow();
  const [resolving, setResolving] = useState(false);
  const seq = useRef(0);
  const busy = useRef(false);
  const abort = useRef(null);
  const alive = useRef(true);

  useEffect(() => () => {
    alive.current = false;
    seq.current += 1;
    abort.current?.abort();
  }, []);

  const key = rowTrackKey(t);
  const mine = (s) => {
    if (!s.track) return false;
    if (key && s.track.key === key) return true;
    const rk = rowKey(t);
    return Boolean(rk) && rowKey(s.track.result) === rk;
  };
  const isCurrent = useEngine(mine);
  const playing = useEngine((s) => mine(s) && s.playing);

  const fail = useCallback(() => {
    show?.(`No se puede reproducir «${t?.title || "este resultado"}»`);
  }, [show, t]);

  const play = useCallback(async () => {
    const plan = rowPlayPlan(t);
    if (!plan) return fail();
    const state = engine.getState();
    if (plan !== "resolve" && mine(state)) return engine.toggle();

    if (plan === "stream") {
      const { queue: lista, index } = streamQueue(queue, t, source);
      return engine.play(lista[index], { queue: lista, index, source });
    }
    if (plan === "archive") {
      const ok = await listenArchive(t, query || t.title);
      if (!ok) fail();
      return;
    }
    if (plan === "preview") return engine.play(previewTrackOf(t));

    /* resolve: un toque a la vez, y solo cuenta el ultimo. */
    if (busy.current) return;
    busy.current = true;
    const intento = ++seq.current;
    const ac = new AbortController();
    abort.current = ac;
    setResolving(true);
    try {
      const full = await resolveResult(t, query, (url, opts) =>
        fetch(url, { ...opts, signal: ac.signal })
      );
      if (!alive.current || intento !== seq.current) return;
      if (canStream(full)) {
        const { queue: lista, index } = streamQueue([full], full, source);
        engine.play(lista[index], { queue: lista, index, source });
      } else if (full?.preview_url || t.preview_url) {
        engine.play(previewTrackOf({ ...t, preview_url: full?.preview_url || t.preview_url }));
      } else {
        fail();
      }
    } catch (e) {
      if (e?.name === "AbortError" || !alive.current || intento !== seq.current) return;
      fail();
    } finally {
      abort.current = null;
      busy.current = false;
      if (alive.current && intento === seq.current) setResolving(false);
    }
  }, [t, query, queue, source, show, fail, key]);

  return { play, isCurrent, playing, resolving };
}
