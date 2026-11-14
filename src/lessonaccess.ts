import { ApiError, TmsSession } from "./session.js";
import { fetchBookInfo } from "./reportcreate.js";
import { lessonNumberOf } from "./scores.js";
import { ValidationError } from "./validate.js";

// Lesson lock and unlock for one student, and the student's lesson progress, using the same calls as the
// portal's student book page (read from the portal's front end bundle, Nov 14 2026):
//   chapters:        GET    /api/v2/tms/book/{bookId}/content?lang=..                 (format "bab")
//   lessons:         GET    /api/v2/tms/book/{bookId}/content?lang=..&parent_uuid=..  (format "topic")
//   unlocked list:   GET    /api/v2/tms/student/{studentId}/book/{bookId}/access      -> {uuids}
//   Unlock button:   POST   same path  {uuids}   every lesson from the first up to and including the target
//   Lock button:     DELETE same path  {uuids}   the target lesson and every lesson after it
//   progress:        GET    /api/v2/tms/student/{studentId}/book/{bookId}/progress-detail
// bookId here is the course book id (book.id), not the student's learning_session_book_id.

export interface Lesson {
  lesson: number; // "Lesson N" from the title, or the running position when the title has no number
  uuid: string;
  title: string;
  chapter: string;
}

async function getData(session: TmsSession, path: string, query?: Record<string, string | undefined>): Promise<any> {
  const r = await session.api(path, query);
  if (r.status >= 400) throw new ApiError(`Request failed with status ${r.status}: ${path}`, r.status);
  return (r.body as { data?: unknown } | null)?.data;
}

const byPosition = (a: any, b: any) => (a?.position ?? 0) - (b?.position ?? 0);

/** Chapters and their lessons for a course book, in order. */
export async function fetchBookLessons(session: TmsSession, bookId: number, lang?: string): Promise<Lesson[]> {
  const path = `/api/v2/tms/book/${bookId}/content`;
  const chapters = await getData(session, path, { lang });
  if (!Array.isArray(chapters)) throw new ApiError("Unexpected book content response shape");
  const out: Lesson[] = [];
  for (const ch of [...chapters].sort(byPosition)) {
    if (!ch?.has_children) continue; // the portal only locks lessons inside chapters
    const kids = await getData(session, path, { lang, parent_uuid: String(ch.uuid) });
    for (const k of (Array.isArray(kids) ? [...kids] : []).sort(byPosition)) {
      out.push({ lesson: lessonNumberOf(String(k.title ?? "")) ?? out.length + 1, uuid: String(k.uuid), title: String(k.title ?? ""), chapter: String(ch.title ?? "") });
    }
  }
  return out;
}

export interface AccessRef {
  studentId: number;
  sessionId: number;
  bookId: number; // learning_session_book_id, like every other tool
}

export interface LessonState extends Lesson {
  unlocked: boolean;
  progress_percentage: number;
  finished: boolean;
}

/** The student's lessons with lock state and progress. Read only. */
export async function getLessonAccess(session: TmsSession, ref: AccessRef) {
  const info = await fetchBookInfo(session, ref.studentId, ref.sessionId, ref.bookId);
  if (info.catalogBookId === undefined) throw new ApiError("The portal did not say which course book this is, so its lessons cannot be read.");
  const base = `/api/v2/tms/student/${ref.studentId}/book/${info.catalogBookId}`;
  const [lessons, access, progress] = await Promise.all([
    fetchBookLessons(session, info.catalogBookId, info.lang),
    getData(session, `${base}/access`),
    getData(session, `${base}/progress-detail`),
  ]);
  if (!Array.isArray(access?.uuids)) throw new ApiError("Unexpected lesson access response shape");
  const open = new Set<string>(access.uuids);
  const prog = new Map<string, any>((Array.isArray(progress?.progresses) ? progress.progresses : []).map((p: any) => [String(p.uuid), p]));
  const rows: LessonState[] = lessons.map((l) => {
    const p = prog.get(l.uuid);
    return { ...l, unlocked: open.has(l.uuid), progress_percentage: Number(p?.progress_percentage ?? 0), finished: p?.detail?.is_finished === true };
  });
  return { catalogBookId: info.catalogBookId, book: info.bookName, book_status: info.bookStatus, stats: progress?.stats?.learnable ?? null, lessons: rows };
}

export type AccessAction = "unlock_through" | "lock_from";

/** The lessons one portal button press would send: unlock = first lesson through the target, lock = target through the last. */
export function planAccess(lessons: LessonState[], action: AccessAction, lesson: number): { send: LessonState[]; changes: LessonState[] } {
  const hits = lessons.filter((l) => l.lesson === lesson);
  if (hits.length === 0) throw new ValidationError(`No Lesson ${lesson} in this book. It has lessons ${lessons[0]?.lesson ?? "?"} to ${lessons.at(-1)?.lesson ?? "?"}.`);
  if (hits.length > 1) throw new ValidationError(`More than one lesson is numbered ${lesson} in this book, so the target is not clear.`);
  const i = lessons.indexOf(hits[0]);
  const send = action === "unlock_through" ? lessons.slice(0, i + 1) : lessons.slice(i);
  return { send, changes: send.filter((l) => l.unlocked !== (action === "unlock_through")) };
}

/** Unlocks or locks lessons for one student. Without confirm it only previews and sends nothing. */
export async function setLessonAccess(session: TmsSession, ref: AccessRef, action: AccessAction, lesson: number, confirm: boolean): Promise<Record<string, unknown>> {
  const before = await getLessonAccess(session, ref);
  const plan = planAccess(before.lessons, action, lesson);
  const label = (l: LessonState) => l.title || `Lesson ${l.lesson}`;
  const out: Record<string, unknown> = {
    book: before.book,
    action,
    lesson,
    [action === "unlock_through" ? "will_unlock" : "will_lock"]: plan.changes.map(label),
    sent: false,
  };
  const losing = action === "lock_from" ? plan.changes.filter((l) => l.progress_percentage > 0).map(label) : [];
  if (losing.length) out.warning = `The student already has progress in: ${losing.join("; ")}. Locking hides these lessons from the student.`;
  if (plan.changes.length === 0) return { ...out, message: "Nothing to change: the lessons are already in that state." };
  if (!confirm) return { ...out, message: "Preview only. Nothing was sent. Call again with confirm=true after the teacher agrees." };

  const r = await session.apiSend(action === "unlock_through" ? "POST" : "DELETE", `/api/v2/tms/student/${ref.studentId}/book/${before.catalogBookId}/access`, {
    json: { uuids: plan.send.map((l) => l.uuid) },
  });
  if (r.status >= 400) throw new ApiError(`The portal refused the ${action === "unlock_through" ? "unlock" : "lock"} (status ${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`, r.status);
  const after = await getLessonAccess(session, ref);
  const want = action === "unlock_through";
  const wrong = after.lessons.filter((l) => plan.send.some((p) => p.uuid === l.uuid) && l.unlocked !== want).map(label);
  return { ...out, sent: true, verified: wrong.length === 0, ...(wrong.length ? { not_changed: wrong } : {}), unlocked_now: after.lessons.filter((l) => l.unlocked).map((l) => l.lesson) };
}
