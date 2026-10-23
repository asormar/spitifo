import "@fontsource-variable/outfit";
import "@fontsource-variable/figtree";
import { createRoot } from "react-dom/client";
import App from "./app/App.jsx";
import "./shared/tokens.css";
import "./app/base.css";
import "./app/nav.css";
import "./download/search.css";
import "./download/progress.css";
import "./player/library.css";
import "./player/player.css";
import "./player/video.css";
import "./download/results.css";
import "./download/cards.css";
import "./shared/motion.css";
import "./settings/storage.css";
import "./download/resolution-menu.css";
/* Ultimo: el shell ajusta offsets de piezas que viven en otras hojas. */
import "./app/shell.css";

document.title = "Spitifo: descarga contenido libre";

createRoot(document.getElementById("root")).render(<App />);
