import { dismissFirstRun, FALLBACK_FOLDER } from "./firstRun.js";
import "./firstRun.css";

/* Tarjeta de bienvenida de Inicio. Se trae en su propio chunk solo cuando va a
   pintarse. La lista es una <ol> de verdad: los numeros los pone CSS, no texto. */
export default function FirstRunCard({ folder }) {
  const place = folder || FALLBACK_FOLDER;
  const steps = [
    [
      "Encuentra tu música",
      "«Música» busca en el catálogo y encuentra la canción completa. Si no está, te ofrece otras fuentes.",
    ],
    [
      "Toca y suena",
      "La canción empieza al momento. Con el corazón la guardas en tu biblioteca.",
    ],
    [
      "Descarga para escuchar sin conexión",
      `Canciones sueltas, discos enteros o la discografía de un artista. Todo queda en ${place}; puedes cambiarlo en Ajustes.`,
    ],
  ];
  return (
    <section className="fr" aria-labelledby="fr-title">
      <h2 id="fr-title" className="fr__t">
        Así funciona spitifo
      </h2>
      <ol className="fr__ol" role="list">
        {steps.map(([title, text]) => (
          <li key={title} className="fr__li">
            <b>{title}</b>
            <span>{text}</span>
          </li>
        ))}
      </ol>
      <div className="fr__f">
        <p>⋯ abre más acciones y «Volver» cierra un paso. El «?» de la barra te trae esta guía.</p>
        <button type="button" className="fr__btn" onClick={dismissFirstRun}>
          Entendido
        </button>
      </div>
    </section>
  );
}
