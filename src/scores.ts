import { API } from "./config.js";
import { ApiError, TmsSession } from "./session.js";

export const LOW_SCORE_THRESHOLD = 75;

export interface PendingLesson {
  name: string;
  progress?: number;
  score?: number | null;
}

export interface PendingRow {
  student: { id: number; code?: string; name: string };
  learning_session_book_meeting_id: number;
  learning_session_book_id: number;
  learning_session_id: number;
  class_id?: number;
  class_name?: string;
  book_name?: string;
  session_name?: string;
  meeting_date?: string;
  journal_status?: string;
  lessons?: PendingLesson[];
}

export interface ScoreCheck {
  threshold: number;
  low: Array<{ lesson: string; score: number }>;
  /** Score is 0 or missing. The portal shows a blank score for these, so they are NOT counted as failures. */
  unscored: string[];
}

/**
 * Scores strictly between 0 and the threshold are "low". A score of 0 or a missing score is treated as
 * "no score recorded" because the journal form shows a blank score for those lessons. This is an
 * inference, so unscored lessons are listed separately for the teacher to judge.
 */
export function classifyScores(lessons: PendingLesson[] | undefined, threshold = LOW_SCORE_THRESHOLD): ScoreCheck {
  const low: ScoreCheck["low"] = [];
  const unscored: string[] = [];
  for (const l of lessons ?? []) {
    const name = typeof l?.name === "string" ? l.name : "(unnamed lesson)";
    const s = l?.score;
    if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) unscored.push(name);
    else if (s < threshold) low.push({ lesson: name, score: s });
  }
  return { threshold, low, unscored };
}

/** "Lesson 22 - Something" gives 22. */
export function lessonNumberOf(name: string): number | undefined {
  const m = /^\s*Lesson\s+(\d+)\b/i.exec(name ?? "");
  return m ? Number(m[1]) : undefined;
}

/** Reads every page of the pending journal list (not created plus draft). */
export async function fetchPendingRows(session: TmsSession, maxPages = 40): Promise<PendingRow[]> {
  const rows: PendingRow[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await session.api(API.pendingJournals, { search: "", statuses: ["not_created", "draft"], limit: 100, page });
    if (r.status >= 400) throw new ApiError(`Pending journal list failed with status ${r.status}`, r.status);
    const body = r.body as { data?: PendingRow[]; meta?: { last_page?: number } };
    if (!Array.isArray(body.data)) throw new ApiError("Unexpected pending journal response shape");
    rows.push(...body.data);
    if (!body.meta?.last_page || page >= body.meta.last_page) break;
  }
  return rows;
}

export type QuizCheck =
  | (ScoreCheck & { available: true; attention?: string })
  | { available: false; reason: string };

function attentionText(c: ScoreCheck): string | undefined {
  if (!c.low.length) return undefined;
  return `Quiz score below ${c.threshold}: ${c.low.map((x) => `${x.lesson} = ${x.score}`).join("; ")}.`;
}

/** Quiz check for one meeting's journal. Never throws: a failure just means "not available". */
export async function quizCheckForMeeting(session: TmsSession, studentId: number, meetingId: number): Promise<QuizCheck> {
  try {
    const rows = await fetchPendingRows(session);
    const row = rows.find((r) => r.student?.id === studentId && r.learning_session_book_meeting_id === meetingId);
    if (!row) {
      return { available: false, reason: "No score data: this meeting is not in the pending journal list (its journal may already be submitted)." };
    }
    const c = classifyScores(row.lessons);
    return { ...c, available: true, attention: attentionText(c) };
  } catch (e) {
    return { available: false, reason: `Could not read scores: ${String((e as Error).message).slice(0, 120)}` };
  }
}

/** Quiz check for the lessons inside a report block, using whatever pending rows exist for that book. */
export async function quizCheckForBlock(
  session: TmsSession,
  studentId: number,
  bookId: number,
  fromLesson: number,
  examLesson: number,
): Promise<QuizCheck & { lessonsWithScoreData?: number; lessonsInBlock?: number }> {
  try {
    const rows = (await fetchPendingRows(session)).filter((r) => r.student?.id === studentId && r.learning_session_book_id === bookId);
    const inBlock: PendingLesson[] = [];
    for (const r of rows) {
      for (const l of r.lessons ?? []) {
        const n = lessonNumberOf(l.name);
        if (n !== undefined && n >= fromLesson && n <= examLesson) inBlock.push(l);
      }
    }
    if (!inBlock.length) {
      return { available: false, reason: "No score data for these lessons: only meetings whose journals are not yet submitted expose scores." };
    }
    const c = classifyScores(inBlock);
    const total = examLesson - fromLesson + 1;
    return { ...c, available: true, attention: attentionText(c), lessonsWithScoreData: inBlock.length, lessonsInBlock: total };
  } catch (e) {
    return { available: false, reason: `Could not read scores: ${String((e as Error).message).slice(0, 120)}` };
  }
}

/** Every pending row that has at least one low score. Read only. */
export function lowScoreRows(rows: PendingRow[], threshold = LOW_SCORE_THRESHOLD) {
  const out: Array<{
    student: string;
    student_id: number;
    class_name?: string;
    book_name?: string;
    meeting_date?: string;
    journal_status?: string;
    meeting_id: number;
    low: ScoreCheck["low"];
  }> = [];
  for (const r of rows) {
    const c = classifyScores(r.lessons, threshold);
    if (!c.low.length) continue;
    out.push({
      student: r.student?.name,
      student_id: r.student?.id,
      class_name: r.class_name,
      book_name: r.book_name,
      meeting_date: r.meeting_date,
      journal_status: r.journal_status,
      meeting_id: r.learning_session_book_meeting_id,
      low: c.low,
    });
  }
  return out.sort((a, b) => String(a.meeting_date).localeCompare(String(b.meeting_date)));
}
