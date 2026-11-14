import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  attendanceIsMine,
  autoApproveProjects,
  autoSendJournals,
  myMainClasses,
  readAutoConfig,
  resolveMyTeacherId,
  toProjectRow,
} from "../src/automation.js";
import { listInboxPhotos, parseMdlsDate } from "../src/inbox.js";

let tmp = "";
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tms-auto-"));
  process.env.TMS_ACTION_LOG = path.join(tmp, "actions.log");
  delete process.env.TMS_TEACHER_ID;
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const cls = (id: number, name: string, teachers: Array<[number, string, string]>, status = "active") => ({
  id,
  name,
  status,
  schedules: [{ day: 6, teachers: teachers.map(([tid, tname, role]) => ({ id: tid, name: tname, role })) }],
});
const ME = 1001;
const CLASSES = [
  cls(1, "Sat Class 3pm - Mr Test", [[ME, "Test Teacher", "main"]]),
  cls(2, "Thu Class - Mr Test", [[ME, "Test Teacher", "main"]]),
  cls(3, "Other teacher class", [[999, "Someone Else", "main"], [ME, "Test Teacher", "assistant"]]),
  cls(4, "Old class - Mr Test", [[ME, "Test Teacher", "main"]], "inactive"),
];

describe("resolveMyTeacherId", () => {
  it("uses TMS_TEACHER_ID first, but ignores a bad one", () => {
    expect(resolveMyTeacherId(CLASSES, { envId: "77" })).toEqual({ id: 77, how: "TMS_TEACHER_ID" });
    expect(resolveMyTeacherId(CLASSES, { envId: "abc", profileName: "Test Teacher" }).id).toBe(ME);
    expect(resolveMyTeacherId(CLASSES, { envId: "-5", profileName: "Test Teacher" }).id).toBe(ME);
  });
  it("uses the login user id only when it really is a teacher on the classes", () => {
    expect(resolveMyTeacherId(CLASSES, { userId: ME }).how).toBe("login user id");
    expect(resolveMyTeacherId(CLASSES, { userId: 5555, profileName: "test teacher " }).how).toBe("profile name");
  });
  it("falls back to the one teacher on every class", () => {
    expect(resolveMyTeacherId(CLASSES, {})).toEqual({ id: ME, how: "teacher on every class" });
  });
  it("refuses to guess when it is ambiguous or empty", () => {
    const two = [cls(1, "a", [[1, "A", "main"], [2, "B", "main"]])];
    expect(() => resolveMyTeacherId(two, {})).toThrow(/TMS_TEACHER_ID/);
    expect(() => resolveMyTeacherId([], {})).toThrow(/TMS_TEACHER_ID/);
    expect(() => resolveMyTeacherId([{ id: 1 }, null], {})).toThrow(/TMS_TEACHER_ID/);
  });
});

describe("myMainClasses", () => {
  it("keeps only active classes where I am the main teacher", () => {
    expect(myMainClasses(CLASSES, ME).map((c) => c.id)).toEqual([1, 2]);
  });
  it("can include inactive ones, accepts Main in any case, and skips junk rows", () => {
    const rows = [...CLASSES, null, { id: "x" }, cls(5, "Caps", [[ME, "E", "MAIN"]])];
    expect(myMainClasses(rows, ME, { includeInactive: true }).map((c) => c.id)).toEqual([1, 2, 4, 5]);
  });
  it("an assistant or substitute role never counts", () => {
    expect(myMainClasses([cls(9, "x", [[ME, "E", "replacement"]])], ME)).toEqual([]);
  });
});

describe("toProjectRow", () => {
  const base = { id: 10, student_id: 20, book_id: 30, status: "on_review", student_name: "Ana", book_name: "Roblox", lesson_name: "Lesson 3", meetings: [{ class_name: "Sat" }], submitted_at: "2026-11-01" };
  it("needs all three ids", () => {
    expect(toProjectRow({ ...base, id: undefined })).toBeNull();
    expect(toProjectRow({ ...base, book_id: 0 })).toBeNull();
    expect(toProjectRow({ ...base, student_id: "x" })).toBeNull();
    expect(toProjectRow(null)).toBeNull();
  });
  it("junk values like [object Object] or a non web path are not an attachment (seen live, Nov 2026)", () => {
    expect(toProjectRow({ ...base, file_url: "[object Object]", project_link: null })!.has_attachment).toBe(false);
    expect(toProjectRow({ ...base, file_url: { url: "x" }, project_link: "javascript:alert(1)" })!.has_attachment).toBe(false);
    expect(toProjectRow({ ...base, file_url: "[object Object]", project_link: "https://ai2.appinventor.mit.edu/#1" })!).toMatchObject({ has_attachment: true, file_url: null });
  });
  it("treats blank file and link as no attachment, either one as an attachment", () => {
    expect(toProjectRow({ ...base, file_url: "  ", project_link: "" })!.has_attachment).toBe(false);
    expect(toProjectRow({ ...base, project_link: "https://scratch.mit.edu/p/1" })!.has_attachment).toBe(true);
    expect(toProjectRow({ ...base, file_url: "https://files/x.png" })!).toMatchObject({ has_attachment: true, class: "Sat", student: "Ana" });
  });
});

describe("attendanceIsMine", () => {
  const mine = myMainClasses(CLASSES, ME);
  it("matches by class id", () => {
    expect(attendanceIsMine({ reservationable: { id: 2, name: "anything" } }, mine)).toMatchObject({ mine: true, how: "class id" });
  });
  it("does NOT match a same named class with a different id", () => {
    expect(attendanceIsMine({ reservationable: { id: 3, name: "Thu Class - Mr Test" } }, mine).mine).toBe(false);
  });
  it("falls back to the exact name only when there is no id", () => {
    expect(attendanceIsMine({ reservationable: { name: "Thu Class - Mr Test" } }, mine)).toMatchObject({ mine: true, how: "class name" });
    expect(attendanceIsMine({ reservationable: { name: "Thu Class" } }, mine).mine).toBe(false);
  });
  it("ignores events and empty rows", () => {
    expect(attendanceIsMine({ reservationable_type: "App\\Models\\Event", reservationable: { id: 1 } }, mine).mine).toBe(false);
    expect(attendanceIsMine({}, mine).mine).toBe(false);
    expect(attendanceIsMine(null, mine).mine).toBe(false);
  });
});

describe("readAutoConfig", () => {
  it("is off without a file, with bad JSON, with non boolean values, and with an array", async () => {
    const f = path.join(tmp, "cfg.json");
    expect(await readAutoConfig({}, f)).toEqual({ autoApproveProjects: false, autoSendJournals: false });
    for (const body of ["{bad", '{"autoApproveProjects":"true","autoSendJournals":1}', "[true]"]) {
      await fs.writeFile(f, body);
      expect(await readAutoConfig({}, f)).toEqual({ autoApproveProjects: false, autoSendJournals: false });
    }
  });
  it("turns on with a literal true or the env switch", async () => {
    const f = path.join(tmp, "cfg2.json");
    await fs.writeFile(f, '{"autoApproveProjects":true}');
    expect(await readAutoConfig({}, f)).toEqual({ autoApproveProjects: true, autoSendJournals: false });
    expect(await readAutoConfig({ TMS_AUTO_SEND_JOURNALS: "1" }, f)).toEqual({ autoApproveProjects: true, autoSendJournals: true });
    expect((await readAutoConfig({ TMS_AUTO_SEND_JOURNALS: "true" }, path.join(tmp, "none.json"))).autoSendJournals).toBe(false);
  });
});

// ---------- a fake portal for the two automatic rules ----------

function fakeSession(opts: { projects?: Record<number, any[]>; patchStatus?: number; attendance?: any[]; details?: Record<number, any>; journals?: Record<string, any> }) {
  const calls: Array<{ m: string; p: string; q?: any; body?: any }> = [];
  const decided = new Set<number>();
  const s: any = {
    userId: undefined,
    safeText: (t: string) => t,
    async api(p: string, q?: any) {
      calls.push({ m: "GET", p, q });
      if (p === "/api/tms/class") return { status: 200, body: { data: CLASSES, meta: { last_page: 1 } } };
      if (p === "/api/tms/profile") return { status: 200, body: { data: { name: "Test Teacher" } } };
      if (p === "/api/tms/assestments/project-approvals") {
        const rows = (opts.projects?.[q.class_id] ?? []).filter((r) => !decided.has(r.id));
        return { status: 200, body: { data: rows, meta: { last_page: 1 } } };
      }
      if (p === "/api/tms/attendance") return { status: 200, body: { data: opts.attendance ?? [], meta: { last_page: 1 } } };
      const ad = /^\/api\/tms\/attendance\/(\d+)$/.exec(p);
      if (ad) return { status: 200, body: { data: opts.details?.[Number(ad[1])] } };
      const jm = /meeting-history\/(\d+)\/journal$/.exec(p);
      if (jm) return { status: 200, body: { data: opts.journals?.[jm[1]] ?? { status: "created", activities: [] } } };
      return { status: 404, body: {} };
    },
    async apiSend(m: string, p: string, payload: any) {
      calls.push({ m, p, body: payload.json });
      const st = opts.patchStatus ?? 200;
      const id = Number(/project\/(\d+)\/status/.exec(p)?.[1]);
      if (st === 200) decided.add(id);
      return { status: st, body: st === 200 ? { message: "ok" } : { message: "nope" } };
    },
  };
  return { s, calls };
}

const proj = (id: number, extra: any = {}) => ({ id, student_id: id + 100, book_id: id + 200, status: "on_review", student_name: `S${id}`, file_url: "https://f/x.png", meetings: [{ class_name: "C" }], ...extra });

describe("autoApproveProjects", () => {
  const projects = {
    1: [proj(1), proj(2, { file_url: "", project_link: "" }), proj(3, { status: "approved" }), proj(4, { file_url: null, project_link: "https://scratch/p" })],
    2: [proj(1), proj(5)], // project 1 shows in two classes: must be handled once
    3: [proj(99)], // not my main class: must never be touched
  };
  it("dry run by default: lists, never PATCHes, never looks at other teachers' classes", async () => {
    const { s, calls } = fakeSession({ projects });
    const r = await autoApproveProjects(s, { auto: { autoApproveProjects: false, autoSendJournals: false } });
    expect(r.mode).toBe("dry_run");
    expect(r.would_approve.map((x) => x.project_id)).toEqual([1, 4, 5]);
    expect(r.skipped.map((x) => x.project_id).sort()).toEqual([2, 3]);
    expect(calls.some((c) => c.m === "PATCH")).toBe(false);
    expect(calls.some((c) => c.q?.class_id === 3 || c.q?.class_id === 4)).toBe(false);
  });
  it("live with the switch on: approves each once, sends status approved, verifies by read back", async () => {
    const { s, calls } = fakeSession({ projects });
    const r = await autoApproveProjects(s, { auto: { autoApproveProjects: true, autoSendJournals: false } });
    expect(r.mode).toBe("live");
    expect(r.approved.map((x) => [x.project_id, x.verified])).toEqual([[1, true], [4, true], [5, true]]);
    const patches = calls.filter((c) => c.m === "PATCH");
    expect(patches.map((c) => c.p)).toEqual([
      "/api/v2/tms/student/101/book/201/project/1/status",
      "/api/v2/tms/student/104/book/204/project/4/status",
      "/api/v2/tms/student/105/book/205/project/5/status",
    ]);
    expect(patches.every((c) => c.body.status === "approved")).toBe(true);
    const log = await fs.readFile(process.env.TMS_ACTION_LOG!, "utf8");
    expect(log).toContain('"action":"project_approved"');
  });
  it("confirm=true runs live even with the switch off", async () => {
    const { s } = fakeSession({ projects: { 1: [proj(7)] } });
    const r = await autoApproveProjects(s, { confirm: true, auto: { autoApproveProjects: false, autoSendJournals: false } });
    expect(r.approved).toHaveLength(1);
  });
  it("a refusal is reported as failed, not as approved", async () => {
    const { s } = fakeSession({ projects: { 1: [proj(7)] }, patchStatus: 422 });
    const r = await autoApproveProjects(s, { confirm: true, auto: { autoApproveProjects: false, autoSendJournals: false } });
    expect(r.approved).toHaveLength(0);
    expect(r.failed[0].error).toMatch(/422/);
  });
  it("respects the per run cap and says what was left", async () => {
    const many = Array.from({ length: 5 }, (_, i) => proj(i + 1));
    const { s } = fakeSession({ projects: { 1: many } });
    const r = await autoApproveProjects(s, { max: 2, auto: { autoApproveProjects: false, autoSendJournals: false } });
    expect(r.would_approve).toHaveLength(2);
    expect(r.capped).toBe(true);
    expect(r.skipped.filter((x) => /limit/.test(x.reason))).toHaveLength(3);
  });
  it("max outside 1..100 is clamped", async () => {
    const { s } = fakeSession({ projects: { 1: [proj(1), proj(2)] } });
    expect((await autoApproveProjects(s, { max: 0, auto: { autoApproveProjects: false, autoSendJournals: false } })).would_approve).toHaveLength(1);
  });
});

describe("autoSendJournals", () => {
  const stu = (n: number, status: string) => ({ name: `Kid${n}`, code: `STD-${n}`, student_id: n, session: { id: n * 10, latest_learning_session_book_id: n * 100, latest_learning_session_book_meeting_id: n * 1000, can_edit: true, book: { name: "B" }, meeting_journal: status === "not_created" ? null : { id: n * 7, status } } });
  const attendance = [
    { id: 501, date: "2026-11-07", reservationable: { id: 1, name: "Sat Class 3pm - Mr Test" } },
    { id: 502, date: "2026-11-07", reservationable: { id: 3, name: "Other teacher class" } },
  ];
  const details = {
    501: { id: 501, date: "2026-11-07", class: { name: "Sat Class 3pm - Mr Test" }, students: [stu(1, "created"), stu(2, "created"), stu(3, "created"), stu(4, "draft"), stu(5, "not_created"), stu(6, "sent"), stu(7, "revision"), stu(8, "created")] },
    502: { id: 502, date: "2026-11-07", class: { name: "Other teacher class" }, students: [stu(9, "created")] },
  };
  const journals = {
    "1000": { status: "created", activities: [{ id: 1, score: 90 }] },
    "2000": { status: "created", activities: [{ id: 1, score: 74, data: { content: "Quiz L5" } }] },
    "3000": { status: "created", activities: [{ id: 1, score: 75 }, { id: 2, score: 0 }] },
    "8000": { status: "created", activities: [] },
  };
  const OFF = { autoApproveProjects: false, autoSendJournals: false };

  it("dry run: holds the 74, sends 75 and unscored, lists drafts, missing and revision, ignores other teachers", async () => {
    const { s } = fakeSession({ attendance, details, journals });
    const sent: any[] = [];
    const r = await autoSendJournals(s, { date: "2026-11-07", auto: OFF, sender: (async (_s: any, ref: any) => { sent.push(ref); return { sent: true }; }) as any });
    expect(r.mode).toBe("dry_run");
    expect(sent).toHaveLength(0);
    expect(r.would_send.map((x: any) => x.student)).toEqual(["Kid1", "Kid3", "Kid8"]);
    expect(r.held_low_score.map((x: any) => [x.student, x.quiz_scores_below_75])).toEqual([["Kid2", ["Quiz L5: 74"]]]);
    expect(r.not_ready.map((x: any) => x.student)).toEqual(["Kid4", "Kid5"]);
    expect(r.revision_send_by_hand.map((x: any) => x.student)).toEqual(["Kid7"]);
    expect(r.already_sent).toBe(1);
    expect(r.other_sessions_ignored.map((x) => x.attendance_id)).toEqual([502]);
  });

  it("live: sends exactly the clean ones with the right ids, and logs them", async () => {
    const { s } = fakeSession({ attendance, details, journals });
    const sent: any[] = [];
    const r = await autoSendJournals(s, { date: "2026-11-07", auto: { ...OFF, autoSendJournals: true }, sender: (async (_s: any, ref: any, confirm: boolean) => { sent.push({ ...ref, confirm }); return { sent: true, verified: true }; }) as any });
    expect(r.mode).toBe("live");
    expect(sent).toEqual([
      { studentId: 1, sessionId: 10, bookId: 100, meetingId: 1000, confirm: true },
      { studentId: 3, sessionId: 30, bookId: 300, meetingId: 3000, confirm: true },
      { studentId: 8, sessionId: 80, bookId: 800, meetingId: 8000, confirm: true },
    ]);
    expect(r.sent).toHaveLength(3);
    expect(sent.some((x) => x.studentId === 2 || x.studentId === 9)).toBe(false);
  });

  it("a send that throws or says not sent goes to failed and the rest continue", async () => {
    const { s } = fakeSession({ attendance, details, journals });
    let n = 0;
    const r = await autoSendJournals(s, { date: "2026-11-07", confirm: true, auto: OFF, sender: (async () => { n++; if (n === 1) throw new Error("button missing"); if (n === 2) return { sent: false, message: "disabled" }; return { sent: true }; }) as any });
    expect(r.failed.map((x: any) => x.error)).toEqual(["button missing", "disabled"]);
    expect(r.sent).toHaveLength(1);
  });

  it("no classes that day gives an empty, clean result", async () => {
    const { s } = fakeSession({ attendance: [] });
    const r = await autoSendJournals(s, { date: "2026-11-08", auto: OFF });
    expect(r.my_class_sessions).toEqual([]);
    expect(r.would_send).toEqual([]);
  });

  it("rejects a bad date before touching the portal", async () => {
    const { s, calls } = fakeSession({});
    await expect(autoSendJournals(s, { date: "07-11-2026", auto: OFF })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(autoSendJournals(s, { date: "2026-13-45", auto: OFF })).rejects.toThrow(/YYYY-MM-DD/);
    expect(calls).toHaveLength(0);
  });
});

describe("photo inbox", () => {
  it("parses mdls dates and rejects junk", () => {
    expect(parseMdlsDate("kMDItemContentCreationDate = 2026-11-01 08:12:33 +0000")!.toISOString()).toBe("2026-11-01T08:12:33.000Z");
    expect(parseMdlsDate("kMDItemContentCreationDate = (null)")).toBeUndefined();
    expect(parseMdlsDate("")).toBeUndefined();
  });
  it("lists photos only, skips hidden, empty and other files, filters by date, respects limit", async () => {
    const d = path.join(tmp, "photos");
    await fs.mkdir(d);
    await fs.writeFile(path.join(d, "a.jpg"), "x");
    await fs.writeFile(path.join(d, "b.HEIC"), "x");
    await fs.writeFile(path.join(d, "c.txt"), "x");
    await fs.writeFile(path.join(d, ".hidden.jpg"), "x");
    await fs.writeFile(path.join(d, "empty.png"), "");
    await fs.mkdir(path.join(d, "sub.jpg"));
    const r = await listInboxPhotos({ dir: d });
    expect(r.photos.map((p) => p.name).sort()).toEqual(["a.jpg", "b.HEIC"]);
    expect((await listInboxPhotos({ dir: d, limit: 1 })).photos).toHaveLength(1);
    expect((await listInboxPhotos({ dir: d, date: "1999-01-01" })).count).toBe(0);
    await expect(listInboxPhotos({ dir: d, date: "yesterday" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(listInboxPhotos({ dir: path.join(tmp, "nope") })).rejects.toThrow(/Cannot read/);
  });
});
