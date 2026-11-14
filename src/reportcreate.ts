import { ApiError, TmsSession } from "./session.js";
import { meetingNumber, parseReportRange, type ReportRow } from "./audit.js";
import { fetchAllMeetings, findReportRange } from "./reports.js";
import { LOW_SCORE_THRESHOLD } from "./scores.js";
import { positiveInt, ValidationError } from "./validate.js";

type Json = Record<string, unknown>;
export type Lang = "en" | "id";

export interface Criterion {
  id: number;
  name: string;
  templates: Array<{ lang: string; content: string }>;
}

export interface JournalItem {
  id: number;
  name: string;
  learning_session_book_meeting_id: number;
  status?: string;
  teacher_note?: string;
  activities?: Array<{ id: number; score?: number | null; data?: { content?: string; progress_percentage?: number } }>;
}

// ---------- reading ----------

async function getJson(session: TmsSession, path: string): Promise<Json> {
  const r = await session.api(path);
  if (r.status >= 400) throw new ApiError(`Request failed with status ${r.status}: ${path}`, r.status);
  if (!r.body || typeof r.body !== "object") throw new ApiError(`Unexpected response: ${path}`);
  return r.body as Json;
}

export function parseLang(v: unknown): Lang | undefined {
  return v === "en" || v === "id" ? v : undefined;
}

/** Language comes from the book's own `lang` field (the language the student's course runs in). */
export async function fetchBookInfo(session: TmsSession, studentId: number, sessionId: number, bookId: number) {
  const body = await getJson(session, `/api/cms/student/${studentId}/learning-session/${sessionId}/book/${bookId}`);
  const d = (body.data ?? body) as Json;
  const book = (d.book ?? {}) as Json;
  const course = (book.course ?? {}) as Json;
  const courseId = typeof course.id === "number" ? course.id : undefined;
  if (courseId === undefined) throw new ApiError("The portal did not say which course this book belongs to, so the report criteria cannot be found.");
  return {
    courseId,
    catalogBookId: typeof book.id === "number" ? book.id : undefined, // the course book itself, not the student's copy
    lang: parseLang(book.lang),
    rawLang: book.lang,
    bookName: String(book.name ?? ""),
    courseName: String(course.name ?? ""),
    bookStatus: String(d.status ?? ""),
  };
}

export async function fetchCriteria(session: TmsSession, courseId: number): Promise<Criterion[]> {
  const body = await getJson(session, `/api/cms/course/${courseId}/report-criteria`);
  const data = body.data;
  if (!Array.isArray(data)) throw new ApiError("Unexpected criteria response shape");
  return data.map((c: Json) => ({
    id: c.id as number,
    name: String(c.name ?? ""),
    templates: Array.isArray(c.templates) ? (c.templates as Criterion["templates"]) : [],
  }));
}

export async function fetchJournals(session: TmsSession, studentId: number, sessionId: number, bookId: number): Promise<JournalItem[]> {
  const body = await getJson(session, `/api/cms/student/${studentId}/learning-session/${sessionId}/book/${bookId}/meeting-history/journal`);
  if (!Array.isArray(body.data)) throw new ApiError("Unexpected journal list response shape");
  return body.data as JournalItem[];
}

export async function fetchReports(session: TmsSession, studentId: number, sessionId: number, bookId: number): Promise<ReportRow[]> {
  const body = await getJson(session, `/api/tms/student/${studentId}/learning-session/${sessionId}/book/${bookId}/report`);
  if (!Array.isArray(body.data)) throw new ApiError("Unexpected report list response shape");
  return body.data as ReportRow[];
}

// ---------- pure logic ----------

/** Journals the portal wizard would include: meeting id between the From and Until journals, inclusive. */
export function journalsInRange(journals: JournalItem[], fromMeeting: number, untilMeeting: number): { from?: JournalItem; until?: JournalItem; included: JournalItem[] } {
  const byNum = (n: number) => journals.find((j) => meetingNumber(j.name) === n);
  const from = byNum(fromMeeting);
  const until = byNum(untilMeeting);
  if (!from || !until) return { from, until, included: [] };
  const lo = from.learning_session_book_meeting_id;
  const hi = until.learning_session_book_meeting_id;
  if (lo > hi) return { from, until, included: [] };
  return { from, until, included: journals.filter((j) => j.learning_session_book_meeting_id >= lo && j.learning_session_book_meeting_id <= hi) };
}

export function lowScoresIn(journals: JournalItem[], threshold = LOW_SCORE_THRESHOLD) {
  const low: Array<{ meeting: string; lesson: string; score: number }> = [];
  const unscored: Array<{ meeting: string; lesson: string }> = [];
  for (const j of journals) {
    for (const a of j.activities ?? []) {
      const lesson = a.data?.content ?? "(unnamed)";
      const s = a.score;
      if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) unscored.push({ meeting: j.name, lesson });
      else if (s < threshold) low.push({ meeting: j.name, lesson, score: s });
    }
  }
  return { low, unscored };
}

export function templateFor(c: Criterion, lang: Lang): string | undefined {
  return c.templates.find((t) => t.lang === lang)?.content;
}

const ID_WORDS = ["dan", "yang", "untuk", "dengan", "dalam", "siswa", "mampu", "telah", "sudah", "membuat", "belajar", "mempelajari", "menggunakan", "sebuah", "agar", "dapat", "juga", "pada"];
const EN_WORDS = ["the", "and", "with", "learned", "student", "was", "has", "have", "using", "his", "her", "their", "to", "of", "is", "able", "created", "built"];

/** Rough language guess. Returns undefined when there is too little text to say. */
export function guessLang(text: string): Lang | undefined {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length < 6) return undefined;
  const count = (list: string[]) => words.filter((w) => list.includes(w)).length;
  const id = count(ID_WORDS);
  const en = count(EN_WORDS);
  if (id === en) return undefined;
  return id > en ? "id" : "en";
}

/** Placeholders from the portal templates such as (student_name) or (project_name). */
export function unresolvedPlaceholders(text: string): string[] {
  return [...text.matchAll(/\((student_name|project_name|[a-z]+_[a-z_]+)\)/gi)].map((m) => m[0]);
}

export interface ReportInput {
  studentId: number;
  sessionId: number;
  bookId: number;
  criteria: Array<{ id: number; score: number; note: string }>;
  fromMeeting?: number;
  untilMeeting?: number;
  examLesson?: number;
  span?: number;
}

export function parseReportInput(a: Record<string, unknown>): ReportInput {
  const arr = a.criteria;
  const criteria: ReportInput["criteria"] = [];
  if (arr !== undefined) {
    if (!Array.isArray(arr)) throw new ValidationError("criteria must be a list of {id, score, note}");
    for (const [i, c] of arr.entries()) {
      const o = (c ?? {}) as Json;
      const score = o.score;
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) throw new ValidationError(`criteria[${i}].score must be a number from 0 to 100`);
      if (typeof o.note !== "string" || !o.note.trim()) throw new ValidationError(`criteria[${i}].note is required`);
      criteria.push({ id: positiveInt(`criteria[${i}].id`, o.id), score, note: o.note.trim() });
    }
    const ids = criteria.map((c) => c.id);
    if (new Set(ids).size !== ids.length) throw new ValidationError("Each criterion may appear only once");
  }
  const optNum = (n: string) => (a[n] === undefined ? undefined : positiveInt(n, a[n]));
  const r: ReportInput = {
    studentId: positiveInt("student_id", a.student_id),
    sessionId: positiveInt("learning_session_id", a.learning_session_id),
    bookId: positiveInt("book_id", a.book_id),
    criteria,
    fromMeeting: optNum("from_meeting"),
    untilMeeting: optNum("until_meeting"),
    examLesson: optNum("exam_lesson"),
    span: optNum("span"),
  };
  if ((r.fromMeeting === undefined) !== (r.untilMeeting === undefined)) throw new ValidationError("Give both from_meeting and until_meeting, or use exam_lesson instead");
  if (r.fromMeeting === undefined && r.examLesson === undefined) throw new ValidationError("Give exam_lesson (for example 8, 16, 24) or both from_meeting and until_meeting");
  if (r.fromMeeting !== undefined && r.untilMeeting !== undefined && r.fromMeeting > r.untilMeeting) throw new ValidationError("from_meeting cannot be after until_meeting");
  return r;
}

async function resolveRange(session: TmsSession, r: ReportInput): Promise<{ from: number; until: number; basis: string; warnings: string[] }> {
  if (r.fromMeeting !== undefined && r.untilMeeting !== undefined) return { from: r.fromMeeting, until: r.untilMeeting, basis: "meeting numbers you gave", warnings: [] };
  const meetings = await fetchAllMeetings(session, r.studentId, r.sessionId, r.bookId);
  const range = findReportRange(meetings, r.examLesson, r.span);
  const from = meetingNumber(range.from.meeting_name);
  const until = meetingNumber(range.end.meeting_name);
  if (from === undefined || until === undefined) throw new ApiError("Could not read meeting numbers from the meeting history.");
  return { from, until, basis: `exam Lesson ${range.exam_lesson}: Lesson ${range.from_lesson} to Lesson ${range.exam_lesson}`, warnings: range.warnings };
}

// ---------- tools ----------

/** Read only. Everything needed to ask you for scores and to draft the notes. */
export async function prepareReport(session: TmsSession, r: ReportInput) {
  const overview = await fetchLessonOverview(session, r);
  if (overview) return prepareLessonReport(session, r, overview);
  const [info, journals, reports] = await Promise.all([
    fetchBookInfo(session, r.studentId, r.sessionId, r.bookId),
    fetchJournals(session, r.studentId, r.sessionId, r.bookId),
    fetchReports(session, r.studentId, r.sessionId, r.bookId),
  ]);
  const criteria = await fetchCriteria(session, info.courseId);
  const range = await resolveRange(session, r);
  const warnings = [...range.warnings];
  const picked = journalsInRange(journals, range.from, range.until);
  const available = journals.map((j) => j.name);
  if (!picked.from || !picked.until) {
    warnings.push(
      `The portal report form can only start and end on meetings that have a created journal. ` +
        `${!picked.from ? `Meeting ${range.from} has no created journal. ` : ""}${!picked.until ? `Meeting ${range.until} has no created journal. ` : ""}` +
        `Meetings with journals: ${available.join(", ") || "none"}.`,
    );
  }
  const name = `Meeting ${range.from} - Meeting ${range.until}`;
  const dup = reports.find((x) => { const p = parseReportRange(x.name); return p && p.from === range.from && p.to === range.until; });
  if (dup) warnings.push(`A report named "${dup.name}" already exists (id ${dup.id}). Creating another would duplicate it.`);
  if (!info.lang) warnings.push(`The portal did not give a clear language for this book (value: ${JSON.stringify(info.rawLang)}). Ask the teacher which language to use.`);
  const scores = lowScoresIn(picked.included);
  const lang = info.lang;
  return {
    report_name: name,
    range_basis: range.basis,
    language: lang ?? null,
    language_source: "the book's lang field in the portal (my inference that this is the student's chosen language)",
    book: info.bookName,
    journals_included: picked.included.map((j) => ({ meeting: j.name, journal_id: j.id, status: j.status, teacher_note: j.teacher_note ?? "" })),
    criteria_needed: criteria.map((c) => ({
      id: c.id,
      name: c.name,
      starting_template: lang ? templateFor(c, lang) ?? null : null,
      available_languages: c.templates.map((t) => t.lang),
    })),
    criteria_count: criteria.length,
    next_step:
      "Ask the teacher for a score (0 to 100) for EVERY criterion listed, then draft one note per criterion in the stated language, replacing placeholders like (student_name).",
    quiz_scores_below_threshold: scores.low,
    threshold: LOW_SCORE_THRESHOLD,
    unscored_lessons: scores.unscored,
    warnings,
  };
}

/** Every criterion of the course must be present once, in the student's language, with no template placeholders left. */
function checkCriteria(r: ReportInput, criteria: Criterion[], lang: Lang, opts: { allowLanguageMismatch?: boolean }): void {
  // Every criterion of the course must be present, once.
  const have = new Set(r.criteria.map((c) => c.id));
  const missing = criteria.filter((c) => !have.has(c.id));
  const unknown = r.criteria.filter((c) => !criteria.some((k) => k.id === c.id));
  if (unknown.length) throw new ValidationError(`Criteria ids not in this course: ${unknown.map((u) => u.id).join(", ")}. The course has: ${criteria.map((c) => `${c.id} ${c.name}`).join("; ")}.`);
  if (missing.length) throw new ValidationError(`Missing criteria: ${missing.map((c) => `${c.id} ${c.name}`).join("; ")}. A report needs a score and a note for every criterion.`);

  for (const c of r.criteria) {
    const name = criteria.find((k) => k.id === c.id)!.name;
    const ph = unresolvedPlaceholders(c.note);
    if (ph.length) throw new ValidationError(`The note for "${name}" still contains placeholder(s) ${ph.join(", ")}. Replace them with real text.`);
    const g = guessLang(c.note);
    if (g && g !== lang && !opts.allowLanguageMismatch) {
      throw new ValidationError(`The note for "${name}" looks ${g === "id" ? "Indonesian" : "English"} but this student's language is ${lang === "id" ? "Indonesian" : "English"}. Rewrite it, or pass allow_language_mismatch=true if that is intended.`);
    }
  }
}

/** Creates the report only when confirm is true. Otherwise returns exactly what would be sent. */
export async function createReport(session: TmsSession, r: ReportInput, confirm: boolean, opts: { allowLanguageMismatch?: boolean } = {}) {
  const overview = await fetchLessonOverview(session, r);
  if (overview) return createLessonReport(session, r, overview, confirm, opts);
  const [info, journals, reports] = await Promise.all([
    fetchBookInfo(session, r.studentId, r.sessionId, r.bookId),
    fetchJournals(session, r.studentId, r.sessionId, r.bookId),
    fetchReports(session, r.studentId, r.sessionId, r.bookId),
  ]);
  const criteria = await fetchCriteria(session, info.courseId);
  if (!info.lang) throw new ValidationError(`The portal gave no clear language for this book (${JSON.stringify(info.rawLang)}). Tell me the language and I will use that.`);

  checkCriteria(r, criteria, info.lang, opts);

  const range = await resolveRange(session, r);
  const picked = journalsInRange(journals, range.from, range.until);
  if (!picked.from || !picked.until || picked.included.length === 0) {
    throw new ValidationError(
      `Cannot build the report: Meeting ${range.from} or Meeting ${range.until} has no created journal. Meetings with journals: ${journals.map((j) => j.name).join(", ") || "none"}.`,
    );
  }
  const dup = reports.find((x) => { const p = parseReportRange(x.name); return p && p.from === range.from && p.to === range.until; });
  if (dup) throw new ValidationError(`A report "${dup.name}" already exists (id ${dup.id}). I will not create a duplicate.`);

  const body = {
    learning_session_book_meeting_journal_ids: picked.included.map((j) => j.id),
    criterias: r.criteria.map((c) => ({ id: c.id, score: c.score, note: c.note })),
  };
  const preview = { report_name: `Meeting ${range.from} - Meeting ${range.until}`, language: info.lang, journals: picked.included.map((j) => j.name), body };
  if (!confirm) return { created: false, message: "Preview only. Nothing was sent. Run again with confirm=true after the teacher approves.", ...preview };

  const res = await session.apiSend("POST", `/api/tms/student/${r.studentId}/learning-session/${r.sessionId}/book/${r.bookId}/report`, { json: body });
  if (res.status >= 400) throw new ApiError(`The portal rejected the report (status ${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`, res.status);
  const after = await fetchReports(session, r.studentId, r.sessionId, r.bookId);
  const found = after.find((x) => { const p = parseReportRange(x.name); return p && p.from === range.from && p.to === range.until; });
  return { created: !!found, verified_in_list: !!found, report: found ?? null, ...preview };
}

// ---------- lesson based reports (the portal's new report builder, Nov 2026) ----------
// The Create Report page now asks the portal which lesson ranges exist and which lessons are ready:
//   GET  .../book/{id}/report/lessons                    -> {is_lesson_based, ranges: [{from, until, report_id?}], ...}
//   GET  .../book/{id}/report/lessons?from=9&until=16    -> {eligible, not_eligible, meetings_without_lesson, can_submit}
//   POST .../book/{id}/report  {learning_session_book_meeting_journal_ids: [], lesson_from, lesson_until,
//                               meeting_journal_ids_without_lesson: [journal ids], criterias: [{id, score, note}]}
// A lesson is "not eligible" while it has no daily journal, and the page refuses to continue until none are left.

interface LessonRange { from: number; until: number; report_id?: number; lessons_learned?: number; lessons_need_journal?: number }
interface LessonRow { lesson_number: number; title: string; meeting_name?: string; journal_status?: string; journal_id?: number; score?: number; progress_percentage?: number }
interface LessonOverview {
  is_lesson_based: boolean;
  ranges: LessonRange[];
  eligible: LessonRow[];
  not_eligible: LessonRow[];
  meetings_without_lesson: Array<{ meeting_name?: string; journal_id?: number; journal_status?: string; selectable?: boolean }>;
  can_submit?: boolean;
}

const reportBase = (r: ReportInput) => `/api/tms/student/${r.studentId}/learning-session/${r.sessionId}/book/${r.bookId}/report`;

/** The lesson based builder's data, or undefined when this book still uses the old meeting based form. */
export async function fetchLessonOverview(session: TmsSession, r: ReportInput, range?: { from: number; until: number }): Promise<LessonOverview | undefined> {
  const res = await session.api(`${reportBase(r)}/lessons`, range);
  if (res.status === 404) return undefined;
  if (res.status >= 400) throw new ApiError(`The portal would not open the report builder (status ${res.status}): ${String((res.body as Json | null)?.message ?? "").slice(0, 200)}`, res.status);
  const d = (res.body as Json | null)?.data as LessonOverview | undefined;
  return d?.is_lesson_based === true && Array.isArray(d.ranges) ? d : undefined;
}

const rangeList = (ov: LessonOverview) => ov.ranges.map((x) => `Lesson ${x.from} to ${x.until}${x.report_id ? " (report exists)" : ""}`).join("; ") || "none (lessons per report is not set for this book in the portal)";

export function pickLessonRange(ov: LessonOverview, r: ReportInput): LessonRange {
  if (r.examLesson === undefined) throw new ValidationError(`This book uses the portal's lesson based reports, which go by lesson range, not meeting numbers. Pass exam_lesson (the last lesson of the range). Ranges: ${rangeList(ov)}.`);
  const range = ov.ranges.find((x) => x.from <= r.examLesson! && r.examLesson! <= x.until);
  if (!range) throw new ValidationError(`No report range contains Lesson ${r.examLesson}. Ranges: ${rangeList(ov)}.`);
  return range;
}

const lessonLine = (l: LessonRow) => ({ lesson: l.lesson_number, title: l.title, meeting: l.meeting_name ?? "", journal_status: l.journal_status ?? "", progress_percentage: l.progress_percentage ?? 0, score: l.score ?? null });

async function loadLessonRange(session: TmsSession, r: ReportInput, overview: LessonOverview) {
  const range = pickLessonRange(overview, r);
  const sections = await fetchLessonOverview(session, r, { from: range.from, until: range.until });
  if (!sections) throw new ApiError("The portal did not return the lessons of this range.");
  const extra = sections.meetings_without_lesson.filter((m) => m.selectable && typeof m.journal_id === "number");
  return { range, sections, extra, name: `Lesson ${range.from} - Lesson ${range.until}` };
}

async function prepareLessonReport(session: TmsSession, r: ReportInput, overview: LessonOverview) {
  const info = await fetchBookInfo(session, r.studentId, r.sessionId, r.bookId);
  const criteria = await fetchCriteria(session, info.courseId);
  const { range, sections, extra, name } = await loadLessonRange(session, r, overview);
  const warnings: string[] = [];
  if (range.report_id) warnings.push(`A report for ${name} already exists (id ${range.report_id}). Creating another is refused.`);
  if (sections.not_eligible.length) warnings.push(`The portal blocks this report until every learned lesson has a daily journal. Missing: ${sections.not_eligible.map((l) => `Lesson ${l.lesson_number}${l.meeting_name ? ` (${l.meeting_name})` : " (no meeting yet)"}`).join(", ")}.`);
  else if (sections.can_submit === false) warnings.push("The portal says this range cannot be submitted yet (can_submit is false), usually because not every lesson of the range is learned.");
  if (!info.lang) warnings.push(`The portal did not give a clear language for this book (value: ${JSON.stringify(info.rawLang)}). Ask the teacher which language to use.`);
  const scored = sections.eligible.filter((l) => typeof l.score === "number" && l.score > 0);
  return {
    report_name: name,
    mode: "lesson_based",
    range_basis: `the portal's own range that contains Lesson ${r.examLesson}`,
    all_ranges: rangeList(overview),
    can_submit: sections.can_submit === true,
    language: info.lang ?? null,
    book: info.bookName,
    lessons_ready: sections.eligible.map(lessonLine),
    lessons_blocking: sections.not_eligible.map(lessonLine),
    extra_meetings_included: extra.map((m) => m.meeting_name ?? ""),
    criteria_needed: criteria.map((c) => ({ id: c.id, name: c.name, starting_template: info.lang ? templateFor(c, info.lang) ?? null : null, available_languages: c.templates.map((t) => t.lang) })),
    criteria_count: criteria.length,
    next_step: "Ask the teacher for a score (0 to 100) for EVERY criterion listed, then draft one note per criterion in the stated language, replacing placeholders like (student_name).",
    quiz_scores_below_threshold: scored.filter((l) => l.score! < LOW_SCORE_THRESHOLD).map((l) => ({ lesson: l.title, score: l.score })),
    threshold: LOW_SCORE_THRESHOLD,
    unscored_lessons: sections.eligible.filter((l) => !(typeof l.score === "number" && l.score > 0)).map((l) => l.title),
    warnings,
  };
}

async function createLessonReport(session: TmsSession, r: ReportInput, overview: LessonOverview, confirm: boolean, opts: { allowLanguageMismatch?: boolean }) {
  const info = await fetchBookInfo(session, r.studentId, r.sessionId, r.bookId);
  const criteria = await fetchCriteria(session, info.courseId);
  if (!info.lang) throw new ValidationError(`The portal gave no clear language for this book (${JSON.stringify(info.rawLang)}). Tell me the language and I will use that.`);
  checkCriteria(r, criteria, info.lang, opts);
  const { range, sections, extra, name } = await loadLessonRange(session, r, overview);
  if (range.report_id) throw new ValidationError(`A report for ${name} already exists (id ${range.report_id}). I will not create a duplicate.`);
  if (sections.not_eligible.length) {
    throw new ValidationError(`The portal does not allow this report yet: these lessons have no daily journal: ${sections.not_eligible.map((l) => `Lesson ${l.lesson_number}${l.meeting_name ? ` (${l.meeting_name})` : ""}`).join(", ")}. Write those journals first.`);
  }
  if (sections.eligible.length === 0 && extra.length === 0) throw new ValidationError(`There is no lesson with a daily journal in ${name}, so there is nothing to report.`);

  const body = {
    learning_session_book_meeting_journal_ids: [],
    lesson_from: range.from,
    lesson_until: range.until,
    meeting_journal_ids_without_lesson: extra.map((m) => m.journal_id),
    criterias: r.criteria.map((c) => ({ id: c.id, score: c.score, note: c.note })),
  };
  const preview = { report_name: name, mode: "lesson_based", language: info.lang, lessons: sections.eligible.map((l) => l.title), can_submit: sections.can_submit === true, body };
  if (!confirm) return { created: false, message: "Preview only. Nothing was sent. Run again with confirm=true after the teacher approves.", ...preview };

  const res = await session.apiSend("POST", reportBase(r), { json: body });
  if (res.status >= 400) throw new ApiError(`The portal rejected the report (status ${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`, res.status);
  const after = await fetchLessonOverview(session, r);
  const reportId = after?.ranges.find((x) => x.from === range.from)?.report_id;
  return { created: !!reportId, verified_in_list: !!reportId, report_id: reportId ?? null, ...preview };
}
