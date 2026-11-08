import "./shared/fonts.css";
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

createRoot(document.getElementById("root")).render(<App />);
