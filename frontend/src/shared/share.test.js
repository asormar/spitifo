import { afterEach, describe, expect, it, vi } from "vitest";
import { appleMusicUrl, isAndroid, share, shareLink, shareText, verifiedVideoUrl } from "./share.js";

const WEB = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("enlace híbrido", () => {
  it("usa el vídeo verificado cuando existe", () => {
    expect(shareLink({ title: "Mesmerizer", artist: "Satsuki", result: { extra: { webpage_url: WEB } } })).toBe(WEB);
    expect(verifiedVideoUrl({ extra: { webpage_url: WEB } })).toBe(WEB);
  });

  it("cae a Apple Music cuando no hay vídeo o no es de YouTube", () => {
    expect(appleMusicUrl("Motomami", "ROSALÍA")).toBe(
      "https://music.apple.com/search?term=Motomami%20ROSAL%C3%8DA"
    );
    expect(shareLink({ title: "Mesmerizer", artist: "Satsuki", result: { extra: {} } })).toBe(
      "https://music.apple.com/search?term=Mesmerizer%20Satsuki"
    );
    expect(verifiedVideoUrl({ extra: { webpage_url: "https://example.com/v" } })).toBeNull();
  });
});

describe("texto compartido", () => {
  it("una canción lleva el título, el artista y el enlace", () => {
    expect(shareText({ kind: "song", title: "Mesmerizer", artist: "Satsuki", result: { extra: { webpage_url: WEB } } }))
      .toBe(`«Mesmerizer» de Satsuki, en spitifo.\n${WEB}`);
  });

  it("un álbum lleva el enlace de búsqueda", () => {
    expect(shareText({ kind: "album", title: "Motomami", artist: "ROSALÍA" }))
      .toBe("«Motomami» de ROSALÍA, en spitifo.\nhttps://music.apple.com/search?term=Motomami%20ROSAL%C3%8DA");
  });

  it("un artista no repite el nombre", () => {
    expect(shareText({ kind: "artist", title: "ROSALÍA", artist: null }))
      .toBe("«ROSALÍA», en spitifo.\nhttps://music.apple.com/search?term=ROSAL%C3%8DA");
  });

  it("una playlist manda la lista, no un enlace que nadie podría abrir", () => {
    const songs = [
      { title: "Mesmerizer", artist: "Satsuki" },
      { title: "Despechá", artist: "ROSALÍA" },
      { title: "Monaco", artist: "Bad Bunny" },
      { title: "Otra", artist: "Alguien" },
    ];
    expect(shareText({ kind: "list", title: "Viernes de oficina", songs })).toBe(
      "Mi lista «Viernes de oficina» en spitifo (4 canciones):\n" +
      "1. Mesmerizer — Satsuki\n2. Despechá — ROSALÍA\n3. Monaco — Bad Bunny\n… y 1 más"
    );
  });
});

describe("destino", () => {
  afterEach(() => {
    delete globalThis.window;
    vi.unstubAllGlobals();
  });

  it("Android usa el puente nativo", async () => {
    const bridge = vi.fn();
    globalThis.window = { SpitifoAndroid: { share: bridge } };
    const show = vi.fn();
    const out = await share({ kind: "song", title: "Mesmerizer", artist: "Satsuki", result: { extra: { webpage_url: WEB } } }, show);
    expect(isAndroid()).toBe(true);
    expect(out.via).toBe("android");
    expect(bridge).toHaveBeenCalledWith(`«Mesmerizer» de Satsuki, en spitifo.\n${WEB}`);
    expect(show).not.toHaveBeenCalled();
  });

  it("PC copia al portapapeles y avisa", async () => {
    const writeText = vi.fn().mockResolvedValue();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const show = vi.fn();
    const out = await share({ kind: "song", title: "Mesmerizer", artist: "Satsuki" }, show);
    expect(isAndroid()).toBe(false);
    expect(out.via).toBe("clipboard");
    expect(writeText).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledWith("Enlace copiado");
  });

  it("sin portapapeles no finge que se copió", async () => {
    vi.stubGlobal("navigator", {});
    const show = vi.fn();
    const out = await share({ kind: "song", title: "X", artist: "Y" }, show);
    expect(out.via).toBe("failed");
    expect(show).toHaveBeenCalledWith("No se pudo copiar el enlace");
  });
});
