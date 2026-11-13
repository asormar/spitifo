import { describe, expect, it } from "vitest";
import {
  albumVerdict,
  checkOf,
  checkText,
  checkedSummary,
  filePill,
  provText,
  rowPill,
  trackPill,
} from "./fileCheck.js";
import { normalizeEntry } from "./library.js";

const file = (extra = {}) =>
  normalizeEntry({
    key: "A/a.mp3",
    filename: "a.mp3",
    folder: "A",
    title: "Numb",
    artist: "Linkin Park",
    duration_s: 187,
    kind: "audio",
    has_audio: true,
    ...extra,
  });
const rec = (verdict, extra = {}) => file({ verdict, meta_src: "itunes", file_src: "youtube", ...extra });
const legacy = file();

describe("checkOf", () => {
  it("maps the four stored verdicts, unknown to unv", () => {
    expect(checkOf(rec("match"))).toBe("match");
    expect(checkOf(rec("partial"))).toBe("partial");
    expect(checkOf(rec("mismatch"))).toBe("mismatch");
    expect(checkOf(rec("unknown"))).toBe("unv");
  });

  it("is null for a legacy file, a value it does not know, or a video", () => {
    expect(checkOf(legacy)).toBeNull();
    expect(checkOf(rec("quizas"))).toBeNull();
    expect(checkOf(rec("match", { kind: "video" }))).toBeNull();
    expect(checkOf(null)).toBeNull();
  });
});

describe("rowPill (phone rows)", () => {
  it("speaks only when something is not right", () => {
    expect(rowPill(rec("partial"))).toBe("partial");
    expect(rowPill(rec("mismatch"))).toBe("mismatch");
    expect(rowPill(rec("unknown"))).toBe("unv");
  });

  it("is silent for a match, a legacy file and a video", () => {
    expect(rowPill(rec("match"))).toBeNull();
    expect(rowPill(legacy)).toBeNull();
    expect(rowPill(rec("mismatch", { kind: "video" }))).toBeNull();
  });
});

describe("filePill", () => {
  it("a legacy file is Sin verificar", () => {
    expect(filePill(legacy)).toBe("unv");
  });

  it("keeps the stored verdict and gives nothing to a video", () => {
    expect(filePill(rec("match"))).toBe("match");
    expect(filePill(rec("match", { kind: "video" }))).toBeNull();
    expect(filePill(undefined)).toBeNull();
  });
});

describe("trackPill", () => {
  it("a 30 s preview is Solo 30 s by its kind", () => {
    expect(trackPill({ kind: "preview" }, undefined)).toBe("p30");
  });

  it("a library track takes its file's pill, legacy included", () => {
    expect(trackPill({ kind: "library" }, rec("partial"))).toBe("partial");
    expect(trackPill({ kind: "library" }, legacy)).toBe("unv");
  });

  it("nothing for a track that is gone, a video or no track", () => {
    expect(trackPill({ kind: "library" }, undefined)).toBeNull();
    expect(trackPill({ kind: "library" }, rec("match", { kind: "video" }))).toBeNull();
    expect(trackPill(null, undefined)).toBeNull();
  });
});

describe("provText", () => {
  it("names one source when ficha and file agree", () => {
    expect(provText(file({ meta_src: "archive" }))).toBe("Internet Archive");
    expect(provText(file({ meta_src: "archive", file_src: "archive" }))).toBe("Internet Archive");
  });

  it("names both when they differ", () => {
    expect(provText(rec("match"))).toBe("Ficha: iTunes · Archivo: YouTube");
  });

  it("is empty without a record or with a source it does not know", () => {
    expect(provText(legacy)).toBe("");
    expect(provText(file({ meta_src: "napster" }))).toBe("");
    expect(provText(null)).toBe("");
  });
});

describe("checkText", () => {
  it("match on the sheet and on the card", () => {
    const e = rec("match", { file_src: undefined, meta_src: "archive" });
    expect(checkText(e)).toBe("Leímos las etiquetas del audio: es «Numb», igual que la ficha.");
    expect(checkText(e, { card: true })).toBe("El audio es «Numb», 3:07, igual que la ficha.");
  });

  it("match from YouTube compares the video title, not tags", () => {
    expect(checkText(rec("match"))).toBe("El título del vídeo coincide con la ficha: «Numb».");
    expect(checkText(rec("match"), { card: true })).toBe("El título del vídeo coincide con la ficha: «Numb».");
  });

  it("the card leaves out the time when the duration is unknown", () => {
    const e = rec("match", { file_src: undefined, duration_s: undefined });
    expect(checkText(e, { card: true })).toBe("El audio es «Numb», igual que la ficha.");
  });

  it("partial and mismatch say what the file says", () => {
    expect(checkText(rec("partial", { real: "Numb (Live)" }))).toBe("En el archivo dice «Numb (Live)».");
    expect(checkText(rec("mismatch", { real: "Otra" }), { card: true })).toBe("En el archivo dice «Otra».");
  });

  it("falls back to the known sentences when the real title is missing", () => {
    expect(checkText(rec("partial"))).toBe("Se parece, pero no es exactamente lo que buscaste.");
    expect(checkText(rec("mismatch"))).toBe("No es lo que buscabas.");
  });

  it("unknown cannot read the title; legacy was never checked", () => {
    expect(checkText(rec("unknown"))).toBe("No se pudo leer el título del audio.");
    expect(checkText(legacy)).toBe("Todavía no se ha comprobado el audio.");
  });
});

describe("albumVerdict", () => {
  it("says nothing when no track has a record", () => {
    expect(albumVerdict([legacy, legacy])).toBe("");
    expect(albumVerdict([])).toBe("");
    expect(albumVerdict(null)).toBe("");
  });

  it("Todo coincide only when every track matches", () => {
    expect(albumVerdict([rec("match"), rec("match")])).toBe("Todo coincide");
    expect(albumVerdict([rec("match")])).toBe("Todo coincide");
  });

  it("counts the matches over all the tracks", () => {
    expect(albumVerdict([rec("match"), rec("partial"), rec("match"), rec("unknown"), rec("mismatch")])).toBe(
      "2 de 5 coinciden"
    );
  });

  it("a track without a record is not a confirmed match", () => {
    expect(albumVerdict([rec("match"), legacy, rec("match")])).toBe("2 de 3 coinciden");
  });

  it("leaves videos out of the count", () => {
    expect(albumVerdict([rec("match"), file({ kind: "video" })])).toBe("Todo coincide");
  });
});

describe("checkedSummary", () => {
  it("never claims anything about a legacy library", () => {
    expect(checkedSummary([legacy, legacy])).toBe("");
    expect(checkedSummary([])).toBe("");
  });

  it("todas comprobadas only when every song was compared", () => {
    expect(checkedSummary([rec("match"), rec("partial"), rec("mismatch")])).toBe("todas comprobadas");
  });

  it("counts the compared ones", () => {
    expect(checkedSummary([rec("match"), legacy, rec("partial"), legacy])).toBe("2 de 4 comprobadas");
  });

  it("an unknown verdict was not compared", () => {
    expect(checkedSummary([rec("unknown"), rec("unknown")])).toBe("");
    expect(checkedSummary([rec("match"), rec("unknown")])).toBe("1 de 2 comprobadas");
  });

  it("videos are not songs here", () => {
    expect(checkedSummary([rec("match"), file({ kind: "video" })])).toBe("todas comprobadas");
    expect(checkedSummary([file({ kind: "video" })])).toBe("");
  });
});
