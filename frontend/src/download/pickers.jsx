import { useRef } from "react";
import { useSlidingPill } from "../shared/ui.jsx";
import { FORMATS, MEDIA_OPTIONS, MODES } from "./constants.js";

/* Selector de formato. Son tres opciones cortas: un desplegable del sistema
   ocupa media pantalla para mostrar tres palabras, asi que va segmentado y a
   la vista, en la segunda fila del panel de busqueda, junto al modo. Radiogroup
   real, navegable con flechas (roving tabindex) y con el valor actual siempre
   visible. La etiqueta "Formato" es solo visual: el nombre accesible ya lo
   lleva el radiogroup. */
export function FmtPicker({ value, onChange }) {
  const refs = useRef([]);
  const segsRef = useRef(null);
  useSlidingPill(segsRef, value);
  const current = Math.max(
    0,
    FORMATS.findIndex((f) => f.value === value)
  );

  const move = (next) => {
    const i = (next + FORMATS.length) % FORMATS.length;
    onChange(FORMATS[i].value);
    refs.current[i]?.focus();
  };

  return (
    <div className="fmts">
      <span className="fmts__lbl" aria-hidden="true">
        Formato
      </span>
      <div
        ref={segsRef}
        className="segs"
        role="radiogroup"
        aria-label="Formato de descarga"
      >
        {FORMATS.map((f, i) => (
          <button
            key={f.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === f.value}
            tabIndex={value === f.value ? 0 : -1}
            title={f.title}
            className={`seg ${value === f.value ? "is-on" : ""}`}
            onClick={() => onChange(f.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(current + 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(current - 1);
              } else if (e.key === "Home") {
                e.preventDefault();
                move(0);
              } else if (e.key === "End") {
                e.preventDefault();
                move(FORMATS.length - 1);
              }
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}
/* Selector de que se baja de YouTube. Es el mismo componente visual que el de
   modo/formato y comparte rol, asi que comparte tambien el patron: radiogroup
   navegable con flechas y roving tabindex. Solo existe en modo YouTube. */
export function MediaPicker({ value, onChange }) {
  const refs = useRef([]);
  const segsRef = useRef(null);
  useSlidingPill(segsRef, value);
  const current = Math.max(
    0,
    MEDIA_OPTIONS.findIndex((m) => m.id === value)
  );

  const move = (next) => {
    const i = (next + MEDIA_OPTIONS.length) % MEDIA_OPTIONS.length;
    onChange(MEDIA_OPTIONS[i].id);
    refs.current[i]?.focus();
  };

  return (
    <div className="fmts">
      <span className="fmts__lbl" aria-hidden="true">
        Contenido
      </span>
      <div
        ref={segsRef}
        className="segs"
        role="radiogroup"
        aria-label="Qué se descarga de YouTube"
      >
        {MEDIA_OPTIONS.map((m, i) => (
          <button
            key={m.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === m.id}
            tabIndex={value === m.id ? 0 : -1}
            className={`seg ${value === m.id ? "is-on" : ""}`}
            onClick={() => onChange(m.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(current + 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(current - 1);
              } else if (e.key === "Home") {
                e.preventDefault();
                move(0);
              } else if (e.key === "End") {
                e.preventDefault();
                move(MEDIA_OPTIONS.length - 1);
              }
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
/* El selector de modo es el mismo componente visual que el de formato (.seg) y
   comparte rol, asi que comparte tambien el patron: radiogroup navegable con
   flechas y roving tabindex. Sin esto el patron ARIA prometia flechas que no
   existian, y el teclado necesitaba tres tab stops para recorrer tres modos. */
export function ModePicker({ value, onChange, ytDead }) {
  const refs = useRef([]);
  const segsRef = useRef(null);
  useSlidingPill(segsRef, value);
  const current = Math.max(
    0,
    MODES.findIndex((m) => m.id === value)
  );

  const move = (next) => {
    const i = (next + MODES.length) % MODES.length;
    onChange(MODES[i].id);
    refs.current[i]?.focus();
  };

  return (
    <div ref={segsRef} className="segs" role="radiogroup" aria-label="Modo de búsqueda">
      {MODES.map((m, i) => (
        <button
          key={m.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === m.id}
          tabIndex={value === m.id ? 0 : -1}
          className={[
            "seg",
            value === m.id ? "is-on" : "",
            m.id === "ytdlp" && ytDead ? "mode--dead" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => onChange(m.id)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              move(current + 1);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              move(current - 1);
            } else if (e.key === "Home") {
              e.preventDefault();
              move(0);
            } else if (e.key === "End") {
              e.preventDefault();
              move(MODES.length - 1);
            }
          }}
          title={
            m.id === "ytdlp" && ytDead
              ? "YouTube está apagado en este servidor: no devolverá resultados"
              : undefined
          }
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
/* Filtro de resultados. Es un componente aparte (y no JSX en App) porque el
   grupo solo existe cuando hay resultados: el hook de la pastilla deslizante
   tiene que montarse con el, no con App. */
export function FilterSegs({ filter, onChange, total, full }) {
  const ref = useRef(null);
  useSlidingPill(ref, filter);
  return (
    <div ref={ref} className="segs" role="group" aria-label="Filtrar resultados">
      <button
        type="button"
        className={`seg ${filter === "all" ? "is-on" : ""}`}
        aria-pressed={filter === "all"}
        onClick={() => onChange("all")}
      >
        Todos <span className="seg__n">{total}</span>
      </button>
      <button
        type="button"
        className={`seg ${filter === "full" ? "is-on" : ""}`}
        aria-pressed={filter === "full"}
        onClick={() => onChange("full")}
      >
        Descarga completa <span className="seg__n">{full}</span>
      </button>
    </div>
  );
}
