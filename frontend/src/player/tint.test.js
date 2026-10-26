import { describe, expect, it } from "vitest";
import {
  artTint,
  averageColor,
  contrastWithWhite,
  darken,
  fallbackTint,
  hashHue,
  luminance,
} from "./tint.js";

const px = (...colors) => Uint8ClampedArray.from(colors.flatMap(([r, g, b, a = 255]) => [r, g, b, a]));

/* HSL -> RGB, solo para comprobar el contraste del color de reserva. */
function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

describe("averageColor", () => {
  it("averages the pixels", () => {
    expect(averageColor(px([0, 0, 0], [100, 50, 200]))).toEqual([50, 25, 100]);
  });

  it("ignores transparent pixels", () => {
    expect(averageColor(px([200, 100, 0], [0, 0, 0, 0]))).toEqual([200, 100, 0]);
  });

  it("returns null when there is nothing to average", () => {
    expect(averageColor(new Uint8ClampedArray(0))).toBeNull();
    expect(averageColor(px([9, 9, 9, 0]))).toBeNull();
  });
});

describe("luminance", () => {
  it("is 0 for black and 1 for white", () => {
    expect(luminance([0, 0, 0])).toBe(0);
    expect(luminance([255, 255, 255])).toBeCloseTo(1, 5);
  });

  it("gives white on black the maximum contrast", () => {
    expect(contrastWithWhite([0, 0, 0])).toBeCloseTo(21, 5);
    expect(contrastWithWhite([255, 255, 255])).toBeCloseTo(1, 5);
  });
});

describe("darken", () => {
  it("keeps a colour that already reads well", () => {
    expect(darken([30, 40, 90])).toEqual([30, 40, 90]);
  });

  it("darkens a bright colour until white text reads on it", () => {
    const out = darken([250, 240, 120]);
    expect(contrastWithWhite(out)).toBeGreaterThanOrEqual(4.5);
    expect(luminance(out)).toBeLessThan(luminance([250, 240, 120]));
  });

  it("reaches 4.5:1 for any colour of a coarse sweep", () => {
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          expect(contrastWithWhite(darken([r, g, b]))).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("never returns a colour outside 0-255", () => {
    expect(darken([255, 255, 255]).every((v) => v >= 0 && v <= 255)).toBe(true);
  });
});

describe("hashHue", () => {
  it("is stable and inside the hue wheel", () => {
    expect(hashHue("Radiohead")).toBe(hashHue("Radiohead"));
    for (const name of ["", null, undefined, "Ñandú", "x".repeat(500)]) {
      const h = hashHue(name);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it("tells different artists apart", () => {
    expect(hashHue("Artista A")).not.toBe(hashHue("Artista B"));
  });
});

describe("fallbackTint", () => {
  it("builds an hsl colour from the artist", () => {
    expect(fallbackTint("Radiohead")).toBe(`hsl(${hashHue("Radiohead")} 45% 28%)`);
  });

  it("keeps white text above 4.5:1 for every hue", () => {
    for (let h = 0; h < 360; h += 1) {
      expect(contrastWithWhite(hslToRgb(h, 0.45, 0.28))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("artTint", () => {
  it("returns a css colour that reads under white text", () => {
    expect(artTint(px([255, 255, 255], [255, 255, 255]))).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
  });

  it("returns null for an image with no pixels", () => {
    expect(artTint(new Uint8ClampedArray(0))).toBeNull();
  });
});
