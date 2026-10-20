import { useCallback, useEffect, useRef, useState } from "react";
import { Cookie, Trash, UploadSimple } from "@phosphor-icons/react";
import { API, errMsg, fetchErr } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   COOKIES DE YOUTUBE (ultimo recurso)
   YouTube a veces pide verificar que no eres un bot. Importar un cookies.txt de
   una sesion iniciada es la salida, pero el backend SOLO lo usa como reintento
   cuando el muro aparece: nunca en el primer intento. El archivo se guarda
   cifrado en el servidor (DPAPI); esta pantalla nunca muestra su contenido.
   Ver backend/app/youtube_cookies.py.
   ------------------------------------------------------------------------- */
function fmtImportDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default function YouTubeCookies({ focus }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);
  const boxRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/youtube/cookies`);
      const d = await r.json();
      if (!r.ok) throw new Error(String(r.status));
      setInfo(d);
      setErr(null);
    } catch (e) {
      setErr(fetchErr(e, "No se pudo leer el estado de las cookies."));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* El aviso de "verifica que no eres un bot" abre este bloque: lo trae a la vista. */
  useEffect(() => {
    if (focus) boxRef.current?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`${API}/youtube/cookies`, { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(errMsg(d, "No se pudo importar el archivo."));
        return;
      }
      setInfo(d);
    } catch (e2) {
      setErr(fetchErr(e2, "No se pudo importar el archivo."));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remove = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${API}/youtube/cookies`, { method: "DELETE" });
      if (!r.ok) throw new Error(String(r.status));
      await load();
    } catch (e) {
      setErr(fetchErr(e, "No se pudo quitar las cookies."));
    } finally {
      setBusy(false);
    }
  };

  const configured = Boolean(info?.configured);
  let state = "Comprobando…";
  if (info) {
    if (configured) {
      const fecha = fmtImportDate(info.imported_at);
      state = `Configuradas · ${info.count} ${
        info.count === 1 ? "cookie" : "cookies"
      }${fecha ? ` · ${fecha}` : ""}`;
    } else {
      state = "Sin configurar";
    }
  }

  return (
    <section
      className="store__cookies"
      ref={boxRef}
      aria-labelledby="ytcookies-title"
    >
      <div className="store__cookies-head">
        <h3 id="ytcookies-title" className="store__cookies-title">
          <Cookie size={16} weight="duotone" aria-hidden="true" />
          Cookies de YouTube
        </h3>
        <span className="store__cookies-state">{state}</span>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".txt,text/plain"
        className="store__file"
        onChange={onPick}
      />
      <div className="store__cookies-actions">
        <button
          type="button"
          className="vf"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          <UploadSimple size={15} aria-hidden="true" />
          {configured ? "Reemplazar cookies.txt" : "Importar cookies.txt"}
        </button>
        {configured && (
          <button type="button" className="vf" onClick={remove} disabled={busy}>
            <Trash size={15} aria-hidden="true" />
            Quitar
          </button>
        )}
      </div>
      <p className="store__note">
        Exporta un <code>cookies.txt</code> desde una ventana privada con sesión
        iniciada en YouTube. Solo se usa si YouTube pide verificar que no eres un
        bot. Usar tu cuenta tiene riesgo de bloqueo: conviene una cuenta
        secundaria.
      </p>
      {err && (
        <p className="store__err" role="alert">
          {err}
        </p>
      )}
    </section>
  );
}
