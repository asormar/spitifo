import { Icon } from "../shared/icons.jsx";
import { useNav } from "./useNav.js";

/* ---------------------------------------------------------------------------
   BOTONES FIJOS DE NAVEGACION (fase 14)

   El engranaje y la guia estan al alcance en las cuatro pestanas del telefono:
   antes solo se podia abrir Ajustes desde Inicio. En PC los pone el riel y la
   barra de arriba; aqui se montan en la cabecera de cada pantalla.
   ------------------------------------------------------------------------- */

export function GuideButton({ className = "cbtn" }) {
  const nav = useNav();
  return (
    <button
      type="button"
      className={className}
      aria-label="Guía de navegación"
      title="Guía de navegación"
      onClick={() => nav.openSettings("guide")}
    >
      <Icon name="Question" size="lg" />
    </button>
  );
}

export function SettingsButton({ className = "cbtn" }) {
  const nav = useNav();
  const open = nav.settings !== null;
  return (
    <button
      type="button"
      className={className}
      aria-label="Ajustes"
      title="Ajustes"
      aria-pressed={open}
      onClick={nav.toggleSettings}
    >
      <Icon name="GearSix" weight={open ? "fill" : "regular"} size="lg" />
    </button>
  );
}

export default function ChromeButtons({ className = "chrome-btns" }) {
  return (
    <span className={className}>
      <GuideButton />
      <SettingsButton />
    </span>
  );
}
