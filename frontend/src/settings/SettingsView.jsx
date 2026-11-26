import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./icons.jsx";
import { useNav } from "../app/useNav.js";
import { backToLabel } from "../app/crossMode.js";
import { usePc } from "../shared/viewport.js";
import { useTheme } from "../shared/theme.js";
import { useHaptics } from "../shared/haptics.js";
import { APP_VERSION } from "../shared/appVersion.js";
import { useAutoDownload } from "./autoDownload.js";
import { FORMATS, MEDIA_OPTIONS, ORIGINAL_HINT } from "../download/constants.js";
import {
  QUALITY_OPTIONS, formatForQuality, qualityHint, useDownloadFormat,
  useDownloadMedia, useDownloadQuality, useDownloadRoaming, useDownloadWifiOnly,
} from "./downloadPrefs.js";
import { requestFirstRun } from "../onboarding/firstRun.js";
import { collapsedSetting, titleBarSetting } from "../app/desktop.js";
import { installedLabel, newerLabel, useReleaseCheck } from "./releaseCheck.js";
import StorageSettings from "./StorageSettings.jsx";
import YouTubeCookies from "./YouTubeCookies.jsx";
import "./settings.css";
import "../shared/chips.css";

/* "Buscar portadas" va en su propio chunk: solo se baja al tocar el boton. */
const CoverFinder = lazy(() => import("./CoverFinder.jsx"));

const THEME_OPTIONS = [
  { id: "light", label: "Claro" },
  { id: "dark", label: "Oscuro" },
];

const NAV_OPTIONS = [
  { id: "tabs", label: "Pestañas" },
  { id: "swipe", label: "Páginas deslizables" },
];

const YES_NO = [
  { id: "no", label: "No" },
  { id: "yes", label: "Sí" },
];

/* Solo confirmaciones discretas: se puede apagar entero (Decisión 3). */
const ON_OFF = [
  { id: true, label: "Activadas" },
  { id: false, label: "Desactivadas" },
];

/* Las mismas opciones que habia en la cabecera de Buscar, ahora aqui. El valor
   que viaja al backend sigue siendo el `value` / `id`, sin traducir. */
const FMT_OPTIONS = FORMATS.map((f) => ({ id: f.value, label: f.label, title: f.title }));

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
function SwitchRow({ label, note, checked, onChange }) {
  return (
    <div className="settings__row settings__switch-row">
      <div>
        <p className="settings__label">{label}</p>
        <p className="settings__note">{note}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`settings__switch ${checked ? "is-on" : ""}`}
        onClick={() => {
          onChange(!checked);
          window.dispatchEvent(new Event("spitifo-network"));
        }}
      >
        <span />
      </button>
    </div>
  );
}

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
  const guideRef = useRef(null);
  const guideHeadRef = useRef(null);
  const coversHeadRef = useRef(null);
  const [theme, chooseTheme] = useTheme();
  const [hapticsOn, setHaptics] = useHaptics();
  const [autoDownload, setAutoDownload] = useAutoDownload();
  const [fmt, setFmt] = useDownloadFormat();
  const [media, setMedia] = useDownloadMedia();
  const [quality, setQuality] = useDownloadQuality();
  const [wifiOnly, setWifiOnly] = useDownloadWifiOnly();
  const [roaming, setRoaming] = useDownloadRoaming();
  const nav = useNav();
  const pc = usePc();
  const railCollapsed = useSyncExternalStore(collapsedSetting.subscribe, collapsedSetting.get);
  const customTitleBar = useSyncExternalStore(titleBarSetting.subscribe, titleBarSetting.get);
  const [finder, setFinder] = useState(false);
  const coversSaved = useRef(false);
  const release = useReleaseCheck();

  /* Al salir de "Buscar portadas" (por su boton o porque se dejo Ajustes) la
     biblioteca se vuelve a pedir si se guardo algo, para ver las portadas. */
  const closeFinder = useCallback(() => {
    setFinder(false);
    if (coversSaved.current) {
      coversSaved.current = false;
      onChanged?.();
    }
  }, [onChanged]);

  useEffect(() => {
    if (!active && finder) closeFinder();
  }, [active, finder, closeFinder]);

  const wasFinder = useRef(false);
  useEffect(() => {
    if (wasFinder.current && !finder) coversHeadRef.current?.focus({ preventScroll: false });
    wasFinder.current = finder;
  }, [finder]);

  /* Al abrir Ajustes con un destino (el aviso de cookies o el boton de la
     biblioteca) se trae esa seccion y se deja el foco en su titulo, para que
     el teclado y el lector de pantalla arranquen donde importa. */
  useEffect(() => {
    if (!active || !focus) return;
    const target =
      focus === "cookies"
        ? { box: cookiesRef, head: cookiesHeadRef }
        : focus === "guide"
          ? { box: guideRef, head: guideHeadRef }
          : { box: storageRef, head: storageHeadRef };
    if (!target.box.current) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.box.current.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    target.head.current?.focus({ preventScroll: true });
  }, [active, focus]);

  if (finder) {
    return (
      <Suspense fallback={<div className="settings" aria-busy="true" />}>
        <CoverFinder onClose={closeFinder} onSaved={() => (coversSaved.current = true)} />
      </Suspense>
    );
  }

  return (
    <div className="settings">
      <header className="settings__head">
        <button
          type="button"
          className="settings__back cbtn cbtn--soft cbtn--l"
          aria-label={backToLabel(nav)}
          title={backToLabel(nav)}
          onClick={onClose}
        >
          <Icon name="CaretLeft" size="md" />
        </button>
        <h1 className="settings__title">Ajustes</h1>
      </header>

      <section className="settings__sec" ref={storageRef} aria-labelledby="settings-storage">
        <h2 id="settings-storage" ref={storageHeadRef} tabIndex={-1} className="settings__h">
          Almacenamiento
        </h2>
        <StorageSettings active={active} onChanged={onChanged} />
      </section>

      <section className="settings__sec" aria-labelledby="settings-covers">
        <h2 id="settings-covers" ref={coversHeadRef} tabIndex={-1} className="settings__h">
          Portadas
        </h2>
        <div className="settings__card">
          <p className="settings__note settings__note--lead">
            Los temas que bajaste antes de que spitifo guardara portadas no tienen una. Puedes
            buscarlas en iTunes y elegir cuál va en cada tema. Nada se guarda sin tu confirmación.
          </p>
          <div className="settings__ckacts">
            <button
              type="button"
              className="settings__btn settings__btn--acc"
              onClick={() => setFinder(true)}
              onPointerEnter={() => import("./CoverFinder.jsx")}
            >
              Buscar portadas
            </button>
          </div>
        </div>
      </section>

      <section className="settings__sec" ref={cookiesRef} aria-labelledby="settings-cookies">
        <h2 id="settings-cookies" ref={cookiesHeadRef} tabIndex={-1} className="settings__h">
          Cookies de YouTube
        </h2>
        <YouTubeCookies focus={focus === "cookies" && active} />
      </section>

      <section className="settings__sec" aria-labelledby="settings-library">
        <h2 id="settings-library" className="settings__h">
          Biblioteca
        </h2>
        <div className="settings__card">
          <div className="settings__row settings__switch-row">
            <div>
              <p className="settings__label">Descargar todo lo que guardo</p>
              <p className="settings__note">
                Al guardar una canción también se bajará a este dispositivo. Lo que ya esté descargado no se vuelve a bajar.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoDownload}
              aria-label="Descargar todo lo que guardo"
              className={`settings__switch ${autoDownload ? "is-on" : ""}`}
              onClick={() => setAutoDownload(!autoDownload)}
            >
              <span />
            </button>
          </div>
        </div>
      </section>

      <section className="settings__sec" aria-labelledby="settings-downloads">
        <h2 id="settings-downloads" className="settings__h">
          Descargas
        </h2>
        <div className="settings__card">
          <div className="settings__row">
            <p className="settings__label">Calidad</p>
            <ChipRadio
              label="Calidad de descarga"
              options={QUALITY_OPTIONS}
              value={quality}
              onPick={(q) => {
                setQuality(q);
                setFmt(formatForQuality(q));
              }}
            />
            <p className="settings__note">
              {qualityHint(quality, { video: media !== "audio" })}. El tamaño real depende del tema.
            </p>
          </div>
          <div className="settings__row">
            <p className="settings__label">Formato</p>
            <ChipRadio label="Formato de descarga" options={FMT_OPTIONS} value={fmt} onPick={setFmt} />
            <p className="settings__note">
              Cómo se guarda el audio al bajar una canción. También puedes cambiarlo al descargar desde el menú ⋯.
            </p>
            {fmt === "mp3" && (
              <p className="settings__note" role="note">
                MP3 recodifica en el teléfono: un álbum de 15 tarda varios minutos más que «original».
              </p>
            )}
            {fmt === "original" && media === "audio" && <p className="settings__note">{ORIGINAL_HINT}</p>}
          </div>
          <div className="settings__row">
            <p className="settings__label">Contenido de YouTube</p>
            <ChipRadio label="Contenido de YouTube" options={MEDIA_OPTIONS} value={media} onPick={setMedia} />
            <p className="settings__note">
              Qué se baja cuando buscas en YouTube: solo el audio, solo el vídeo o las dos cosas.
            </p>
          </div>
          <SwitchRow
            label="Descargar solo con Wi-Fi"
            note="En datos móviles la descarga espera y dice «Esperando Wi-Fi»."
            checked={wifiOnly}
            onChange={setWifiOnly}
          />
          <SwitchRow
            label="Permitir descargas en roaming"
            note="Si lo apagas, no se descarga con datos del exterior."
            checked={roaming}
            onChange={setRoaming}
          />
          <p className="settings__note">
            Los cambios del índice se agrupan: una versión antigua puede ver la biblioteca hasta 5 minutos atrasada.
          </p>
        </div>
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
          {/* Solas en el escritorio: son preferencias de la persona, no
              detalles de implementación, y se guardan como el tema. */}
          {pc && (
            <>
              <div className="settings__row">
                <p className="settings__label">Riel colapsado</p>
                <ChipRadio
                  label="Riel colapsado"
                  options={YES_NO}
                  value={railCollapsed ? "yes" : "no"}
                  onPick={(v) => collapsedSetting.set(v === "yes")}
                />
                <p className="settings__note">Solo iconos. También se cambia con Ctrl+\.</p>
              </div>
              <div className="settings__row">
                <p className="settings__label">Barra de título propia</p>
                <ChipRadio
                  label="Barra de título propia"
                  options={YES_NO}
                  value={customTitleBar ? "yes" : "no"}
                  onPick={(v) => titleBarSetting.set(v === "yes")}
                />
                <p className="settings__note">Solo Windows. Requiere reiniciar la ventana.</p>
              </div>
            </>
          )}
          {/* Solo vibraciones de confirmacion: corazon, hoja o fila que encaja,
              descarga terminada y el detente del progreso. Se apaga entero. */}
          <div className="settings__row">
            <p className="settings__label">Vibraciones</p>
            <ChipRadio label="Vibraciones" options={ON_OFF} value={hapticsOn} onPick={setHaptics} />
            <p className="settings__note">Solo confirmaciones, en el teléfono.</p>
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

      <section className="settings__sec" ref={guideRef} aria-labelledby="settings-guide">
        <h2 id="settings-guide" ref={guideHeadRef} tabIndex={-1} className="settings__h">
          Guía
        </h2>
        <div className="settings__card">
          <button
            type="button"
            className="settings__act"
            onClick={() => {
              requestFirstRun();
              nav.goTab("home");
            }}
          >
            Ver cómo funciona spitifo
          </button>
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

      <section className="settings__sec" aria-labelledby="settings-about">
        <h2 id="settings-about" className="settings__h">
          Acerca de la app
        </h2>
        <div className="settings__card">
          <div className="settings__about">
            <Icon name="GearSix" size="md" />
            <div className="settings__aboutinfo">
              <p className="settings__label">{installedLabel(APP_VERSION)}</p>
              {release.state === "current" && (
                <p className="settings__aboutok">
                  <Icon name="CheckCircle" size="sm" />
                  Tienes la última versión
                </p>
              )}
            </div>
            <button
              type="button"
              className="settings__btn settings__btn--ghost"
              onClick={() => release.check(true)}
              disabled={release.checking}
            >
              {release.checking ? "Buscando…" : "Buscar actualizaciones"}
            </button>
          </div>
          {release.state === "newer" && (
            <div className="settings__update">
              <Icon name="ArrowCircleUp" size="md" />
              <div className="settings__updateinfo">
                <p className="settings__updatetitle">{newerLabel(release.latest)}</p>
                <p className="settings__updatesub">{installedLabel(APP_VERSION)} instalada</p>
              </div>
              <a
                className="settings__btn settings__btn--ghost"
                href={release.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="ArrowSquareOut" size="sm" />
                Ver
              </a>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
