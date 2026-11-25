import { dismissFirstRun } from "./firstRun.js";
import "./firstRun.css";

/* Tarjeta de bienvenida de Inicio. Se trae en su propio chunk solo cuando va a
   pintarse. La lista es una <ol> de verdad: los numeros los pone CSS, no texto. */
export default function FirstRunCard({ folder }) {
  const steps = [
    ["Inicio", "Lo que escuchas. El engranaje abre Ajustes desde cualquier pestaña."],
    ["Buscar", "Encuentra y descarga. La búsqueda se guarda en la dirección de la página."],
    ["Tu biblioteca", "Tus archivos, álbumes y listas. Las listas siempre viven aquí."],
    ["Descubrir", "Géneros y artistas. Desliza para cambiar de pestaña si lo prefieres."],
  ];
  return (
    <section className="fr" aria-labelledby="fr-title">
      <h2 id="fr-title" className="fr__t">
        Así funciona Spitifo
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
