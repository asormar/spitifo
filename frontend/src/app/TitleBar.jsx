import { useEffect, useSyncExternalStore } from "react";
import { Icon } from "../shared/icons.jsx";
import { titleBarSetting } from "./desktop.js";

/* ---------------------------------------------------------------------------
   BARRA DE TITULO PROPIA (opcional)

   Sale solo cuando la persona la activa en Ajustes. Sin el paquete JS de Tauri
   en el frontend se usa el invoke de bajo nivel que el runtime expone en
   window.__TAURI_INTERNALS__; en un navegador no hay nada y los botones no
   hacen nada (la barra tampoco se pinta, porque la preferencia es opt-in).
   `data-tauri-drag-region` va en una franja propia, nunca en los botones.
   ------------------------------------------------------------------------- */

const invoke = (cmd, args = {}) => {
  const fn = window.__TAURI_INTERNALS__?.invoke;
  if (typeof fn !== "function") return;
  try {
    const r = fn(cmd, { label: "main", ...args });
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch {
    /* Sin la ventana (navegador, o un runtime mas antiguo): boton inerte. */
  }
};

export default function TitleBar() {
  const on = useSyncExternalStore(titleBarSetting.subscribe, titleBarSetting.get);

  /* El marco nativo se quita/pone en el mismo gesto que el ajuste, sin tocar
     tauri.conf.json: asi el valor por defecto sigue siendo el marco de Windows. */
  useEffect(() => {
    invoke("plugin:window|set_decorations", { decorations: !on });
  }, [on]);

  if (!on) return null;
  return (
    <div className="wintitle">
      <span className="wintitle__brand" data-tauri-drag-region="">
        <span className="wintitle__disc" aria-hidden="true" />
        spitifo
      </span>
      <span className="wintitle__drag" data-tauri-drag-region="" aria-hidden="true" />
      <div className="wintitle__caps">
        <button type="button" className="wintitle__cap" aria-label="Minimizar" title="Minimizar" onClick={() => invoke("plugin:window|minimize")}>
          <Icon name="Minimize" size="sm" />
        </button>
        <button type="button" className="wintitle__cap" aria-label="Maximizar" title="Maximizar" onClick={() => invoke("plugin:window|toggle_maximize")}>
          <Icon name="Maximize" size="sm" />
        </button>
        <button type="button" className="wintitle__cap wintitle__cap--close" aria-label="Cerrar" title="Cerrar" onClick={() => invoke("plugin:window|close")}>
          <Icon name="X" size="sm" />
        </button>
      </div>
    </div>
  );
}
