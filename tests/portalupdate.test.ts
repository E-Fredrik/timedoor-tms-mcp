import { describe, expect, it } from "vitest";
import { auditBook, parseLessonReportRange } from "../src/audit.js";
import { getLessonAccess, planAccess, setLessonAccess } from "../src/lessonaccess.js";
import { checkReadPath, MAX_BODY_CHARS, portalGet } from "../src/portalget.js";
import { createReport, parseReportInput, prepareReport } from "../src/reportcreate.js";
import type { TmsSession } from "../src/session.js";

// ---------- lesson lock and unlock ----------

/** Fake portal: one book (course book 123) with 2 chapters of 2 lessons, lessons 1 and 2 unlocked. */
function fakeBook(opts: { refuse?: boolean; ignoreWrites?: boolean } = {}) {
  const lessons = [1, 2, 3, 4].map((n) => ({ uuid: `u${n}`, title: `Lesson ${n} - T${n}`, position: ((n - 1) % 2) + 1, parent: n <= 2 ? "c1" : "c2" }));
  let open = new Set(["u1", "u2"]);
  const writes: Array<{ method: string; path: string; body: any }> = [];
  const api = async (path: string, query?: Record<string, unknown>) => {
    if (path === "/api/cms/student/7/learning-session/8/book/9") return { status: 200, body: { data: { status: "ongoing", book: { id: 123, name: "Book", lang: "id", course: { id: 21 } } } } };
    if (path === "/api/v2/tms/book/123/content") {
      const data = query?.parent_uuid
        ? lessons.filter((l) => l.parent === query.parent_uuid).reverse() // out of order on purpose
        : [{ uuid: "c2", title: "Chapter 2", position: 2, has_children: true }, { uuid: "c1", title: "Chapter 1", position: 1, has_children: true }];
      return { status: 200, body: { data } };
    }
    if (path === "/api/v2/tms/student/7/book/123/access") return { status: 200, body: { data: { uuids: [...open] } } };
    if (path === "/api/v2/tms/student/7/book/123/progress-detail")
      return { status: 200, body: { data: { stats: { learnable: { total: 4, finished: 1 } }, progresses: [{ uuid: "u1", progress_percentage: 100, detail: { is_finished: true } }, { uuid: "u2", progress_percentage: 40, detail: null }] } } };
    return { status: 404, body: {} };
  };
  const apiSend = async (method: string, path: string, payload: any) => {
    writes.push({ method, path, body: payload.json });
    if (opts.refuse) return { status: 403, body: { message: "no" } };
    if (!opts.ignoreWrites) for (const u of payload.json.uuids) method === "POST" ? open.add(u) : open.delete(u);
    return { status: 200, body: {} };
  };
  return { s: { api, apiSend } as unknown as TmsSession, writes };
}
const REF = { studentId: 7, sessionId: 8, bookId: 9 };

describe("lesson access", () => {
  it("reads lessons in chapter and position order with lock state and progress", async () => {
    const d = await getLessonAccess(fakeBook().s, REF);
    expect(d.lessons.map((l) => [l.lesson, l.chapter, l.unlocked, l.progress_percentage, l.finished])).toEqual([
      [1, "Chapter 1", true, 100, true],
      [2, "Chapter 1", true, 40, false],
      [3, "Chapter 2", false, 0, false],
      [4, "Chapter 2", false, 0, false],
    ]);
  });

  it("plans like the portal buttons: unlock sends first..target, lock sends target..last", async () => {
    const { lessons } = await getLessonAccess(fakeBook().s, REF);
    const up = planAccess(lessons, "unlock_through", 3);
    expect(up.send.map((l) => l.lesson)).toEqual([1, 2, 3]);
    expect(up.changes.map((l) => l.lesson)).toEqual([3]);
    const down = planAccess(lessons, "lock_from", 2);
    expect(down.send.map((l) => l.lesson)).toEqual([2, 3, 4]);
    expect(down.changes.map((l) => l.lesson)).toEqual([2]);
    expect(() => planAccess(lessons, "unlock_through", 9)).toThrow(/No Lesson 9/);
  });

  it("previews without confirm and sends nothing", async () => {
    const f = fakeBook();
    const out = await setLessonAccess(f.s, REF, "unlock_through", 3, false);
    expect(out.sent).toBe(false);
    expect(out.will_unlock).toEqual(["Lesson 3 - T3"]);
    expect(f.writes).toHaveLength(0);
  });

  it("unlocks with POST of every lesson up to the target and verifies", async () => {
    const f = fakeBook();
    const out = await setLessonAccess(f.s, REF, "unlock_through", 3, true);
    expect(f.writes).toEqual([{ method: "POST", path: "/api/v2/tms/student/7/book/123/access", body: { uuids: ["u1", "u2", "u3"] } }]);
    expect(out).toMatchObject({ sent: true, verified: true, unlocked_now: [1, 2, 3] });
  });

  it("locks with DELETE from the target on, and warns when the student has progress there", async () => {
    const f = fakeBook();
    const out = await setLessonAccess(f.s, REF, "lock_from", 2, true);
    expect(f.writes[0]).toMatchObject({ method: "DELETE", body: { uuids: ["u2", "u3", "u4"] } });
    expect(out.warning).toMatch(/Lesson 2/);
    expect(out).toMatchObject({ verified: true, unlocked_now: [1] });
  });

  it("does nothing when already in that state, reports a refusal, and reports a write that did not stick", async () => {
    const same = fakeBook();
    expect((await setLessonAccess(same.s, REF, "unlock_through", 2, true)).sent).toBe(false);
    expect(same.writes).toHaveLength(0);
    await expect(setLessonAccess(fakeBook({ refuse: true }).s, REF, "unlock_through", 4, true)).rejects.toThrow(/refused the unlock \(status 403\)/);
    const stuck = await setLessonAccess(fakeBook({ ignoreWrites: true }).s, REF, "unlock_through", 3, true);
    expect(stuck).toMatchObject({ sent: true, verified: false, not_changed: ["Lesson 3 - T3"] });
  });
});

// ---------- lesson based reports ----------

const CRITERIA = [{ id: 14, name: "Logic", templates: [{ lang: "id", content: "(student_name) ..." }] }, { id: 15, name: "Creativity", templates: [] }];
const NOTE = "Siswa sudah mampu membuat program dengan baik dan juga belajar menggunakan variabel untuk game.";
const args = (over: Record<string, unknown> = {}) => parseReportInput({ student_id: 1, learning_session_id: 2, book_id: 3, exam_lesson: 16, criteria: CRITERIA.map((c) => ({ id: c.id, score: 80, note: NOTE })), ...over });
const row = (n: number, extra: Record<string, unknown> = {}) => ({ lesson_number: n, title: `Lesson ${n} - X`, meeting_name: "Meeting 5", journal_status: "sent", journal_id: 500 + n, score: 80, progress_percentage: 100, ...extra });

function fakeReports(w: { notEligible?: unknown[]; eligible?: unknown[]; reported?: boolean; postStatus?: number } = {}) {
  const writes: Array<{ method: string; path: string; body: any }> = [];
  let reportId: number | undefined = w.reported ? 77 : undefined;
  const api = async (path: string, query?: Record<string, unknown>) => {
    if (path.endsWith("/report-criteria")) return { status: 200, body: { data: CRITERIA } };
    if (path.includes("/api/cms/student/") && /\/book\/\d+$/.test(path)) return { status: 200, body: { data: { status: "ongoing", book: { id: 123, name: "Book", lang: "id", course: { id: 21 } } } } };
    if (path.endsWith("/report/lessons")) {
      const ranges = [{ from: 1, until: 8, report_id: 5 }, { from: 9, until: 16, ...(reportId ? { report_id: reportId } : {}) }];
      const sections = query?.from
        ? { eligible: w.eligible ?? [row(9), row(10, { score: 60 })], not_eligible: w.notEligible ?? [], meetings_without_lesson: [{ meeting_name: "Meeting 4", journal_id: 900, selectable: true }, { meeting_name: "Meeting 3", journal_id: 901, selectable: false }], can_submit: !(w.notEligible ?? []).length }
        : { eligible: [], not_eligible: [], meetings_without_lesson: [], can_submit: false };
      return { status: 200, body: { data: { is_lesson_based: true, ranges, ...sections } } };
    }
    return { status: 404, body: {} };
  };
  const apiSend = async (method: string, path: string, payload: any) => {
    writes.push({ method, path, body: payload.json });
    if ((w.postStatus ?? 201) < 400) reportId = 88;
    return { status: w.postStatus ?? 201, body: { message: "bad" } };
  };
  return { s: { api, apiSend } as unknown as TmsSession, writes };
}

describe("lesson based report", () => {
  it("prepare shows the range, ready lessons, low scores and the extra meeting", async () => {
    const p: any = await prepareReport(fakeReports().s, args({ criteria: undefined }));
    expect(p).toMatchObject({ report_name: "Lesson 9 - Lesson 16", mode: "lesson_based", can_submit: true, language: "id", criteria_count: 2, extra_meetings_included: ["Meeting 4"] });
    expect(p.lessons_ready.map((l: any) => l.lesson)).toEqual([9, 10]);
    expect(p.quiz_scores_below_threshold).toEqual([{ lesson: "Lesson 10 - X", score: 60 }]);
    expect(p.warnings).toEqual([]);
  });

  it("prepare warns, and create refuses, while a lesson has no journal", async () => {
    const w = { notEligible: [row(11, { meeting_name: "", journal_status: "" })] };
    const p: any = await prepareReport(fakeReports(w).s, args({ criteria: undefined }));
    expect(p.warnings.join(" ")).toMatch(/Lesson 11 \(no meeting yet\)/);
    const f = fakeReports(w);
    await expect(createReport(f.s, args(), true)).rejects.toThrow(/no daily journal: Lesson 11/);
    expect(f.writes).toHaveLength(0);
  });

  it("create previews without confirm, then posts the portal's lesson body and verifies the range got a report", async () => {
    const f = fakeReports();
    const pre: any = await createReport(f.s, args(), false);
    expect(pre.created).toBe(false);
    expect(f.writes).toHaveLength(0);
    const out: any = await createReport(f.s, args(), true);
    expect(f.writes).toEqual([{
      method: "POST",
      path: "/api/tms/student/1/learning-session/2/book/3/report",
      body: { learning_session_book_meeting_journal_ids: [], lesson_from: 9, lesson_until: 16, meeting_journal_ids_without_lesson: [900], criterias: CRITERIA.map((c) => ({ id: c.id, score: 80, note: NOTE })) },
    }]);
    expect(out).toMatchObject({ created: true, report_id: 88, report_name: "Lesson 9 - Lesson 16" });
  });

  it("refuses a duplicate, an empty range, a lesson outside every range, meeting numbers, and a portal rejection", async () => {
    await expect(createReport(fakeReports({ reported: true }).s, args(), true)).rejects.toThrow(/already exists \(id 77\)/);
    await expect(createReport(fakeReports().s, args({ exam_lesson: 8 }), true)).rejects.toThrow(/already exists \(id 5\)/);
    const empty = fakeReports({ eligible: [] });
    (empty.s as any).api = ((orig) => async (p: string, q?: any) => { const r = await orig(p, q); if (q?.from) (r.body as any).data.meetings_without_lesson = []; return r; })((empty.s as any).api);
    await expect(createReport(empty.s, args(), true)).rejects.toThrow(/nothing to report/);
    await expect(createReport(fakeReports().s, args({ exam_lesson: 40 }), true)).rejects.toThrow(/No report range contains Lesson 40/);
    await expect(createReport(fakeReports().s, args({ exam_lesson: undefined, from_meeting: 1, until_meeting: 4 }), true)).rejects.toThrow(/Pass exam_lesson/);
    await expect(createReport(fakeReports({ postStatus: 422 }).s, args(), true)).rejects.toThrow(/rejected the report \(status 422\)/);
  });
});

// ---------- report gap check with lesson named reports ----------

describe("auditBook with lesson based report names", () => {
  const meetings = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `Meeting ${i + 1}`, date: `2026-01-${String(i + 1).padStart(2, "0")}`, activities: [{ data: { content: `Lesson ${i + 1} - T` } }] }));
  it("parses the name and counts the block as done", () => {
    expect(parseLessonReportRange("Lesson 9 - Lesson 16")).toEqual({ from: 9, to: 16 });
    expect(parseLessonReportRange("Meeting 1 - Meeting 8")).toBeUndefined();
    const r = auditBook(meetings as any, [{ id: 1, name: "Lesson 1 - Lesson 8" }]);
    expect(r.blocks[0].state).toBe("done");
    expect(r.warnings.join(" ")).not.toMatch(/cannot read/);
  });
  it("a lesson report for another block does not cover this one", () => {
    expect(auditBook(meetings as any, [{ id: 1, name: "Lesson 9 - Lesson 16" }]).blocks[0].state).toBe("missing");
  });
});

// ---------- generic read ----------

describe("portalGet", () => {
  it("allows teacher paths only", () => {
    expect(checkReadPath("/api/tms/schedule")).toBe("/api/tms/schedule");
    expect(checkReadPath("/api/v2/tms/student/1/book/2/progress-detail")).toBe("/api/v2/tms/student/1/book/2/progress-detail");
    for (const bad of ["/api/cms/teacher", "/api/tms/../cms/teacher", "/api/tms/auth/login", "/api/tms/schedule/dev-tool/upcoming-class", "/api/tms/schedule?x=1", "https://evil.example/api/tms/x", "/api/tms//x", "/api/tms/", 5]) {
      expect(() => checkReadPath(bad)).toThrow(/teacher API path/);
    }
  });
  it("passes the query and cuts a huge answer", async () => {
    const seen: any[] = [];
    const s = { api: async (p: string, q: any) => { seen.push([p, q]); return { status: 200, body: { data: p.endsWith("big") ? "x".repeat(MAX_BODY_CHARS + 10) : [1] } }; } } as unknown as TmsSession;
    expect(await portalGet(s, "/api/tms/schedule", { limit: 5 })).toEqual({ status: 200, body: { data: [1] } });
    expect(seen[0]).toEqual(["/api/tms/schedule", { limit: 5 }]);
    const big: any = await portalGet(s, "/api/tms/big");
    expect(big.truncated).toBe(true);
    expect(big.body_text).toHaveLength(MAX_BODY_CHARS);
  });
});

// ---------- sheet row picked by the portal course ----------

import { chooseStudentRow, sameCourse, type SheetsApi, type SheetSettings } from "../src/sheets.js";

describe("sheet row by portal course", () => {
  const settings: SheetSettings = { spreadsheetId: "x", tabGid: 0, nameColumn: "B", firstDataRow: 5, lesson1DateColumn: "M", maxLesson: 32 };
  const names = ["Andi Pratama\n(Andi)", "Andi Pratama\n(Andi)", "Andi Pratama\n(Andi)", "Budi"];
  const sheet = (cells: Record<string, string>): SheetsApi => ({
    readRange: async (range) => [[cells[range] ?? ""]],
    writeValue: async () => {},
    fillColor: async () => {},
  });
  const cells = { F5: "Game Dev 24", G5: "ID", F6: "Interactive Mechanics on Roblox", G6: "ID", F7: "Fullstack Programming for Roblox", G7: "ID" };
  const input = (names_: string[], lang?: string) => ({ studentName: "Andi Pratama", lesson: 14, finished: true, teacherNotes: "n", overwrite: false, portalCourse: { names: names_, lang } });

  it("sameCourse ignores case, spaces and punctuation but not different words", () => {
    expect(sameCourse("Fullstack Programming for Roblox", "Full Stack Programming for Roblox")).toBe(true);
    expect(sameCourse("Code & Design", "code and design")).toBe(true);
    expect(sameCourse("Game Dev 24", "Kids Game Developer 24 - Adaptive")).toBe(false);
    expect(sameCourse("", "")).toBe(false);
  });

  it("picks the one row with the same course and language", async () => {
    const c = await chooseStudentRow(sheet(cells), settings, names, input(["Full Stack Programming for Roblox"], "id"));
    expect(c).toEqual({ row: 7, selected_by: "course", candidate_rows: [5, 6, 7] });
  });

  it("matches on the course name when the book name differs", async () => {
    const c = await chooseStudentRow(sheet(cells), settings, names, input(["Some Book - Adaptive", "Interactive Mechanics on Roblox"]));
    expect(c.row).toBe(6);
  });

  it("refuses and lists the rows when the name is only similar, the language differs, or two rows are the same course", async () => {
    await expect(chooseStudentRow(sheet(cells), settings, names, input(["Kids Game Developer 24 - Adaptive"], "id"))).rejects.toThrow(/none of them has exactly.*5 = "Game Dev 24" \(ID\).*pass it as row/s);
    await expect(chooseStudentRow(sheet(cells), settings, names, input(["Full Stack Programming for Roblox"], "en"))).rejects.toThrow(/none of them/);
    await expect(chooseStudentRow(sheet({ ...cells, F6: "Full-Stack Programming for Roblox" }), settings, names, input(["Full Stack Programming for Roblox"], "id"))).rejects.toThrow(/2 of them have/);
  });

  it("an explicit row still wins, and a single name match needs no course", async () => {
    expect((await chooseStudentRow(sheet(cells), settings, names, { ...input(["Nope"]), row: 5 })).selected_by).toBe("row");
    expect((await chooseStudentRow(sheet(cells), settings, names, { ...input(["Nope"]), studentName: "Budi" })).selected_by).toBe("name");
  });
});
