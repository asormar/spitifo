import { EXAMPLES } from "./constants.js";
import GenreTiles from "./GenreTiles.jsx";
import Recent from "./Recent.jsx";

/* ---------------------------------------------------------------------------
   BUSCAR EN REPOSO

   Lo que se ve antes de buscar: ejemplos para empezar, una nota de donde sale
   cada cosa, atajos por genero y lo ultimo que se descargo.
   ------------------------------------------------------------------------- */

export default function Idle({ files, active, onExample, onOpenLibrary }) {
  return (
    <>
      <section className="try" aria-labelledby="try-h">
        <h2 className="sh2" id="try-h">
          Prueba con alguno de estos
        </h2>
        <ul className="try__list">
          {EXAMPLES.map((ex, i) => (
            <li key={ex} style={{ "--i": i }}>
              <button type="button" className="chip" onClick={() => onExample(ex)}>
                {ex}
              </button>
            </li>
          ))}
        </ul>
        <p className="fine">
          Internet Archive y Wikimedia liberan los archivos. iTunes sirve para encontrar la ficha y la
          portada. De YouTube sale el audio completo del tema.
        </p>
      </section>
      <GenreTiles active={active} empty={files.length === 0} />
      <Recent files={files} onOpen={onOpenLibrary} />
    </>
  );
}
