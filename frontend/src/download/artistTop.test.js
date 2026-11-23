import { describe, expect, it } from "vitest";
import { artistPopulares } from "./artistTop.js";

const song = (title, extra = {}) => ({ title, artist: "Radiohead", preview_url: "p", extra });
const searched = [song("De busqueda")];

/* Las paginas llaman con TRES argumentos (backend, resultados, nombre): el
   plan que filtraba antes no existia en produccion y ResultRow ya se encarga
   de como suena cada fila, previews de 30 s incluidos. */
describe("artistPopulares", () => {
  it("prefiere las canciones del backend", () => {
    expect(artistPopulares([song("Del backend")], searched, "Radiohead").map((t) => t.title))
      .toEqual(["Del backend"]);
  });

  it("cae a los resultados de Buscar si el backend no trae nada", () => {
    expect(artistPopulares([], searched, "Radiohead").map((t) => t.title))
      .toEqual(["De busqueda"]);
    expect(artistPopulares(undefined, searched, "Radiohead").map((t) => t.title))
      .toEqual(["De busqueda"]);
  });

  it("no hay seccion si ambas fuentes estan vacias", () => {
    expect(artistPopulares([], [], "Radiohead")).toEqual([]);
    expect(artistPopulares([], searched, null)).toEqual([]);
  });

  it("respeta el tope de cinco", () => {
    const many = Array.from({ length: 8 }, (_, i) => song(`Cancion ${i}`));
    expect(artistPopulares(many, [], "Radiohead")).toHaveLength(5);
  });

  it("deja pasar los previews: la fila decide como suena", () => {
    const soloPreview = [{ title: "Solo preview", artist: "Radiohead", preview_url: "p", extra: {} }];
    expect(artistPopulares(soloPreview, [], "Radiohead").map((t) => t.title))
      .toEqual(["Solo preview"]);
  });
});
