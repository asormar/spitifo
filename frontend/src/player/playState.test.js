import { describe, expect, it } from "vitest";
import { playStateText } from "./playState.js";

describe("playStateText", () => {
  it("names a stream that is not in the library", () => {
    expect(playStateText({ kind: "stream" })).toBe("En streaming");
  });

  it("names a stream that has been saved", () => {
    expect(playStateText({ kind: "stream", saved: true })).toBe("Guardada · en streaming");
  });

  it("names a file from the library", () => {
    expect(playStateText({ kind: "library" })).toBe("Descargada · sin conexión");
  });

  it("names a 30 s preview", () => {
    expect(playStateText({ kind: "preview" })).toBe("Vista previa de 30 s");
  });

  it("says nothing for an unknown track", () => {
    expect(playStateText()).toBeNull();
    expect(playStateText({ kind: "video" })).toBeNull();
  });
});
