import { useState } from "react";
import { resultOf } from "../player/savedTrack.js";
import { songFromResult, songIdOf } from "../shared/songId.js";
import { resolveResult } from "../download/resolveResult.js";
import { trackState } from "../download/constants.js";
import { trackSpec } from "../download/albumText.js";
import { queueStore } from "../download/queueStore.js";
import { autoDownload } from "../settings/autoDownload.js";
import { removeEntry } from "./deleteSong.js";
import { saved, useSaved } from "./saved.js";
import { useListen } from "./ListenProvider.jsx";
import { heartState, ownedEntryFor, saveNotice, shouldEnqueue } from "./saveLogic.js";

/* ---------------------------------------------------------------------------
   GUARDAR DESDE BUSCAR Y DESDE AHORA SUENA

   El corazon de una fila y el del reproductor comparten la mismasecuencia:
   saber si ya esta guardado, resolver el resultado que todavia no tiene id,
   guardar con foto optimista y, si el ajuste esta encendido, encolar la
   descarga sin repetir lo que ya esta bajado.
   ------------------------------------------------------------------------- */

/* La cola espera la forma de item de /api/downloads, no la cancion guardada.
   `resultOf` reconstruye el resultado de Buscar a partir del registro. */
export function autoDownloadSpec(song, result, { downloaded = false } = {}) {
  return shouldEnqueue({ enabled: autoDownload.get(), downloaded })
    ? trackSpec(song ? resultOf(song) : result, "")
    : null;
}

export function maybeAutoDownload(song, result, options) {
  const spec = autoDownloadSpec(song, result, options);
  if (spec) queueStore.enqueue({ items: [spec] });
  return Boolean(spec);
}

export function maybeAutoDownloadMany(pairs) {
  const items = pairs
    .map(([song, result, options]) => autoDownloadSpec(song, result, options))
    .filter(Boolean);
  if (items.length) queueStore.enqueue({ items });
  return items.length;
}

/* `t` es un resultado de Buscar; `track` es la pista del motor. Los dos llegan
   aqui y devuelven lo mismo: si se pinta el corazon, si esta lleno y que hacer
   al tocarlo. */
export function useSaveTarget({ t = null, track = null, query = "" } = {}) {
  const savedById = useSaved((s) => s.byId);
  const listen = useListen();
  const [busy, setBusy] = useState(false);
  const result = track?.result || t || null;
  const kind = track?.kind || (result ? "stream" : null);
  const entry = track && !result
    ? listen?.model?.byKey?.get(track.sid || track.key) || null
    : ownedEntryFor(result, listen?.model?.entries, savedById);
  const id = songIdOf(result) || (!result && track?.sid ? track.sid : null);
  const stored = Boolean(
    (id && savedById.has(id)) ||
      (track?.sid && savedById.has(track.sid)) ||
      entry
  );
  const full = kind === "library" || (!track && !!result && trackState(result) === "full") ||
    (track?.kind === "stream" && Boolean(track.sid));
  const state = heartState({ kind, full, saved: stored, owned: Boolean(entry) });
  const title = track?.title || result?.title || entry?.title || "sin título";

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    const deps = {
      show: listen?.ctx?.show,
      hideKeys: listen?.ctx?.hideKeys,
      restoreFiles: listen?.ctx?.restoreFiles,
      refreshLibrary: listen?.ctx?.refreshLibrary,
    };
    if (state.filled) {
      removeEntry(
        entry || (track ? { key: track.key, sid: track.sid, title, downloaded: false } : null),
        deps
      );
      setBusy(false);
      return;
    }
    let resolved = null;
    try {
      resolved = await resolveResult(result, query);
    } catch {
      /* Sin resolucion no hay id: se dice y el corazon sigue vacio. */
    }
    const song = resolved ? songFromResult(resolved) : null;
    if (!song || !(await saved.save(song))) {
      deps.show?.(saveNotice.fail(title));
      setBusy(false);
      return;
    }
    maybeAutoDownload(song, resolved, { downloaded: false });
    deps.show?.(saveNotice.ok);
    setBusy(false);
  };

  return { ...state, title, toggle };
}
