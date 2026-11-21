import { useCallback, useEffect, useRef, useState } from "react";
import { rowKey } from "../shared/api.js";
import { useShow } from "../listen/Notice.jsx";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { listenArchive } from "./ArchiveListenButton.jsx";
import { resolveResult } from "./resolveResult.js";
import { rowPlayPlan } from "./rowPlayPlan.js";
import { auditionKey, canStream, previewKey, previewTrack, streamKey, streamQueue, streamTrack } from "./streamTrack.js";

/* ---------------------------------------------------------------------------
   TOQUE DE UNA FILA DE BUSCAR

   Los botones que habia en la fila se juntan aqui: la misma cola de StreamButton,
   la misma verificacion de ArchiveListenButton y la misma pista de PreviewButton.
   La decision de cual usar vive en rowPlayPlan.js (puro). Resolver es asincrono:
   un numero de intento descarta respuestas viejas y desmontar aborta la peticion,
   asi una busqueda nueva no deja la fila «buscando…» colgada.
   ------------------------------------------------------------------------- */

/* Clave del motor para esta fila, segun lo que vaya a sonar. */
export function rowTrackKey(t) {
  const plan = rowPlayPlan(t);
  if (plan === "stream") return streamKey(t.extra?.webpage_url);
  if (plan === "archive") return auditionKey(t);
  if (plan === "preview") return previewKey(t);
  return null;
}

/* ¿Es esta fila la pista que suena ahora? Puro: con la foto del motor y la
   clave/rowKey ya calculadas decide si el toque debe alternar pausa en vez de
   empezar de nuevo. En los resultados que hay que resolver `key` es null (la
   clave definitiva no se conoce hasta que llega la respuesta), asi que ahi se
   compara por el rowKey del resultado guardado en la pista del motor. */
export function isMine(state, { key, rk }) {
  if (!state?.track) return false;
  if (key && state.track.key === key) return true;
  return Boolean(rk) && rowKey(state.track.result) === rk;
}

/* La misma pista, pero para la cola del menu ⋯: resuelve primero si hace falta
   y deja que el motor decida si la pone a continuacion o al final. */
export async function resultTrackFor(t, { query = "", source = null } = {}) {
  const plan = rowPlayPlan(t);
  if (plan === "stream") return streamTrack(t, source);
  if (plan === "preview") return previewTrack(t);
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
      return previewTrack({ ...t, preview_url: full?.preview_url || t.preview_url });
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
  const rk = rowKey(t);
  const mine = (s) => isMine(s, { key, rk });
  const isCurrent = useEngine(mine);
  const playing = useEngine((s) => mine(s) && s.playing);

  /* La fila conserva su key de React entre busquedas: si cambian el resultado
     o la consulta mientras resuelve, sube el intento, corta la peticion y deja
     la fila lista para el nuevo toque. Asi no suena la respuesta que llega
     tarde de la busqueda anterior. */
  useEffect(() => {
    seq.current += 1;
    abort.current?.abort();
    abort.current = null;
    busy.current = false;
    setResolving(false);
  }, [key, rk, query]);

  const fail = useCallback(() => {
    show?.(`No se puede reproducir «${t?.title || "este resultado"}»`);
  }, [show, t]);

  const play = useCallback(async () => {
    const plan = rowPlayPlan(t);
    if (!plan) return fail();
    /* Si esta fila ya es la pista del motor, alternar pausa sin importar el
       plan: resolver de nuevo reiniciaria la cancion mientras la fila dice
       «Pausar». Antes del plan para que tambien valga en stream, archive,
       resolve y preview. */
    const state = engine.getState();
    if (mine(state)) return engine.toggle();

    if (plan === "stream") {
      const { queue: lista, index } = streamQueue(queue, t, source);
      return engine.play(lista[index], { queue: lista, index, source });
    }
    if (plan === "archive") {
      const intento = ++seq.current;
      const ok = await listenArchive(t, query || t.title);
      if (!alive.current || intento !== seq.current) return;
      if (!ok) fail();
      return;
    }
    if (plan === "preview") return engine.play(previewTrack(t));

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
        engine.play(previewTrack({ ...t, preview_url: full?.preview_url || t.preview_url }));
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
