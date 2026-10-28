import { useEffect, useState } from "react";
import { startsCollapsed } from "./frame.js";
import { Icon } from "./icons.jsx";
import { useReco, visibleArtists } from "./reco.js";

/* ---------------------------------------------------------------------------
   HUECO DE "PARA TI"

   El panel (ForYou.jsx y todo lo que arrastra: gestos, filas, estilos) es un
   chunk aparte. El mapa no lo espera: dibuja su primer cuadro con un marco
   estatico en el sitio del panel, y en cuanto ese cuadro esta en pantalla se
   pide el chunk y el panel de verdad ocupa el hueco. El marco ocupa lo mismo
   que el panel (la camara ya encuadra para ese espacio), asi que nada se mueve.
   ------------------------------------------------------------------------- */

const plural = (n) => `${n} ${n === 1 ? "artista" : "artistas"}`;

/* El titulo del panel, el mismo en el marco y en el panel. */
export function panelHead(rec) {
  const count = visibleArtists(rec.artists, rec.hidden).length;
  if (count === 0 && rec.status.running) return "Para ti · Conociendo tus artistas…";
  return count ? `Para ti · ${plural(count)}` : "Para ti";
}

/* El titulo con su icono. */
export function PanelTitle({ head }) {
  return (
    <>
      <span className="fy__ico" aria-hidden="true">
        <Icon name="Sparkle" weight="fill" size={18} />
      </span>
      <span className="fy__title">{head}</span>
    </>
  );
}

/* El marco estatico: la barra de la hoja (telefono) o la cabecera del panel
   lateral. Recogido en ancho no pinta nada: la pestana aparece con el panel. */
function Frame({ narrow, collapsed }) {
  const head = panelHead(useReco());
  if (narrow) {
    return (
      <section className="fy fy--sheet fy--stub" aria-hidden="true" data-snap="peek" inert="">
        <div className="fy__top">
          <div className="fy__peek">
            <span className="fy__grip" />
            <PanelTitle head={head} />
            <span className="fy__caret">
              <Icon name="CaretDown" weight="fill" size={20} />
            </span>
          </div>
        </div>
      </section>
    );
  }
  if (collapsed) return null;
  return (
    <section className="fy fy--side fy--stub" aria-hidden="true" inert="">
      <div className="fy__head">
        <PanelTitle head={head} />
      </div>
    </section>
  );
}

let loaded = null;
let loading = null;
const loadForYou = () => {
  loading ||= import("./ForYou.jsx").then(
    (m) => (loaded = m.default),
    (e) => {
      loading = null;
      throw e;
    }
  );
  return loading;
};

/* `ctx` y el resto son los del panel (ver GenreMap). El marco se pinta con el
   primer cuadro; el chunk se pide cuando ese cuadro ya esta en pantalla. */
export default function ForYouSlot(props) {
  const { ctx } = props;
  const [ForYou, setForYou] = useState(() => loaded);
  /* El panel lateral nace recogido o no segun el ancho del mapa de ahora. */
  const [collapsed] = useState(() => startsCollapsed(ctx.box.w, ctx.narrow));

  useEffect(() => {
    if (ForYou) return undefined;
    let alive = true;
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        loadForYou().then(
          (component) => alive && setForYou(() => component),
          () => {
            /* Sin el chunk se queda el marco; abrir Descubrir otra vez reintenta. */
          }
        );
      }, 0);
    });
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [ForYou]);

  if (ForYou) return <ForYou {...props} initialCollapsed={collapsed} />;
  return <Frame narrow={ctx.narrow} collapsed={collapsed} />;
}
