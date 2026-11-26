import { Icon } from "./icons.jsx";
import {
  CROSSFADE_MAX, QUALITY_OPTIONS, crossfadeLabel, useAutoSaver,
  useCrossfade, useQuality,
} from "./playbackSettings.js";
import "./playback.css";

/* ---------------------------------------------------------------------------
   REPRODUCCIÓN Y DATOS

   La calidad y el ahorro son decisiones (cobalto), nunca sonido: el único rosa
   de esta pantalla no aparece, porque aquí no se reproduce nada. El crossfade
   también es cobalto por la misma razón. El motor leerá el paso guardado en su
   propia fase; esta vista solo lo elige y lo conserva.
   ------------------------------------------------------------------------- */

export default function PlaybackSettings() {
  const [quality, setQuality] = useQuality();
  const [automatic, setAutomatic] = useAutoSaver();
  const [step, setStep] = useCrossfade();

  return (
    <div className="pb">
      <div className="pb__group" role="radiogroup" aria-label="Calidad de transmisión">
        <p className="settings__label">Calidad de transmisión</p>
        {QUALITY_OPTIONS.map((option) => {
          const selected = quality === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              className={selected ? "pb__q is-sel" : "pb__q"}
              onClick={() => setQuality(option.id)}
            >
              <span className="pb__dot" aria-hidden="true" />
              <span className="pb__tx">
                <b>{option.label}</b>
                <small>{option.sub}</small>
              </span>
              <span className="pb__mb">{option.mb}</span>
            </button>
          );
        })}
        <p className="settings__note">MB estimados para una canción de 3:30 al transmitir. Lo que ya bajaste no cambia.</p>
      </div>

      <div className="pb__row">
        <span className="pb__ic"><Icon name="WifiSlash" size="md" /></span>
        <div className="pb__tx">
          <p className="settings__label">Ahorro de datos automático</p>
          <p className="settings__note">
            Usa «Ahorro de datos» en itinerancia o sin Wi-Fi; vuelve a tu nivel al reconectarte.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={automatic}
          aria-label="Activar ahorro automático"
          className={`settings__switch ${automatic ? "is-on" : ""}`}
          onClick={() => setAutomatic(!automatic)}
        >
          <span />
        </button>
      </div>

      <div className="pb__group">
        <p className="settings__label">Reproducción</p>
        <div className="pb__xfade">
          <div className="pb__xfade-head">
            Crossfade <span className="pb__xfade-val">{crossfadeLabel(step)}</span>
          </div>
          <input
            type="range"
            className="pb__xfade-range"
            min="0"
            max={CROSSFADE_MAX}
            step="1"
            value={step}
            aria-label="Duración del crossfade"
            onChange={(e) => setStep(Number(e.target.value))}
          />
          <div className="pb__ticks"><span>Apagado</span><span>2 s</span><span>12 s</span></div>
          <p className="settings__note">
            Funde el final de una canción con el principio de la siguiente. En «Apagado», las
            canciones simplemente empiezan y terminan limpias.
          </p>
        </div>
        <div className="pb__row pb__row--always">
          <span className="pb__ic pb__ic--ok"><Icon name="Check" size="md" /></span>
          <div className="pb__tx">
            <p className="settings__label">Reproducción sin cortes</p>
            <p className="settings__note">
              Siempre activa: no hay silencio entre canciones del mismo álbum o lista.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
