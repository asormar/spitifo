import Logo from "../shared/Logo.jsx";
import { useEngine } from "../player/useEngine.js";

/* El disco gira mientras suena algo (selector booleano: solo repinta al
   pausar o reanudar). */
export default function BrandLogo() {
  return <Logo spinning={useEngine((s) => s.playing)} />;
}
