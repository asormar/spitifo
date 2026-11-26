import { describe, expect, it } from "vitest";
import { resumeNotice } from "./videoResume.js";

describe("resumeNotice", () => {
  it("names the track and the second it resumes at", () => {
    expect(resumeNotice("Monaco", 102)).toBe("Volviendo a «Monaco» desde 1:42");
  });

  it("falls back when the video had no title", () => {
    expect(resumeNotice("", 5)).toBe("Volviendo a «el audio» desde 0:05");
    expect(resumeNotice(null, 0)).toBe("Volviendo a «el audio» desde 0:00");
  });
});
