import { describe, expect, it, vi } from "vitest";
import { absoluteUrl, shareLink } from "./share.js";

describe("compartir una pagina", () => {
  it("la ruta se vuelve una URL absoluta", () => {
    expect(absoluteUrl("/", "?view=library&page=album:168")).toBe("https://spitifo.app/?view=library&page=album:168");
  });

  it("usa navigator.share cuando esta", async () => {
    const share = vi.fn().mockResolvedValue();
    const write = vi.fn();
    expect(await shareLink({ title: "Motomami", url: "https://x/y", share, write })).toBe("shared");
    expect(share).toHaveBeenCalledWith({ title: "Motomami", url: "https://x/y" });
    expect(write).not.toHaveBeenCalled();
  });

  it("cae al portapapeles si no hay share", async () => {
    const write = vi.fn().mockResolvedValue();
    expect(await shareLink({ title: "x", url: "https://x/y", share: null, write })).toBe("copied");
    expect(write).toHaveBeenCalledWith("https://x/y");
  });

  it("un rechazo no produce error", async () => {
    const share = vi.fn().mockRejectedValue(new Error("cancelado"));
    expect(await shareLink({ title: "x", url: "https://x/y", share, write: null })).toBe("none");
  });
});
