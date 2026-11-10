import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { labelInk } from "./mapInk.js";

/* La tinta de las etiquetas contra la superficie del mapa (--s1), con los
   valores literales de tokens.css: claro en :root, oscuro en
   :root[data-theme="dark"]. */

const css = readFileSync(new URL("../shared/tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector) {
  const start = css.indexOf(`${selector} {`);
  const end = css.indexOf("\n}", start);
  const out = {};
  for (const m of css.slice(start, end).matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)) out[m[1]] = m[2];
  return out;
}

const light = block(":root");
const dark = { ...light, ...block(':root[data-theme="dark"]') };
const palette = (theme) => Array.from({ length: 16 }, (_, i) => theme[`--genre-${i}`]);

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function luminance([r, g, b]) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a, b) {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("labelInk", () => {
  it("en claro acerca el color 68 % al negro", () => {
    expect(labelInk("#ffffff", "light")).toBe("#adadad");
    expect(labelInk("#e45741", "light")).toBe("#9b3b2c");
    expect(labelInk("#000000", "light")).toBe("#000000");
  });

  it("en oscuro devuelve el color tal cual", () => {
    expect(labelInk("#ff866f", "dark")).toBe("#ff866f");
  });

  it("lo que no es #rrggbb vuelve igual", () => {
    expect(labelInk("rgb(10, 20, 30)", "light")).toBe("rgb(10, 20, 30)");
    expect(labelInk("#fff", "light")).toBe("#fff");
    expect(labelInk("", "light")).toBe("");
  });
});

describe("contraste de las etiquetas", () => {
  it("la paleta tiene los 16 colores en los dos temas", () => {
    for (const theme of [light, dark]) {
      expect(palette(theme).filter((c) => /^#[0-9a-f]{6}$/i.test(c))).toHaveLength(16);
    }
  });

  it("claro: la tinta sobre el blanco de las tarjetas llega a 4.5:1 en los 16 colores", () => {
    for (const c of palette(light)) {
      expect(ratio(labelInk(c, "light"), light["--s1"])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("oscuro: el color puro sobre la superficie oscura llega a 4.5:1 en los 16 colores", () => {
    for (const c of palette(dark)) {
      expect(ratio(labelInk(c, "dark"), dark["--s1"])).toBeGreaterThanOrEqual(4.5);
    }
  });
});
