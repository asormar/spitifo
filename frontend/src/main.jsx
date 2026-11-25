import "./shared/fonts.css";
import unboundedLatin from "@fontsource-variable/unbounded/files/unbounded-latin-wght-normal.woff2?url";
import { createRoot } from "react-dom/client";
import App from "./app/App.jsx";
import "./shared/tokens.css";
import "./app/base.css";
import "./app/nav.css";
import "./download/progress.css";
import "./listen/listen.css";
import "./player/player.css";
import "./player/video.css";
import "./shared/controls.css";
import "./shared/motion.css";
/* Ultimo: el shell ajusta offsets de piezas que viven en otras hojas. */
import "./app/shell.css";

document.title = "Spitifo: descarga contenido libre";

/* Preload de la cara latina de la fuente de display: Vite resuelve la URL
   con su hash, asi que no hay que acertar el nombre del asset a mano. Se
   pide antes de montar React para que no espere al parseo del entry. */
const preload = document.createElement("link");
preload.rel = "preload";
preload.as = "font";
preload.type = "font/woff2";
preload.crossOrigin = "";
preload.href = unboundedLatin;
document.head.appendChild(preload);

createRoot(document.getElementById("root")).render(<App />);
