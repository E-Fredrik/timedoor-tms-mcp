import { describe, expect, it } from "vitest";
import { examLikeLessons, fetchAllMeetings, findReportRange, lessonsOf, type MeetingRow } from "../src/reports.js";
import { ApiError, type TmsSession } from "../src/session.js";
import { ValidationError } from "../src/validate.js";

let nextId = 1000;
const m = (name: string, date: string, titles: string[], id = nextId++): MeetingRow => ({
  id,
  name,
  date,
  activities: titles.map((t) => ({ data: { content: t } })),
});

// Mirrors the real response shape: activities[].data.content = "Lesson N - Title".
const course = (): MeetingRow[] => [
  m("Meeting 1", "2026-09-05", ["Lesson 1 - Getting To Know Computer & Roblox"]),
  m("Meeting 2", "2026-09-12", ["Lesson 2 - Basics"]),
  m("Meeting 3", "2026-10-17", ["Lesson 7 - Awesome Footer"]),
  m("Meeting 4", "2026-10-24", ["Lesson 8 - Exam"]),
  m("Meeting 5", "2026-10-31", ["Lesson 9 - Next block"]),
  m("Meeting 6", "2026-12-05", ["Lesson 16 - Final Exam"]),
];

describe("lessonsOf", () => {
  it("parses lesson numbers case insensitively and ignores non lessons", () => {
    expect(lessonsOf(m("a", "2026-01-01", ["Lesson 8 - Exam", "lesson 12 - x", "Review of lesson 8", "Lesson - none", "Lesson 80 - Big"])).map((l) => l.n)).toEqual([8, 12, 80]);
  });
  it("does not confuse 8 with 18 or 80", () => {
    const meetings = [m("a", "2026-01-01", ["Lesson 18 - X"]), m("b", "2026-01-02", ["Lesson 80 - Y"])];
    expect(() => findReportRange(meetings, 8)).toThrow(/No meeting with Lesson 8/);
  });
  it("copes with missing, empty and malformed activities", () => {
    const weird = [
      { id: 1, name: "x", date: "2026-01-01" },
      { id: 2, name: "y", date: "2026-01-02", activities: [] },
      { id: 3, name: "z", date: "2026-01-03", activities: [{}, { data: {} }, { data: { content: 5 as unknown as string } }] },
    ] as MeetingRow[];
    expect(weird.flatMap(lessonsOf)).toEqual([]);
  });
});

describe("findReportRange: the user's rule", () => {
  it("lesson 8 done on 24 Oct 2026 (meeting 4) ends the report; lesson 1 starts it", () => {
    const r = findReportRange(course(), 8);
    expect(r.end).toMatchObject({ meeting_name: "Meeting 4", date: "2026-10-24", lesson_number: 8 });
    expect(r.from).toMatchObject({ meeting_name: "Meeting 1", lesson_number: 1 });
    expect(r.from_lesson).toBe(1);
    expect(r.warnings).toEqual([]);
  });
  it("lesson 16 starts at lesson 9", () => {
    const r = findReportRange(course(), 16);
    expect(r.from.lesson_number).toBe(9);
    expect(r.end.lesson_number).toBe(16);
  });
  it("supports a different span", () => {
    const meetings = [...course(), m("Meeting 3b", "2026-10-10", ["Lesson 5 - Mid"])];
    const r = findReportRange(meetings, 8, 4);
    expect(r.from_lesson).toBe(5);
    expect(r.from.meeting_name).toBe("Meeting 3b");
  });
  it("a missing start lesson for a custom span gives a clear error, not a wrong guess", () => {
    expect(() => findReportRange(course(), 8, 4)).toThrow(/No meeting with Lesson 5/);
  });
  it("exam 8 with span 8 is lesson 1, but lesson 3 would start before lesson 1", () => {
    expect(() => findReportRange(course(), 3)).toThrow(ValidationError);
  });
  it("exam lesson 1 with span 1 means the same meeting, with a warning", () => {
    const r = findReportRange(course(), 1, 1);
    expect(r.warnings.join(" ")).toMatch(/same meeting/);
  });
});

describe("findReportRange: edge cases", () => {
  it("fails clearly when the exam lesson was never taught, listing what exists", () => {
    expect(() => findReportRange(course(), 24)).toThrow(/Lessons found in meetings: 1, 2, 7, 8, 9, 16/);
  });
  it("fails clearly when there are no meetings at all", () => {
    expect(() => findReportRange([], 8)).toThrow(/Lessons found in meetings: none/);
  });
  it("fails when the starting lesson is missing", () => {
    const meetings = course().filter((x) => x.name !== "Meeting 1");
    expect(() => findReportRange(meetings, 8)).toThrow(/No meeting with Lesson 1/);
  });
  it("uses the most recent exam meeting if the exam lesson repeats, and warns", () => {
    const meetings = [...course(), m("Meeting 7", "2026-11-14", ["Lesson 8 - Exam retake"])];
    const r = findReportRange(meetings, 8);
    expect(r.end.date).toBe("2026-11-14");
    expect(r.warnings[0]).toMatch(/appears in 2 meetings/);
  });
  it("ignores a repeat of lesson 1 that happens AFTER the exam", () => {
    const meetings = [...course(), m("Meeting 8", "2027-01-10", ["Lesson 1 - Again"])];
    expect(findReportRange(meetings, 8).from.date).toBe("2026-09-05");
  });
  it("errors if lesson 1 only happens after the exam meeting", () => {
    const meetings = [m("A", "2026-10-24", ["Lesson 8 - Exam"]), m("B", "2026-11-01", ["Lesson 1 - Late"])];
    expect(() => findReportRange(meetings, 8)).toThrow(/only appears after/);
  });
  it("breaks same day ties by higher meeting id", () => {
    const meetings = [m("A", "2026-10-24", ["Lesson 8 - Exam"], 5), m("B", "2026-10-24", ["Lesson 8 - Exam"], 9), m("C", "2026-09-01", ["Lesson 1 - Intro"], 1)];
    expect(findReportRange(meetings, 8).end.meeting_id).toBe(9);
  });
  it("handles a meeting that taught several lessons", () => {
    const meetings = [m("A", "2026-09-01", ["Lesson 1 - Intro", "Lesson 2 - More"]), m("B", "2026-10-24", ["Lesson 7 - x", "Lesson 8 - Exam"])];
    const r = findReportRange(meetings, 8);
    expect(r.end.meeting_name).toBe("B");
    expect(r.from.meeting_name).toBe("A");
  });
  it("rejects invalid inputs", () => {
    for (const bad of [0, -8, 1.5, NaN, "8", null, undefined]) expect(() => findReportRange(course(), bad)).toThrow(ValidationError);
    expect(() => findReportRange(course(), 8, 0)).toThrow(ValidationError);
    expect(() => findReportRange(course(), 8, 51)).toThrow(ValidationError);
    expect(() => findReportRange(course(), 8, "8")).toThrow(ValidationError);
  });
});

describe("examLikeLessons", () => {
  it("finds exam, test and final titles but not 'Testing' or presentations", () => {
    const meetings = [
      m("a", "2026-01-01", ["Lesson 8 - Python Coder Middle Exam"]),
      m("b", "2026-01-02", ["Lesson 15 - Review materials & Final Exam"]),
      m("c", "2026-01-03", ["Lesson 8 - Middle Test and Responsive Website"]),
      m("d", "2026-01-04", ["Lesson 24 - Presentation"]),
      m("e", "2026-01-05", ["Lesson 9 - Testing your game"]),
    ];
    expect(examLikeLessons(meetings).map((x) => x.lesson_number)).toEqual([8, 8, 15]);
  });
});

describe("fetchAllMeetings", () => {
  const fake = (pages: Record<number, { status: number; body: unknown }>, calls: number[] = []) =>
    ({
      api: async (_p: string, q?: Record<string, unknown>) => {
        calls.push(q?.page as number);
        return pages[q?.page as number] ?? { status: 200, body: { data: [], meta: { last_page: 1 } } };
      },
    }) as unknown as TmsSession;

  it("reads every page and stops at last_page", async () => {
    const calls: number[] = [];
    const s = fake(
      {
        1: { status: 200, body: { data: [m("a", "2026-01-01", [])], meta: { last_page: 3 } } },
        2: { status: 200, body: { data: [m("b", "2026-01-02", [])], meta: { last_page: 3 } } },
        3: { status: 200, body: { data: [m("c", "2026-01-03", [])], meta: { last_page: 3 } } },
      },
      calls,
    );
    expect((await fetchAllMeetings(s, 1, 2, 3)).map((x) => x.name)).toEqual(["a", "b", "c"]);
    expect(calls).toEqual([1, 2, 3]);
  });
  it("never loops forever if the server reports a huge last_page", async () => {
    const calls: number[] = [];
    const s = { api: async (_p: string, q?: Record<string, unknown>) => { calls.push(q?.page as number); return { status: 200, body: { data: [m("x", "2026-01-01", [])], meta: { last_page: 99999 } } }; } } as unknown as TmsSession;
    await fetchAllMeetings(s, 1, 2, 3);
    expect(calls.length).toBe(50);
  });
  it("turns 404, server errors and odd shapes into clear ApiErrors", async () => {
    await expect(fetchAllMeetings(fake({ 1: { status: 404, body: {} } }), 1, 2, 3)).rejects.toThrow(/not found/);
    await expect(fetchAllMeetings(fake({ 1: { status: 500, body: {} } }), 1, 2, 3)).rejects.toThrow(ApiError);
    await expect(fetchAllMeetings(fake({ 1: { status: 200, body: { nope: true } } }), 1, 2, 3)).rejects.toThrow(/Unexpected/);
  });
});
