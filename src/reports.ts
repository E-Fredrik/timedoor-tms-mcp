import { ApiError, TmsSession } from "./session.js";
import { positiveInt, ValidationError } from "./validate.js";

export interface MeetingRow {
  id: number;
  name: string;
  date: string;
  class?: { id?: number; name?: string };
  activities?: Array<{ data?: { content?: string } }>;
}

export interface LessonMeeting {
  meeting_id: number;
  meeting_name: string;
  date: string;
  lesson_number: number;
  lesson_title: string;
}

/** Pulls "Lesson 24 - Presentation" style titles out of a meeting's activities. */
export function lessonsOf(m: MeetingRow): Array<{ n: number; title: string }> {
  const out: Array<{ n: number; title: string }> = [];
  for (const a of m.activities ?? []) {
    const title = a?.data?.content;
    if (typeof title !== "string") continue;
    const match = /^\s*Lesson\s+(\d+)\b/i.exec(title);
    if (match) out.push({ n: Number(match[1]), title: title.trim() });
  }
  return out;
}

function toLessonMeeting(m: MeetingRow, l: { n: number; title: string }): LessonMeeting {
  return { meeting_id: m.id, meeting_name: m.name, date: m.date, lesson_number: l.n, lesson_title: l.title };
}

/** Most recent first: by date, then by higher id. */
function latestFirst(a: LessonMeeting, b: LessonMeeting): number {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : b.meeting_id - a.meeting_id;
}

export interface ReportRange {
  exam_lesson: number;
  from_lesson: number;
  from: LessonMeeting;
  end: LessonMeeting;
  warnings: string[];
}

/**
 * Report rule: the END meeting is the one where the exam lesson N was taught, and the FROM meeting
 * is the one where lesson N minus (span minus 1) was taught (for N=8 and span=8 that is lesson 1).
 */
export function findReportRange(meetings: MeetingRow[], examLesson: unknown, spanArg?: unknown): ReportRange {
  const exam = positiveInt("exam_lesson", examLesson);
  const span = spanArg === undefined ? 8 : positiveInt("span", spanArg);
  if (span > 50) throw new ValidationError("span is unreasonably large");
  const fromLesson = exam - (span - 1);
  if (fromLesson < 1) {
    throw new ValidationError(`exam_lesson ${exam} with span ${span} would start before lesson 1`);
  }
  const all: LessonMeeting[] = [];
  for (const m of meetings) for (const l of lessonsOf(m)) all.push(toLessonMeeting(m, l));

  const ends = all.filter((x) => x.lesson_number === exam).sort(latestFirst);
  if (ends.length === 0) {
    const have = [...new Set(all.map((x) => x.lesson_number))].sort((a, b) => a - b);
    throw new ApiError(
      `No meeting with Lesson ${exam} was found for this student's book. Lessons found in meetings: ${have.length ? have.join(", ") : "none"}.`,
    );
  }
  const end = ends[0];
  const warnings: string[] = [];
  if (ends.length > 1) {
    warnings.push(`Lesson ${exam} appears in ${ends.length} meetings (${ends.map((e) => e.date).join(", ")}). Using the most recent: ${end.date}.`);
  }

  const froms = all.filter((x) => x.lesson_number === fromLesson).sort(latestFirst);
  if (froms.length === 0) {
    throw new ApiError(`No meeting with Lesson ${fromLesson} was found, so the starting meeting for a report ending at Lesson ${exam} cannot be set.`);
  }
  const onOrBefore = froms.filter((f) => f.date <= end.date);
  if (onOrBefore.length === 0) {
    throw new ApiError(
      `Lesson ${fromLesson} only appears after the Lesson ${exam} meeting (${froms.map((f) => f.date).join(", ")}). Please check the meeting history.`,
    );
  }
  const from = onOrBefore[0];
  if (onOrBefore.length > 1) {
    warnings.push(`Lesson ${fromLesson} appears in ${onOrBefore.length} meetings on or before ${end.date} (${onOrBefore.map((f) => f.date).join(", ")}). Using the most recent: ${from.date}.`);
  }
  if (from.meeting_id === end.meeting_id) {
    warnings.push("The from and end meeting are the same meeting.");
  }
  return { exam_lesson: exam, from_lesson: fromLesson, from, end, warnings };
}

/** Meetings whose lesson title looks like an exam, to help pick exam_lesson when unsure. */
export function examLikeLessons(meetings: MeetingRow[]): Array<{ lesson_number: number; lesson_title: string; date: string }> {
  const out: Array<{ lesson_number: number; lesson_title: string; date: string }> = [];
  for (const m of meetings) {
    for (const l of lessonsOf(m)) {
      if (/\b(exam|test|final)\b/i.test(l.title)) out.push({ lesson_number: l.n, lesson_title: l.title, date: m.date });
    }
  }
  return out.sort((a, b) => a.lesson_number - b.lesson_number);
}

/** Reads every page of a book's meeting history. */
export async function fetchAllMeetings(session: TmsSession, studentId: number, sessionId: number, bookId: number): Promise<MeetingRow[]> {
  const base = `/api/tms/student/${studentId}/learning-session/${sessionId}/book/${bookId}/meeting-history`;
  const rows: MeetingRow[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await session.api(base, { search: "", limit: 50, page });
    if (r.status === 404) throw new ApiError("Student, session or book not found", 404);
    if (r.status >= 400) throw new ApiError(`Meeting history failed with status ${r.status}`, r.status);
    const body = r.body as { data?: MeetingRow[]; meta?: { last_page?: number } };
    if (!Array.isArray(body.data)) throw new ApiError("Unexpected meeting history response shape");
    rows.push(...body.data);
    if (!body.meta?.last_page || page >= body.meta.last_page) break;
  }
  return rows;
}
