import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleNotch,
  DeviceMobile,
  GoogleDriveLogo,
  Laptop,
  X,
} from "@phosphor-icons/react";
import { API, fetchErr } from "../shared/api.js";
import QuotaBar from "./QuotaBar.jsx";
import YouTubeCookies from "./YouTubeCookies.jsx";

const IS_ANDROID = /android/i.test(navigator.userAgent);
/* Los mensajes del flujo vienen del backend en ingles y estables: se traducen
   aca para no mostrar texto crudo. */
function connectErrorText(error) {
  if (!error) return null;
  if (/cancel/i.test(error)) return "Cancelaste el inicio de sesión.";
  if (/timed out/i.test(error)) return "El navegador tardó demasiado. Vuelve a intentarlo.";
  return "No se pudo conectar con Google Drive. Vuelve a intentarlo.";
}
export default function StorageDialog({ open, onClose, onChanged, focusCookies }) {
  const ref = useRef(null);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [authUrl, setAuthUrl] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/storage`);
      if (!r.ok) throw new Error(String(r.status));
      setInfo(await r.json());
      setErr(null);
    } catch (e) {
      setErr(fetchErr(e, "No se pudo leer dónde está tu biblioteca."));
    }
  }, []);

  /* <dialog> nativo: showModal da foco atrapado, Escape y fondo inerte. */
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      load();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open, load]);

  /* Mientras el sign-in esta pendiente se sondea; al conectar, la biblioteca
     cambia sola en el backend y la app tiene que recargarla. */
  const pending = info?.connect?.state === "pending";
  const wasPending = useRef(false);
  useEffect(() => {
    if (!open || !pending) return undefined;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [open, pending, load]);
  useEffect(() => {
    if (wasPending.current && !pending) {
      setAuthUrl(null);
      if (info?.connect?.state === "connected") onChanged();
    }
    wasPending.current = pending;
  }, [pending, info, onChanged]);

  const post = useCallback(
    async (path, body) => {
      setBusy(true);
      setErr(null);
      try {
        const r = await fetch(`${API}/storage/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          setErr(
            d.code === "not_configured"
              ? "Google Drive no está disponible en esta versión."
              : "No se pudo completar. Vuelve a intentarlo."
          );
          return null;
        }
        return d;
      } catch (e) {
        setErr(fetchErr(e, "No se pudo completar. Vuelve a intentarlo."));
        return null;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const google = info?.providers?.find((p) => p.id === "google");
  const active = info?.active;
  const locked = Boolean(info?.override);
  /* En Android el sign-in lo hace el shell nativo, no el navegador: el backend
     lo dice (`connect_via`) y el puente lo inyecta MainActivity. Si el puente
     no esta, se cae al camino de siempre (link) en vez de quedarse esperando. */
  const viaAndroid =
    info?.connect_via === "android" &&
    typeof window.SpitifoAndroid?.connectDrive === "function";

  const pickLocal = async () => {
    if (active === "local" || locked) return;
    if (await post("use", { provider: "local" })) {
      await load();
      onChanged();
    }
  };

  const pickDrive = async () => {
    if (!google?.configured || locked || pending) return;
    /* En Android "conectado" es solo una marca persistida: el token vive en
       memoria y puede faltar (caducado, revocado). Pasar siempre por el sign-in
       nativo no cuesta nada si el permiso ya existe (silencioso, ~100 ms) y es
       la unica salida de un 503 reconnect_required. */
    if (google.connected && !viaAndroid) {
      if (active === "google") return;
      if (await post("use", { provider: "google" })) {
        await load();
        onChanged();
      }
      return;
    }
    const d = await post("connect", { provider: "google" });
    if (d) {
      /* Un token silencioso puede llegar antes del proximo load() y `pending`
         no llegar a pintarse: se marca aca para que el paso a "connected"
         recargue la biblioteca igual. */
      wasPending.current = true;
      if (viaAndroid) window.SpitifoAndroid.connectDrive();
      else setAuthUrl(d.auth_url);
      await load();
    }
  };

  const cancel = async () => {
    await post("connect/cancel");
    setAuthUrl(null);
    load();
  };

  const disconnect = async () => {
    if (await post("disconnect", { provider: "google" })) {
      await load();
      onChanged();
    }
  };

  const connectErr = connectErrorText(info?.connect?.error);
  const DeviceIcon = IS_ANDROID ? DeviceMobile : Laptop;

  let driveSub;
  if (!info) driveSub = " ";
  else if (!google?.configured) driveSub = "No disponible en esta versión";
  else if (pending) driveSub = (
    <span className="store__state">
      <CircleNotch size={14} className="spin" aria-hidden="true" />
      {viaAndroid ? "Esperando a Google…" : "Esperando al navegador…"}
    </span>
  );
  else if (google.connected) driveSub = (
    <span className="store__state">
      <span className="store__dot" aria-hidden="true" />
      Conectada
    </span>
  );
  else driveSub = "Conecta tu cuenta";

  return (
    <dialog
      ref={ref}
      className="store"
      aria-labelledby="store-title"
      onClose={onClose}
      onClick={(e) => {
        /* Click en el fondo (el propio <dialog>, fuera de la tarjeta) cierra. */
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="store__card">
        <div className="store__head">
          <h2 id="store-title" className="store__title">¿Dónde guardas tu música?</h2>
          <button type="button" className="store__x" aria-label="Cerrar" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="store__opts" role="radiogroup" aria-labelledby="store-title">
          <button
            type="button"
            role="radio"
            aria-checked={active === "local"}
            className="store__opt"
            onClick={pickLocal}
            disabled={busy}
          >
            <DeviceIcon size={24} weight="duotone" className="store__icon" aria-hidden="true" />
            <span className="store__name">Este dispositivo</span>
            <span className="store__sub">Sin conexión, solo aquí</span>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked={active === "google"}
            aria-disabled={!google?.configured || undefined}
            className="store__opt"
            onClick={pickDrive}
            disabled={busy}
          >
            <GoogleDriveLogo size={24} weight="duotone" className="store__icon" aria-hidden="true" />
            <span className="store__name">Google Drive</span>
            <span className="store__sub">{driveSub}</span>
          </button>
        </div>

        {pending && (
          <p className="store__note">
            {viaAndroid
              ? "Esperando a Google…"
              : "Termina de iniciar sesión en el navegador."}{" "}
            {!viaAndroid && authUrl && (
              <a href={authUrl} target="_blank" rel="noreferrer">
                Abrir de nuevo
              </a>
            )}
            <button type="button" className="store__link" onClick={cancel}>
              Cancelar
            </button>
          </p>
        )}

        {active === "google" && <QuotaBar quota={info?.quota} />}

        {locked && (
          <p className="store__note">Fijado por SPITIFO_STORAGE: se cambia desde el entorno.</p>
        )}
        {(err || connectErr) && (
          <p className="store__err" role="alert">
            {err || connectErr}
          </p>
        )}

        <YouTubeCookies focus={focusCookies} />

        <div className="store__foot">
          {google?.connected && !locked && (
            <button type="button" className="store__link" onClick={disconnect} disabled={busy}>
              Desconectar Google Drive
            </button>
          )}
          <button type="button" className="store__done" onClick={onClose}>
            Listo
          </button>
        </div>
      </div>
    </dialog>
  );
}
