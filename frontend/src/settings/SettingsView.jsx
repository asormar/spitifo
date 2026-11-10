import { useEffect, useRef } from "react";
import Ico from "../shared/ico.jsx";
import { usePc } from "../shared/viewport.js";
import { useTheme } from "../shared/theme.js";
import StorageSettings from "./StorageSettings.jsx";
import YouTubeCookies from "./YouTubeCookies.jsx";
import "./settings.css";
import "../shared/chips.css";

const THEME_OPTIONS = [
  { id: "light", label: "Claro" },
  { id: "dark", label: "Oscuro" },
];

const NAV_OPTIONS = [
  { id: "tabs", label: "Pestañas" },
  { id: "swipe", label: "Páginas deslizables" },
];

/* De donde sale lo que muestra Descubrir y con que licencia. */
const DATA_SOURCES = [
  [
    "MusicBrainz",
    "La lista de géneros es CC0. Los géneros de cada artista son CC BY-NC-SA y se guardan en este dispositivo.",
  ],
  ["Wikidata", "Las relaciones entre géneros del mapa vienen de Wikidata (CC0)."],
  ["ListenBrainz", "Los artistas similares que se recomiendan."],
];

/* Un grupo de chips que funciona como radio: uno activo, y el tabindex entra
   solo por el elegido. */
function ChipRadio({ label, options, value, onPick }) {
  return (
    <div className="chips" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          tabIndex={value === option.id ? 0 : -1}
          className={`chip ${value === option.id ? "is-on" : ""}`}
          onClick={() => onPick(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* Ajustes es una pantalla del shell, no un modal: se abre desde el menu lateral o la
   cabecera de Inicio y el boton atras del telefono la cierra (App escucha popstate).
   Es UNA pagina de secciones (h1 + cuatro h2), no subpaginas: los destinos de
   `focus` son un scrollIntoView con el foco en el titulo. */
export default function SettingsView({ active, focus, onClose, onChanged, phoneNav, onPhoneNav }) {
  const storageRef = useRef(null);
  const storageHeadRef = useRef(null);
  const cookiesRef = useRef(null);
  const cookiesHeadRef = useRef(null);
  const [theme, chooseTheme] = useTheme();
  const pc = usePc();

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
        <button type="button" className="settings__back cbtn cbtn--soft cbtn--l" aria-label="Volver" onClick={onClose}>
          <Ico n="back" size={20} sw={2.2} />
        </button>
        <h1 className="settings__title">Ajustes</h1>
      </header>

      <section className="settings__sec" ref={storageRef} aria-labelledby="settings-storage">
        <h2 id="settings-storage" ref={storageHeadRef} tabIndex={-1} className="settings__h">
          Almacenamiento
        </h2>
        <StorageSettings active={active} onChanged={onChanged} />
      </section>

      <section className="settings__sec" ref={cookiesRef} aria-labelledby="settings-cookies">
        <h2 id="settings-cookies" ref={cookiesHeadRef} tabIndex={-1} className="settings__h">
          Cookies de YouTube
        </h2>
        <YouTubeCookies focus={focus === "cookies" && active} />
      </section>

      <section className="settings__sec" aria-labelledby="settings-interface">
        <h2 id="settings-interface" className="settings__h">
          Interfaz
        </h2>
        <div className="settings__card">
          <div className="settings__row">
            <p className="settings__label">Tema</p>
            <ChipRadio label="Tema" options={THEME_OPTIONS} value={theme} onPick={chooseTheme} />
          </div>
          {/* Solo en el telefono: en el escritorio la navegacion es el menu
              lateral y la barra de arriba. El ajuste se guarda igual. */}
          {!pc && (
            <div className="settings__row">
              <p className="settings__label">Navegación en el teléfono</p>
              <ChipRadio
                label="Navegación en el teléfono"
                options={NAV_OPTIONS}
                value={phoneNav}
                onPick={onPhoneNav}
              />
              <p className="settings__note">Solo en teléfonos. Se guarda en este dispositivo.</p>
            </div>
          )}
        </div>
      </section>

      <section className="settings__sec" aria-labelledby="settings-data">
        <h2 id="settings-data" className="settings__h">
          Acerca de los datos
        </h2>
        {DATA_SOURCES.map(([name, note]) => (
          <div key={name} className="settings__src">
            <b>{name}</b>
            <span>{note}</span>
          </div>
        ))}
        <p className="settings__note">
          Las recomendaciones se calculan en este dispositivo. Solo los nombres de los artistas se
          envían a MusicBrainz y ListenBrainz; tu historial de escucha no sale de aquí.
        </p>
      </section>
    </div>
  );
}
