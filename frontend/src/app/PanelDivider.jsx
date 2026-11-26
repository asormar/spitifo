import { useRef, useSyncExternalStore } from "react";
import { clampPanel, panelSetting } from "./desktop.js";

/* ---------------------------------------------------------------------------
   DIVISOR DE LA COLUMNA DE "AHORA SUENA"

   Vive en el shell, no en el reproductor: el panel es fijo y su ancho es una
   variable (--np-w), asi que el asa no necesita tocar player/. Con el panel
   flotando o ampliado no se pinta.
   ------------------------------------------------------------------------- */

export default function PanelDivider({ active }) {
  const dragging = useRef(false);
  const start = useRef({ x: 0, w: 340 });
  const width = useSyncExternalStore(panelSetting.subscribe, panelSetting.get);
  if (!active) return null;

  const end = () => {
    dragging.current = false;
    document.body.classList.remove("np-resizing");
  };

  return (
    <div
      className="np-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Redimensionar el panel de Ahora suena"
      aria-valuemin={280}
      aria-valuemax={520}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e) => {
        dragging.current = true;
        start.current = { x: e.clientX, w: width };
        document.body.classList.add("np-resizing");
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (dragging.current) panelSetting.set(clampPanel(start.current.w - (e.clientX - start.current.x)));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") panelSetting.set(clampPanel(panelSetting.get() + 12));
        else if (e.key === "ArrowRight") panelSetting.set(clampPanel(panelSetting.get() - 12));
        else return;
        e.preventDefault();
      }}
    >
      <span className="np-divider__grip" aria-hidden="true" />
    </div>
  );
}
