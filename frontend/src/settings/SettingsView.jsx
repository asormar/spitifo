import { useEffect, useRef } from "react";
import { CaretLeft } from "@phosphor-icons/react";
import { useSlidingPill } from "../shared/ui.jsx";
import StorageSettings from "./StorageSettings.jsx";
import YouTubeCookies from "./YouTubeCookies.jsx";

const NAV_OPTIONS = [
  { id: "tabs", label: "Pestañas" },
  { id: "swipe", label: "Páginas deslizables" },
];

/* Ajustes es una pantalla del shell, no un modal: se abre desde el riel o la
   cabecera y el boton atras del telefono la cierra (App escucha popstate). */
export default function SettingsView({ active, focus, onClose, onChanged, phoneNav, onPhoneNav }) {
  const storageRef = useRef(null);
  const storageHeadRef = useRef(null);
  const cookiesRef = useRef(null);
  const cookiesHeadRef = useRef(null);
  const segsRef = useRef(null);
  useSlidingPill(segsRef, phoneNav);

  /* Al abrir Ajustes con un destino (el aviso de cookies o el boton de la
     biblioteca) se trae esa seccion y se deja el foco en su titulo, para que
     el teclado y el lector de pantalla arranquen donde importa. */
  useEffect(() => {
    if (!active || !focus) return;
    const target =
      focus === "cookies"
        ? { box: cookiesRef, head: cookiesHeadRef }
        : { box: storageRef, head: storageHeadRef };
    if (!target.box.current) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.box.current.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    target.head.current?.focus({ preventScroll: true });
  }, [active, focus]);

  return (
    <div className="settings">
      <header className="settings__head">
        <button type="button" className="settings__back" aria-label="Volver" onClick={onClose}>
          <CaretLeft size={20} />
        </button>
        <h1 className="settings__title">Ajustes</h1>
      </header>

      <section className="settings__card" ref={storageRef} aria-labelledby="settings-storage">
        <h2 id="settings-storage" ref={storageHeadRef} tabIndex={-1} className="settings__h">
          Almacenamiento
        </h2>
        <StorageSettings active={active} onChanged={onChanged} />
      </section>

      <section className="settings__card" ref={cookiesRef} aria-labelledby="settings-youtube">
        <h2 id="settings-youtube" ref={cookiesHeadRef} tabIndex={-1} className="settings__h">
          YouTube
        </h2>
        <YouTubeCookies focus={focus === "cookies" && active} />
      </section>

      <section className="settings__card" aria-labelledby="settings-interface">
        <h2 id="settings-interface" className="settings__h">
          Interfaz
        </h2>
        <div className="settings__row">
          <div>
            <p className="settings__label">Navegación en el teléfono</p>
            <p className="settings__note">Solo en teléfonos. Se guarda en este dispositivo.</p>
          </div>
          <div
            ref={segsRef}
            className="segs settings__segs"
            role="radiogroup"
            aria-label="Navegación en el teléfono"
          >
            {NAV_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={phoneNav === option.id}
                tabIndex={phoneNav === option.id ? 0 : -1}
                className={`seg ${phoneNav === option.id ? "is-on" : ""}`}
                onClick={() => onPhoneNav(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
