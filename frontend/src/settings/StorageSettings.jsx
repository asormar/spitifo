import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { API, fetchErr } from "../shared/api.js";
import QuotaBar from "./QuotaBar.jsx";

const IS_ANDROID = /android/i.test(navigator.userAgent);
/* Los mensajes del flujo vienen del backend en ingles y estables: se traducen
   aca para no mostrar texto crudo. */
function connectErrorText(error) {
  if (!error) return null;
  if (/cancel/i.test(error)) return "Cancelaste el inicio de sesión.";
  if (/timed out/i.test(error)) return "El navegador tardó demasiado. Vuelve a intentarlo.";
  return "No se pudo conectar con Google Drive. Vuelve a intentarlo.";
}

/* Cuerpo de la seccion Almacenamiento. Era un <dialog>; ahora es una seccion
   normal de Ajustes, asi que no abre ni cierra nada: solo se carga cuando la
   pantalla esta activa y deja de sondear cuando se sale. */
export default function StorageSettings({ active, onChanged }) {
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

  /* Al entrar a Ajustes se lee el estado real; no al montar, porque la
     pantalla se queda montada entre aperturas. */
  useEffect(() => {
    if (active) load();
  }, [active, load]);

  /* Mientras el sign-in esta pendiente se sondea; al conectar, la biblioteca
     cambia sola en el backend y la app tiene que recargarla. */
  const pending = info?.connect?.state === "pending";
  const wasPending = useRef(false);
  useEffect(() => {
    if (!active || !pending) return undefined;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [active, pending, load]);
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
  const activeProvider = info?.active;
  const locked = Boolean(info?.override);
  /* En Android el sign-in lo hace el shell nativo, no el navegador: el backend
     lo dice (`connect_via`) y el puente lo inyecta MainActivity. Si el puente
     no esta, se cae al camino de siempre (link) en vez de quedarse esperando. */
  const viaAndroid =
    info?.connect_via === "android" &&
    typeof window.SpitifoAndroid?.connectDrive === "function";

  const pickLocal = async () => {
    if (activeProvider === "local" || locked) return;
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
      if (activeProvider === "google") return;
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
  const deviceIcon = IS_ANDROID ? "DeviceMobile" : "Laptop";

  let driveSub;
  if (!info) driveSub = " ";
  else if (!google?.configured) driveSub = "No disponible en esta versión";
  else if (pending) driveSub = (
    <span className="store__state">
      <Icon name="CircleNotch" size={14} className="spin" aria-hidden="true" />
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
    <div className="store">
      <p className="store__lede">¿Dónde guardas tu música?</p>

      <div className="store__opts" role="radiogroup" aria-label="Dónde guardas tu música">
        <button
          type="button"
          role="radio"
          aria-checked={activeProvider === "local"}
          className="store__opt"
          onClick={pickLocal}
          disabled={busy}
        >
          <Icon name={deviceIcon} size={24} weight="duotone" className="store__icon" aria-hidden="true" />
          <span className="store__name">Este dispositivo</span>
          <span className="store__sub">Sin conexión, solo aquí</span>
        </button>

        <button
          type="button"
          role="radio"
          aria-checked={activeProvider === "google"}
          aria-disabled={!google?.configured || undefined}
          className="store__opt"
          onClick={pickDrive}
          disabled={busy}
        >
          <Icon name="GoogleDriveLogo" size={24} weight="duotone" className="store__icon" aria-hidden="true" />
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

      {activeProvider === "google" && <QuotaBar quota={info?.quota} />}

      {locked && (
        <p className="store__note">Fijado por SPITIFO_STORAGE: se cambia desde el entorno.</p>
      )}
      {(err || connectErr) && (
        <p className="store__err" role="alert">
          {err || connectErr}
        </p>
      )}

      {google?.connected && !locked && (
        <div className="store__foot">
          <button type="button" className="store__link" onClick={disconnect} disabled={busy}>
            Desconectar Google Drive
          </button>
        </div>
      )}
    </div>
  );
}
