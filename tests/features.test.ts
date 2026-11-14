import { describe, expect, it } from "vitest";
import { createReport, guessLang, journalsInRange, lowScoresIn, parseReportInput, prepareReport, unresolvedPlaceholders, type JournalItem } from "../src/reportcreate.js";
import { findAttendanceGaps, jakartaNow, parseAttendanceRange } from "../src/attendance.js";
import { applyScoreChanges, parseScoreChanges, updateLessonScores } from "../src/grades.js";
import type { TmsSession } from "../src/session.js";

// ---------- fake portal ----------
const crit = (id: number, name: string) => ({
  id,
  name,
  templates: [
    { lang: "en", content: `(student_name) did ${name}` },
    { lang: "id", content: `(Student_name) mengerjakan ${name}` },
  ],
});
const CRITERIA = [crit(14, "Coding Concept"), crit(15, "Coding Application"), crit(16, "Character")];

const jr = (id: number, num: number, meetingId: number, acts: Array<[string, number]> = []): JournalItem => ({
  id,
  name: `Meeting ${num}`,
  learning_session_book_meeting_id: meetingId,
  status: "created",
  teacher_note: `note ${num}`,
  activities: acts.map(([content, score], i) => ({ id: id * 10 + i, score, data: { content } })),
});

interface World {
  lang?: string | null;
  criteria?: unknown[];
  journals?: JournalItem[];
  reports?: Array<{ id: number; name: string }>;
  postStatus?: number;
  createOnPost?: boolean;
}
function fakeSession(w: World) {
  const writes: Array<{ method: string; path: string; payload: any }> = [];
  const reports = [...(w.reports ?? [])];
  const api = async (path: string) => {
    if (path.endsWith("/report-criteria")) return { status: 200, body: { data: w.criteria ?? CRITERIA } };
    if (path.endsWith("/meeting-history/journal")) return { status: 200, body: { data: w.journals ?? [] } };
    if (path.includes("/api/tms/") && path.endsWith("/report")) return { status: 200, body: { data: reports } };
    if (path.includes("/api/cms/student/") && /\/book\/\d+$/.test(path))
      return { status: 200, body: { data: { status: "completed", book: { name: "Book", lang: w.lang === undefined ? "id" : w.lang, course: { id: 21 } } } } };
    return { status: 404, body: {} };
  };
  const apiSend = async (method: string, path: string, payload: any) => {
    writes.push({ method, path, payload });
    if ((w.postStatus ?? 201) < 400 && w.createOnPost !== false) reports.push({ id: 999, name: "Meeting 1 - Meeting 4" });
    return { status: w.postStatus ?? 201, body: { ok: true } };
  };
  return { s: { api, apiSend } as unknown as TmsSession, writes };
}

const baseArgs = { student_id: 1, learning_session_id: 2, book_id: 3, from_meeting: 1, until_meeting: 4 };
const goodCriteria = (lang: "en" | "id" = "id") =>
  CRITERIA.map((c, i) => ({
    id: c.id,
    score: 80 + i,
    note: lang === "id" ? "Siswa sudah mampu membuat halaman web dengan baik dan juga belajar CSS untuk tampilan." : "The student learned to build a web page and is able to use CSS with the layout.",
  }));
const journals = [jr(101, 1, 1001), jr(102, 2, 1002), jr(103, 4, 1004, [["Lesson 3 - X", 60], ["Lesson 4 - Y", 0], ["Lesson 5 - Z", 90]])];

describe("parseReportInput", () => {
  it("accepts a valid input", () => {
    const r = parseReportInput({ ...baseArgs, criteria: goodCriteria() });
    expect(r.criteria).toHaveLength(3);
    expect(r.fromMeeting).toBe(1);
  });
  it("needs a range", () => {
    expect(() => parseReportInput({ student_id: 1, learning_session_id: 2, book_id: 3 })).toThrow(/exam_lesson/);
  });
  it("needs both from and until", () => {
    expect(() => parseReportInput({ ...baseArgs, until_meeting: undefined })).toThrow(/both/);
  });
  it("rejects reversed range, bad scores, empty notes and duplicate criteria", () => {
    expect(() => parseReportInput({ ...baseArgs, from_meeting: 5, until_meeting: 2 })).toThrow(/after/);
    for (const score of [-1, 101, NaN, "80"]) expect(() => parseReportInput({ ...baseArgs, criteria: [{ id: 14, score, note: "x" }] })).toThrow(/score/);
    expect(() => parseReportInput({ ...baseArgs, criteria: [{ id: 14, score: 80, note: "   " }] })).toThrow(/note/);
    expect(() => parseReportInput({ ...baseArgs, criteria: [{ id: 14, score: 80, note: "a" }, { id: 14, score: 70, note: "b" }] })).toThrow(/once/);
    expect(() => parseReportInput({ ...baseArgs, criteria: "nope" })).toThrow(/list/);
  });
  it("accepts score 0 and 100", () => {
    expect(parseReportInput({ ...baseArgs, criteria: [{ id: 14, score: 0, note: "a" }, { id: 15, score: 100, note: "b" }] }).criteria).toHaveLength(2);
  });
});

describe("helpers", () => {
  it("guessLang", () => {
    expect(guessLang("Siswa sudah mampu membuat halaman web dengan baik dan juga belajar CSS")).toBe("id");
    expect(guessLang("The student learned to build a web page and is able to use CSS")).toBe("en");
    expect(guessLang("ok")).toBeUndefined();
  });
  it("unresolvedPlaceholders", () => {
    expect(unresolvedPlaceholders("(student_name) built (project_name)")).toEqual(["(student_name)", "(project_name)"]);
    expect(unresolvedPlaceholders("Ali built it (with help)")).toEqual([]);
  });
  it("journalsInRange is inclusive and needs both ends", () => {
    expect(journalsInRange(journals, 1, 4).included.map((j) => j.name)).toEqual(["Meeting 1", "Meeting 2", "Meeting 4"]);
    expect(journalsInRange(journals, 1, 3).included).toEqual([]);
    expect(journalsInRange(journals, 4, 1).included).toEqual([]);
  });
  it("lowScoresIn flags below 75 and separates unscored", () => {
    const r = lowScoresIn(journals);
    expect(r.low).toEqual([{ meeting: "Meeting 4", lesson: "Lesson 3 - X", score: 60 }]);
    expect(r.unscored).toEqual([{ meeting: "Meeting 4", lesson: "Lesson 4 - Y" }]);
  });
});

describe("prepareReport", () => {
  it("returns language, ALL criteria with templates in that language, journals and low scores", async () => {
    const { s } = fakeSession({ journals });
    const p = await prepareReport(s, parseReportInput(baseArgs));
    expect(p.language).toBe("id");
    expect(p.criteria_count).toBe(3);
    expect(p.criteria_needed[0].starting_template).toContain("mengerjakan");
    expect(p.report_name).toBe("Meeting 1 - Meeting 4");
    expect(p.journals_included).toHaveLength(3);
    expect(p.quiz_scores_below_threshold).toHaveLength(1);
  });
  it("uses english templates for an english student", async () => {
    const { s } = fakeSession({ journals, lang: "en" });
    const p = await prepareReport(s, parseReportInput(baseArgs));
    expect(p.language).toBe("en");
    expect(p.criteria_needed[1].starting_template).toContain("did Coding Application");
  });
  it("handles a 4 criteria course", async () => {
    const { s } = fakeSession({ journals, criteria: [...CRITERIA, crit(17, "Design")] });
    expect((await prepareReport(s, parseReportInput(baseArgs))).criteria_count).toBe(4);
  });
  it("warns when the language is unclear and when an end meeting has no journal", async () => {
    const { s } = fakeSession({ journals: [jr(101, 1, 1001)], lang: "fr" });
    const p = await prepareReport(s, parseReportInput(baseArgs));
    expect(p.language).toBeNull();
    expect(p.warnings.join(" ")).toMatch(/language/);
    expect(p.warnings.join(" ")).toMatch(/no created journal/);
  });
  it("warns about a duplicate report", async () => {
    const { s } = fakeSession({ journals, reports: [{ id: 5, name: "Meeting 1 - Meeting 4" }] });
    expect((await prepareReport(s, parseReportInput(baseArgs))).warnings.join(" ")).toMatch(/already exists/);
  });
});

describe("createReport", () => {
  const run = (w: World, over: Record<string, unknown> = {}, confirm = true, opts = {}) => {
    const f = fakeSession(w);
    return { f, p: createReport(f.s, parseReportInput({ ...baseArgs, criteria: goodCriteria(), ...over }), confirm, opts) };
  };
  it("preview without confirm sends nothing", async () => {
    const { f, p } = run({ journals }, {}, false);
    const r: any = await p;
    expect(r.created).toBe(false);
    expect(f.writes).toHaveLength(0);
    expect(r.body.learning_session_book_meeting_journal_ids).toEqual([101, 102, 103]);
  });
  it("confirm sends the exact portal body to the right URL and verifies", async () => {
    const { f, p } = run({ journals });
    const r: any = await p;
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].method).toBe("POST");
    expect(f.writes[0].path).toBe("/api/tms/student/1/learning-session/2/book/3/report");
    expect(f.writes[0].payload.json.criterias.map((c: any) => c.id)).toEqual([14, 15, 16]);
    expect(Object.keys(f.writes[0].payload.json.criterias[0]).sort()).toEqual(["id", "note", "score"]);
    expect(r.created).toBe(true);
  });
  it("refuses a missing criterion", async () => {
    const { f, p } = run({ journals }, { criteria: goodCriteria().slice(0, 2) });
    await expect(p).rejects.toThrow(/Missing criteria.*Character/);
    expect(f.writes).toHaveLength(0);
  });
  it("refuses a criterion that is not in the course", async () => {
    const { p } = run({ journals }, { criteria: [...goodCriteria(), { id: 99, score: 80, note: "x" }] });
    await expect(p).rejects.toThrow(/not in this course/);
  });
  it("refuses leftover placeholders", async () => {
    const c = goodCriteria();
    c[0].note = "(student_name) sudah mampu membuat halaman web dengan baik dan juga belajar CSS";
    const { f, p } = run({ journals }, { criteria: c });
    await expect(p).rejects.toThrow(/placeholder/);
    expect(f.writes).toHaveLength(0);
  });
  it("refuses English notes for an Indonesian student, allows with override", async () => {
    const { f, p } = run({ journals }, { criteria: goodCriteria("en") });
    await expect(p).rejects.toThrow(/Indonesian/);
    expect(f.writes).toHaveLength(0);
    const ok = run({ journals }, { criteria: goodCriteria("en") }, true, { allowLanguageMismatch: true });
    expect(((await ok.p) as any).created).toBe(true);
  });
  it("refuses Indonesian notes for an English student", async () => {
    const { p } = run({ journals, lang: "en" }, { criteria: goodCriteria("id") });
    await expect(p).rejects.toThrow(/English/);
  });
  it("refuses when the language is unknown", async () => {
    const { p } = run({ journals, lang: null });
    await expect(p).rejects.toThrow(/language/);
  });
  it("refuses a duplicate, and a range with no journal at an end", async () => {
    await expect(run({ journals, reports: [{ id: 5, name: "Meeting 1 - Meeting 4" }] }).p).rejects.toThrow(/duplicate/);
    await expect(run({ journals }, { until_meeting: 3 }).p).rejects.toThrow(/no created journal/);
  });
  it("surfaces a portal rejection and does not claim success", async () => {
    const { p } = run({ journals, postStatus: 422 });
    await expect(p).rejects.toThrow(/rejected the report/);
  });
  it("does not claim created when the list does not show it afterwards", async () => {
    const { p } = run({ journals, createOnPost: false });
    const r: any = await p;
    expect(r.created).toBe(false);
    expect(r.verified_in_list).toBe(false);
  });
});

describe("attendance", () => {
  const now = { date: "2026-10-24", time: "10:00" };
  const row = (o: any) => ({ id: 1, date: "2026-10-20", start_time: "08:00:00", end_time: "09:30:00", status: "finish", attendance_status: "approved", reservationable: { name: "Class A" }, students: [], ...o });
  it("flags past active sessions with no attendance, ignores drop and finished", () => {
    const g = findAttendanceGaps([row({ id: 1, status: "active", attendance_status: "" }), row({ id: 2, status: "drop", attendance_status: "" }), row({ id: 3 })], { start: "a", end: "b" }, now);
    expect(g.not_recorded.map((x) => x.id)).toEqual([1]);
  });
  it("today: only a gap once the session has ended", () => {
    const ended = row({ id: 1, date: "2026-10-24", end_time: "09:30:00", status: "active", attendance_status: "" });
    const later = row({ id: 2, date: "2026-10-24", end_time: "15:00:00", status: "active", attendance_status: "" });
    const future = row({ id: 3, date: "2026-10-25", status: "active", attendance_status: "" });
    expect(findAttendanceGaps([ended, later, future], { start: "a", end: "b" }, now).not_recorded.map((x) => x.id)).toEqual([1]);
  });
  it("flags unapproved attendance and counts absences and lateness", () => {
    const g = findAttendanceGaps(
      [
        row({ id: 1, attendance_status: "pending" }),
        row({ id: 2, students: [{ name: "Ali", presence: { is_present: false, late_time: 0 } }, { name: "Budi", presence: { is_present: true, late_time: 10 } }] }),
        row({ id: 3, students: [{ name: "Ali", presence: { is_present: true, late_time: 0 } }, null] }),
      ],
      { start: "a", end: "b" },
      now,
    );
    expect(g.not_approved.map((x) => x.id)).toEqual([1]);
    expect(g.absences.find((a) => a.student === "Ali")).toMatchObject({ absent: 1, sessions: 2 });
    expect(g.absences.find((a) => a.student === "Budi")).toMatchObject({ late: 1 });
  });
  it("handles empty input", () => {
    expect(findAttendanceGaps([], { start: "a", end: "b" }, now).not_recorded).toEqual([]);
  });
  it("range defaults to 30 days and validates", () => {
    expect(parseAttendanceRange({ end_date: "2026-10-24" }, now)).toEqual({ start: "2026-09-24", end: "2026-10-24" });
    expect(() => parseAttendanceRange({ start_date: "2026-11-01", end_date: "2026-10-01" }, now)).toThrow(/after/);
    expect(() => parseAttendanceRange({ start_date: "nope" }, now)).toThrow(/YYYY-MM-DD/);
  });
  it("jakartaNow returns a date and an HH:MM time", () => {
    const n = jakartaNow(new Date("2026-10-24T17:30:00Z"));
    expect(n).toEqual({ date: "2026-10-25", time: "00:30" });
  });
});

describe("grades", () => {
  const acts = [
    { id: 11, score: 60, data: { content: "Lesson 3 - A" } },
    { id: 12, score: 0, data: { content: "Lesson 4 - B" } },
  ];
  it("parseScoreChanges validates", () => {
    expect(parseScoreChanges([{ lesson: 3, score: 80 }])).toHaveLength(1);
    expect(() => parseScoreChanges([])).toThrow();
    expect(() => parseScoreChanges([{ lesson: 3, activity_id: 11, score: 80 }])).toThrow(/exactly one/);
    expect(() => parseScoreChanges([{ score: 80 }])).toThrow(/exactly one/);
    expect(() => parseScoreChanges([{ lesson: 3, score: 101 }])).toThrow(/0 to 100/);
    expect(() => parseScoreChanges([{ lesson: 3, score: -1 }])).toThrow(/0 to 100/);
    expect(() => parseScoreChanges(new Array(21).fill({ lesson: 3, score: 1 }))).toThrow(/Too many/);
  });
  it("applyScoreChanges changes only the targeted lesson", () => {
    const r = applyScoreChanges(acts, [{ lesson: 3, score: 80 }]);
    expect(r.activities).toEqual([{ id: 11, score: 80 }, { id: 12, score: 0 }]);
    expect(r.diff[0]).toMatchObject({ from: 60, to: 80 });
  });
  it("errors for a lesson that is not on the journal, and for an ambiguous one", () => {
    expect(() => applyScoreChanges(acts, [{ lesson: 9, score: 80 }])).toThrow(/No lesson/);
    expect(() => applyScoreChanges([...acts, { id: 13, score: 5, data: { content: "Lesson 3 - Again" } }], [{ lesson: 3, score: 80 }])).toThrow(/matches 2/);
  });

  const journalBody = (o: any = {}) => ({ data: { status: "draft", sent_at: "", evidence_photos: [], teacher_note: "good", note: "<p>sum</p>", project: { is_active: true, project_name: "P" }, activities: acts, ...o } });
  const sess = (initial: any, afterScores?: Record<number, number>, dropPhotos = false) => {
    const writes: any[] = [];
    let posted = false;
    const api = async () => {
      if (initial === 404) return { status: 404, body: {} };
      if (posted && afterScores) return { status: 200, body: journalBody({ ...initial.data, evidence_photos: dropPhotos ? [] : initial.data.evidence_photos, activities: acts.map((a) => ({ ...a, score: afterScores[a.id] ?? a.score })) }) };
      return { status: 200, body: initial };
    };
    const apiSend = async (method: string, path: string, payload: any) => {
      posted = true;
      writes.push({ method, path, payload });
      return { status: 200, body: {} };
    };
    return { s: { api, apiSend } as unknown as TmsSession, writes };
  };
  const ref = { studentId: 1, sessionId: 2, bookId: 3, meetingId: 4 };
  it("preview sends nothing", async () => {
    const f = sess(journalBody());
    const r: any = await updateLessonScores(f.s, ref, [{ lesson: 3, score: 80 }], false);
    expect(r.saved).toBe(false);
    expect(f.writes).toHaveLength(0);
    expect(r.changes[0]).toMatchObject({ from: 60, to: 80 });
  });
  it("confirm re sends the journal with the new score, keeps notes, and verifies by reading back", async () => {
    const f = sess(journalBody(), { 11: 80 });
    const r: any = await updateLessonScores(f.s, ref, [{ lesson: 3, score: 80 }], true);
    expect(f.writes).toHaveLength(1);
    const form = f.writes[0].payload.form;
    expect(form.status).toBe("draft");
    expect(form.teacher_note).toBe("good");
    expect(form.note).toBe("<p>sum</p>");
    expect(JSON.parse(form.learning_session_book_meeting_activities)).toEqual([{ id: 11, score: 80 }, { id: 12, score: 0 }]);
    expect(r.verified_scores).toBe(true);
    expect(r.teacher_note_and_summary_unchanged).toBe(true);
  });
  it("flags a read back that does not match", async () => {
    const f = sess(journalBody(), { 11: 60 });
    const r: any = await updateLessonScores(f.s, ref, [{ lesson: 3, score: 80 }], true);
    expect(r.verified_scores).toBe(false);
    expect(r.message).toMatch(/did not match/);
  });
  it("flags it loudly if the portal drops the photos on re-save", async () => {
    const photos = [{ id: 7, file: "a/b.jpg", url: "https://x/1" }];
    const f = sess(journalBody({ status: "created", evidence_photos: photos }), { 11: 80 }, true);
    const r: any = await updateLessonScores(f.s, ref, [{ lesson: 3, score: 80 }], true);
    expect(r.photos_unchanged).toBe(false);
    expect(r.message).toMatch(/PHOTOS differ/);
  });
  it("handles a journal with no photos (empty list stays empty)", async () => {
    const f = sess(journalBody({ status: "created" }), { 11: 80 });
    const r: any = await updateLessonScores(f.s, ref, [{ lesson: 3, score: 80 }], true);
    expect(f.writes[0].payload.form.existing_evidence_photos).toBe("[]");
    expect(r.photos_unchanged).toBe(true);
  });
  it("refuses: no journal, sent journal (unless allowed), unknown status", async () => {
    await expect(updateLessonScores(sess(404).s, ref, [{ lesson: 3, score: 80 }], true)).rejects.toThrow(/No journal exists/);
    await expect(updateLessonScores(sess(journalBody({ sent_at: "2026-01-01" })).s, ref, [{ lesson: 3, score: 80 }], true)).rejects.toThrow(/already sent/);
    await expect(updateLessonScores(sess(journalBody({ status: "weird" })).s, ref, [{ lesson: 3, score: 80 }], true)).rejects.toThrow(/status/);
    const sent = sess(journalBody({ sent_at: "2026-01-01" }), { 11: 80 });
    expect(((await updateLessonScores(sent.s, ref, [{ lesson: 3, score: 80 }], true, true)) as any).saved).toBe(true);
  });
  it("allows a CREATED journal with photos and passes the photo references back without files", async () => {
    const photos = [{ id: 7, file: "a/b.jpg", url: "https://x/1" }, { id: 8, file: "a/c.jpg", url: "https://x/2" }];
    const f = sess(journalBody({ status: "created", evidence_photos: photos }), { 11: 80 });
    const r: any = await updateLessonScores(f.s, ref, [{ lesson: 3, score: 80 }], true);
    const form = f.writes[0].payload.form;
    expect(form.status).toBe("created");
    expect(JSON.parse(form.existing_evidence_photos)).toEqual([{ id: 7, url: "https://x/1", path: "a/b.jpg" }, { id: 8, url: "https://x/2", path: "a/c.jpg" }]);
    expect(Object.keys(form)).not.toContain("evidence_photos");
    expect(r.photos_unchanged).toBe(true);
    expect(r.message).toMatch(/notes and photos unchanged/);
  });
});
