import { describe, expect, it } from "vitest";
import { playButtonLabel } from "./controls.jsx";

describe("playButtonLabel", () => {
  it("says it's loading, with the track's title, while buffering", () => {
    expect(playButtonLabel({ icon: "load", playing: false, label: "Mesmerizer" })).toBe(
      "Cargando Mesmerizer"
    );
    /* El giro sigue igual aunque `playing` ya diga true: buffering manda. */
    expect(playButtonLabel({ icon: "load", playing: true, label: "Mesmerizer" })).toBe(
      "Cargando Mesmerizer"
    );
  });

  it("says play or pause once it isn't buffering", () => {
    expect(playButtonLabel({ icon: "pause", playing: true, label: "Mesmerizer" })).toBe(
      "Pausar Mesmerizer"
    );
    expect(playButtonLabel({ icon: "play", playing: false, label: "Mesmerizer" })).toBe(
      "Reproducir Mesmerizer"
    );
  });
});
