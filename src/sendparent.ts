import type { Locator, Page } from "playwright";
import { API, PATHS } from "./config.js";
import { ApiError, TmsSession } from "./session.js";
import { ValidationError } from "./validate.js";
import type { MeetingRef } from "./journal.js";
import { LOW_SCORE_THRESHOLD } from "./scores.js";
import { fetchAttendance } from "./attendance.js";
import { pool } from "./audit.js";

/**
 * Journal statuses, as the portal's own code labels them on the Class Attendance page:
 *   not_created -> "Create Daily Journal", draft -> "Edit Daily Journal",
 *   created / revision -> "Send Daily Journal", sent / revision_sent -> "View Daily Journal".
 */
export const SENDABLE_STATUSES = ["created", "revision"] as const;
export const SENT_STATUSES = ["sent", "revision_sent"] as const;

const isSendable = (s: string) => (SENDABLE_STATUSES as readonly string[]).includes(s);
const isSent = (s: string) => (SENT_STATUSES as readonly string[]).includes(s);

/** The portal's send request: POST .../meeting-history/{meeting}/journal/{journalId}/send-journal */
export const SEND_REQUEST_RE = /\/meeting-history\/\d+\/journal\/\d+\/send-journal(\?.*)?$/;

export const SEND_TIMEOUTS = {
  pageLoad: 30_000,
  // The page renders the journal to an image and uploads it before the send request, so allow time.
  sendRequest: 120_000,
  verifyTries: 6,
  verifyDelayMs: 1_000,
} as const;

export function unwrap(body: unknown): Record<string, any> {
  const b = body as { data?: Record<string, any> } | Record<string, any> | null;
  return ((b && typeof b === "object" && "data" in b ? (b as any).data : b) ?? {}) as Record<string, any>;
}

async function readJournal(session: TmsSession, ref: MeetingRef): Promise<Record<string, any> | null> {
  const r = await session.api(API.journal(ref.studentId, ref.sessionId, ref.bookId, ref.meetingId));
  if (r.status === 404) return null;
  if (r.status >= 400) throw new ApiError(`Journal lookup failed with status ${r.status}`, r.status);
  return unwrap(r.body);
}

export function journalPreview(j: Record<string, any>) {
  const activities: any[] = Array.isArray(j.activities) ? j.activities : [];
  const photos: any[] = Array.isArray(j.evidence_photos) ? j.evidence_photos : [];
  const summary = String(j.note ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return {
    journal_id: j.id ?? null,
    reference: j.daily_journal_reference ?? null,
    status: String(j.status ?? ""),
    last_sent_at: j.sent_at || null,
    teacher_note: String(j.teacher_note ?? ""),
    ai_summary_preview: summary.slice(0, 400),
    ai_summary_chars: summary.length,
    photos: photos.length,
    quiz_scores_below_75: activities
      .filter((a) => typeof a.score === "number" && a.score > 0 && a.score < LOW_SCORE_THRESHOLD)
      .map((a) => `${a.data?.content ?? a.id}: ${a.score}`),
  };
}

/**
 * Finds the "Send to Parent" button that sits next to "Download PDF" in the journal preview step.
 * That one carries the click handler that renders the journal image and sends it.
 * Returns null when the preview loaded but no send button is shown (for example the branch has
 * "Send Daily Journal to Parents" turned off).
 */
export async function findSendButton(page: Page): Promise<Locator | null> {
  try {
    await page.locator('[data-pw="download-pdf-journal"]').first().waitFor({ state: "visible", timeout: SEND_TIMEOUTS.pageLoad });
  } catch {
    throw new ApiError("The journal preview (with Download PDF) did not load. Nothing was sent. The page layout may have changed.");
  }
  await page.waitForTimeout(500);
  const paired = page.locator('div:has(> [data-pw="download-pdf-journal"]) > [data-pw="send-parent-button"]:visible');
  if ((await paired.count()) >= 1) return paired.first();
  const any = page.locator('[data-pw="send-parent-button"]:visible');
  if ((await any.count()) === 1) return any.first();
  return null;
}

export interface SendResult {
  sent: boolean;
  [k: string]: unknown;
}

/**
 * Sends a created (submitted) daily journal to the parents, by opening the journal in the portal and
 * clicking its own "Send to Parent" button. The page itself renders the journal image, uploads it and
 * sends it (the portal says this goes to parents via WhatsApp), so nothing is rebuilt by hand here.
 * Without confirm it only previews: it opens the page and checks the button is there, but never clicks.
 */
export async function sendJournalToParent(session: TmsSession, ref: MeetingRef, confirm: boolean): Promise<SendResult> {
  const j = await readJournal(session, ref);
  if (!j) throw new ValidationError("There is no journal for this meeting yet. Write it, submit it, then send it.");
  const preview = journalPreview(j);
  const status = preview.status;

  if (isSent(status)) {
    return { sent: false, already_sent: true, message: `Already sent to parents (last sent ${preview.last_sent_at ?? "at an unknown time"}). The portal locks sent journals, so nothing was done.`, ...preview };
  }
  if (status === "draft") {
    throw new ValidationError("This journal is still a draft. Submit it first (tms_submit_journal), then send it to parents.");
  }
  if (!isSendable(status)) throw new ValidationError(`This journal's status is "${status}", which the portal does not offer to send.`);

  const page = await session.ensureLoggedIn();
  const url = session.baseUrl + PATHS.meetingPage(ref.studentId, ref.sessionId, ref.bookId, ref.meetingId) + "?initialStep=2";
  await page.goto(url, { waitUntil: "domcontentloaded" });
  let button: Locator | null;
  try {
    button = await findSendButton(page);
  } catch (e) {
    if (status === "revision") {
      throw new ApiError("This journal is a revision and the portal did not open its send preview automatically (it only does that for status created). Nothing was sent. Please send this one from the portal.");
    }
    throw e;
  }

  if (!button) {
    const msg = "The journal opened, but the portal shows no Send to Parent button. The branch setting 'Send Daily Journal to Parents' may be off, or this status cannot be sent from the preview. Nothing was sent.";
    if (!confirm) return { sent: false, send_button_found: false, message: msg, ...preview };
    throw new ApiError(msg);
  }
  if (!confirm) {
    return {
      sent: false,
      send_button_found: true,
      message: "Preview only. Nothing was sent. Show the teacher this journal and get a clear yes, then run again with confirm=true." + (preview.quiz_scores_below_75.length ? " Note: some quiz scores are below 75." : ""),
      ...preview,
    };
  }

  if (!(await button.isEnabled())) throw new ApiError("The Send to Parent button is disabled right now. Nothing was sent.");

  const req = page.waitForResponse((r) => r.request().method() === "POST" && SEND_REQUEST_RE.test(r.url()), { timeout: SEND_TIMEOUTS.sendRequest });
  await button.click();
  let resStatus: number;
  let resBody = "";
  try {
    const res = await req;
    resStatus = res.status();
    resBody = await res.text().catch(() => "");
  } catch {
    // No send request seen. The page builds the image and uploads it first, so a failure there means no send.
    const again = await readJournal(session, ref).catch(() => null);
    if (again && isSent(String(again.status ?? ""))) {
      return { sent: true, verified: true, status_after: again.status, sent_at_after: again.sent_at ?? null, message: "Sent (confirmed by reading the journal back, although I did not see the request myself).", ...preview };
    }
    throw new ApiError("I clicked Send to Parent but never saw the portal send it within 2 minutes, and the journal is not marked sent. It was most likely NOT sent. Check the journal in the portal before retrying.");
  }
  if (resStatus < 200 || resStatus >= 300) {
    throw new ApiError(`The portal rejected the send (status ${resStatus}): ${resBody.slice(0, 300)}`, resStatus);
  }

  let after: Record<string, any> | null = null;
  for (let i = 0; i < SEND_TIMEOUTS.verifyTries; i++) {
    after = await readJournal(session, ref).catch(() => null);
    if (after && (isSent(String(after.status ?? "")) || (after.sent_at && after.sent_at !== preview.last_sent_at))) break;
    await page.waitForTimeout(SEND_TIMEOUTS.verifyDelayMs);
  }
  const statusAfter = String(after?.status ?? "");
  const verified = !!after && (isSent(statusAfter) || (!!after.sent_at && after.sent_at !== preview.last_sent_at));
  return {
    sent: true,
    verified,
    status_after: statusAfter || null,
    sent_at_after: after?.sent_at ?? null,
    message: verified
      ? "Sent to parents and confirmed by reading the journal back."
      : "The portal accepted the send request, but reading the journal back does not show it as sent yet. Check it in the portal before sending again.",
    ...preview,
  };
}

export interface ClassJournalRow {
  attendance_id: number;
  date: string;
  class: string;
  student: string;
  student_code: string;
  book: string;
  journal_status: string;
  journal_id: number | null;
  can_edit: boolean;
  student_id: number | null;
  learning_session_id: number | null;
  book_id: number | null;
  meeting_id: number | null;
}

/** Turns one /api/tms/attendance/{id} detail into one row per student. Pure, so it is unit tested. */
export function journalRowsFromAttendance(detail: Record<string, any>): ClassJournalRow[] {
  const d = unwrap(detail);
  const cls = String(d.class?.name ?? d.reservationable?.name ?? "(unnamed class)");
  const students: any[] = Array.isArray(d.students) ? d.students : [];
  return students.map((s) => {
    const sess = s?.session ?? {};
    const mj = sess.meeting_journal ?? null;
    // A student who moved to a new book still has this meeting (and its journal) in the OLD book.
    // The portal then hides the direct link behind its "Student Book History" dialog; meeting_book
    // names the book the meeting really belongs to (seen live Nov 19 2026, has_changed: true).
    const mb = sess.meeting_book ?? null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
    return {
      attendance_id: Number(d.id),
      date: String(d.date ?? ""),
      class: cls,
      student: String(s?.name ?? ""),
      student_code: String(s?.code ?? ""),
      book: String(mb?.name ?? sess.book?.name ?? ""),
      journal_status: String(mj?.status ?? "not_created"),
      journal_id: num(mj?.id),
      can_edit: sess.can_edit === true,
      // The ids the portal's own journal button links with, but with the meeting's own book.
      student_id: num(s?.student_id),
      learning_session_id: num(sess.id),
      book_id: num(mb?.learning_session_book_id) ?? num(sess.latest_learning_session_book_id),
      meeting_id: num(sess.latest_learning_session_book_meeting_id),
    };
  });
}

export async function listClassJournals(
  session: TmsSession,
  opts: { start: string; end: string; attendanceId?: number; classSearch?: string; includeAll: boolean; maxSessions?: number },
) {
  let ids: Array<{ id: number; date: string; name: string }>;
  if (opts.attendanceId) {
    ids = [{ id: opts.attendanceId, date: "", name: "" }];
  } else {
    const rows = await fetchAttendance(session, opts.start, opts.end);
    ids = rows
      .map((r: any) => ({ id: Number(r.id), date: String(r.date ?? ""), name: String(r.reservationable?.name ?? r.class?.name ?? "") }))
      .filter((r) => Number.isFinite(r.id) && r.id > 0)
      .filter((r) => !opts.classSearch || r.name.toLowerCase().includes(opts.classSearch.toLowerCase()))
      .sort((a, b) => b.date.localeCompare(a.date));
  }
  const cap = opts.maxSessions ?? 40;
  const truncated = ids.length > cap;
  ids = ids.slice(0, cap);
  const results = await pool(ids, 3, async (x) => {
    const r = await session.api(API.attendanceDetail(x.id));
    if (r.status >= 400) throw new ApiError(`Class attendance ${x.id} failed with status ${r.status}`, r.status);
    return journalRowsFromAttendance(r.body as Record<string, any>);
  });
  const errors: string[] = [];
  const all: ClassJournalRow[] = [];
  results.forEach((r, i) => (r.ok ? all.push(...r.value) : errors.push(`attendance ${ids[i].id}: ${r.error}`)));
  const counts: Record<string, number> = {};
  for (const r of all) counts[r.journal_status] = (counts[r.journal_status] ?? 0) + 1;
  const ready = all.filter((r) => isSendable(r.journal_status));
  return {
    range: opts.attendanceId ? undefined : { start: opts.start, end: opts.end },
    class_sessions_checked: ids.length,
    truncated_at_cap: truncated,
    status_counts: counts,
    ready_to_send: ready,
    rows: opts.includeAll ? all : undefined,
    errors,
    note: "ready_to_send = journals that are submitted (created or revision) but not sent yet. Use the ids on each row with tms_send_journal_to_parent. The ids are the same ones the portal's own Send Daily Journal button links to (checked live: they point to that class session's journal).",
  };
}
