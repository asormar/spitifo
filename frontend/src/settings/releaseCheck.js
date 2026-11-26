import { useCallback, useEffect, useState } from "react";
import { API } from "../shared/api.js";
import { APP_VERSION } from "../shared/appVersion.js";

/* ---------------------------------------------------------------------------
   VERSION Y ACTUALIZACIONES (R2-install-e)

   La comparacion de versiones es pura (se prueba sin red ni DOM); el hook solo
   llama a /api/release/latest, que el backend cachea 24 h. Tres estados nada
   mas: "current" (ya tiene la ultima), "newer" (hay una version nueva) y
   "offline" (no se pudo saber, estado tranquilo, no un error).
   ------------------------------------------------------------------------- */

export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/* -1/0/1, como Array.prototype.sort. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function updateState(installed, latest) {
  const inst = parseVersion(installed);
  const lat = parseVersion(latest);
  if (!inst || !lat) return "offline";
  return compareVersions(lat, inst) > 0 ? "newer" : "current";
}

export const installedLabel = (version) => `spitifo v${version}`;
export const newerLabel = (version) => `Hay una versión nueva: v${version}`;

/* Comprueba /api/release/latest. `force` ignora la cache del backend (el boton
   "Buscar actualizaciones"); un fallo de red deja state en "offline" sin
   lanzar, igual que cuando el backend no pudo llegar a GitHub. */
export function useReleaseCheck() {
  const [latest, setLatest] = useState(null);
  const [url, setUrl] = useState(null);
  const [checking, setChecking] = useState(true);

  const check = useCallback(async (force = false) => {
    setChecking(true);
    try {
      const res = await fetch(`${API}/release/latest${force ? "?force=1" : ""}`);
      const data = await res.json();
      setLatest(data?.version ?? null);
      setUrl(data?.url ?? null);
    } catch {
      setLatest(null);
      setUrl(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    check(false);
  }, [check]);

  return { state: updateState(APP_VERSION, latest), latest, url, checking, check };
}
