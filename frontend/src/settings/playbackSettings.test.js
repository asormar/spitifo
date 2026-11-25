import { describe, expect, it } from "vitest";
import {
  CROSSFADE_MAX, QUALITY_OPTIONS, autoSaver, crossfade, crossfadeLabel,
  effectiveQuality, onMobileData, quality, readAutoSaver, readCrossfade,
  readQuality, withStreamQuality,
} from "./playbackSettings.js";

const store = (values) => ({ getItem: (k) => (k in values ? values[k] : null) });

describe("lectura y valores por defecto", () => {
  it("calidad: solo los tres niveles, auto por defecto", () => {
    expect(readQuality(store({}))).toBe("auto");
    expect(readQuality(store({ "spitifo:stream-quality": "high" }))).toBe("high");
    expect(readQuality(store({ "spitifo:stream-quality": "raro" }))).toBe("auto");
  });

  it("ahorro automático es un booleano de verdad", () => {
    expect(readAutoSaver(store({}))).toBe(true);
    expect(readAutoSaver(store({ "spitifo:stream-auto-saver": "false" }))).toBe(false);
    expect(readAutoSaver(store({ "spitifo:stream-auto-saver": true }))).toBe(true);
  });

  it("crossfade: 0..11 y solo números enteros", () => {
    expect(readCrossfade(store({}))).toBe(0);
    // La clave guarda segundos (contrato con el motor): 8 s es el paso 7.
    expect(readCrossfade(store({ "spitifo.playback.crossfade": "8" }))).toBe(7);
    expect(readCrossfade(store({ "spitifo.playback.crossfade": "0" }))).toBe(0);
    expect(readCrossfade(store({ "spitifo.playback.crossfade": "99" }))).toBe(0);
    expect(readCrossfade(store({ "spitifo.playback.crossfade": "x" }))).toBe(0);
    expect(CROSSFADE_MAX).toBe(11);
    expect(crossfadeLabel(0)).toBe("Apagado");
    expect(crossfadeLabel(11)).toBe("12 s");
  });

  it("las tres opciones llevan su MB estimado", () => {
    expect(QUALITY_OPTIONS.map((o) => o.id)).toEqual(["auto", "saver", "high"]);
    for (const o of QUALITY_OPTIONS) expect(o.mb).toMatch(/^~\d/);
  });
});

describe("cuándo se aplica el ahorro", () => {
  it("el interruptor solo cambia el cuándo, nunca el nivel elegido", () => {
    expect(effectiveQuality({ quality: "high", autoSaver: true, mobile: false })).toBe("high");
    expect(effectiveQuality({ quality: "high", autoSaver: true, mobile: true })).toBe("saver");
    expect(effectiveQuality({ quality: "high", autoSaver: false, mobile: true })).toBe("high");
  });

  it("sin información de red no suponemos datos móviles", () => {
    expect(onMobileData({})).toBe(false);
    expect(onMobileData({ connection: { type: "wifi" } })).toBe(false);
    expect(onMobileData({ connection: { type: "cellular" } })).toBe(true);
  });

  it("la calidad viaja como query y auto no viaja", () => {
    const url = "/api/stream?url=https%3A%2F%2Fyoutu.be%2Fabc";
    expect(withStreamQuality(url, "auto")).toBe(url);
    expect(withStreamQuality(url, "saver")).toBe(`${url}&quality=saver`);
    expect(withStreamQuality("/api/stream", "high")).toBe("/api/stream?quality=high");
  });

  it("el valor guardado llega a la URL del stream", () => {
    const url = "/api/stream?url=abc";
    quality.set("saver");
    autoSaver.set(false);
    expect(withStreamQuality(url)).toBe(`${url}&quality=saver`);
    quality.set("auto");
    expect(withStreamQuality(url)).toBe(url);
  });
});
