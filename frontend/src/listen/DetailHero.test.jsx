import { describe, expect, it } from "vitest";
import render from "preact-render-to-string";
import DetailHero from "./DetailHero.jsx";

/* La ficha entera necesita tienda, navigation y chunks; aqui se prueba solo la
   gramatica de la cabecera compartida, que es lo que cambia con VH-7 y VH-8. */

const base = {
  art: <span className="cv" />,
  title: <h1>Álbum</h1>,
  meta: "12 canciones",
  acts: <div className="dacts">acciones</div>,
};

describe("DetailHero", () => {
  it("puts every slot in one header", () => {
    const html = render(
      <DetailHero
        {...base}
        back={<button>Volver</button>}
        more={<button>Más</button>}
        by={{ name: "Artista", onClick: () => {} }}
        foot={<p className="liner">Nota</p>}
      />
    );
    expect(html).toContain('<header class="dhero"');
    expect(html).toContain('class="dhero__back"');
    expect(html).toContain('class="dhero__art"');
    expect(html).toContain('class="dhero__by"');
    expect(html).toContain('class="dmeta dhero__meta"');
    expect(html).toContain('class="dhero__more"');
    expect(html).toContain("Nota");
  });

  it("changes only the round modifier for artists", () => {
    const html = render(<DetailHero {...base} round tone={2} />);
    expect(html).toContain('class="dhero dhero--round"');
    expect(html).not.toContain("ahero");
  });
});
