import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Icon, createIcon } from "./icons.jsx";
import { Icon as ListenIcon } from "../listen/icons.jsx";

describe("Icon", () => {
  it("pinta el peso pedido con los atributos de siempre", () => {
    const html = renderToStaticMarkup(<Icon name="Play" weight="fill" size="sm" className="x" />);
    expect(html.startsWith('<svg viewBox="0 0 256 256" width="16" height="16" fill="currentColor" class="x" aria-hidden="true" focusable="false"><path d="')).toBe(true);
    expect(html.match(/<path/g)).toHaveLength(1);
  });

  it("los iconos de la vista y los del script inicial son rutas distintas", () => {
    const a = renderToStaticMarkup(<Icon name="X" />);
    const b = renderToStaticMarkup(<ListenIcon name="CaretDown" />);
    expect(a).not.toBe(b);
    expect(renderToStaticMarkup(<Icon name="CircleNotch" weight="bold" />)).toContain("<path");
  });

  it("duotone lleva la capa con opacidad", () => {
    const DuoIcon = createIcon({ Duo: ["M1,1", ["M2,2", 0.2]] });
    const html = renderToStaticMarkup(<DuoIcon name="Duo" />);
    expect(html.match(/<path/g)).toHaveLength(2);
    expect(html).toContain('opacity="0.2"');
  });

  it("las vistas heredan los iconos del script inicial", () => {
    expect(renderToStaticMarkup(<ListenIcon name="Play" weight="fill" />)).toContain("<path");
  });

  it("un icono sin definir no pinta nada", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(renderToStaticMarkup(<Icon name="Nope" />)).toBe("");
    warn.mockRestore();
  });
});

/* ---------------------------------------------------------------------------
   UN SOLO SISTEMA DE ICONOS (guarda de regresion)

   Estas dos pruebas leen el codigo fuente, no lo ejecutan: que ningun
   componente vuelva a dibujar un <svg> a mano o a traer de vuelta Ico/NavIcon,
   y que las rutas que escribimos a mano en los modulos de iconos sigan siendo,
   byte a byte, las del paquete @phosphor-icons/core (nunca un glifo inventado).
   ------------------------------------------------------------------------- */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PHOSPHOR_ASSETS = resolve(SRC, "..", "node_modules/@phosphor-icons/core/assets");

/* Los unicos modulos con permiso para tener rutas de icono o dibujar <svg>. */
const ICON_MODULES = [
  "shared/icons.jsx",
  "shared/viewIcons.js",
  "discover/icons.jsx",
  "listen/icons.jsx",
  "download/icons.jsx",
  "settings/icons.jsx",
];
/* El logo del disco es el unico icono que se dibuja a mano (DESIGN.md). */
const SVG_ALLOWED = new Set(["shared/icons.jsx", "shared/Logo.jsx"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SOURCE_FILES = walk(SRC)
  .map((f) => ({ path: f, rel: relative(SRC, f).replace(/\\/g, "/") }))
  .filter((f) => !f.rel.endsWith(".test.js") && !f.rel.endsWith(".test.jsx"));

describe("un solo sistema de iconos", () => {
  it("nada fuera de los modulos de iconos dibuja un <svg> a mano (salvo el logo)", () => {
    const offenders = SOURCE_FILES.filter(
      (f) => !SVG_ALLOWED.has(f.rel) && /<svg[\s>]/.test(readFileSync(f.path, "utf8"))
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("los tamanos de icono salen de los tokens (sm, md, lg, xl), nunca en px", () => {
    const offenders = SOURCE_FILES.flatMap((f) =>
      (readFileSync(f.path, "utf8").match(/<Icon\b[^>]*\bsize=\{\d+\}[^>]*>/g) ?? []).map((tag) => `${f.rel}: ${tag}`)
    );
    expect(offenders).toEqual([]);
  });

  it("Ico y NavIcon no vuelven a aparecer", () => {
    const offenders = SOURCE_FILES.filter((f) => {
      const text = readFileSync(f.path, "utf8");
      return /\bIco\b/.test(text) || /\bNavIcon\b/.test(text);
    }).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("toda ruta de los modulos de iconos es, byte a byte, la del paquete @phosphor-icons/core", () => {
    /* "Nombre" o "Nombre:peso" seguido de un literal de cadena: una ruta de
       icono escrita a mano en uno de los modulos de iconos. */
    const NAME_RE = /(?:^|\n)\s*(?:"([A-Za-z]+:[a-z]+)"|([A-Za-z]+))\s*:\s*\n?\s*"([^"]+)"/g;
    const toSlug = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

    let checked = 0;
    for (const mod of ICON_MODULES) {
      const text = readFileSync(join(SRC, mod), "utf8");
      let m;
      while ((m = NAME_RE.exec(text))) {
        const key = m[1] || m[2];
        const ours = m[3];
        /* REPEAT es una constante auxiliar (se concatena en RepeatOnce), no un
           nombre de icono por si mismo. */
        if (key === "REPEAT") continue;
        const [name, weight = "regular"] = key.split(":");
        const slug = toSlug(name);
        const file = join(
          PHOSPHOR_ASSETS,
          weight,
          `${slug}${weight === "regular" ? "" : `-${weight}`}.svg`
        );
        if (!existsSync(file)) continue; // una rama duotone ([ruta, opacidad]) no es un literal de cadena simple
        const svg = readFileSync(file, "utf8");
        const expected = [...svg.matchAll(/\sd="([^"]+)"/g)].map((p) => p[1]).join("|");
        expect(ours, `${mod}: ${key}`).toBe(expected);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});
