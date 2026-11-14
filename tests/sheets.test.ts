import { describe, expect, it } from "vitest";
import {
  buildSyncPlan,
  chooseStudentRow,
  columnToIndex,
  findStudentRow,
  findStudentRows,
  indexToColumn,
  lessonCells,
  loadSheetSettings,
  namesFromCell,
  normalizeName,
  syncLessonProgress,
  type SheetSettings,
  type SheetsApi,
  parseHexColor,
} from "../src/sheets.js";

const settings: SheetSettings = {
  spreadsheetId: "x",
  tabGid: 123,
  highlightColor: { red: 0, green: 1, blue: 1 },
  nameColumn: "B",
  firstDataRow: 5,
  lesson1DateColumn: "H",
  maxLesson: 32,
};

describe("column helpers", () => {
  it("round-trips column letters", () => {
    for (const letters of ["A", "Z", "AA", "AD", "AZ", "BA", "BX", "ZZ"]) {
      expect(indexToColumn(columnToIndex(letters))).toBe(letters);
    }
  });
  it("rejects bad column letters", () => {
    expect(() => columnToIndex("A1")).toThrow();
    expect(() => columnToIndex("")).toThrow();
    expect(() => indexToColumn(-1)).toThrow();
  });
});

describe("name matching", () => {
  it("normalises case and spacing", () => {
    expect(normalizeName("  Samuel   Surya ")).toBe("samuel surya");
  });
  it("matches full name and bracketed nickname", () => {
    const cell = "Samuel Adi Nugroho (Samuel)";
    expect(namesFromCell(cell)).toContain("samuel adi nugroho");
    expect(namesFromCell(cell)).toContain("samuel");
  });
  it("handles a name cell with a line break", () => {
    expect(namesFromCell("Kevin Budi Hartono\n(Kevin)")).toContain("kevin");
  });
  it("finds one row by full name or nickname, ignoring case", () => {
    const cells = ["Kevin Budi Hartono (Kevin)", "Samuel Adi Nugroho (Samuel)"];
    expect(findStudentRow(cells, 5, "samuel adi NUGROHO")).toBe(6);
    expect(findStudentRow(cells, 5, "Kevin")).toBe(5);
  });
  it("throws when no student matches", () => {
    expect(() => findStudentRow(["Kevin (Kevin)"], 5, "Mun")).toThrow(/No student named/);
  });
  it("throws when the name is ambiguous", () => {
    const cells = ["Ana Lim (Ana)", "Ana Putri (Ana)"];
    expect(() => findStudentRow(cells, 5, "Ana")).toThrow(/matches 2 rows/);
  });
  it("throws on an empty name", () => {
    expect(() => findStudentRow(["Kevin (Kevin)"], 5, "   ")).toThrow(/empty/);
  });
  it("does not match a partial first name", () => {
    expect(() => findStudentRow(["Kevin Budi Hartono (Kevin)"], 5, "Kev")).toThrow(/No student/);
  });
});

describe("lesson cells", () => {
  it("lesson 1 uses the first date column and the next for progress", () => {
    expect(lessonCells(settings, 1)).toEqual({ date: "H", progress: "I" });
  });
  it("lesson 2 starts two columns later", () => {
    expect(lessonCells(settings, 2)).toEqual({ date: "J", progress: "K" });
  });
  it("lesson 32 works and lesson 33 or 0 is rejected", () => {
    expect(lessonCells(settings, 32).date).toBe(indexToColumn(columnToIndex("H") + 62));
    expect(() => lessonCells(settings, 33)).toThrow();
    expect(() => lessonCells(settings, 0)).toThrow();
    expect(() => lessonCells(settings, 1.5)).toThrow();
  });
});

describe("buildSyncPlan", () => {
  const base = { studentName: "Kevin", teacherNotes: "Good progress", overwrite: false };

  it("not finished: no colour, note in the lesson the student is on", () => {
    const plan = buildSyncPlan(settings, 5, { ...base, lesson: 3, finished: false }, "");
    expect(plan.highlightRanges).toEqual([]);
    expect(plan.highlightLesson).toBeNull();
    expect(plan.noteLesson).toBe(3);
    expect(plan.noteRange).toBe(`${lessonCells(settings, 3).progress}5`);
  });

  it("finished: colours date and progress of that lesson, note goes to the next lesson", () => {
    const plan = buildSyncPlan(settings, 5, { ...base, lesson: 3, finished: true }, "");
    expect(plan.highlightLesson).toBe(3);
    expect(plan.highlightRanges).toEqual([`${lessonCells(settings, 3).date}5`, `${lessonCells(settings, 3).progress}5`]);
    expect(plan.noteLesson).toBe(4);
    expect(plan.noteRange).toBe(`${lessonCells(settings, 4).progress}5`);
  });

  it("finished lesson 32 has no next lesson and throws", () => {
    expect(() => buildSyncPlan(settings, 5, { ...base, lesson: 32, finished: true }, "")).toThrow(/last lesson/);
  });

  it("refuses to replace a different existing note unless overwrite is set", () => {
    expect(() => buildSyncPlan(settings, 5, { ...base, lesson: 3, finished: false }, "old note")).toThrow(/already has text/);
    const plan = buildSyncPlan(settings, 5, { ...base, lesson: 3, finished: false, overwrite: true }, "old note");
    expect(plan.note).toBe("Good progress");
  });

  it("an identical existing note is not a conflict", () => {
    expect(() => buildSyncPlan(settings, 5, { ...base, lesson: 3, finished: false }, "Good progress")).not.toThrow();
  });

  it("rejects empty teacher notes", () => {
    expect(() => buildSyncPlan(settings, 5, { ...base, teacherNotes: "", lesson: 3, finished: false }, "")).toThrow();
  });
});

describe("syncLessonProgress", () => {
  function fakeApi(nameCells: string[], noteValue: string) {
    const calls: { fill: string[][]; writes: [string, string][] } = { fill: [], writes: [] };
    const api: SheetsApi = {
      async readRange(range: string) {
        if (range.startsWith("B")) return nameCells.map((c) => [c]);
        return [[noteValue]];
      },
      async writeValue(range, value) {
        calls.writes.push([range, value]);
      },
      async fillColor(ranges) {
        calls.fill.push(ranges);
      },
    };
    return { api, calls };
  }

  it("dry run never writes", async () => {
    const { api, calls } = fakeApi(["Kevin (Kevin)"], "");
    const r = await syncLessonProgress(api, settings, { studentName: "Kevin", lesson: 2, finished: true, teacherNotes: "ok", overwrite: false }, { dryRun: true });
    expect(r.written).toBe(false);
    expect(calls.fill).toEqual([]);
    expect(calls.writes).toEqual([]);
    expect(r.note_cell).toBe(`${lessonCells(settings, 3).progress}5`);
  });

  it("live run colours then writes the note", async () => {
    const { api, calls } = fakeApi(["Kevin (Kevin)"], "");
    await syncLessonProgress(api, settings, { studentName: "Kevin", lesson: 2, finished: true, teacherNotes: "ok", overwrite: false }, { dryRun: false });
    expect(calls.fill.length).toBe(1);
    expect(calls.writes).toEqual([[`${lessonCells(settings, 3).progress}5`, "ok"]]);
  });

  it("writes nothing when the student is not found", async () => {
    const { api, calls } = fakeApi(["Kevin (Kevin)"], "");
    await expect(
      syncLessonProgress(api, settings, { studentName: "Nobody", lesson: 2, finished: true, teacherNotes: "ok", overwrite: false }, { dryRun: false }),
    ).rejects.toThrow(/No student/);
    expect(calls.fill).toEqual([]);
    expect(calls.writes).toEqual([]);
  });
});

describe("loadSheetSettings", () => {
  const env = {
    TMS_SHEET_ID: "abc",
    TMS_SHEET_GID: "123",
    TMS_SHEET_HIGHLIGHT_COLOR: "#00FF80",
    TMS_SHEET_FIRST_ROW: "5",
    TMS_SHEET_LESSON1_DATE_COLUMN: "h",
    TMS_SHEET_CREDENTIALS: "/secret/key.json",
  } as NodeJS.ProcessEnv;

  it("reads the tab and colour, defaults name column and sync to off", () => {
    const s = loadSheetSettings(env);
    expect(s.tabGid).toBe(123);
    expect(s.highlightColor).toEqual({ red: 0, green: 1, blue: 128 / 255 });
    expect(s.nameColumn).toBe("B");
    expect(s.lesson1DateColumn).toBe("H");
    expect(s.syncEnabled).toBe(false);
  });
  it("turns sync on only for the exact value true", () => {
    expect(loadSheetSettings({ ...env, TMS_SHEET_SYNC_ENABLED: "true" }).syncEnabled).toBe(true);
    expect(loadSheetSettings({ ...env, TMS_SHEET_SYNC_ENABLED: "yes" }).syncEnabled).toBe(false);
  });
  it("names the missing variable", () => {
    expect(() => loadSheetSettings({ ...env, TMS_SHEET_ID: "" })).toThrow(/TMS_SHEET_ID/);
  });
  it("has no built-in tab or colour: each teacher sets their own", () => {
    expect(() => loadSheetSettings({ ...env, TMS_SHEET_GID: "" })).toThrow(/TMS_SHEET_GID/);
    expect(() => loadSheetSettings({ ...env, TMS_SHEET_HIGHLIGHT_COLOR: "" })).toThrow(/TMS_SHEET_HIGHLIGHT_COLOR/);
    expect(() => loadSheetSettings({ ...env, TMS_SHEET_HIGHLIGHT_COLOR: "cyan" })).toThrow(/hex colour/);
    expect(parseHexColor("00ffff")).toEqual({ red: 0, green: 1, blue: 1 });
  });
});

import { pickFinishedLesson, syncAfterJournalSave } from "../src/sheets.js";

describe("pickFinishedLesson", () => {
  it("returns null when there are no lessons", () => {
    expect(pickFinishedLesson(undefined)).toBeNull();
    expect(pickFinishedLesson([])).toBeNull();
  });
  it("returns the lesson at 100 and ignores lessons still in progress", () => {
    expect(pickFinishedLesson([{ name: "Lesson 13 - Enemies", progress: 100 }, { name: "Lesson 14 - Next", progress: 40 }])).toBe(13);
  });
  it("picks the highest lesson at 100 when several are complete", () => {
    expect(pickFinishedLesson([{ name: "Lesson 12 - A", progress: 100 }, { name: "Lesson 13 - B", progress: 100 }])).toBe(13);
  });
  it("does not count 99 or 99.9 as finished", () => {
    expect(pickFinishedLesson([{ name: "Lesson 5 - X", progress: 99 }, { name: "Lesson 6 - Y", progress: 99.9 }])).toBeNull();
  });
  it("ignores lesson names without a Lesson number", () => {
    expect(pickFinishedLesson([{ name: "Project week", progress: 100 }])).toBeNull();
  });
  it("ignores progress stored as text, so it does not guess", () => {
    expect(pickFinishedLesson([{ name: "Lesson 3 - Z", progress: "100" as unknown as number }])).toBeNull();
  });
});

describe("syncAfterJournalSave", () => {
  it("skips without touching the sheet when nothing is at 100", async () => {
    const r = await syncAfterJournalSave("Kevin", [{ name: "Lesson 2 - A", progress: 50 }], "note", {});
    expect(r.status).toBe("skipped");
  });
  it("reports failure instead of throwing when Google credentials are missing", async () => {
    const r = await syncAfterJournalSave("Kevin", [{ name: "Lesson 2 - A", progress: 100 }], "note", {});
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/TMS_SHEET_ID|not set/);
  });
});

// Row selection (explicit row, and picking among duplicate names) ---------

/** Fake sheet: name column B holds nameCells from row 5; notes maps a row number to its note cell value. */
function sheetApi(nameCells: string[], notes: Record<number, string> = {}) {
  const calls: { fill: string[][]; writes: [string, string][]; reads: string[] } = { fill: [], writes: [], reads: [] };
  const api: SheetsApi = {
    async readRange(range: string) {
      calls.reads.push(range);
      if (range.includes(":")) return nameCells.map((c) => [c]);
      const row = Number(range.replace(/^[A-Z]+/, ""));
      return [[notes[row] ?? ""]];
    },
    async writeValue(range, value) {
      calls.writes.push([range, value]);
    },
    async fillColor(ranges) {
      calls.fill.push(ranges);
    },
  };
  return { api, calls };
}

const base = { lesson: 3, finished: false, teacherNotes: "Good progress", overwrite: false };

describe("findStudentRows", () => {
  it("returns every matching row, not just one", () => {
    expect(findStudentRows(["Ana Lim (Ana)", "Kevin (Kevin)", "Ana Lim (Ana)"], 5, "Ana Lim")).toEqual([5, 7]);
  });
  it("returns an empty list when nothing matches", () => {
    expect(findStudentRows(["Kevin (Kevin)"], 5, "Nobody")).toEqual([]);
  });
});

describe("explicit row (option 1)", () => {
  it("uses the given row when its name cell contains the student name", async () => {
    const cells = ["Ana Lim (Ana)", "Ana Lim (Ana)"];
    const { api } = sheetApi(cells);
    const c = await chooseStudentRow(api, settings, cells, { ...base, studentName: "Ana Lim", row: 6 });
    expect(c).toEqual({ row: 6, selected_by: "row", candidate_rows: [6] });
  });
  it("matches a portal name longer than the sheet nickname form", async () => {
    const cells = ["Rama Putra Santoso (Rama)"];
    const { api } = sheetApi(cells);
    const c = await chooseStudentRow(api, settings, cells, { ...base, studentName: "Rama Putra Santoso", row: 5 });
    expect(c.row).toBe(5);
  });
  it("refuses a row whose name is a different student and writes nothing", async () => {
    const cells = ["Kevin (Kevin)", "Ana Lim (Ana)"];
    const { api, calls } = sheetApi(cells);
    await expect(
      syncLessonProgress(api, settings, { ...base, studentName: "Ana Lim", row: 5 }, { dryRun: false }),
    ).rejects.toThrow(/does not belong to "Ana Lim"/);
    expect(calls.writes).toEqual([]);
    expect(calls.fill).toEqual([]);
  });
  it("refuses a blank name cell", async () => {
    const cells = ["", "Kevin (Kevin)"];
    const { api } = sheetApi(cells);
    await expect(chooseStudentRow(api, settings, cells, { ...base, studentName: "Kevin", row: 5 })).rejects.toThrow(/does not belong/);
  });
  it("refuses a row above the first data row", async () => {
    const cells = ["Kevin (Kevin)"];
    const { api } = sheetApi(cells);
    await expect(chooseStudentRow(api, settings, cells, { ...base, studentName: "Kevin", row: 4 })).rejects.toThrow(/at least 5/);
  });
  it("refuses a row past the end of the name column", async () => {
    const cells = ["Kevin (Kevin)"];
    const { api } = sheetApi(cells);
    await expect(chooseStudentRow(api, settings, cells, { ...base, studentName: "Kevin", row: 9 })).rejects.toThrow(/has no name/);
  });
  it("refuses a fractional row", async () => {
    const cells = ["Kevin (Kevin)"];
    const { api } = sheetApi(cells);
    await expect(chooseStudentRow(api, settings, cells, { ...base, studentName: "Kevin", row: 5.5 })).rejects.toThrow(/whole number/);
  });
  it("an explicit row wins even when the name is duplicated", async () => {
    const cells = ["Ana Lim (Ana)", "Ana Lim (Ana)"];
    const { api } = sheetApi(cells);
    const c = await chooseStudentRow(api, settings, cells, { ...base, studentName: "Ana Lim", row: 5 });
    expect(c.selected_by).toBe("row");
    expect(c.row).toBe(5);
  });
  it("live run writes the note to the chosen row only", async () => {
    const cells = ["Ana Lim (Ana)", "Ana Lim (Ana)"];
    const { api, calls } = sheetApi(cells);
    const r = await syncLessonProgress(api, settings, { ...base, studentName: "Ana Lim", row: 6 }, { dryRun: false });
    expect(r.student_row).toBe(6);
    expect(calls.writes).toEqual([[`${lessonCells(settings, 3).progress}6`, "Good progress"]]);
  });
  it("finished with a row colours that row and writes the note to the next lesson", async () => {
    const cells = ["Ana Lim (Ana)", "Ana Lim (Ana)"];
    const { api, calls } = sheetApi(cells);
    await syncLessonProgress(api, settings, { ...base, finished: true, studentName: "Ana Lim", row: 6 }, { dryRun: false });
    expect(calls.fill).toEqual([[`${lessonCells(settings, 3).date}6`, `${lessonCells(settings, 3).progress}6`]]);
    expect(calls.writes).toEqual([[`${lessonCells(settings, 4).progress}6`, "Good progress"]]);
  });
});

describe("duplicate names without a row (option 3)", () => {
  it("picks the one matching row whose note cell is empty and reports the candidates", async () => {
    const cells = ["Ana Lim (Ana)", "Kevin (Kevin)", "Ana Lim (Ana)"];
    const { api } = sheetApi(cells, { 5: "old note", 7: "" });
    const c = await chooseStudentRow(api, settings, cells, { ...base, studentName: "Ana Lim", pickByEmptyNote: true });
    expect(c).toEqual({ row: 7, selected_by: "empty_note", candidate_rows: [5, 7] });
  });
  it("refuses when no matching row has an empty note cell", async () => {
    const cells = ["Ana Lim (Ana)", "Ana Lim (Ana)"];
    const { api } = sheetApi(cells, { 5: "a", 6: "b" });
    await expect(
      chooseStudentRow(api, settings, cells, { ...base, studentName: "Ana Lim", pickByEmptyNote: true }),
    ).rejects.toThrow(/0 of them have an empty note cell/);
  });
  it("refuses when more than one matching row has an empty note cell", async () => {
    const cells = ["Ana Lim (Ana)", "Ana Lim (Ana)"];
    const { api } = sheetApi(cells, { 5: "", 6: "" });
    await expect(
      chooseStudentRow(api, settings, cells, { ...base, studentName: "Ana Lim", pickByEmptyNote: true }),
    ).rejects.toThrow(/2 of them have an empty note cell/);
  });
  it("refuses when picking is not allowed (automatic sync after a journal save)", async () => {
    const cells = ["Ana Lim (Ana)", "Ana Lim (Ana)"];
    const { api, calls } = sheetApi(cells, { 5: "", 6: "" });
    await expect(
      syncLessonProgress(api, settings, { ...base, studentName: "Ana Lim" }, { dryRun: false }),
    ).rejects.toThrow(/matches 2 rows \(5, 6\). Pass row/);
    expect(calls.writes).toEqual([]);
  });
  it("checks the note cell of the lesson being written, not the one before", async () => {
    const cells = ["Ana Lim (Ana)", "Ana Lim (Ana)"];
    const { api } = sheetApi(cells, { 5: "", 6: "x" });
    // finished lesson 3 writes its note to lesson 4, so row 5 (empty there) is the only candidate
    const c = await chooseStudentRow(api, settings, cells, { ...base, finished: true, studentName: "Ana Lim", pickByEmptyNote: true });
    expect(c.row).toBe(5);
  });
  it("refuses cleanly when the finished lesson is the last one", async () => {
    const cells = ["Ana Lim (Ana)", "Ana Lim (Ana)"];
    const { api } = sheetApi(cells);
    await expect(
      chooseStudentRow(api, settings, cells, { ...base, lesson: 32, finished: true, studentName: "Ana Lim", pickByEmptyNote: true }),
    ).rejects.toThrow(/matches 2 rows/);
  });
  it("live run writes to the picked row", async () => {
    const cells = ["Ana Lim (Ana)", "Ana Lim (Ana)"];
    const { api, calls } = sheetApi(cells, { 5: "old", 6: "" });
    const r = await syncLessonProgress(api, settings, { ...base, studentName: "Ana Lim", pickByEmptyNote: true }, { dryRun: false });
    expect(r.student_row).toBe(6);
    expect(r.row_selected_by).toBe("empty_note");
    expect(calls.writes).toEqual([[`${lessonCells(settings, 3).progress}6`, "Good progress"]]);
  });
});
