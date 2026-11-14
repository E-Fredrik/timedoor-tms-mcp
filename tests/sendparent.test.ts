import { describe, expect, it } from "vitest";
import { API } from "../src/config.js";
import { fetchAttendance, jakartaDayBounds, parseAttendanceRange } from "../src/attendance.js";
import { journalRowsFromAttendance, listClassJournals, SEND_REQUEST_RE, sendJournalToParent } from "../src/sendparent.js";
import { ApiError, type TmsSession } from "../src/session.js";
import { ValidationError } from "../src/validate.js";

const ref = { studentId: 31898, sessionId: 26671, bookId: 252769, meetingId: 980821 };
const journalPath = API.journal(ref.studentId, ref.sessionId, ref.bookId, ref.meetingId);
const sendUrl = `https://x.test/api/tms/student/31898/learning-session/26671/book/252769/meeting-history/980821/journal/815822/send-journal`;

const journal = (o: Record<string, unknown> = {}) => ({
  data: {
    id: 815822,
    status: "created",
    sent_at: null,
    teacher_note: "Great focus today",
    note: "<p>Dimas built a <b>landing page</b>.</p>",
    evidence_photos: [{ id: 1, path: "a.jpg" }],
    activities: [
      { id: 11, score: 90, data: { content: "Lesson 3" } },
      { id: 12, score: 60, data: { content: "Lesson 4" } },
      { id: 13, score: 0, data: { content: "Lesson 5" } },
    ],
    daily_journal_reference: "DJ-1",
    ...o,
  },
});

interface PageOpts {
  previewLoads?: boolean;
  pairedCount?: number;
  anyCount?: number;
  enabled?: boolean;
  response?: "ok" | "timeout" | number;
}

/** journals: successive bodies returned by GET journal (last one repeats). */
function setup(journals: Array<{ status: number; body?: unknown }>, p: PageOpts = {}) {
  const calls: string[] = [];
  let reads = 0;
  let predicate: ((r: any) => boolean) | undefined;
  const loc = (sel: string) => {
    const count = sel.includes("div:has") ? (p.pairedCount ?? 1) : sel.includes("send-parent-button") ? (p.anyCount ?? 0) : 1;
    const self: any = {
      first: () => self,
      waitFor: async () => {
        if (sel.includes("download-pdf-journal") && p.previewLoads === false) throw new Error("timeout");
      },
      count: async () => count,
      isEnabled: async () => p.enabled ?? true,
      click: async () => calls.push(`click:${sel}`),
    };
    return self;
  };
  const page = {
    goto: async (u: string) => calls.push(`goto:${u}`),
    locator: loc,
    waitForTimeout: async () => undefined,
    waitForResponse: (pred: (r: any) => boolean) => {
      predicate = pred;
      const r = p.response ?? "ok";
      if (r === "timeout") return new Promise((_res, rej) => setTimeout(() => rej(new Error("timeout")), 5));
      const code = r === "ok" ? 200 : r;
      return Promise.resolve({ status: () => code, text: async () => (code === 200 ? "{}" : '{"message":"boom"}') });
    },
  };
  const session = {
    baseUrl: "https://x.test",
    ensureLoggedIn: async () => {
      calls.push("login");
      return page;
    },
    api: async (path: string) => {
      if (path !== journalPath) throw new Error("unexpected path " + path);
      const r = journals[Math.min(reads, journals.length - 1)];
      reads++;
      return r;
    },
  } as unknown as TmsSession;
  return { session, calls, getPredicate: () => predicate, reads: () => reads };
}

const clicked = (calls: string[]) => calls.some((c) => c.startsWith("click:"));

describe("sendJournalToParent: refuses what cannot be sent", () => {
  it("no journal yet -> clear error, browser never opened", async () => {
    const f = setup([{ status: 404, body: {} }]);
    await expect(sendJournalToParent(f.session, ref, true)).rejects.toThrow(ValidationError);
    expect(f.calls).toEqual([]);
  });
  it("draft -> tells you to submit first, nothing clicked", async () => {
    const f = setup([{ status: 200, body: journal({ status: "draft" }) }]);
    await expect(sendJournalToParent(f.session, ref, true)).rejects.toThrow(/still a draft.*tms_submit_journal/);
    expect(f.calls).toEqual([]);
  });
  it.each(["sent", "revision_sent"])("already %s -> no resend, no browser", async (st) => {
    const f = setup([{ status: 200, body: journal({ status: st, sent_at: "2026-11-03T10:40:05.779Z" }) }]);
    const r: any = await sendJournalToParent(f.session, ref, true);
    expect(r.sent).toBe(false);
    expect(r.already_sent).toBe(true);
    expect(r.message).toMatch(/2026-11-03T10:40:05.779Z/);
    expect(f.calls).toEqual([]);
  });
  it("unknown status -> error", async () => {
    const f = setup([{ status: 200, body: journal({ status: "weird" }) }]);
    await expect(sendJournalToParent(f.session, ref, true)).rejects.toThrow(/"weird"/);
  });
  it("portal error reading the journal -> ApiError", async () => {
    const f = setup([{ status: 500, body: {} }]);
    await expect(sendJournalToParent(f.session, ref, true)).rejects.toThrow(ApiError);
  });
  it("journal body without a data wrapper still works", async () => {
    const f = setup([{ status: 200, body: journal({ status: "sent" }).data }]);
    expect(((await sendJournalToParent(f.session, ref, true)) as any).already_sent).toBe(true);
  });
});

describe("sendJournalToParent: preview (no confirm)", () => {
  it("opens the preview step, checks the button, never clicks, summarises the journal", async () => {
    const f = setup([{ status: 200, body: journal() }]);
    const r: any = await sendJournalToParent(f.session, ref, false);
    expect(r.sent).toBe(false);
    expect(r.send_button_found).toBe(true);
    expect(clicked(f.calls)).toBe(false);
    expect(f.calls).toContain("goto:https://x.test/tms/student/31898/session/26671/session-history/252769/meeting/980821?initialStep=2");
    expect(r.quiz_scores_below_75).toEqual(["Lesson 4: 60"]); // 0 is "not scored", not low
    expect(r.ai_summary_preview).toBe("Dimas built a landing page .");
    expect(r.photos).toBe(1);
    expect(r.journal_id).toBe(815822);
  });
  it("button missing -> says so without throwing", async () => {
    const f = setup([{ status: 200, body: journal() }], { pairedCount: 0, anyCount: 0 });
    const r: any = await sendJournalToParent(f.session, ref, false);
    expect(r.send_button_found).toBe(false);
    expect(r.message).toMatch(/Send Daily Journal to Parents/);
  });
  it("falls back to a single visible send button when the pairing is not found", async () => {
    const f = setup([{ status: 200, body: journal() }], { pairedCount: 0, anyCount: 1 });
    expect(((await sendJournalToParent(f.session, ref, false)) as any).send_button_found).toBe(true);
  });
  it("two unpaired send buttons -> treated as not found (never guesses)", async () => {
    const f = setup([{ status: 200, body: journal() }], { pairedCount: 0, anyCount: 2 });
    expect(((await sendJournalToParent(f.session, ref, false)) as any).send_button_found).toBe(false);
  });
  it("preview page never loads -> error", async () => {
    const f = setup([{ status: 200, body: journal() }], { previewLoads: false });
    await expect(sendJournalToParent(f.session, ref, false)).rejects.toThrow(/did not load/);
  });
  it("revision whose preview does not open -> specific message", async () => {
    const f = setup([{ status: 200, body: journal({ status: "revision" }) }], { previewLoads: false });
    await expect(sendJournalToParent(f.session, ref, true)).rejects.toThrow(/revision.*Nothing was sent/);
    expect(clicked(f.calls)).toBe(false);
  });
});

describe("sendJournalToParent: confirmed send", () => {
  it("clicks the paired button, waits for the send request, verifies by reading back", async () => {
    const f = setup([
      { status: 200, body: journal() },
      { status: 200, body: journal({ status: "sent", sent_at: "2026-11-05T08:30:00Z" }) },
    ]);
    const r: any = await sendJournalToParent(f.session, ref, true);
    expect(f.calls.filter((c) => c.startsWith("click:"))).toEqual([
      'click:div:has(> [data-pw="download-pdf-journal"]) > [data-pw="send-parent-button"]:visible',
    ]);
    expect(r.sent).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.status_after).toBe("sent");
    expect(r.sent_at_after).toBe("2026-11-05T08:30:00Z");
  });
  it("only the portal's POST send-journal request counts as the send", async () => {
    const f = setup([{ status: 200, body: journal() }, { status: 200, body: journal({ status: "sent" }) }]);
    await sendJournalToParent(f.session, ref, true);
    const pred = f.getPredicate()!;
    const fake = (method: string, url: string) => ({ request: () => ({ method: () => method }), url: () => url });
    expect(pred(fake("POST", sendUrl))).toBe(true);
    expect(pred(fake("GET", sendUrl))).toBe(false);
    expect(pred(fake("POST", sendUrl.replace("/send-journal", "")))).toBe(false);
    expect(pred(fake("POST", "https://x.test/api/files/upload"))).toBe(false);
  });
  it("button not found -> throws, nothing clicked", async () => {
    const f = setup([{ status: 200, body: journal() }], { pairedCount: 0, anyCount: 0 });
    await expect(sendJournalToParent(f.session, ref, true)).rejects.toThrow(/Nothing was sent/);
    expect(clicked(f.calls)).toBe(false);
  });
  it("button disabled -> throws, nothing clicked", async () => {
    const f = setup([{ status: 200, body: journal() }], { enabled: false });
    await expect(sendJournalToParent(f.session, ref, true)).rejects.toThrow(/disabled/);
    expect(clicked(f.calls)).toBe(false);
  });
  it("portal answers 500 -> error with the status", async () => {
    const f = setup([{ status: 200, body: journal() }], { response: 500 });
    await expect(sendJournalToParent(f.session, ref, true)).rejects.toThrow(/status 500.*boom/);
  });
  it("no send request seen and not marked sent -> says most likely NOT sent", async () => {
    const f = setup([{ status: 200, body: journal() }], { response: "timeout" });
    await expect(sendJournalToParent(f.session, ref, true)).rejects.toThrow(/most likely NOT sent/);
  });
  it("no request seen but the journal IS sent -> reports sent", async () => {
    const f = setup([{ status: 200, body: journal() }, { status: 200, body: journal({ status: "sent" }) }], { response: "timeout" });
    const r: any = await sendJournalToParent(f.session, ref, true);
    expect(r.sent).toBe(true);
    expect(r.verified).toBe(true);
  });
  it("request accepted but read back still 'created' -> sent but NOT verified, warns", async () => {
    const f = setup([{ status: 200, body: journal() }]);
    const r: any = await sendJournalToParent(f.session, ref, true);
    expect(r.sent).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.message).toMatch(/before sending again/);
    expect(f.reads()).toBe(1 + 6); // first read plus 6 verify tries
  });
  it("a new sent_at counts as verified even if the status label differs", async () => {
    const f = setup([{ status: 200, body: journal({ status: "revision", sent_at: "2026-11-01T00:00:00Z" }) }, { status: 200, body: journal({ status: "revision", sent_at: "2026-11-05T09:00:00Z" }) }]);
    const r: any = await sendJournalToParent(f.session, ref, true);
    expect(r.verified).toBe(true);
  });
});

describe("SEND_REQUEST_RE", () => {
  it("matches the portal route with or without a query", () => {
    expect(SEND_REQUEST_RE.test(sendUrl)).toBe(true);
    expect(SEND_REQUEST_RE.test(sendUrl + "?x=1")).toBe(true);
    expect(SEND_REQUEST_RE.test(sendUrl.replace("815822", "abc"))).toBe(false);
  });
});

// Shape copied from the live /api/tms/attendance/325555 response (5 Nov 2026), trimmed.
const liveDetail = {
  data: {
    id: 325555,
    date: "2026-11-03",
    class: { id: 3456, name: "Tuesday Class 4pm - Mr Test" },
    reservationable: { name: "Tuesday Class 4pm - Mr Test" },
    students: [
      {
        id: 1945092,
        code: "STD-20251021-7095",
        name: "Dimas Nugraha",
        student_id: 31898,
        session: {
          id: 26671,
          latest_learning_session_book_id: 252769,
          latest_learning_session_book_meeting_id: 980821,
          book: { name: "Teens Websites Developer 24 - Adaptive" },
          meeting_journal: { id: 815822, status: "sent", record_count: 1 },
          can_edit: true,
        },
      },
      {
        id: 2,
        code: "STD-2",
        name: "Andi Pratama",
        student_id: 31914,
        session: { id: 26675, latest_learning_session_book_id: 340351, latest_learning_session_book_meeting_id: 980820, book: { name: "Roblox" }, meeting_journal: { id: 815831, status: "created" }, can_edit: true },
      },
      { id: 3, code: "STD-3", name: "No Journal Yet", student_id: 1, session: { id: 5, meeting_journal: null } },
      { id: 4, name: "Broken Row" },
    ],
  },
};

describe("journalRowsFromAttendance", () => {
  it("maps the live shape to the ids the portal's own button uses", () => {
    const rows = journalRowsFromAttendance(liveDetail);
    expect(rows[0]).toMatchObject({
      attendance_id: 325555,
      class: "Tuesday Class 4pm - Mr Test",
      student: "Dimas Nugraha",
      journal_status: "sent",
      journal_id: 815822,
      student_id: 31898,
      learning_session_id: 26671,
      book_id: 252769,
      meeting_id: 980821,
      can_edit: true,
    });
    expect(rows[2].journal_status).toBe("not_created");
    expect(rows[2].book_id).toBeNull();
    expect(rows[3]).toMatchObject({ student: "Broken Row", journal_status: "not_created", student_id: null, can_edit: false });
  });
  it("handles an empty or odd body without crashing", () => {
    expect(journalRowsFromAttendance({})).toEqual([]);
    expect(journalRowsFromAttendance({ data: { students: "nope" } })).toEqual([]);
  });
});

function listSession(list: any[], details: Record<number, { status: number; body: unknown }>) {
  const seen: Array<{ path: string; q?: any }> = [];
  const s = {
    api: async (path: string, q?: any) => {
      seen.push({ path, q });
      if (path === "/api/tms/attendance") return { status: 200, body: { data: list, meta: { last_page: 1 } } };
      const id = Number(path.split("/").pop());
      return details[id] ?? { status: 404, body: {} };
    },
  } as unknown as TmsSession;
  return { s, seen };
}

describe("listClassJournals", () => {
  const list = [
    { id: 325555, date: "2026-11-03", reservationable: { name: "Tuesday Class 4pm - Mr Test" } },
    { id: 311076, date: "2026-11-03", reservationable: { name: "Tue 14.00 WIB - Mr Test" } },
  ];
  it("returns only created/revision journals as ready, with counts", async () => {
    const f = listSession(list, { 325555: { status: 200, body: liveDetail }, 311076: { status: 200, body: { data: { id: 311076, students: [] } } } });
    const r: any = await listClassJournals(f.s, { start: "2026-10-29", end: "2026-11-05", includeAll: false });
    expect(r.ready_to_send.map((x: any) => x.student)).toEqual(["Andi Pratama"]);
    expect(r.status_counts).toEqual({ sent: 1, created: 1, not_created: 2 });
    expect(r.rows).toBeUndefined();
    expect(r.class_sessions_checked).toBe(2);
  });
  it("class_search filters by name, case insensitive", async () => {
    const f = listSession(list, { 325555: { status: 200, body: liveDetail } });
    const r: any = await listClassJournals(f.s, { start: "2026-10-29", end: "2026-11-05", includeAll: true, classSearch: "tuesday CLASS" });
    expect(r.class_sessions_checked).toBe(1);
    expect(r.rows).toHaveLength(4);
    expect(r.errors).toEqual([]);
  });
  it("one failing class does not stop the others", async () => {
    const f = listSession(list, { 325555: { status: 200, body: liveDetail }, 311076: { status: 500, body: {} } });
    const r: any = await listClassJournals(f.s, { start: "2026-10-29", end: "2026-11-05", includeAll: false });
    expect(r.ready_to_send).toHaveLength(1);
    expect(r.errors[0]).toMatch(/attendance 311076/);
  });
  it("attendance_id skips the list call", async () => {
    const f = listSession(list, { 325555: { status: 200, body: liveDetail } });
    const r: any = await listClassJournals(f.s, { start: "x", end: "y", attendanceId: 325555, includeAll: false });
    expect(f.seen.map((x) => x.path)).toEqual(["/api/tms/attendance/325555"]);
    expect(r.range).toBeUndefined();
  });
  it("caps the number of class sessions and says so", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, date: `2026-11-0${i + 1}`, reservationable: { name: "C" } }));
    const f = listSession(many, {});
    const r: any = await listClassJournals(f.s, { start: "2026-11-01", end: "2026-11-05", includeAll: false, maxSessions: 2 });
    expect(r.class_sessions_checked).toBe(2);
    expect(r.truncated_at_cap).toBe(true);
    expect(f.seen.slice(1).map((x) => x.path)).toEqual(["/api/tms/attendance/104", "/api/tms/attendance/103"]); // newest first
  });
});

describe("attendance date range bug fix", () => {
  it("sends full Jakarta day bounds so the last day is included", () => {
    expect(jakartaDayBounds("2026-11-05", "2026-11-05")).toEqual({ start: "2026-11-04T17:00:00.000Z", end: "2026-11-05T16:59:59.000Z" });
  });
  it("fetchAttendance uses those bounds in the query", async () => {
    const f = listSession([], {});
    await fetchAttendance(f.s, "2026-10-29", "2026-11-05");
    expect(f.seen[0].q).toMatchObject({ start_date: "2026-10-28T17:00:00.000Z", end_date: "2026-11-05T16:59:59.000Z" });
  });
  it("parseAttendanceRange default days is configurable (7 for the send list, 30 still the default)", () => {
    const now = { date: "2026-11-05", time: "15:00" };
    expect(parseAttendanceRange({}, now, 7)).toEqual({ start: "2026-10-29", end: "2026-11-05" });
    expect(parseAttendanceRange({}, now)).toEqual({ start: "2026-10-06", end: "2026-11-05" });
  });
});
