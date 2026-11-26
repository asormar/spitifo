import { describe, expect, it } from "vitest";
import { EXAMPLES } from "../download/constants.js";
import { starterExamples } from "./starter.js";

describe("starterExamples", () => {
  it("offers searches from the existing catalog examples", () => {
    expect(starterExamples(2)).toEqual(EXAMPLES.slice(0, 2));
    expect(starterExamples(0)).toEqual([]);
  });
});
