import Sheet, { SheetBar } from "../shared/Sheet.jsx";

/* ---------------------------------------------------------------------------
   CHULETA DE ATAJOS («?»)

   La hoja que falta en el shell: se abre con ? o con el boton del buscador de
   la barra de arriba. No es una pagina ni una entrada del historial; al cerrar
   devuelve el foco a quien la abrio (lo hace Sheet).
   ------------------------------------------------------------------------- */

const ROWS = [
  ["Reproducir / pausar", ["Espacio"]],
  ["Retroceder / avanzar 10 s", ["←", "→"]],
  ["Pista anterior / siguiente", ["Ctrl", "←/→"]],
  ["Silenciar", ["M"]],
  ["Alternar el riel", ["Ctrl", "\\"]],
  ["Alternar el panel", ["Ctrl", "Shift", "P"]],
  ["Menú de la fila enfocada", ["Shift", "F10"]],
  ["Buscar", ["/", "Ctrl K"]],
  ["Seleccionar filas", ["Ctrl", "clic"]],
  ["Elegir un rango", ["Shift", "clic"]],
  ["Cerrar / volver", ["Esc"]],
  ["Esta hoja", ["?"]],
];

export default function ShortcutsSheet({ onClose }) {
  return (
    <Sheet title="Atajos de teclado" onClose={onClose}>
      <SheetBar title="Atajos de teclado" onClose={onClose} />
      <div className="kbd">
        <p className="kbd__note">Los atajos funcionan con el foco en la ventana. Las teclas multimedia siguen respondiendo aunque esté en segundo plano.</p>
        <div className="kbd__grid">
          {ROWS.map(([label, keys]) => (
            <div className="kbd__row" key={label}>
              <span>{label}</span>
              <span className="kbd__keys">
                {keys.map((k, i) => <kbd className="kbd__key" key={`${k}-${i}`}>{k}</kbd>)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
