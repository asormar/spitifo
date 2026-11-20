import { describe, expect, it } from "vitest";
import {
  OFFLINE_EMPTY,
  allBlocked,
  offlineLabel,
  offlineNotice,
  playableEntries,
  rowState,
} from "./offline.js";

const file = { key: "A/A - Uno.mp3", downloaded: true };
const stream = { key: "yt:dQw4w9WgXcQ", title: "Tema", downloaded: false };

describe("playableEntries", () => {
  it("con red deja todo, incluidos los streams", () => {
    expect(playableEntries([file, stream], true)).toEqual([file, stream]);
  });

  it("sin red descarta las guardadas sin archivo", () => {
    expect(playableEntries([file, stream], false)).toEqual([file]);
  });

  it("sin red y sin descargas no deja nada", () => {
    expect(playableEntries([stream], false)).toEqual([]);
    expect(playableEntries(null, false)).toEqual([]);
  });
});

describe("allBlocked", () => {
  it("solo avisa cuando habia filas y todas eran streams", () => {
    expect(allBlocked([stream], false)).toBe(true);
    expect(allBlocked([file], false)).toBe(false);
    expect(allBlocked([file, stream], false)).toBe(false);
    expect(allBlocked([], false)).toBe(false);
    expect(allBlocked([stream], true)).toBe(false);
  });
});

describe("rowState", () => {
  it("con red una guardada sin archivo se ve y se pulsa normal", () => {
    expect(rowState(stream, true)).toEqual({ blocked: false, label: "", notice: "" });
  });

  it("sin red se bloquea con la etiqueta y el aviso exactos", () => {
    const state = rowState(stream, false);
    expect(state.blocked).toBe(true);
    expect(state.label).toBe(
      "«Tema» no está descargada: sin conexión no se puede escuchar");
    expect(state.notice).toBe("Sin conexión. «Tema» no está descargada.");
    expect(state.label).toBe(offlineLabel(stream));
    expect(state.notice).toBe(offlineNotice(stream));
  });

  it("un archivo nunca se bloquea", () => {
    expect(rowState(file, false).blocked).toBe(false);
  });

  it("el aviso de cola vacia dice que no hay nada descargado", () => {
    expect(OFFLINE_EMPTY).toBe(
      "Sin conexión no hay nada descargado para escuchar aquí.");
  });
});
