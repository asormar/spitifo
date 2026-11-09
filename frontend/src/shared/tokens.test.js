import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/* Contraste WCAG de los pares de texto que importan, leyendo los valores
   literales de tokens.css (claro en :root, oscuro en :root[data-theme="dark"],
   que hereda de :root lo que no redefine). */

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector) {
  const start = css.indexOf(`${selector} {`);
  const end = css.indexOf("\n}", start);
  const out = {};
  for (const m of css.slice(start, end).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = block(":root");
const dark = { ...light, ...block(':root[data-theme="dark"]') };

/* Valor de un token como [r, g, b, a]; resuelve var(--otro). */
function color(theme, name) {
  const raw = theme[name];
  if (raw === undefined) throw new Error(`token sin definir: ${name}`);
  const ref = raw.match(/^var\((--[a-z0-9-]+)\)$/);
  if (ref) return color(theme, ref[1]);
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  const rgba = raw.match(/^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/);
  if (rgba) return [+rgba[1], +rgba[2], +rgba[3], rgba[4] === undefined ? 1 : +rgba[4]];
  throw new Error(`valor no literal en ${name}: ${raw}`);
}

/* `top` (con alfa) compuesto sobre `base` opaco. */
const over = (top, base) => [0, 1, 2].map((i) => top[i] * top[3] + base[i] * (1 - top[3])).concat(1);

function luminance([r, g, b]) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

const PAIRS = [
  ["ink", "bg"],
  ["ink", "s1"],
  ["ink", "s2"],
  ["mut", "bg"],
  ["mut", "s1"],
  ["mut", "s2"],
  ["dim", "bg"],
  ["dim", "s1"],
  ["dim", "s2"],
  ["acc", "bg"],
  ["acc", "s1"],
  ["acc", "s2"],
  ["acc-ink", "acc"],
  ["on", "ink"],
  ["on-pink", "pink"],
  ["toast-act", "ink"],
  /* Ajustes: el enlace de desconectar, el punto de "Conectada" y el glifo de
     reproducir de una fila (grafico, 3:1 alcanza). */
  ["bad-t", "bg"],
  ["bad-t", "s1"],
  ["ok-t", "s1"],
];

describe.each([
  ["light", light],
  ["dark", dark],
])("tokens.css, theme %s", (_name, theme) => {
  it.each(PAIRS)("%s on %s reaches 4.5:1", (fg, bg) => {
    expect(ratio(color(theme, `--${fg}`), color(theme, `--${bg}`))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["ok", "near", "bad"])("verdict %s text on its tint over the card reaches 4.5:1", (tone) => {
    const card = color(theme, "--s1");
    const tint = over(color(theme, `--${tone}-bg`), card);
    expect(ratio(color(theme, `--${tone}-t`), tint)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["ok", "near", "bad"])("verdict %s text on the page ground reaches 4.5:1", (tone) => {
    const tint = over(color(theme, `--${tone}-bg`), color(theme, "--bg"));
    expect(ratio(color(theme, `--${tone}-t`), tint)).toBeGreaterThanOrEqual(4.5);
  });

  /* El glifo de reproducir es un grafico: WCAG pide 3:1, no 4.5. En claro va
     justo (3.04), asi que el umbral es el que es. */
  it("pink as a graphic on the card reaches 3:1", () => {
    expect(ratio(color(theme, "--pink"), color(theme, "--s1"))).toBeGreaterThanOrEqual(3);
  });

  /* La fila elegida de Para ti: tinte rosa al 14 % sobre la tarjeta. */
  it.each(["ink", "mut"])("%s on the selected-row tint reaches 4.5:1", (fg) => {
    const pink = color(theme, "--pink");
    const tint = over([pink[0], pink[1], pink[2], 0.14], color(theme, "--s1"));
    expect(ratio(color(theme, `--${fg}`), tint)).toBeGreaterThanOrEqual(4.5);
  });

  it("defines the 16 genre colours", () => {
    for (let i = 0; i < 16; i++) expect(() => color(theme, `--genre-${i}`)).not.toThrow();
  });
});

describe("theme parity", () => {
  it("dark redefines every colour token that light sets", () => {
    const darkOnly = block(':root[data-theme="dark"]');
    const colours = Object.keys(light).filter((k) => /^--(bg|s[123]|ink|on|mut|dim|line|hair|hover|acc|acc-ink|pink|pink2|ok|near|bad|(ok|near|bad)-(t|bg)|shadow|scrim|glass|toast-act|genre-\d+)$/.test(k));
    expect(colours.filter((k) => !(k in darkOnly))).toEqual([]);
  });
});

/* La Mezcla de Inicio es azul #3045ff en los dos temas (home.css fuerza el
   mismo azul en oscuro) con texto blanco. */
describe("Mezcla hero", () => {
  const BLUE = [0x30, 0x45, 0xff, 1];
  const WHITE = [255, 255, 255, 1];
  const home = readFileSync(new URL("../listen/home.css", import.meta.url), "utf8");

  it("uses the same blue in both themes", () => {
    expect(color(light, "--acc")).toEqual(BLUE);
    expect(home).toMatch(/:root\[data-theme="dark"\] \.mezcla \{\s*--hero: #3045ff;/);
  });

  it.each([
    ["white text", WHITE],
    ["white text at .9 (sub line)", over([255, 255, 255, 0.9], BLUE)],
    ["white text at .85 (mix name)", over([255, 255, 255, 0.85], BLUE)],
  ])("%s on the blue reaches 4.5:1", (_name, fg) => {
    expect(ratio(fg, BLUE)).toBeGreaterThanOrEqual(4.5);
  });

  it("white chip text on the translucent chip (PC) and the blue text on the active white chip reach 4.5:1", () => {
    expect(ratio(WHITE, over([10, 14, 70, 0.32], BLUE))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(BLUE, WHITE)).toBeGreaterThanOrEqual(4.5);
  });
});
