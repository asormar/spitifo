import { useState } from "react";
import { useNav } from "../app/useNav.js";
import { engine } from "../player/engine.js";
import { requestSearch } from "../download/searchRequest.js";
import { STARTER_GENRE } from "../shared/starters.js";
import { useListen } from "./ListenProvider.jsx";
import { starterExamples } from "./starter.js";

/* ---------------------------------------------------------------------------
   EMPIEZA A ESCUCHAR

   Con la biblioteca vacia Inicio no tiene nada que tocar: aqui se ofrece una
   muestra que suena al instante y, debajo, las consultas que Buscar ya conoce.
   La muestra se pide bajo demanda para no cargar Descubrir en el arranque.
   ------------------------------------------------------------------------- */

export default function StarterStep() {
  const nav = useNav();
  const { ctx } = useListen();
  const [busy, setBusy] = useState(false);

  const playSample = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { fetchSamples } = await import("../discover/samples.js");
      const tracks = await fetchSamples(STARTER_GENRE);
      if (!tracks.length) ctx.show("No hay muestras ahora. Prueba con una búsqueda.");
      else engine.play(tracks[0], { queue: tracks, index: 0, restart: true });
    } catch {
      ctx.show("No se pudo cargar la muestra. Prueba con una búsqueda.");
    } finally {
      setBusy(false);
    }
  };

  const search = (query) => () => {
    requestSearch(query);
    nav.goTab("search");
  };

  return (
    <section className="start" aria-labelledby="start-h">
      <h2 id="start-h" className="start__t">
        Empieza a escuchar
      </h2>
      <p className="start__note">Tu biblioteca está vacía, pero puedes probar ahora.</p>
      <button
        type="button"
        className="start__play"
        onClick={playSample}
        disabled={busy}
        aria-busy={busy || undefined}
      >
        {busy ? "Buscando…" : "Escuchar una muestra"}
      </button>
      <p className="start__note">Muestras de 30 s de {STARTER_GENRE}.</p>
      <p className="start__label">O busca tu primera canción</p>
      <ul className="start__list">
        {starterExamples(3).map((example) => (
          <li key={example}>
            <button type="button" className="start__chip" onClick={search(example)}>
              {example}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
