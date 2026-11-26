import { describe, expect, it } from "vitest";
import { compareVersions, installedLabel, newerLabel, parseVersion, updateState } from "./releaseCheck.js";

describe("parseVersion", () => {
  it("lee major.minor.patch de un tag con o sin la v inicial", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
  });

  it("vacio o con forma rara no parsea", () => {
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion("latest")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("compara por el primer campo que difiere", () => {
    expect(compareVersions([1, 0, 0], [0, 9, 9])).toBe(1);
    expect(compareVersions([1, 2, 3], [1, 2, 4])).toBe(-1);
    expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0);
  });
});

describe("updateState", () => {
  it("version mas nueva en GitHub", () => {
    expect(updateState("0.1.0", "0.2.0")).toBe("newer");
  });

  it("ya tiene la ultima, igual o mas nueva que GitHub", () => {
    expect(updateState("0.2.0", "0.2.0")).toBe("current");
    expect(updateState("0.3.0", "0.2.0")).toBe("current");
  });

  it("sin version de GitHub (sin internet) queda offline", () => {
    expect(updateState("0.1.0", null)).toBe("offline");
    expect(updateState("0.1.0", undefined)).toBe("offline");
  });
});

describe("etiquetas", () => {
  it("version instalada", () => {
    expect(installedLabel("0.1.0")).toBe("spitifo v0.1.0");
  });

  it("aviso de version nueva", () => {
    expect(newerLabel("0.2.0")).toBe("Hay una versión nueva: v0.2.0");
  });
});
