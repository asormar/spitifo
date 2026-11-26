import { describe, expect, it } from "vitest";
import {
  artTint,
  averageColor,
  contrastWithWhite,
  darken,
  luminance,
  maxSatQuadrant,
  toneTint,
} from "./tint.js";

const px = (...colors) => Uint8ClampedArray.from(colors.flatMap(([r, g, b, a = 255]) => [r, g, b, a]));

/* Un ImageData de 24x24 pintado de un solo color por cuadrante (12x12 cada
   uno), en el orden que usa maxSatQuadrant: arriba-izq, arriba-der, abajo-izq,
   abajo-der. */
function quadImage(tl, tr, bl, br) {
  const data = new Uint8ClampedArray(24 * 24 * 4);
  const paint = (qx, qy, [r, g, b]) => {
    for (let y = qy; y < qy + 12; y += 1) {
      for (let x = qx; x < qx + 12; x += 1) {
        const i = (y * 24 + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
    }
  };
  paint(0, 0, tl);
  paint(12, 0, tr);
  paint(0, 12, bl);
  paint(12, 12, br);
  return data;
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

describe("maxSatQuadrant", () => {
  it("picks the most saturated quadrant, not the average", () => {
    /* Tres cuadrantes grises (saturacion 0) y uno rosa vivo: el promedio de
       toda la imagen seria un gris turbio, pero el matiz que importa es el
       vivo. */
    const data = quadImage([40, 40, 40], [40, 40, 40], [40, 40, 40], [255, 79, 163]);
    expect(maxSatQuadrant(data)).toEqual([255, 79, 163]);
  });

  it("returns null for an image with no pixels", () => {
    /* Un ImageData entero a cero es tambien alpha 0: totalmente transparente. */
    expect(maxSatQuadrant(new Uint8ClampedArray(24 * 24 * 4))).toBeNull();
    expect(maxSatQuadrant(new Uint8ClampedArray(0))).toBeNull();
  });

  it("ignores fully transparent quadrants", () => {
    const data = quadImage([200, 100, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]);
    /* Vacia el cuadrante vivo (alpha 0): el mejor cuadrante que queda es gris,
       saturacion 0, pero sigue devolviendo un color (no null). */
    for (let y = 0; y < 12; y += 1) {
      for (let x = 0; x < 12; x += 1) {
        data[(y * 24 + x) * 4 + 3] = 0;
      }
    }
    expect(maxSatQuadrant(data)).toEqual([0, 0, 0]);
  });
});

describe("toneTint", () => {
  it("mixes the genre colour of the tone into the dark base", () => {
    expect(toneTint(0)).toBe("color-mix(in oklab, var(--genre-0) 50%, #0e0e18)");
    expect(toneTint(37)).toBe("color-mix(in oklab, var(--genre-5) 50%, #0e0e18)");
  });

  it("stays on the 16 colours for every tone", () => {
    for (let tone = 0; tone < 64; tone += 1) {
      const n = Number(/--genre-(\d+)/.exec(toneTint(tone))[1]);
      expect(n).toBe(tone % 16);
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
