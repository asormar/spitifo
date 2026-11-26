import { describe, expect, it } from "vitest";
import { PULL_THRESHOLD, pullOffset, shouldRefresh } from "./pullRefresh.js";

describe("pullOffset", () => {
  it("ignores an upward or zero pull", () => {
    expect(pullOffset(-20)).toBe(0);
    expect(pullOffset(0)).toBe(0);
  });

  it("resists the pull before the threshold", () => {
    expect(pullOffset(40)).toBe(20);
    expect(pullOffset(PULL_THRESHOLD)).toBe(PULL_THRESHOLD);
  });

  it("resists harder past the threshold", () => {
    expect(pullOffset(PULL_THRESHOLD + 40)).toBe(PULL_THRESHOLD + 10);
  });
});

describe("shouldRefresh", () => {
  it("arms only past the threshold", () => {
    expect(shouldRefresh(PULL_THRESHOLD - 1)).toBe(false);
    expect(shouldRefresh(PULL_THRESHOLD)).toBe(true);
  });
});
