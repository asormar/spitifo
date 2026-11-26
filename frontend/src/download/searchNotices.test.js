import { describe, expect, it } from "vitest";
import { OFFLINE_TEXT, SEARCH_FAIL, SHELF_FAIL, offlineText, searchErrorText, shelfErrorText, typoHead } from "./searchNotices.js";

describe("searchNotices", () => {
  it("traduce el fallo de red por fetchErr y el resto con el texto de Buscar", () => {
    expect(searchErrorText(new TypeError("Failed to fetch"))).toMatch(/No se pudo contactar/);
    expect(searchErrorText(new Error("boom"))).toBe(SEARCH_FAIL);
    expect(searchErrorText(new Error("iTunes no respondio"))).toBe(SEARCH_FAIL);
  });

  it("da texto a los estados que antes callaban", () => {
    expect(shelfErrorText()).toBe(SHELF_FAIL);
    expect(offlineText()).toBe(OFFLINE_TEXT);
    expect(typoHead("Mesmerzer")).toBe("No encontré nada para «Mesmerzer»");
  });
});
