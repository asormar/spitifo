import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { isComposing } from "./ime.js";
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
   Con `listId` el campo pasa a ser un combobox real: sugerencias con
   `aria-activedescendant`, flechas y un toque que elige. Sin `listId` sigue
   siendo el input de siempre, para la barra y la biblioteca.
   ------------------------------------------------------------------------- */

export default function SearchField({
  value,
  onChange,
  onSubmit,
  onFocus,
  onPaste,
  go,
  busy = false,
  placeholder,
  label,
  clearLabel = "Borrar",
  inputRef,
  big = false,
  className,
  ghost = false,
  listId,
  suggestions = [],
  onPickSuggestion,
  onArrowDown,
}) {
  const own = useRef(null);
  const ref = inputRef || own;
  const [active, setActive] = useState(-1);
  const [closed, setClosed] = useState(false);

  const combobox = Boolean(listId);
  const open = combobox && !closed && suggestions.length > 0;

  /*Una sugerencia nueva reempieza el foco activo; no heredamos un indice de la
    lista anterior cuando cambia el texto.*/
  useEffect(() => {
    setActive(-1);
    setClosed(false);
  }, [value, suggestions.length]);

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
    setClosed(false);
    setActive(-1);
    ref.current?.focus({ preventScroll: true });
  };

  const pick = (i) => {
    const item = suggestions[i];
    if (!item) return;
    setClosed(true);
    setActive(-1);
    onPickSuggestion?.(item);
  };

  const onKeyDown = (e) => {
    /* Enter mientras se compone (IME) confirma el caracter, no la busqueda. */
    if (e.key === "Enter" && isComposing(e)) {
      e.preventDefault();
      return;
    }
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.max(0, Math.min(suggestions.length - 1, i + step)));
      return;
    }
    if (open && e.key === "Enter" && active >= 0) {
      e.preventDefault();
      pick(active);
      return;
    }
    /* En PC, bajar desde el campo con la lista cerrada lleva a la primera
       fila de resultados; antes no pasaba nada. */
    if (e.key === "ArrowDown" && !open) {
      onArrowDown?.(e);
      return;
    }
    if (e.key !== "Escape") return;
    if (open) {
      e.preventDefault();
      e.stopPropagation();
      setClosed(true);
      setActive(-1);
      return;
    }
    e.stopPropagation();
    if (value) onChange("");
    else e.currentTarget.blur();
  };

  return (
    <div className={cx("sfwrap", className)}>
      <form
        className={cx("sfield", big && "sfield--big", scan && "is-scanning")}
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.(e);
        }}
        onAnimationIteration={(e) => {
          if (!busy && e.target.classList.contains("sfield__icon")) setScan(false);
        }}
      >
        <Icon name="MagnifyingGlass" size={big ? "lg" : "md"} className="sfield__icon" />
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
          role={combobox ? "combobox" : undefined}
          aria-expanded={combobox ? open : undefined}
          aria-controls={combobox ? listId : undefined}
          aria-autocomplete={combobox ? "list" : undefined}
          aria-activedescendant={open && active >= 0 ? `${listId}-opt-${active}` : undefined}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
        />
        {value && (
          <button type="button" className="cbtn cbtn--sm" aria-label={clearLabel} title={clearLabel} onClick={clear}>
            <Icon name="X" size="sm" />
          </button>
        )}
        {go && (
          <button type="submit" className={cx("sfield__go", ghost && "sfield__go--ghost")}>
            {busy ? "Buscando" : go}
          </button>
        )}
      </form>
      {open && (
        <div className="sfcombo" id={listId} role="listbox" aria-label="Sugerencias">
          {suggestions.map((s, i) => (
            <div
              key={`${s.kind}:${s.id ?? s.title}`}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={cx("sfcombo__row", i === active && "is-active")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <span className="sfcombo__cv" aria-hidden="true">
                {(s.title || "?").trim().slice(0, 1).toUpperCase()}
              </span>
              <span className="sfcombo__tx">
                <b>{s.title}</b>
                {s.sub && <span>{s.sub}</span>}
              </span>
              <span className="sfcombo__kind">
                {s.kind === "song" ? "Canción" : s.kind === "artist" ? "Artista" : "Álbum"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
