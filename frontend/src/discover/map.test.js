import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  buildGrid,
  centerOn,
  clampView,
  decodeMap,
  easeOut,
  exploreGenres,
  fitScale,
  flyView,
  genreIndex,
  hitTest,
  inertiaStep,
  limits,
  normalize,
  panBy,
  parseMs,
  placeCard,
  placeLabels,
  related,
  releaseVelocity,
  searchGenres,
  toScreen,
  toWorld,
  zoomAt,
} from "./map.js";

const SIZE = { w: 800, h: 600 };

/* Datos falsos con la forma del contrato: n/x/y/c/w/r/mb en columnas. */
function fake(count, seed = 7) {
  let s = seed;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  return {
    version: 1,
    n: Array.from({ length: count }, (_, i) => `genre ${i}`),
    x: Array.from({ length: count }, () => Math.floor(rnd() * 65536)),
    y: Array.from({ length: count }, () => Math.floor(rnd() * 65536)),
    c: Array.from({ length: count }, (_, i) => i % 16),
    w: Array.from({ length: count }, () => Math.floor(rnd() * 101)),
    r: Array.from({ length: count }, (_, i) => [(i + 1) % count, (i + 2) % count]),
    mb: Array.from({ length: count }, () => ""),
  };
}

describe("normalize", () => {
  it("drops accents, case and extra spaces", () => {
    expect(normalize("  Bossa  Nová ")).toBe("bossa nova");
    expect(normalize("Cumbia ÑANDÚ")).toBe("cumbia nandu");
    expect(normalize(null)).toBe("");
  });
});

describe("decodeMap", () => {
  it("scales coordinates to 0..1 and keeps columns aligned", () => {
    const d = decodeMap(fake(50));
    expect(d.count).toBe(50);
    expect(d.x).toBeInstanceOf(Float32Array);
    expect(d.c).toBeInstanceOf(Uint8Array);
    for (let i = 0; i < d.count; i++) {
      expect(d.x[i]).toBeGreaterThanOrEqual(0);
      expect(d.x[i]).toBeLessThanOrEqual(1);
      expect(d.y[i]).toBeGreaterThanOrEqual(0);
      expect(d.y[i]).toBeLessThanOrEqual(1);
    }
    expect(decodeMap({ ...fake(2), x: [0, 65535] }).x[1]).toBe(1);
  });

  it("orders by weight descending, ties by index", () => {
    const raw = { ...fake(4), w: [10, 90, 90, 50] };
    expect(Array.from(decodeMap(raw).order)).toEqual([1, 2, 3, 0]);
  });

  it("groups genres by cluster", () => {
    const d = decodeMap(fake(48));
    for (let k = 0; k < 16; k++) {
      const members = Array.from(d.clIdx.subarray(d.clStart[k], d.clStart[k + 1]));
      expect(members.length).toBe(3);
      members.forEach((i) => expect(d.c[i]).toBe(k));
    }
  });

  it("drops invalid, repeated and self related indexes", () => {
    const raw = { ...fake(3), r: [[1, 1, 7, -1, 0, 2.5, 2], [], [0]] };
    const d = decodeMap(raw);
    expect(Array.from(related(d, 0))).toEqual([1, 2]);
    expect(Array.from(related(d, 1))).toEqual([]);
    expect(Array.from(related(d, 2))).toEqual([0]);
  });

  it("clamps colour and weight, and throws on unequal columns", () => {
    const d = decodeMap({ ...fake(2), c: [99, -3], w: [250, -4] });
    expect(Array.from(d.c)).toEqual([15, 0]);
    expect(Array.from(d.w)).toEqual([100, 0]);
    expect(() => decodeMap({ ...fake(3), y: [1, 2] })).toThrow();
    expect(() => decodeMap(null)).toThrow();
    expect(() => decodeMap({ n: [] })).toThrow();
  });
});

describe("view", () => {
  const lim = limits(SIZE);

  it("converts world and screen both ways", () => {
    const v = { x: 0.4, y: 0.6, k: 900 };
    const s = toScreen(v, SIZE, 0.45, 0.5);
    const w = toWorld(v, SIZE, s.x, s.y);
    expect(w.x).toBeCloseTo(0.45, 9);
    expect(w.y).toBeCloseTo(0.5, 9);
    expect(toScreen(v, SIZE, 0.4, 0.6)).toEqual({ x: 400, y: 300 });
  });

  it("fits the whole map with a margin and caps the zoom", () => {
    expect(fitScale(SIZE)).toBeCloseTo(600 / 1.08, 6);
    expect(lim.max / lim.min).toBeCloseTo(MAX_ZOOM, 9);
    expect(clampView({ x: 0.5, y: 0.5, k: 1 }, SIZE).k).toBe(lim.min);
    expect(clampView({ x: 0.5, y: 0.5, k: 1e9 }, SIZE).k).toBe(lim.max);
  });

  it("centres an axis that fits and bounds the one that does not", () => {
    const fit = clampView({ x: 0.9, y: 0.9, k: lim.min }, SIZE);
    expect(fit.x).toBe(0.5); // el eje largo no cabe en el mundo + holgura
    expect(fit.y).toBeCloseTo(1.12 - 600 / lim.min / 2, 9); // el corto solo tiene la holgura
    const zoomed = clampView({ x: -5, y: 9, k: lim.min * 10 }, SIZE);
    expect(zoomed.x).toBeCloseTo(-0.12 + 800 / zoomed.k / 2, 9);
    expect(zoomed.y).toBeCloseTo(1.12 - 600 / zoomed.k / 2, 9);
  });

  it("pans opposite to the drag", () => {
    const v = { x: 0.5, y: 0.5, k: lim.min * 8 };
    const p = panBy(v, SIZE, 100, 0, lim);
    expect(p.x).toBeCloseTo(0.5 - 100 / v.k, 9);
    expect(p.y).toBe(0.5);
  });

  it("zooms keeping the point under the cursor fixed", () => {
    const v = clampView({ x: 0.5, y: 0.5, k: lim.min * 4 }, SIZE);
    const before = toWorld(v, SIZE, 650, 120);
    const z = zoomAt(v, SIZE, 650, 120, 2, lim);
    expect(z.k).toBeCloseTo(v.k * 2, 6);
    const after = toWorld(z, SIZE, 650, 120);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("never zooms outside the limits", () => {
    const v = { x: 0.5, y: 0.5, k: lim.max };
    expect(zoomAt(v, SIZE, 10, 10, 5, lim).k).toBe(lim.max);
    const out = zoomAt({ x: 0.5, y: 0.5, k: lim.min * 1.2 }, SIZE, 10, 10, 0.1, lim);
    expect(out.k).toBe(lim.min);
  });

  it("centres a world point, optionally at another screen spot", () => {
    const v = centerOn(SIZE, 0.3, 0.3, lim.min * 10, lim);
    expect(toScreen(v, SIZE, 0.3, 0.3).x).toBeCloseTo(400, 6);
    const off = centerOn(SIZE, 0.5, 0.5, lim.min * 10, lim, 400, 150);
    expect(toScreen(off, SIZE, 0.5, 0.5).y).toBeCloseTo(150, 6);
  });
});

describe("flyView", () => {
  const a = { x: 0.2, y: 0.8, k: 500 };
  const b = { x: 0.7, y: 0.3, k: 18000 };

  it("starts and ends exactly on the two views", () => {
    expect(flyView(a, b, 0)).toEqual(a);
    expect(flyView(a, b, 1)).toEqual(b);
  });

  it("zooms exponentially and moves the centre monotonically", () => {
    let prev = flyView(a, b, 0.01);
    for (let t = 0.05; t < 1; t += 0.05) {
      const v = flyView(a, b, t);
      expect(v.k).toBeGreaterThan(prev.k);
      expect(v.x).toBeGreaterThanOrEqual(prev.x);
      expect(v.y).toBeLessThanOrEqual(prev.y);
      prev = v;
    }
    expect(flyView(a, b, 0.5).k).toBeCloseTo(Math.sqrt(500 * 18000), 4);
  });

  it("keeps the destination on screen while zooming in", () => {
    for (let t = 0; t <= 1; t += 0.1) {
      const v = flyView(a, b, t);
      const s = toScreen(v, SIZE, b.x, b.y);
      const start = toScreen(a, SIZE, b.x, b.y);
      expect(Math.abs(s.x - 400)).toBeLessThanOrEqual(Math.abs(start.x - 400) + 1e-6);
      expect(Math.abs(s.y - 300)).toBeLessThanOrEqual(Math.abs(start.y - 300) + 1e-6);
    }
  });

  it("handles a pure pan (same zoom)", () => {
    const c = { ...b, k: a.k };
    const mid = flyView(a, c, 0.5);
    expect(mid.x).toBeCloseTo(0.45, 9);
    expect(mid.k).toBe(a.k);
  });

  it("eases out within 0..1", () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
    expect(easeOut(2)).toBe(1);
  });
});

describe("inertia", () => {
  it("measures speed from the recent samples only", () => {
    const samples = [
      { t: 0, x: 0, y: 0 },
      { t: 920, x: 50, y: 0 },
      { t: 950, x: 80, y: 10 },
      { t: 1000, x: 130, y: 20 },
    ];
    const v = releaseVelocity(samples, 1000);
    expect(v.vx).toBeCloseTo((130 - 50) / 0.08, 6);
    expect(v.vy).toBeCloseTo(20 / 0.08, 6);
    expect(releaseVelocity([samples[0]], 10)).toEqual({ vx: 0, vy: 0 });
    expect(releaseVelocity(samples, 5000)).toEqual({ vx: 0, vy: 0 });
  });

  it("decays and covers the same distance whatever the frame rate", () => {
    let one = { vx: 1000, vy: 0 };
    let dist1 = 0;
    for (let i = 0; i < 60; i++) {
      const s = inertiaStep(one.vx, one.vy, 1000 / 60);
      dist1 += s.dx;
      one = s;
    }
    let two = { vx: 1000, vy: 0 };
    let dist2 = 0;
    for (let i = 0; i < 20; i++) {
      const s = inertiaStep(two.vx, two.vy, 50);
      dist2 += s.dx;
      two = s;
    }
    expect(dist1).toBeCloseTo(dist2, 6);
    expect(one.vx).toBeLessThan(1000);
    expect(one.vx).toBeGreaterThan(0);
  });
});

describe("hitTest", () => {
  const d = decodeMap(fake(1500, 3));

  it("finds the nearest genre inside the radius", () => {
    for (const i of [0, 17, 800, 1499]) {
      expect(hitTest(d.grid, d.x, d.y, d.x[i], d.y[i], 0.004)).toBe(i);
    }
  });

  it("agrees with a brute force scan", () => {
    const rnd = (n) => ((n * 9301 + 49297) % 233280) / 233280;
    for (let t = 1; t <= 60; t++) {
      const wx = rnd(t);
      const wy = rnd(t * 7);
      const r = 0.03;
      let best = -1;
      let bestD = r * r;
      for (let i = 0; i < d.count; i++) {
        const dd = (d.x[i] - wx) ** 2 + (d.y[i] - wy) ** 2;
        if (dd <= bestD) {
          bestD = dd;
          best = i;
        }
      }
      expect(hitTest(d.grid, d.x, d.y, wx, wy, r)).toBe(best);
    }
  });

  it("returns -1 on empty space and survives the map edges", () => {
    const g = buildGrid(new Float32Array([0.5]), new Float32Array([0.5]), 8);
    expect(hitTest(g, new Float32Array([0.5]), new Float32Array([0.5]), 0.1, 0.1, 0.02)).toBe(-1);
    expect(hitTest(g, new Float32Array([0.5]), new Float32Array([0.5]), -3, 4, 0.02)).toBe(-1);
  });

  it("puts every genre in exactly one cell", () => {
    expect(d.grid.items.length).toBe(d.count);
    expect(d.grid.start[d.grid.start.length - 1]).toBe(d.count);
    expect(new Set(d.grid.items).size).toBe(d.count);
  });
});

describe("placeLabels", () => {
  const d = decodeMap(fake(2000, 11));
  const base = {
    order: d.order,
    xs: d.x,
    ys: d.y,
    size: SIZE,
    measure: () => 70,
    radius: () => 3,
  };
  const fit = { x: 0.5, y: 0.5, k: limits(SIZE).min };

  it("caps the count and never overlaps", () => {
    const out = placeLabels({ ...base, view: fit });
    expect(out.length).toBeGreaterThan(20);
    expect(out.length).toBeLessThanOrEqual(200);
    const box = (l) => {
      const x0 = l.left ? l.x - 70 : l.x;
      return [x0, l.y - 7, x0 + 70, l.y + 7];
    };
    for (let a = 0; a < out.length; a++) {
      for (let b = a + 1; b < out.length; b++) {
        const p = box(out[a]);
        const q = box(out[b]);
        const apart = p[2] <= q[0] || q[2] <= p[0] || p[3] <= q[1] || q[3] <= p[1];
        expect(apart).toBe(true);
      }
    }
  });

  it("keeps the most central genres first", () => {
    const out = placeLabels({ ...base, view: fit });
    expect(out[0].i).toBe(d.order[0]);
  });

  it("shows more detail when zoomed in", () => {
    const wide = placeLabels({ ...base, view: fit, max: 1000 });
    const near = placeLabels({
      ...base,
      view: { x: 0.5, y: 0.5, k: fit.k * 6 },
      max: 1000,
    });
    const share = (labels, view) =>
      labels.length /
      Math.max(
        1,
        Array.from(d.x).filter((x, i) => {
          const s = toScreen(view, SIZE, x, d.y[i]);
          return s.x >= 0 && s.x <= SIZE.w && s.y >= 0 && s.y <= SIZE.h;
        }).length
      );
    expect(share(near, { x: 0.5, y: 0.5, k: fit.k * 6 })).toBeGreaterThan(share(wide, fit));
  });

  it("places priority labels first and skips offscreen genres", () => {
    const last = d.order[d.order.length - 1];
    const out = placeLabels({ ...base, view: fit, first: [last] });
    expect(out[0].i).toBe(last);
    expect(out.filter((l) => l.i === last).length).toBe(1);
    const away = placeLabels({ ...base, view: { x: 5, y: 5, k: fit.k * 4 } });
    expect(away.length).toBe(0);
  });

  it("flips a label to the left at the right edge", () => {
    const xs = new Float32Array([0.5]);
    const ys = new Float32Array([0.5]);
    const out = placeLabels({
      ...base,
      xs,
      ys,
      order: [0],
      view: { x: 0.5 - 380 / 1000, y: 0.5, k: 1000 },
    });
    expect(out).toHaveLength(1);
    expect(out[0].left).toBe(true);
  });
});

describe("searchGenres", () => {
  const raw = {
    n: ["rock", "indie rock", "rock en español", "bossa nova", "bossa nová", "krautrock", "rocksteady"],
    x: [1, 2, 3, 4, 5, 6, 7],
    y: [1, 2, 3, 4, 5, 6, 7],
    c: [0, 0, 0, 0, 0, 0, 0],
    w: [100, 60, 40, 30, 20, 50, 10],
    r: [],
  };
  const d = decodeMap(raw);

  it("ranks prefix, then word start, then substring", () => {
    const names = searchGenres(d, "rock").map((i) => raw.n[i]);
    expect(names).toEqual(["rock", "rock en español", "rocksteady", "indie rock", "krautrock"]);
  });

  it("ignores accents and case in both directions", () => {
    expect(searchGenres(d, "ESPAÑOL").map((i) => raw.n[i])).toEqual(["rock en español"]);
    expect(searchGenres(d, "espanol").map((i) => raw.n[i])).toEqual(["rock en español"]);
    expect(searchGenres(d, "nova").length).toBe(2);
  });

  it("respects the limit and empty queries", () => {
    expect(searchGenres(d, "r", 3)).toHaveLength(3);
    expect(searchGenres(d, "")).toEqual([]);
    expect(searchGenres(d, "   ")).toEqual([]);
    expect(searchGenres(d, "zzz")).toEqual([]);
  });
});

describe("placeCard", () => {
  const card = { w: 240, h: 180 };

  it("sits to the right of the point when there is room", () => {
    const p = placeCard(100, 200, card, SIZE);
    expect(p.x).toBeGreaterThan(100);
  });

  it("flips left near the right edge and stays inside", () => {
    const p = placeCard(760, 590, card, SIZE);
    expect(p.x + card.w).toBeLessThanOrEqual(SIZE.w);
    expect(p.x).toBeLessThan(760);
    expect(p.y + card.h).toBeLessThanOrEqual(SIZE.h);
  });

  it("stays inside when the point is offscreen", () => {
    const p = placeCard(-500, -500, card, SIZE);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });
});

describe("parseMs", () => {
  it("reads ms and s", () => {
    expect(parseMs("360ms")).toBe(360);
    expect(parseMs(" 0.36s ")).toBeCloseTo(360, 9);
    expect(parseMs("", 99)).toBe(99);
    expect(parseMs("fast", 99)).toBe(99);
  });
});

describe("genreIndex", () => {
  it("maps normalized names to indexes and keeps the first of a repeated name", () => {
    const d = decodeMap({ ...fake(4), n: ["Bossa Nová", "trap", "bossa nova", "R&B"] });
    const idx = genreIndex(d);
    expect(idx.get(normalize("BOSSA NOVA"))).toBe(0);
    expect(idx.get("trap")).toBe(1);
    expect(idx.get("r&b")).toBe(3);
    expect(idx.get("jazz")).toBeUndefined();
  });
});

describe("exploreGenres", () => {
  /* 0 y 1 son del usuario; 2..7 cuelgan de ellos. */
  const raw = {
    ...fake(8),
    w: [90, 80, 10, 70, 30, 60, 20, 50],
    r: [[1, 2, 3, 4], [0, 5, 6, 7], [], [], [], [], [], []],
  };
  const d = decodeMap(raw);

  it("takes the neighbours the user does not have, most central first, by turns", () => {
    const out = exploreGenres(d, [0, 1], 4);
    expect(out).toEqual([
      { i: 3, near: 0 },
      { i: 5, near: 1 },
      { i: 4, near: 0 },
      { i: 7, near: 1 },
    ]);
  });

  it("never offers a genre the user already has and stops at the limit", () => {
    const out = exploreGenres(d, [0, 1], 6);
    expect(out.map((x) => x.i)).not.toContain(0);
    expect(out.map((x) => x.i)).not.toContain(1);
    expect(out).toHaveLength(6);
    expect(new Set(out.map((x) => x.i)).size).toBe(6);
  });

  it("returns fewer when there is nothing else and tolerates no genres", () => {
    expect(exploreGenres(d, [2], 6)).toEqual([]);
    expect(exploreGenres(d, [], 6)).toEqual([]);
  });

  it("does not repeat a genre that hangs from two of the user's", () => {
    const shared = decodeMap({ ...fake(4), w: [50, 50, 40, 30], r: [[1, 2, 3], [0, 2, 3], [], []] });
    const out = exploreGenres(shared, [0, 1], 6);
    expect(out.map((x) => x.i).sort()).toEqual([2, 3]);
  });
});

describe("placeLabels with a shifted centre", () => {
  it("lays labels out around the given centre instead of the canvas middle", () => {
    const xs = new Float32Array([0.5]);
    const ys = new Float32Array([0.5]);
    const view = { x: 0.5, y: 0.5, k: 400 };
    const base = { order: [0], xs, ys, view, size: SIZE, measure: () => 40, radius: () => 3 };
    const [middle] = placeLabels(base);
    const [shifted] = placeLabels({ ...base, center: { x: SIZE.w / 2 - 150, y: SIZE.h / 2 + 30 } });
    expect(shifted.x).toBeCloseTo(middle.x - 150);
    expect(shifted.y).toBeCloseTo(middle.y + 30);
  });
});
