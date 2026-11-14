import { ApiError, TmsSession } from "./session.js";
import { fetchAllMeetings, lessonsOf, type MeetingRow } from "./reports.js";
import { positiveInt } from "./validate.js";

// ---------- parsing ----------

/** "Meeting 20" gives 20. */
export function meetingNumber(name: unknown): number | undefined {
  if (typeof name !== "string") return undefined;
  const m = /(\d+)\s*$/.exec(name.trim());
  return m ? Number(m[1]) : undefined;
}

/** "Meeting 1 - Meeting 25" gives {from: 1, to: 25}. Accepts hyphen, en dash and em dash. */
export function parseReportRange(name: unknown): { from: number; to: number } | undefined {
  if (typeof name !== "string") return undefined;
  const m = /Meeting\s*(\d+)\s*[-–—]\s*Meeting\s*(\d+)/i.exec(name);
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

/** "Lesson 9 - Lesson 16" (the name the portal's lesson based report builder gives) gives {from: 9, to: 16}. */
export function parseLessonReportRange(name: unknown): { from: number; to: number } | undefined {
  if (typeof name !== "string") return undefined;
  const m = /Lesson\s*(\d+)\s*[-–—]\s*Lesson\s*(\d+)/i.exec(name);
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

export interface ReportRow {
  id: number;
  name: string;
  created_at?: string;
  status?: string;
  teacher?: { name?: string };
}

// ---------- block logic ----------

export interface Block {
  block: number;
  from_lesson: number;
  exam_lesson: number;
}

/**
 * Report blocks: every `span` lessons (8, 16, 24 ...). If the book's total lesson count is known and is
 * not a multiple of the span, the last lessons form a shorter final block ending at the last lesson.
 */
export function buildBlocks(span: number, totalLessons: number | undefined, currentLesson: number): Block[] {
  const limit = Math.max(totalLessons ?? 0, currentLesson);
  const blocks: Block[] = [];
  let prevEnd = 0;
  let k = 1;
  for (let end = span; end <= limit; end += span, k++) {
    blocks.push({ block: k, from_lesson: prevEnd + 1, exam_lesson: end });
    prevEnd = end;
  }
  if (totalLessons && totalLessons > prevEnd) {
    blocks.push({ block: k, from_lesson: prevEnd + 1, exam_lesson: totalLessons });
  }
  return blocks;
}

export type BlockState = "done" | "missing" | "partial" | "unlocatable" | "upcoming";

export interface BlockResult extends Block {
  state: BlockState;
  from_meeting?: number;
  end_meeting?: number;
  end_date?: string;
  covered_by?: { report_id: number; name: string };
  note?: string;
}

interface Located {
  num: number;
  date: string;
}

/** Most recent meeting where this lesson was taught (by date, then by meeting number). */
function locate(meetings: MeetingRow[], lesson: number): Located | undefined {
  let best: Located | undefined;
  for (const m of meetings) {
    const n = meetingNumber(m.name);
    if (n === undefined) continue;
    if (!lessonsOf(m).some((l) => l.n === lesson)) continue;
    if (!best || m.date > best.date || (m.date === best.date && n > best.num)) best = { num: n, date: m.date };
  }
  return best;
}

export function currentLessonOf(meetings: MeetingRow[]): number {
  let max = 0;
  for (const m of meetings) for (const l of lessonsOf(m)) if (l.n > max) max = l.n;
  return max;
}

export interface AuditResult {
  current_lesson: number;
  total_lessons?: number;
  span: number;
  blocks: BlockResult[];
  missing: BlockResult[];
  reports: Array<{ id: number; name: string; meetings: string; created_at?: string; teacher?: string; portal_status_NOT_USED?: string }>;
  warnings: string[];
}

/**
 * Manual report check. The portal's own status flags are deliberately ignored (known to be buggy).
 * A block counts as done only if some existing report's meeting range spans from the meeting where the
 * block's first lesson was taught to the meeting where its exam lesson was taught.
 */
export function auditBook(meetings: MeetingRow[], reports: ReportRow[], opts: { span?: number; totalLessons?: number } = {}): AuditResult {
  const span = opts.span === undefined ? 8 : positiveInt("span", opts.span);
  const current = currentLessonOf(meetings);
  const warnings: string[] = [];

  const parsed = reports.map((r) => ({ r, range: parseReportRange(r.name) }));
  const lessonReports = reports.flatMap((r) => { const lessons = parseLessonReportRange(r.name); return lessons ? [{ r, lessons }] : []; });
  const unparseable = parsed.filter((p) => !p.range && !parseLessonReportRange(p.r.name));
  if (unparseable.length) {
    warnings.push(`${unparseable.length} report(s) have a name I cannot read as a meeting or lesson range (${unparseable.map((p) => JSON.stringify(p.r.name)).join(", ")}), so they cannot count as coverage. Please check them by hand.`);
  }

  const blocks: BlockResult[] = buildBlocks(span, opts.totalLessons, current).map((b) => {
    const base: BlockResult = { ...b, state: "upcoming" };
    if (b.exam_lesson > current) {
      base.note = `Not due yet: the student is on Lesson ${current}, this block ends at Lesson ${b.exam_lesson}.`;
      return base;
    }
    // Lesson based reports name their lessons directly, so no meeting lookup is needed.
    const byLesson = lessonReports.find((p) => p.lessons.from <= b.from_lesson && p.lessons.to >= b.exam_lesson);
    if (byLesson) return { ...base, state: "done", covered_by: { report_id: byLesson.r.id, name: byLesson.r.name } };
    const end = locate(meetings, b.exam_lesson);
    const from = locate(meetings, b.from_lesson);
    if (!end) {
      return { ...base, state: "unlocatable", note: `No meeting records Lesson ${b.exam_lesson}, so I cannot tell which meeting ends this block. Check by hand.` };
    }
    base.end_meeting = end.num;
    base.end_date = end.date;
    base.from_meeting = from?.num;
    const ranged = parsed.filter((p): p is { r: ReportRow; range: { from: number; to: number } } => !!p.range);
    const full = ranged.find((p) => p.range.to >= end.num && p.range.from <= (from?.num ?? end.num));
    if (full) return { ...base, state: "done", covered_by: { report_id: full.r.id, name: full.r.name } };
    const part = ranged.find((p) => p.range.from <= end.num && p.range.to >= end.num);
    if (part) {
      return {
        ...base,
        state: "partial",
        covered_by: { report_id: part.r.id, name: part.r.name },
        note: `Report "${part.r.name}" reaches the exam meeting but starts after the block's first meeting${from ? ` (Meeting ${from.num})` : ""}.`,
      };
    }
    const touching = ranged.find((p) => from && p.range.from <= end.num && p.range.to >= from.num);
    if (touching) {
      return { ...base, state: "partial", covered_by: { report_id: touching.r.id, name: touching.r.name }, note: `Report "${touching.r.name}" overlaps this block but stops before the exam meeting (Meeting ${end.num}).` };
    }
    if (!from) base.note = `No meeting records Lesson ${b.from_lesson}, so the start of this block is uncertain.`;
    return { ...base, state: "missing" };
  });

  return {
    current_lesson: current,
    total_lessons: opts.totalLessons,
    span,
    blocks,
    missing: blocks.filter((b) => b.state === "missing" || b.state === "partial" || b.state === "unlocatable"),
    reports: reports.map((r) => ({
      id: r.id,
      name: r.name,
      meetings: r.name,
      created_at: r.created_at,
      teacher: r.teacher?.name,
      portal_status_NOT_USED: r.status,
    })),
    warnings,
  };
}

export function describeBlock(b: BlockResult): string {
  const lessons = b.from_lesson === b.exam_lesson ? `Lesson ${b.from_lesson}` : `Lessons ${b.from_lesson} to ${b.exam_lesson}`;
  const where = b.end_meeting ? ` (exam at Meeting ${b.end_meeting}${b.end_date ? ", " + b.end_date : ""})` : "";
  const what = b.state === "partial" ? "report only PARTLY covers" : b.state === "unlocatable" ? "cannot verify" : "NO report for";
  return `${what} ${lessons}${where}`;
}

// ---------- fetching ----------

type Json = Record<string, unknown>;

async function getPaged<T>(session: TmsSession, path: string, maxPages = 30, limit = 50): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await session.api(path, { search: "", limit, page });
    if (r.status === 404) throw new ApiError(`Not found: ${path}`, 404);
    if (r.status >= 400) throw new ApiError(`Request failed with status ${r.status}: ${path}`, r.status);
    const body = r.body as { data?: T[]; meta?: { last_page?: number } };
    if (!Array.isArray(body.data)) throw new ApiError(`Unexpected response shape: ${path}`);
    out.push(...body.data);
    if (!body.meta?.last_page || page >= body.meta.last_page) break;
  }
  return out;
}

export interface BookRef {
  studentId: number;
  studentName: string;
  sessionId: number;
  bookId: number; // learning_session_book_id, the id used in portal URLs
  bookName: string;
  bookStatus: string;
  totalLessons?: number;
}

export async function listBooksForStudent(session: TmsSession, studentId: number, studentName = ""): Promise<BookRef[]> {
  const sessions = await getPaged<Json>(session, `/api/tms/student/${studentId}/learning-session`);
  const refs: BookRef[] = [];
  for (const s of sessions) {
    const sid = s.id as number;
    const total = typeof s.total_progress === "number" && s.total_progress > 0 ? (s.total_progress as number) : undefined;
    const books = await getPaged<Json>(session, `/api/tms/student/${studentId}/learning-session/${sid}/book`);
    const latest = s.latest_learning_session_book_id as number | undefined;
    for (const b of books) {
      const book = b.book as Json | undefined;
      refs.push({
        studentId,
        studentName,
        sessionId: sid,
        bookId: b.id as number,
        bookName: (book?.name as string) ?? "(unknown book)",
        bookStatus: String(b.status ?? ""),
        // total_progress on the session describes the latest book only.
        totalLessons: b.id === latest ? total : undefined,
      });
    }
  }
  return refs;
}

/** Runs jobs with at most `limit` in flight. Errors are captured per item and never abort the others. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<Array<{ ok: true; value: R } | { ok: false; error: string }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: string }> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (e) {
        results[i] = { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, worker));
  return results;
}

export async function auditOneBook(session: TmsSession, ref: BookRef, span: number) {
  const [meetings, reportRes] = await Promise.all([
    fetchAllMeetings(session, ref.studentId, ref.sessionId, ref.bookId),
    session.api(`/api/tms/student/${ref.studentId}/learning-session/${ref.sessionId}/book/${ref.bookId}/report`),
  ]);
  if (reportRes.status >= 400) throw new ApiError(`Report list failed with status ${reportRes.status}`, reportRes.status);
  const body = reportRes.body as { data?: ReportRow[] };
  if (!Array.isArray(body.data)) throw new ApiError("Unexpected report list response shape");
  return auditBook(meetings, body.data, { span, totalLessons: ref.totalLessons });
}

export async function listAllBooks(session: TmsSession, opts: { includeCompleted: boolean }): Promise<{ books: BookRef[]; errors: string[] }> {
  const students = await getPaged<{ id: number; name: string; status?: string }>(session, "/api/tms/student");
  const results = await pool(students, 4, (s) => listBooksForStudent(session, s.id, s.name));
  const books: BookRef[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.ok) books.push(...r.value);
    else errors.push(`${students[i].name}: ${r.error}`);
  });
  return { books: opts.includeCompleted ? books : books.filter((b) => b.bookStatus !== "completed"), errors };
}
