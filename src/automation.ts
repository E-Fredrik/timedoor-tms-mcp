import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "./config.js";
import { fetchAttendance, jakartaNow } from "./attendance.js";
import { journalPreview, listClassJournals, sendJournalToParent } from "./sendparent.js";
import { ApiError, type TmsSession } from "./session.js";
import { ValidationError } from "./validate.js";

// ---------- switches (read on every call, like cis.config.json) ----------

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface AutoConfig {
  autoApproveProjects: boolean;
  autoSendJournals: boolean;
}

/**
 * tms.config.json at the project root, or TMS_AUTO_APPROVE_PROJECTS=1 / TMS_AUTO_SEND_JOURNALS=1.
 * Missing file or bad JSON means everything off. Only a literal true turns a switch on.
 */
export async function readAutoConfig(env: NodeJS.ProcessEnv = process.env, file = path.join(PROJECT_DIR, "tms.config.json")): Promise<AutoConfig> {
  let cfg: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cfg = parsed as Record<string, unknown>;
  } catch {
    /* off */
  }
  return {
    autoApproveProjects: env.TMS_AUTO_APPROVE_PROJECTS === "1" || cfg.autoApproveProjects === true,
    autoSendJournals: env.TMS_AUTO_SEND_JOURNALS === "1" || cfg.autoSendJournals === true,
  };
}

// ---------- action log ----------

export function actionLogFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.TMS_ACTION_LOG?.trim() || path.join(homedir(), ".config", "timedoor-tms-mcp", "actions.log");
}

/** One JSON line per write the server makes on the portal, so every automatic action can be checked later. */
export async function logAction(entry: Record<string, unknown>, file = actionLogFile()): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    /* logging must never break the action itself */
  }
}

// ---------- who am I, and which classes are mine ----------

const unwrapList = (b: unknown): any[] => {
  const x = b as { data?: unknown };
  return Array.isArray(x?.data) ? (x.data as any[]) : Array.isArray(b) ? (b as any[]) : [];
};

export async function fetchAllClasses(session: TmsSession, maxPages = 20): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await session.api(API.classes, { search: "", limit: 100, page });
    if (r.status >= 400) throw new ApiError(`Class list failed with status ${r.status}`, r.status);
    out.push(...unwrapList(r.body));
    const last = (r.body as any)?.meta?.last_page;
    if (!last || page >= last) break;
  }
  return out;
}

export interface MyClass {
  id: number;
  name: string;
  status: string;
  days: number[];
}

/**
 * Works out the teacher id that means "me" in the class lists.
 * Order: TMS_TEACHER_ID, then the login user id if it appears as a teacher, then the teacher whose
 * name matches the profile name, then the one teacher who is on every class. Refuses to guess beyond that.
 */
export function resolveMyTeacherId(classes: any[], hints: { envId?: string; userId?: number; profileName?: string }): { id: number; how: string } {
  const env = Number(hints.envId);
  if (hints.envId && Number.isInteger(env) && env > 0) return { id: env, how: "TMS_TEACHER_ID" };
  const seen = new Map<number, { name: string; classes: Set<number> }>();
  for (const c of classes) {
    for (const s of Array.isArray(c?.schedules) ? c.schedules : []) {
      for (const t of Array.isArray(s?.teachers) ? s.teachers : []) {
        const id = Number(t?.id);
        if (!Number.isInteger(id) || id <= 0) continue;
        const e = seen.get(id) ?? { name: String(t?.name ?? ""), classes: new Set<number>() };
        e.classes.add(Number(c?.id));
        seen.set(id, e);
      }
    }
  }
  if (hints.userId && seen.has(hints.userId)) return { id: hints.userId, how: "login user id" };
  const pn = hints.profileName?.trim().toLowerCase();
  if (pn) {
    const m = [...seen.entries()].filter(([, v]) => v.name.trim().toLowerCase() === pn);
    if (m.length === 1) return { id: m[0][0], how: "profile name" };
  }
  const n = classes.length;
  const everywhere = [...seen.entries()].filter(([, v]) => n > 0 && v.classes.size === n);
  if (everywhere.length === 1) return { id: everywhere[0][0], how: "teacher on every class" };
  throw new ValidationError(
    "Could not work out which teacher id is you from the class list. Set TMS_TEACHER_ID in .env (your id appears in tms_list_classes under schedules.teachers).",
  );
}

/** Classes where this teacher is the MAIN teacher. Substitute or assistant roles are left out on purpose. */
export function myMainClasses(classes: any[], teacherId: number, opts: { includeInactive?: boolean } = {}): MyClass[] {
  const out: MyClass[] = [];
  for (const c of classes) {
    const id = Number(c?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const status = String(c?.status ?? "");
    if (!opts.includeInactive && status && status !== "active") continue;
    const scheds: any[] = Array.isArray(c?.schedules) ? c.schedules : [];
    const main = scheds.some((s) => (Array.isArray(s?.teachers) ? s.teachers : []).some((t: any) => Number(t?.id) === teacherId && String(t?.role ?? "").toLowerCase() === "main"));
    if (!main) continue;
    out.push({ id, name: String(c?.name ?? ""), status, days: scheds.map((s) => Number(s?.day)).filter((d) => Number.isInteger(d)) });
  }
  return out;
}

export async function loadMyClasses(session: TmsSession): Promise<{ teacherId: number; how: string; classes: MyClass[] }> {
  const all = await fetchAllClasses(session);
  let profileName: string | undefined;
  try {
    const p = await session.api(API.profile);
    const d = ((p.body as any)?.data ?? p.body) as any;
    profileName = typeof d?.name === "string" ? d.name : undefined;
  } catch {
    /* name is only a hint */
  }
  const me = resolveMyTeacherId(all, { envId: process.env.TMS_TEACHER_ID, userId: session.userId, profileName });
  return { teacherId: me.id, how: me.how, classes: myMainClasses(all, me.id) };
}

// ---------- project approvals ----------

export interface ProjectRow {
  project_id: number;
  student_id: number;
  book_id: number;
  student: string;
  student_code: string;
  book: string;
  lesson: string;
  class: string;
  class_id?: number;
  status: string;
  submitted_at: string | null;
  file_url: string | null;
  project_link: string | null;
  has_attachment: boolean;
}

const posInt = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Pure: one portal project approval item into a row, or null if the ids needed to act on it are missing. */
export function toProjectRow(x: any, classId?: number): ProjectRow | null {
  const project_id = posInt(x?.id);
  const student_id = posInt(x?.student_id);
  const book_id = posInt(x?.book_id);
  if (!project_id || !student_id || !book_id) return null;
  // Only real web addresses count. The portal has stored junk like "[object Object]" on some old projects.
  const url = (v: unknown) => (typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim()) ? v.trim() : null);
  const file = url(x?.file_url);
  const link = url(x?.project_link);
  const meetings: any[] = Array.isArray(x?.meetings) ? x.meetings : [];
  return {
    project_id,
    student_id,
    book_id,
    student: String(x?.student_name ?? x?.student?.name ?? ""),
    student_code: String(x?.student_code ?? x?.student?.code ?? ""),
    book: String(x?.book_name ?? ""),
    lesson: String(x?.lesson_name ?? ""),
    class: String(meetings[0]?.class_name ?? ""),
    class_id: classId,
    status: String(x?.status ?? ""),
    submitted_at: x?.submitted_at ? String(x.submitted_at) : null,
    file_url: file,
    project_link: link,
    // The portal itself disables Approve and Reject unless one of these is present.
    has_attachment: !!(file || link),
  };
}

export async function listProjectApprovals(
  session: TmsSession,
  opts: { classId?: number; status?: string; search?: string; maxPages?: number } = {},
): Promise<ProjectRow[]> {
  const out: ProjectRow[] = [];
  const maxPages = opts.maxPages ?? 10;
  for (let page = 1; page <= maxPages; page++) {
    const r = await session.api(API.projectApprovals, { search: opts.search ?? "", class_id: opts.classId, status: opts.status, page, limit: 50 });
    if (r.status >= 400) throw new ApiError(`Project approval list failed with status ${r.status}`, r.status);
    for (const x of unwrapList(r.body)) {
      const row = toProjectRow(x, opts.classId);
      if (row) out.push(row);
    }
    const last = (r.body as any)?.meta?.last_page;
    if (!last || page >= last) break;
  }
  return out;
}

export const PROJECT_STATUSES = ["approved", "rejected"] as const;
export type ProjectDecision = (typeof PROJECT_STATUSES)[number];

/** Approve or reject one project, the same single request the portal's own buttons send. */
export async function setProjectStatus(
  session: TmsSession,
  row: Pick<ProjectRow, "student_id" | "book_id" | "project_id">,
  status: ProjectDecision,
  meta: Record<string, unknown> = {},
): Promise<{ ok: boolean; http_status: number; message: string }> {
  if (!PROJECT_STATUSES.includes(status)) throw new ValidationError(`status must be approved or rejected, got ${String(status)}`);
  const r = await session.apiSend("PATCH", API.projectStatus(row.student_id, row.book_id, row.project_id), { json: { status } });
  const ok = r.status >= 200 && r.status < 300;
  const msg = (r.body as any)?.message;
  await logAction({ action: `project_${status}`, ok, http_status: r.status, project_id: row.project_id, student_id: row.student_id, book_id: row.book_id, ...meta });
  return { ok, http_status: r.status, message: ok ? `Project ${status}.` : `The portal refused (status ${r.status})${typeof msg === "string" ? `: ${msg.slice(0, 200)}` : ""}.` };
}

export interface AutoApproveResult {
  mode: "dry_run" | "live";
  why_mode: string;
  teacher_id: number;
  classes_checked: string[];
  approved: Array<ProjectRow & { verified: boolean }>;
  would_approve: ProjectRow[];
  skipped: Array<{ project_id: number; student: string; class: string; reason: string }>;
  failed: Array<{ project_id: number; student: string; error: string }>;
  capped: boolean;
}

/**
 * The automatic rule: projects waiting for approval, in classes where you are the MAIN teacher,
 * that have a file or a link attached. Never rejects anything. Runs live only when confirm=true
 * or the autoApproveProjects switch is on; otherwise it is a dry run that lists what it would do.
 */
export async function autoApproveProjects(
  session: TmsSession,
  opts: { confirm?: boolean; max?: number; auto?: AutoConfig } = {},
): Promise<AutoApproveResult> {
  const auto = opts.auto ?? (await readAutoConfig());
  const live = opts.confirm === true || auto.autoApproveProjects;
  const max = Math.min(Math.max(opts.max ?? 30, 1), 100);
  const mine = await loadMyClasses(session);
  const res: AutoApproveResult = {
    mode: live ? "live" : "dry_run",
    why_mode: opts.confirm === true ? "confirm=true" : auto.autoApproveProjects ? "autoApproveProjects is on in tms.config.json" : "switch is off and confirm was not given, so nothing was changed",
    teacher_id: mine.teacherId,
    classes_checked: mine.classes.map((c) => c.name),
    approved: [],
    would_approve: [],
    skipped: [],
    failed: [],
    capped: false,
  };
  const seen = new Set<number>();
  const candidates: ProjectRow[] = [];
  for (const c of mine.classes) {
    const rows = await listProjectApprovals(session, { classId: c.id });
    for (const r of rows) {
      if (seen.has(r.project_id)) continue;
      seen.add(r.project_id);
      const label = { project_id: r.project_id, student: r.student, class: r.class || c.name };
      if (r.status && r.status !== "on_review") res.skipped.push({ ...label, reason: `status is ${r.status}` });
      else if (!r.has_attachment) res.skipped.push({ ...label, reason: "no file or link attached (the portal does not allow approving it)" });
      else candidates.push({ ...r, class: r.class || c.name });
    }
  }
  if (candidates.length > max) {
    res.capped = true;
    for (const r of candidates.slice(max)) res.skipped.push({ project_id: r.project_id, student: r.student, class: r.class, reason: `over the per run limit of ${max}; will be handled next run` });
  }
  const todo = candidates.slice(0, max);
  if (!live) {
    res.would_approve = todo;
    return res;
  }
  for (const r of todo) {
    try {
      const out = await setProjectStatus(session, r, "approved", { via: "auto_approve", student: r.student, class: r.class });
      if (!out.ok) {
        res.failed.push({ project_id: r.project_id, student: r.student, error: out.message });
        continue;
      }
      // Read back: it must no longer be waiting for approval in that class.
      let verified = false;
      try {
        const again = await listProjectApprovals(session, { classId: r.class_id, maxPages: 3 });
        verified = !again.some((x) => x.project_id === r.project_id && x.status === "on_review");
      } catch {
        verified = false;
      }
      res.approved.push({ ...r, verified });
    } catch (e) {
      res.failed.push({ project_id: r.project_id, student: r.student, error: session.safeText(String((e as Error).message)).slice(0, 200) });
    }
  }
  return res;
}

// ---------- automatic sending of the day's journals ----------

/** Pure: does this attendance session belong to one of my classes? By class id first, exact name second. */
export function attendanceIsMine(row: any, classes: MyClass[]): { mine: boolean; class_name: string; how?: string } {
  const res = row?.reservationable ?? row?.class ?? {};
  const name = String(res?.name ?? "").trim();
  const type = String(row?.reservationable_type ?? "").toLowerCase();
  if (type && !type.includes("class")) return { mine: false, class_name: name };
  const id = posInt(res?.id ?? row?.reservationable_id ?? row?.class_id);
  if (id && classes.some((c) => c.id === id)) return { mine: true, class_name: name, how: "class id" };
  if (!id && name && classes.some((c) => c.name.trim() === name)) return { mine: true, class_name: name, how: "class name" };
  return { mine: false, class_name: name };
}

export interface AutoSendResult {
  date: string;
  mode: "dry_run" | "live";
  why_mode: string;
  teacher_id: number;
  my_class_sessions: Array<{ attendance_id: number; class: string; matched_by?: string }>;
  other_sessions_ignored: Array<{ attendance_id: number; class: string }>;
  sent: Array<Record<string, unknown>>;
  would_send: Array<Record<string, unknown>>;
  held_low_score: Array<Record<string, unknown>>;
  not_ready: Array<Record<string, unknown>>;
  revision_send_by_hand: Array<Record<string, unknown>>;
  already_sent: number;
  failed: Array<Record<string, unknown>>;
  errors: string[];
}

/**
 * The automatic rule for parents: journals from the class sessions you taught on `date`, in classes
 * where you are the MAIN teacher, that are submitted (status created) and not sent yet.
 * A journal with any quiz score below 75 is NOT sent: it is held and listed so you can decide.
 */
export async function autoSendJournals(
  session: TmsSession,
  opts: { date?: string; confirm?: boolean; auto?: AutoConfig; sender?: typeof sendJournalToParent } = {},
): Promise<AutoSendResult> {
  const date = opts.date ?? jakartaNow().date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new ValidationError("date must be YYYY-MM-DD");
  const auto = opts.auto ?? (await readAutoConfig());
  const live = opts.confirm === true || auto.autoSendJournals;
  const send = opts.sender ?? sendJournalToParent;
  const mine = await loadMyClasses(session);
  const res: AutoSendResult = {
    date,
    mode: live ? "live" : "dry_run",
    why_mode: opts.confirm === true ? "confirm=true" : auto.autoSendJournals ? "autoSendJournals is on in tms.config.json" : "switch is off and confirm was not given, so nothing was sent",
    teacher_id: mine.teacherId,
    my_class_sessions: [],
    other_sessions_ignored: [],
    sent: [],
    would_send: [],
    held_low_score: [],
    not_ready: [],
    revision_send_by_hand: [],
    already_sent: 0,
    failed: [],
    errors: [],
  };
  const sessions = await fetchAttendance(session, date, date);
  for (const a of sessions) {
    const id = posInt(a?.id);
    if (!id) continue;
    const m = attendanceIsMine(a, mine.classes);
    if (m.mine) res.my_class_sessions.push({ attendance_id: id, class: m.class_name, matched_by: m.how });
    else res.other_sessions_ignored.push({ attendance_id: id, class: m.class_name });
  }
  for (const s of res.my_class_sessions) {
    let list;
    try {
      list = await listClassJournals(session, { start: date, end: date, attendanceId: s.attendance_id, includeAll: true });
    } catch (e) {
      res.errors.push(`attendance ${s.attendance_id}: ${session.safeText(String((e as Error).message)).slice(0, 200)}`);
      continue;
    }
    res.errors.push(...list.errors);
    for (const row of list.rows ?? []) {
      const label = { class: row.class || s.class, student: row.student, journal_status: row.journal_status, attendance_id: row.attendance_id };
      const st = row.journal_status;
      if (st === "sent" || st === "revision_sent") {
        res.already_sent++;
        continue;
      }
      if (st === "revision") {
        res.revision_send_by_hand.push(label);
        continue;
      }
      if (st !== "created") {
        res.not_ready.push({ ...label, reason: st === "draft" ? "still a draft, submit it first" : "no journal written yet" });
        continue;
      }
      if (!row.student_id || !row.learning_session_id || !row.book_id || !row.meeting_id) {
        res.failed.push({ ...label, error: "missing ids on the class attendance row" });
        continue;
      }
      const ref = { studentId: row.student_id, sessionId: row.learning_session_id, bookId: row.book_id, meetingId: row.meeting_id };
      // Re-read the journal itself for the quiz scores, right before deciding.
      let preview;
      try {
        const j = await session.api(API.journal(ref.studentId, ref.sessionId, ref.bookId, ref.meetingId));
        if (j.status >= 400) throw new ApiError(`journal read failed with status ${j.status}`, j.status);
        preview = journalPreview(((j.body as any)?.data ?? j.body) as Record<string, any>);
      } catch (e) {
        res.failed.push({ ...label, error: session.safeText(String((e as Error).message)).slice(0, 200) });
        continue;
      }
      const item = { ...label, ...ref, journal_id: row.journal_id };
      if (preview.quiz_scores_below_75.length) {
        res.held_low_score.push({ ...item, quiz_scores_below_75: preview.quiz_scores_below_75 });
        continue;
      }
      if (!live) {
        res.would_send.push(item);
        continue;
      }
      try {
        const out = await send(session, ref, true);
        await logAction({ action: "journal_sent_to_parent", ok: out.sent === true, via: "auto_send", ...item });
        if (out.sent) res.sent.push({ ...item, verified: (out as any).verified ?? null });
        else res.failed.push({ ...item, error: String((out as any).message ?? "not sent") });
      } catch (e) {
        await logAction({ action: "journal_sent_to_parent", ok: false, via: "auto_send", ...item, error: String((e as Error).message).slice(0, 200) });
        res.failed.push({ ...item, error: session.safeText(String((e as Error).message)).slice(0, 200) });
      }
    }
  }
  return res;
}
