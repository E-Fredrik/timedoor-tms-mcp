import { describe, expect, it } from "vitest";
import { auditBook, buildBlocks, currentLessonOf, describeBlock, meetingNumber, parseReportRange, pool } from "../src/audit.js";
import { classifyScores, lessonNumberOf, lowScoreRows, quizCheckForBlock, quizCheckForMeeting, type PendingRow } from "../src/scores.js";
import type { MeetingRow } from "../src/reports.js";
import type { TmsSession } from "../src/session.js";

let id = 1;
const mt = (n: number, date: string, lesson?: number): MeetingRow => ({
  id: id++,
  name: `Meeting ${n}`,
  date,
  activities: lesson === undefined ? [] : [{ data: { content: `Lesson ${lesson} - Title` } }],
});
const rep = (name: string, rid = id++) => ({ id: rid, name, status: "approved" });

// One lesson per meeting: meeting n teaches lesson n.
const oneToOne = (upTo: number): MeetingRow[] =>
  Array.from({ length: upTo }, (_, i) => mt(i + 1, `2026-01-${String(i + 1).padStart(2, "0")}`, i + 1));

describe("parsing", () => {
  it("meetingNumber", () => {
    expect(meetingNumber("Meeting 20")).toBe(20);
    expect(meetingNumber("Meeting")).toBeUndefined();
    expect(meetingNumber(undefined)).toBeUndefined();
  });
  it("parseReportRange handles dashes, spacing, case and reversed order", () => {
    expect(parseReportRange("Meeting 1 - Meeting 25")).toEqual({ from: 1, to: 25 });
    expect(parseReportRange("meeting 3–meeting 10")).toEqual({ from: 3, to: 10 });
    expect(parseReportRange("Meeting 9 — Meeting 2")).toEqual({ from: 2, to: 9 });
    expect(parseReportRange("Report for Ali")).toBeUndefined();
    expect(parseReportRange(null)).toBeUndefined();
  });
});

describe("buildBlocks", () => {
  it("builds 8 lesson blocks", () => {
    expect(buildBlocks(8, undefined, 22)).toEqual([
      { block: 1, from_lesson: 1, exam_lesson: 8 },
      { block: 2, from_lesson: 9, exam_lesson: 16 },
    ]);
  });
  it("adds a short final block from the known total", () => {
    const b = buildBlocks(8, 20, 20);
    expect(b.at(-1)).toEqual({ block: 3, from_lesson: 17, exam_lesson: 20 });
  });
  it("no blocks before lesson 8 and no total", () => {
    expect(buildBlocks(8, undefined, 5)).toEqual([]);
  });
  it("exact multiple total adds no extra block", () => {
    expect(buildBlocks(8, 24, 24)).toHaveLength(3);
  });
});

describe("auditBook", () => {
  it("the user's example: lesson 22, only the lesson 1 to 8 report exists, so 9 to 16 is missing", () => {
    const r = auditBook(oneToOne(22), [rep("Meeting 1 - Meeting 8")]);
    expect(r.current_lesson).toBe(22);
    expect(r.blocks.map((b) => b.state)).toEqual(["done", "missing"]);
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0]).toMatchObject({ from_lesson: 9, exam_lesson: 16, end_meeting: 16 });
  });
  it("ignores the portal status field entirely", () => {
    const rows = [{ id: 1, name: "Meeting 1 - Meeting 8", status: "rejected" }];
    expect(auditBook(oneToOne(10), rows).blocks[0].state).toBe("done");
    expect(auditBook(oneToOne(10), []).blocks[0].state).toBe("missing");
  });
  it("one big report covering many meetings counts for every block it spans", () => {
    const r = auditBook(oneToOne(25), [rep("Meeting 1 - Meeting 25")]);
    expect(r.blocks.every((b) => b.state === "done")).toBe(true);
  });
  it("not due yet is upcoming, not missing", () => {
    const r = auditBook(oneToOne(15), []);
    expect(r.blocks.map((b) => b.state)).toEqual(["missing"]);
    const r2 = auditBook(oneToOne(7), []);
    expect(r2.blocks).toEqual([]);
  });
  it("partial: report reaches the exam but starts late", () => {
    const r = auditBook(oneToOne(10), [rep("Meeting 4 - Meeting 8")]);
    expect(r.blocks[0].state).toBe("partial");
    expect(r.missing).toHaveLength(1);
  });
  it("partial: report stops before the exam meeting", () => {
    const r = auditBook(oneToOne(10), [rep("Meeting 1 - Meeting 6")]);
    expect(r.blocks[0].state).toBe("partial");
  });
  it("unlocatable when the exam lesson was never recorded", () => {
    const meetings = [...oneToOne(7), mt(8, "2026-02-01", 9), mt(9, "2026-02-02", 10)];
    const r = auditBook(meetings, []);
    expect(r.blocks[0].state).toBe("unlocatable");
    expect(r.missing).toHaveLength(1);
  });
  it("lesson taught twice uses the most recent meeting", () => {
    const meetings = [...oneToOne(8), mt(9, "2026-03-01", 8)];
    expect(auditBook(meetings, []).blocks[0].end_meeting).toBe(9);
  });
  it("warns about report names it cannot read and does not count them", () => {
    const r = auditBook(oneToOne(10), [rep("Semester report")]);
    expect(r.warnings[0]).toMatch(/cannot read/);
    expect(r.blocks[0].state).toBe("missing");
  });
  it("empty history", () => {
    const r = auditBook([], []);
    expect(r.current_lesson).toBe(0);
    expect(r.blocks).toEqual([]);
  });
  it("meetings without lesson activities are ignored", () => {
    expect(currentLessonOf([mt(1, "2026-01-01"), mt(2, "2026-01-02", 3)])).toBe(3);
  });
  it("rejects a bad span", () => {
    expect(() => auditBook(oneToOne(3), [], { span: 0 })).toThrow();
    expect(() => auditBook(oneToOne(3), [], { span: -2 })).toThrow();
  });
  it("describeBlock wording", () => {
    const r = auditBook(oneToOne(22), []);
    expect(describeBlock(r.missing[0])).toMatch(/NO report for Lessons 1 to 8/);
  });
});

describe("pool", () => {
  it("keeps order, isolates errors, and respects concurrency", async () => {
    let live = 0;
    let peak = 0;
    const out = await pool([1, 2, 3, 4, 5], 2, async (n) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      if (n === 3) throw new Error("boom");
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(out.map((x) => (x.ok ? x.value : "err"))).toEqual([2, 4, "err", 8, 10]);
  });
  it("empty input", async () => {
    expect(await pool([], 3, async () => 1)).toEqual([]);
  });
});

describe("scores", () => {
  it("classifies low, unscored and ok", () => {
    const c = classifyScores([
      { name: "Lesson 1 - A", score: 74 },
      { name: "Lesson 2 - B", score: 75 },
      { name: "Lesson 3 - C", score: 0 },
      { name: "Lesson 4 - D", score: null },
      { name: "Lesson 5 - E" },
      { name: "Lesson 6 - F", score: 100 },
      { name: "Lesson 7 - G", score: 0.5 },
    ]);
    expect(c.low).toEqual([
      { lesson: "Lesson 1 - A", score: 74 },
      { lesson: "Lesson 7 - G", score: 0.5 },
    ]);
    expect(c.unscored).toEqual(["Lesson 3 - C", "Lesson 4 - D", "Lesson 5 - E"]);
  });
  it("handles undefined, NaN and negatives", () => {
    expect(classifyScores(undefined)).toMatchObject({ low: [], unscored: [] });
    expect(classifyScores([{ name: "x", score: NaN }, { name: "y", score: -5 }]).unscored).toEqual(["x", "y"]);
  });
  it("custom threshold", () => {
    expect(classifyScores([{ name: "a", score: 80 }], 90).low).toHaveLength(1);
  });
  it("lessonNumberOf", () => {
    expect(lessonNumberOf("Lesson 22 - X")).toBe(22);
    expect(lessonNumberOf("Review")).toBeUndefined();
  });

  const row = (sid: number, mid: number, lessons: PendingRow["lessons"], bookId = 5): PendingRow => ({
    student: { id: sid, name: "Ali" },
    learning_session_book_meeting_id: mid,
    learning_session_book_id: bookId,
    learning_session_id: 1,
    meeting_date: "2026-10-24",
    lessons,
  });
  const fake = (rows: PendingRow[], status = 200): TmsSession =>
    ({ api: async () => ({ status, body: { data: rows, meta: { last_page: 1 } } }) }) as unknown as TmsSession;

  it("lowScoreRows picks only rows with low scores, sorted by date", () => {
    const out = lowScoreRows([row(1, 1, [{ name: "Lesson 1 - A", score: 60 }]), row(2, 2, [{ name: "Lesson 1 - A", score: 90 }])]);
    expect(out).toHaveLength(1);
    expect(out[0].meeting_id).toBe(1);
  });
  it("quizCheckForMeeting warns on a low score", async () => {
    const q = await quizCheckForMeeting(fake([row(1, 10, [{ name: "Lesson 3 - A", score: 60 }])]), 1, 10);
    expect(q.available).toBe(true);
    if (q.available) expect(q.attention).toMatch(/below 75.*Lesson 3 - A = 60/);
  });
  it("quizCheckForMeeting says unavailable when meeting is not pending", async () => {
    const q = await quizCheckForMeeting(fake([]), 1, 10);
    expect(q.available).toBe(false);
  });
  it("quizCheckForMeeting never throws on API failure", async () => {
    const q = await quizCheckForMeeting(fake([], 500), 1, 10);
    expect(q.available).toBe(false);
  });
  it("quizCheckForBlock only counts lessons in the block and book", async () => {
    const rows = [
      row(1, 1, [{ name: "Lesson 2 - A", score: 50 }, { name: "Lesson 12 - B", score: 40 }]),
      row(1, 2, [{ name: "Lesson 3 - C", score: 99 }], 99),
    ];
    const q = await quizCheckForBlock(fake(rows), 1, 5, 1, 8);
    expect(q.available).toBe(true);
    if (q.available) {
      expect(q.low).toEqual([{ lesson: "Lesson 2 - A", score: 50 }]);
      expect(q.lessonsWithScoreData).toBe(1);
      expect(q.lessonsInBlock).toBe(8);
    }
  });
  it("quizCheckForBlock reports no data honestly", async () => {
    const q = await quizCheckForBlock(fake([]), 1, 5, 1, 8);
    expect(q.available).toBe(false);
  });
});

import { auditOneBook, listBooksForStudent } from "../src/audit.js";

describe("fetch layer with a fake portal", () => {
  const meetings = oneToOne(22);
  const api = async (path: string) => {
    if (path.endsWith("/learning-session")) return { status: 200, body: { data: [{ id: 7, latest_learning_session_book_id: 70, total_progress: 22 }], meta: { last_page: 1 } } };
    if (path.endsWith("/book")) return { status: 200, body: { data: [{ id: 60, status: "completed", book: { name: "Old" } }, { id: 70, status: "ongoing", book: { name: "Android" } }], meta: { last_page: 1 } } };
    if (path.endsWith("/meeting-history")) return { status: 200, body: { data: meetings, meta: { last_page: 1 } } };
    if (path.endsWith("/report")) return { status: 200, body: { data: [{ id: 1, name: "Meeting 1 - Meeting 8", status: "approved" }] } };
    return { status: 404, body: {} };
  };
  const session = { api } as unknown as TmsSession;

  it("lists books, keeps total lessons only for the latest book", async () => {
    const books = await listBooksForStudent(session, 1, "Ali");
    expect(books.map((b) => [b.bookId, b.totalLessons])).toEqual([[60, undefined], [70, 22]]);
  });
  it("audits a book end to end and finds the missing 9 to 16 report plus the short final block", async () => {
    const books = await listBooksForStudent(session, 1, "Ali");
    const r = await auditOneBook(session, books[1], 8);
    expect(r.missing.map((m) => `${m.from_lesson}-${m.exam_lesson}`)).toEqual(["9-16", "17-22"]);
    expect(r.blocks.find((b) => b.exam_lesson === 16)?.state).toBe("missing");
  });
  it("a failing report endpoint raises instead of reporting everything as missing", async () => {
    const bad = { api: async (p: string) => (p.endsWith("/report") ? { status: 500, body: {} } : api(p)) } as unknown as TmsSession;
    const books = await listBooksForStudent(bad, 1);
    await expect(auditOneBook(bad, books[1], 8)).rejects.toThrow(/status 500/);
  });
});
