import Logo from "../shared/Logo.jsx";
import { useEngine } from "../player/useEngine.js";

/* El disco gira mientras suena algo (selector booleano: solo repinta al
   pausar o reanudar). `still` lo deja quieto aunque suene (oculto no gira). */
export default function BrandLogo({ still = false }) {
  const playing = useEngine((s) => s.playing);
  return <Logo spinning={playing && !still} />;
}
