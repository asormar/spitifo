import { useEffect, useRef, useState } from "react";
import { NavIcon } from "../app/navIcons.jsx";
import { Icon } from "./icons.jsx";
import { cx } from "./ui.jsx";
import "./sfield.css";

/* ---------------------------------------------------------------------------
   EL CAMPO DE BUSQUEDA

   Un solo componente para los tres campos de la app: la barra de arriba
   (escritorio), Buscar y Tu biblioteca (telefono). Controlado por quien lo usa:
   aqui solo viven el aspecto, la lupa que orbita mientras `busy` y el teclado
   (Escape borra y, con el campo vacio, suelta el foco; el campo lo consume y no
   cierra tambien la pagina de debajo).

   `go`: texto del boton de enviar (sin el, el campo no lleva boton; Enter
   sigue llamando a onSubmit). `big`: la version de pantalla del telefono.
   ------------------------------------------------------------------------- */

export default function SearchField({
  value,
  onChange,
  onSubmit,
  onFocus,
  go,
  busy = false,
  placeholder,
  label,
  clearLabel = "Borrar",
  inputRef,
  big = false,
  className,
}) {
  const own = useRef(null);
  const ref = inputRef || own;

  /* La lupa orbita mientras busca. Al llegar la respuesta NO se corta: sigue
     hasta cerrar la vuelta en curso (la orbita empieza y acaba en reposo), asi
     que se detiene sin saltar. El timeout es la red de seguridad para
     prefers-reduced-motion, donde no hay animacion ni evento que esperar. */
  const [scan, setScan] = useState(false);
  useEffect(() => {
    if (busy) {
      setScan(true);
      return undefined;
    }
    const id = setTimeout(() => setScan(false), 1500);
    return () => clearTimeout(id);
  }, [busy]);

  const clear = () => {
    onChange("");
    ref.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (value) onChange("");
    else e.currentTarget.blur();
  };

  return (
    <form
      className={cx("sfield", big && "sfield--big", scan && "is-scanning", className)}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.(e);
      }}
      onAnimationIteration={(e) => {
        if (!busy && e.target.classList.contains("sfield__icon")) setScan(false);
      }}
    >
      <NavIcon name="search" size={big ? 22 : 20} className="sfield__icon" />
      <input
        ref={ref}
        type="text"
        inputMode="search"
        data-field="search"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      />
      {value && (
        <button type="button" className="cbtn cbtn--sm" aria-label={clearLabel} title={clearLabel} onClick={clear}>
          <Icon name="X" size={16} />
        </button>
      )}
      {go && (
        <button type="submit" className="sfield__go">
          {busy ? "Buscando" : go}
        </button>
      )}
    </form>
  );
}
