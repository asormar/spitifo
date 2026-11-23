import { describe, expect, it } from "vitest";
import { rowKey } from "../shared/api.js";
import { isMine, rowTrackKey } from "./resultPlayback.js";

/* La decision de «¿es esta la pista que suena?» es pura y vive en isMine. El
   toque de una fila con cambios de biblioteca, pero aca probamos la decision:
   con resolve la clave de motor es null y solo cuenta el rowKey del resultado
   guardado, que es justo el caso que antes volvia a resolver y reiniciaba. */
const mineOf = (state, t) => isMine(state, { key: rowTrackKey(t), rk: rowKey(t) });

describe("isMine", () => {
  it("no reconoce ninguna fila cuando el motor no tiene pista", () => {
    const t = { source: "itunes", source_id: "1", extra: { webpage_url: "https://youtu.be/abcdefghijk" } };
    expect(isMine({}, { key: rowTrackKey(t), rk: rowKey(t) })).toBe(false);
    expect(isMine({ track: null }, { key: rowTrackKey(t), rk: rowKey(t) })).toBe(false);
  });

  it("reconoce una pista por su clave de motor (stream, archive y preview)", () => {
    const stream = { source: "itunes", source_id: "1", extra: { webpage_url: "https://youtu.be/abcdefghijk" } };
    const archive = { source: "archive", source_id: "items/xyz", extra: { needs_resolve: true } };
    const preview = { source: "itunes", source_id: "2", preview_url: "https://audio.example/p.m4a", extra: {} };
    for (const t of [stream, archive, preview]) {
      expect(rowTrackKey(t)).toBeTruthy();
      expect(mineOf({ track: { key: rowTrackKey(t), result: t } }, t)).toBe(true);
    }
  });

  it("un resultado que hay que resolver se reconoce por rowKey aunque no tenga clave", () => {
    const t = { source: "itunes", source_id: "42", extra: { needs_resolve: true }, title: "Radiohead" };
    expect(rowTrackKey(t)).toBeNull();
    const full = {
      ...t,
      extra: { needs_resolve: false, webpage_url: "https://youtu.be/xxxxxxxxxxx" },
    };
    const state = { track: { key: "stream:https://youtu.be/xxxxxxxxxxx", result: full } };
    expect(mineOf(state, t)).toBe(true);
  });

  it("no confunde dos filas distintas que resuelven", () => {
    const a = { source: "itunes", source_id: "42", extra: { needs_resolve: true } };
    const b = { source: "itunes", source_id: "43", extra: { needs_resolve: true } };
    expect(mineOf({ track: { result: b } }, a)).toBe(false);
  });
});
