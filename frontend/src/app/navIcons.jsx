/* Iconos de la navegacion: regular en reposo y fill en la pestana activa.
   Las rutas viven en shared/icons.jsx (solo esos dos pesos, ya que van en el
   script inicial); aqui solo se traduce el id de la pestana al icono. */
import { Icon } from "../shared/icons.jsx";

const NAV = {
  download: "DownloadSimple",
  listen: "Headphones",
  discover: "Sparkle",
  settings: "GearSix",
};

export function NavIcon({ name, filled = false, size = 22 }) {
  return <Icon name={NAV[name]} weight={filled ? "fill" : "regular"} size={size} />;
}
