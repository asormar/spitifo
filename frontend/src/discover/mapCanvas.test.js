import { describe, expect, it } from "vitest";
import { clusterLegend } from "./mapCanvas.js";

/* `order` va de mas a menos peso, como en decodeMap. */
const data = {
  names: ["Pop", "Urbano", "Electro", "Latino", "Indie", "J-pop", "Clásica", "Metal", "Folk"],
  c: [0, 1, 2, 3, 4, 5, 6, 0, 1],
  w: [9, 8, 7, 6, 5, 4, 3, 2, 1],
  order: [0, 1, 2, 3, 4, 5, 6, 7, 8],
};

describe("clusterLegend", () => {
  it("names each color with its heaviest genre, in weight order", () => {
    const { shown, more } = clusterLegend(data, 7);
    expect(shown.map((r) => r.name)).toEqual([
      "Pop",
      "Urbano",
      "Electro",
      "Latino",
      "Indie",
      "J-pop",
      "Clásica",
    ]);
    expect(shown[0]).toMatchObject({ c: 0, i: 0, w: 9 });
    expect(more).toBe(0);
  });

  it("collapses the remaining colors into a count", () => {
    expect(clusterLegend(data, 2)).toEqual({
      shown: [
        { c: 0, i: 0, name: "Pop", w: 9 },
        { c: 1, i: 1, name: "Urbano", w: 8 },
      ],
      more: 5,
    });
  });

  it("is empty without map data", () => {
    expect(clusterLegend(undefined)).toEqual({ shown: [], more: 0 });
    expect(clusterLegend({ names: [] })).toEqual({ shown: [], more: 0 });
  });
});
