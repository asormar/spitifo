import { describe, expect, it } from "vitest";
import { linkFromSearch, resolveArtistLink } from "./artistLink.js";

describe("Más de <artista>", () => {
  it("solo acepta una coincidencia exacta del nombre", () => {
    expect(linkFromSearch("Soda Stereo", [{ id: 7, name: "soda stereo", genre: "Rock" }])).toEqual({
      type: "itunesartist", id: 7, name: "soda stereo", genre: "Rock",
    });
    expect(linkFromSearch("Soda Stereo", [{ id: 8, name: "Soda Stereo en vivo" }])).toBe(null);
    expect(linkFromSearch("Soda Stereo", [])).toBe(null);
  });

  it("usa el id guardado sin consultar la red", async () => {
    const search = () => { throw new Error("no debe buscar"); };
    const view = await resolveArtistLink("Soda Stereo", [{ artist: "Soda Stereo", artist_id: "77" }], search);
    expect(view).toEqual({ type: "itunesartist", id: "77", name: "Soda Stereo" });
  });

  it("busca el nombre si no hay id guardado", async () => {
    const search = async () => [{ id: 9, name: "Soda Stereo", genre: "Rock" }];
    const view = await resolveArtistLink("Soda Stereo", [], search);
    expect(view).toEqual({ type: "itunesartist", id: 9, name: "Soda Stereo", genre: "Rock" });
  });

  it("devuelve null si la busqueda falla o no coincide", async () => {
    expect(await resolveArtistLink("X", [], async () => { throw new Error("caida"); })).toBe(null);
    expect(await resolveArtistLink("X", [], async () => [{ id: 1, name: "Otro" }])).toBe(null);
  });
});
