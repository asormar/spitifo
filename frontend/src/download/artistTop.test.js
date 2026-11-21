import { describe, expect, it } from "vitest";
import { artistPopulares } from "./artistTop.js";

/* Un plan minimo: solo suena lo que trae preview o version completa. */
const plan = (t) => (t?.extra?.has_full || t?.preview_url ? "preview" : null);
const song = (title, extra = {}) => ({ title, artist: "Radiohead", preview_url: "p", extra });
const searched = [song("De busqueda")];

describe("artistPopulares", () => {
  it("prefiere las canciones del backend", () => {
    const got = artistPopulares([song("Del backend")], null, searched, "Radiohead", plan);
    expect(got.map((t) => t.title)).toEqual(["Del backend"]);
  });

  it("cae a los resultados de Buscar si el backend no trae nada", () => {
    expect(artistPopulares([], null, searched, "Radiohead", plan).map((t) => t.title))
      .toEqual(["De busqueda"]);
    expect(artistPopulares(undefined, null, searched, "Radiohead", plan).map((t) => t.title))
      .toEqual(["De busqueda"]);
  });

  it("no hay seccion si ambas fuentes estan vacias", () => {
    expect(artistPopulares([], null, [], "Radiohead", plan)).toEqual([]);
    expect(artistPopulares([], null, searched, null, plan)).toEqual([]);
  });

  it("respeta el tope de cinco", () => {
    const many = Array.from({ length: 8 }, (_, i) => song(`Cancion ${i}`));
    expect(artistPopulares(many, null, [], "Radiohead", plan)).toHaveLength(5);
  });

  it("descarta lo que no se puede tocar", () => {
    const sinPlan = [{ title: "Sin plan", artist: "Radiohead" }];
    expect(artistPopulares(sinPlan, null, [], "Radiohead", plan)).toEqual([]);
  });
});
