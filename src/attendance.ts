import { ApiError, TmsSession } from "./session.js";
import { isoDate, ValidationError } from "./validate.js";

export interface AttendanceRow {
  id: number;
  date: string;
  start_time?: string;
  end_time?: string;
  status?: string; // finish, active, drop were observed
  attendance_status?: string; // approved or empty were observed
  reservationable?: { name?: string };
  students?: Array<null | { is_present?: boolean; late_time?: number } | { name?: string }>;
}

export interface AttendanceStudent {
  id?: number;
  name?: string;
  presence?: null | { is_present?: boolean; late_time?: number };
}

/**
 * The portal reads a plain YYYY-MM-DD end_date as midnight, so the last day was silently left out
 * (checked live on 5 Nov 2026: end_date=2026-11-05 did not return that day's class). The portal's own
 * page sends full UTC timestamps for the Jakarta day, so this does the same.
 */
export function jakartaDayBounds(start: string, end: string): { start: string; end: string } {
  return {
    start: new Date(`${start}T00:00:00+07:00`).toISOString(),
    end: new Date(`${end}T23:59:59+07:00`).toISOString(),
  };
}

export async function fetchAttendance(session: TmsSession, start: string, end: string, maxPages = 20): Promise<any[]> {
  const out: any[] = [];
  const b = jakartaDayBounds(start, end);
  for (let page = 1; page <= maxPages; page++) {
    const r = await session.api("/api/tms/attendance", { start_date: b.start, end_date: b.end, limit: 100, page });
    if (r.status >= 400) throw new ApiError(`Attendance list failed with status ${r.status}`, r.status);
    const body = r.body as { data?: unknown[]; meta?: { last_page?: number } };
    if (!Array.isArray(body.data)) throw new ApiError("Unexpected attendance response shape");
    out.push(...body.data);
    if (!body.meta?.last_page || page >= body.meta.last_page) break;
  }
  return out;
}

/** Local date and time in Asia/Jakarta, the portal's timezone for this teacher. */
export function jakartaNow(d = new Date()): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}` };
}

export interface GapResult {
  range: { start: string; end: string };
  sessions_checked: number;
  not_recorded: Array<{ id: number; date: string; time: string; class: string; status: string; students: number }>;
  not_approved: Array<{ id: number; date: string; class: string; attendance_status: string }>;
  absences: Array<{ student: string; absent: number; late: number; sessions: number }>;
  notes: string[];
}

/**
 * Attendance gap = a class session that already ended, still marked "active" (not finish, not drop),
 * with no attendance status. Sessions marked "drop" are treated as cancelled, not as gaps.
 * The meaning of these status values was inferred from the portal data, so the notes say so.
 */
export function findAttendanceGaps(rows: any[], range: { start: string; end: string }, now = jakartaNow()): GapResult {
  const notRecorded: GapResult["not_recorded"] = [];
  const notApproved: GapResult["not_approved"] = [];
  const per = new Map<string, { absent: number; late: number; sessions: number }>();
  for (const r of rows) {
    const date = String(r.date ?? "");
    const ended = date < now.date || (date === now.date && String(r.end_time ?? "99:99").slice(0, 5) <= now.time);
    const status = String(r.status ?? "");
    const att = String(r.attendance_status ?? "");
    const cls = String(r.reservationable?.name ?? "(unnamed class)");
    const studs: any[] = Array.isArray(r.students) ? r.students : [];
    if (ended && status === "active" && att === "") {
      notRecorded.push({ id: r.id, date, time: `${String(r.start_time ?? "").slice(0, 5)}-${String(r.end_time ?? "").slice(0, 5)}`, class: cls, status, students: studs.length });
    } else if (ended && status === "finish" && att !== "" && att !== "approved") {
      notApproved.push({ id: r.id, date, class: cls, attendance_status: att });
    }
    if (status === "finish") {
      for (const s of studs) {
        const p = s?.presence ?? s;
        if (!p || typeof p.is_present !== "boolean") continue;
        const key = String(s?.name ?? s?.id ?? "unknown");
        const e = per.get(key) ?? { absent: 0, late: 0, sessions: 0 };
        e.sessions++;
        if (!p.is_present) e.absent++;
        if (p.is_present && (p.late_time ?? 0) > 0) e.late++;
        per.set(key, e);
      }
    }
  }
  const sortByDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);
  return {
    range,
    sessions_checked: rows.length,
    not_recorded: notRecorded.sort(sortByDate),
    not_approved: notApproved.sort(sortByDate),
    absences: [...per.entries()].map(([student, v]) => ({ student, ...v })).filter((x) => x.absent > 0 || x.late > 0).sort((a, b) => b.absent - a.absent),
    notes: [
      "A gap means: the session already ended, is still marked active, and has no attendance status. Sessions marked drop are treated as cancelled, not as gaps. This reading is inferred from portal data, not from documentation.",
      "Per student absence counts only use finished sessions where the list included student names. If the list does not include names, absences may be empty.",
    ],
  };
}

export function parseAttendanceRange(a: { start_date?: unknown; end_date?: unknown }, now = jakartaNow(), defaultDays = 30): { start: string; end: string } {
  const end = a.end_date === undefined ? now.date : isoDate("end_date", a.end_date);
  let start: string;
  if (a.start_date === undefined) {
    const d = new Date(end + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - defaultDays);
    start = d.toISOString().slice(0, 10);
  } else start = isoDate("start_date", a.start_date);
  if (start > end) throw new ValidationError("start_date cannot be after end_date");
  return { start, end };
}
