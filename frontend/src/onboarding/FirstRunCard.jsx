import { useNav } from "../app/useNav.js";
import { dismissFirstRun, FALLBACK_FOLDER } from "./firstRun.js";
import "./firstRun.css";

/* Tarjeta de bienvenida de Inicio. Se trae en su propio chunk solo cuando va a
   pintarse. La lista es una <ol> de verdad: los numeros los pone CSS, no texto.
   Cada paso tiene su propia accion: la tarjeta no solo explica, tambien hace. */
export default function FirstRunCard({ folder }) {
  const nav = useNav();
  const place = folder || FALLBACK_FOLDER;
  const steps = [
    {
      title: "Busca tu canción",
      text: "Escribe el nombre y toca un resultado para escucharlo.",
      action: "Ir a Buscar",
      run: () => nav.goTab("search"),
    },
    {
      title: "Descarga en m4a",
      text: "Es el formato por defecto. Puedes cambiarlo en Ajustes › Descargas.",
      action: "Ver formato",
      run: () => nav.openSettings(),
    },
    {
      title: "Escucha sin conexión",
      text: `Todo queda en ${place}.`,
      action: "Cambiar carpeta",
      run: () => nav.openSettings("storage"),
    },
  ];
  return (
    <section className="fr" aria-labelledby="fr-title">
      <h2 id="fr-title" className="fr__t">
        Así funciona spitifo
      </h2>
      <ol className="fr__ol" role="list">
        {steps.map((step) => (
          <li key={step.title} className="fr__li">
            <b>{step.title}</b>
            <span>{step.text}</span>
            <button type="button" className="fr__act" onClick={step.run}>
              {step.action}
            </button>
          </li>
        ))}
      </ol>
      <div className="fr__f">
        <p>Puedes volver a verlo en Ajustes</p>
        <button type="button" className="fr__btn" onClick={dismissFirstRun}>
          Entendido
        </button>
      </div>
    </section>
  );
}
