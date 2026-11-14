import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { API, LIST_LIMIT } from "./config.js";
import { getJournal, parseDraftInput, parseMeetingRef, saveJournalDraft } from "./journal.js";
import { examLikeLessons, fetchAllMeetings, findReportRange } from "./reports.js";
import { auditOneBook, describeBlock, listAllBooks, listBooksForStudent, pool, type BookRef } from "./audit.js";
import { fetchAttendance, findAttendanceGaps, parseAttendanceRange } from "./attendance.js";
import { parseScoreChanges, updateLessonScores } from "./grades.js";
import { runLessonSync, syncAfterJournalSave } from "./sheets.js";
import { submitJournal } from "./submit.js";
import { listClassJournals, sendJournalToParent } from "./sendparent.js";
import { createReport, fetchBookInfo, parseReportInput, prepareReport } from "./reportcreate.js";
import { fetchPendingRows, LOW_SCORE_THRESHOLD, lowScoreRows, quizCheckForBlock, quizCheckForMeeting } from "./scores.js";
import { ApiError, ConfigError, loadConfig, TmsSession } from "./session.js";
import {
  autoApproveProjects,
  autoSendJournals,
  listProjectApprovals,
  loadMyClasses,
  logAction,
  PROJECT_DIR,
  readAutoConfig,
  setProjectStatus,
  toProjectRow,
} from "./automation.js";
import { listInboxPhotos } from "./inbox.js";
import { fetchClassDetail, finishClass, isRenting, setClassPresence } from "./classattendance.js";
import { findStudentsByName } from "./students.js";
import { fetchBookLessons, getLessonAccess, setLessonAccess } from "./lessonaccess.js";
import { portalGet } from "./portalget.js";
import { writeFile } from "node:fs/promises";
import { clampInt, redact, ValidationError } from "./validate.js";

// Load .env that sits next to the project folder, regardless of where the client launched us from.
try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"));
} catch {
  /* no .env file: fall back to real environment variables */
}

// stdout belongs to the MCP protocol, so all logging goes to stderr.
const log = (...a: unknown[]) => console.error("[timedoor-tms]", ...a);

let session: TmsSession | undefined;
function getSession(): TmsSession {
  if (!session) session = new TmsSession(loadConfig());
  return session;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

async function guarded(job: (s: TmsSession) => Promise<unknown>): Promise<ToolResult> {
  const secrets = [process.env.TMS_PASSWORD, process.env.TMS_USERNAME];
  try {
    const s = getSession();
    return ok(await s.run(() => job(s)));
  } catch (e) {
    const err = e as Error;
    const kind =
      e instanceof ValidationError || e instanceof ConfigError || e instanceof ApiError || err.name === "LoginError"
        ? err.name
        : "UnexpectedError";
    const message = redact(String(err.message ?? err), secrets).slice(0, 600);
    log(kind, message);
    return { content: [{ type: "text", text: `${kind}: ${message}` }], isError: true };
  }
}

const pageArgs = {
  limit: z.number().optional().describe(`Rows per page, ${LIST_LIMIT.min} to ${LIST_LIMIT.max}, default ${LIST_LIMIT.default}`),
  page: z.number().optional().describe("Page number starting at 1"),
};
const meetingArgs = {
  student_id: z.number().describe("Numeric student id (the 'id' field, not the STD code)"),
  learning_session_id: z.number().describe("learning_session_id from the pending journal list"),
  book_id: z.number().describe("learning_session_book_id from the pending journal list"),
  meeting_id: z.number().describe("learning_session_book_meeting_id from the pending journal list"),
};

/** The course a student's book belongs to, in the form the sheet sync uses to pick the student's row. */
async function portalCourseOf(s: TmsSession, ref: { studentId: number; sessionId: number; bookId: number }) {
  const info = await fetchBookInfo(s, ref.studentId, ref.sessionId, ref.bookId);
  return { names: [info.bookName, info.courseName].filter(Boolean), lang: info.lang };
}

/** After a draft is really saved, sync the lesson progress sheet. Never throws, so it cannot hide a saved journal. */
async function sheetSyncAfterSave(s: TmsSession, input: ReturnType<typeof parseDraftInput>): Promise<unknown> {
  if (input.dryRun) return { status: "skipped", reason: "Dry run: no journal was saved, so the sheet was not changed." };
  try {
    const rows = await fetchPendingRows(s);
    const row = rows.find((r) => r.student?.id === input.ref.studentId && r.learning_session_book_meeting_id === input.ref.meetingId);
    return row
      ? await syncAfterJournalSave(row.student.name, row.lessons, input.teacherNotes, process.env, await portalCourseOf(s, input.ref))
      : { status: "skipped", reason: "This meeting is not in the pending journal list, so the sheet was not changed." };
  } catch (e) {
    return { status: "failed", reason: String((e as Error).message ?? e).slice(0, 300) };
  }
}

const server = new McpServer({ name: "timedoor-tms", version: "0.1.0" });

server.registerTool(
  "tms_auth_status",
  {
    description:
      "Log in to the Timedoor teacher portal (if not already) and report whether the session and API access work. Uses the portal's login API (no browser): a saved session file first, then the refresh token, then the password. Run this first to check setup. Never returns credentials or tokens.",
    inputSchema: {},
  },
  async () => guarded((s) => s.status()),
);

server.registerTool(
  "tms_list_pending_journals",
  {
    description:
      "List daily journals that still need writing for the logged in teacher. Each row has student, class, book, lesson list, meeting date and the ids needed to write the journal.",
    inputSchema: {
      status: z.enum(["not_created", "draft", "all"]).optional().describe("Default all (not_created plus draft)"),
      class_id: z.number().optional().describe("Only rows for this class_id (filtered after fetching)"),
      search: z.string().max(100).optional().describe("Student name search"),
      ...pageArgs,
    },
  },
  async (a) =>
    guarded(async (s) => {
      const limit = clampInt("limit", a.limit);
      const page = clampInt("page", a.page, 1, 10_000, 1);
      const statuses = a.status === "not_created" ? ["not_created"] : a.status === "draft" ? ["draft"] : ["not_created", "draft"];
      const r = await s.api(API.pendingJournals, { search: a.search ?? "", statuses, limit, page });
      if (r.status >= 400) throw new ApiError(`Pending journal list failed with status ${r.status}`, r.status);
      const body = r.body as { data?: Array<{ class_id?: number }>; meta?: unknown };
      let rows = body.data ?? [];
      if (a.class_id !== undefined) rows = rows.filter((x) => x.class_id === a.class_id);
      return { meta: body.meta, count: rows.length, rows };
    }),
);

server.registerTool(
  "tms_list_students",
  {
    description: "List the teacher's students (name, code, number of sessions, parent name).",
    inputSchema: { search: z.string().max(100).optional(), ...pageArgs },
  },
  async (a) =>
    guarded(async (s) => {
      const r = await s.api(API.students, {
        search: a.search ?? "",
        limit: clampInt("limit", a.limit),
        page: clampInt("page", a.page, 1, 10_000, 1),
      });
      if (r.status >= 400) throw new ApiError(`Student list failed with status ${r.status}`, r.status);
      return r.body;
    }),
);

server.registerTool(
  "tms_find_student",
  {
    description:
      "Search the teacher's students by name (part of the name is fine, case ignored). Returns each matching student's id, name, code and status, plus the portal's student detail for up to 5 matches. Read only.",
    inputSchema: { name: z.string().min(2).max(100).describe("Name or part of a name"), max_details: z.number().int().min(0).max(5).optional() },
  },
  async (a) => guarded((s) => findStudentsByName(s, a.name, { maxDetails: a.max_details ?? 5 })),
);

server.registerTool(
  "tms_list_classes",
  {
    description:
      "List the teacher's classes. The exact response fields for classes were not verified when this was built, so the raw rows are returned.",
    inputSchema: { search: z.string().max(100).optional(), ...pageArgs },
  },
  async (a) =>
    guarded(async (s) => {
      const r = await s.api(API.classes, {
        search: a.search ?? "",
        limit: clampInt("limit", a.limit),
        page: clampInt("page", a.page, 1, 10_000, 1),
      });
      if (r.status >= 400) throw new ApiError(`Class list failed with status ${r.status}`, r.status);
      return r.body;
    }),
);

server.registerTool(
  "tms_get_meeting_journal",
  {
    description:
      "Read the meeting details and the existing daily journal (if any) for one student meeting. Use this before writing a journal.",
    inputSchema: meetingArgs,
  },
  async (a) => guarded((s) => getJournal(s, parseMeetingRef(a))),
);

server.registerTool(
  "tms_save_journal_draft",
  {
    description:
      "Fill in the daily journal for one student meeting and click 'Save as Draft' in the portal. This NEVER submits or finalises it; the teacher reviews and submits in the portal. teacher_notes is limited to 200 characters. Refuses to touch a journal that already exists unless it is a draft or overwrite_existing=true. Use dry_run=true to fill the form without saving.",
    inputSchema: {
      ...meetingArgs,
      teacher_notes: z.string().describe("Teacher notes about the student this meeting, max 200 characters"),
      project: z.string().optional().describe("Project name"),
      active_project: z.boolean().optional().describe("Tick or untick the 'Active project' checkbox"),
      photos: z
        .array(z.string())
        .max(2)
        .optional()
        .describe(
          "Up to 2 evidence photos as file paths ON THIS COMPUTER (JPG, PNG, HEIC, or a PDF whose first pages become photos). Each under 15 MB. Not uploaded during dry_run.",
        ),
      generate_ai_summary: z.boolean().optional().describe("Also click the portal's own 'Generate AI Summary' button (parent facing summary) before saving the draft. Not run during dry_run."),
      dry_run: z.boolean().optional().describe("Fill the form but do not save"),
      overwrite_existing: z.boolean().optional().describe("Allow editing a journal that is not a draft"),
    },
  },
  async (a) =>
    guarded(async (s) => {
      const input = parseDraftInput(a); // validate before touching the browser
      const quiz = await quizCheckForMeeting(s, input.ref.studentId, input.ref.meetingId);
      const saved = await saveJournalDraft(s, input);
      return { ...saved, quiz_check: quiz, sheet_sync: await sheetSyncAfterSave(s, input) };
    }),
);

server.registerTool(
  "tms_find_report_range",
  {
    description:
      "Work out which meetings a student progress report should span. The END meeting is where the exam lesson was taught (for example Lesson 8, 16, 24, 32) and the FROM meeting is where the first lesson of that block was taught (exam lesson minus span plus 1; for Lesson 8 that is Lesson 1). Read only. Also lists lessons that look like exams if you are unsure which number to use.",
    inputSchema: {
      student_id: meetingArgs.student_id,
      learning_session_id: meetingArgs.learning_session_id,
      book_id: meetingArgs.book_id,
      exam_lesson: z.number().describe("Lesson number of the exam, e.g. 8, 16, 24, 32"),
      span: z.number().optional().describe("Lessons per report block, default 8"),
    },
  },
  async (a) =>
    guarded(async (s) => {
      const ref = parseMeetingRef({ ...a, meeting_id: 1 });
      const meetings = await fetchAllMeetings(s, ref.studentId, ref.sessionId, ref.bookId);
      try {
        const range = findReportRange(meetings, a.exam_lesson, a.span);
        const quiz = await quizCheckForBlock(s, ref.studentId, ref.bookId, range.from_lesson, range.exam_lesson);
        return { ...range, meetings_checked: meetings.length, quiz_check: quiz };
      } catch (e) {
        if (e instanceof ApiError) {
          const hints = examLikeLessons(meetings);
          throw new ApiError(hints.length ? `${e.message} Lessons that look like exams: ${hints.map((h) => h.lesson_number + " (" + h.date + ")").join(", ")}.` : e.message);
        }
        throw e;
      }
    }),
);

server.registerTool(
  "tms_list_report_reminders",
  {
    description:
      "List student report reminders (students who finished a lesson and are due a progress report). Read only. Creating the report itself is not supported yet: use tms_find_report_range to get the meeting range.",
    inputSchema: { search: z.string().max(100).optional(), ...pageArgs },
  },
  async (a) =>
    guarded(async (s) => {
      const r = await s.api(API.reportReminders, {
        search: a.search ?? "",
        limit: clampInt("limit", a.limit),
        page: clampInt("page", a.page, 1, 10_000, 1),
      });
      if (r.status >= 400) throw new ApiError(`Report reminder list failed with status ${r.status}`, r.status);
      return r.body;
    }),
);

server.registerTool(
  "tms_list_student_reports",
  {
    description: "List the reports that already exist for one student's book. Read only.",
    inputSchema: {
      student_id: meetingArgs.student_id,
      learning_session_id: meetingArgs.learning_session_id,
      book_id: meetingArgs.book_id,
    },
  },
  async (a) =>
    guarded(async (s) => {
      const ref = parseMeetingRef({ ...a, meeting_id: 1 });
      const r = await s.api(API.studentReports(ref.studentId, ref.sessionId, ref.bookId));
      if (r.status >= 400) throw new ApiError(`Report list failed with status ${r.status}`, r.status);
      return r.body;
    }),
);

server.registerTool(
  "tms_check_report_gaps",
  {
    description:
      "Manually check which progress reports exist and which are missing. The portal's own report status is deliberately IGNORED (known bug). For each book it finds the highest lesson reached from the meeting history, builds the expected blocks (Lessons 1 to 8, 9 to 16, 17 to 24 ...), and checks whether an existing report's meeting range covers each block's meetings. Example: a student on Lesson 22 with only a report for Lessons 1 to 8 is told the Lessons 9 to 16 report is missing. Give student_id for one student, or omit it to scan all your students (slower). Read only.",
    inputSchema: {
      student_id: z.number().optional().describe("Only this student. Omit to scan every student."),
      include_completed: z.boolean().optional().describe("Also check books marked completed. Default false."),
      span: z.number().optional().describe("Lessons per report block, default 8"),
      max_books: z.number().optional().describe("Safety cap on books scanned, default 60"),
    },
  },
  async (a) =>
    guarded(async (s) => {
      const span = a.span === undefined ? 8 : clampInt("span", a.span, 1, 100, 8);
      const cap = clampInt("max_books", a.max_books, 1, 300, 60);
      const includeCompleted = a.include_completed === true;
      let books: BookRef[];
      const scanErrors: string[] = [];
      if (a.student_id !== undefined) {
        const all = await listBooksForStudent(s, clampInt("student_id", a.student_id, 1, 2_000_000_000, 1));
        books = includeCompleted ? all : all.filter((b) => b.bookStatus !== "completed");
      } else {
        const r = await listAllBooks(s, { includeCompleted });
        books = r.books;
        scanErrors.push(...r.errors);
      }
      const truncated = books.length > cap;
      books = books.slice(0, cap);
      const results = await pool(books, 3, (b) => auditOneBook(s, b, span));
      const reminders: string[] = [];
      const detail = books.map((b, i) => {
        const r = results[i];
        const label = `${b.studentName || "Student " + b.studentId} / ${b.bookName}`;
        if (!r.ok) {
          scanErrors.push(`${label}: ${r.error}`);
          return { student_id: b.studentId, student: b.studentName, book: b.bookName, error: r.error };
        }
        for (const m of r.value.missing) reminders.push(`${label}: ${describeBlock(m)}`);
        return {
          student_id: b.studentId,
          student: b.studentName,
          learning_session_id: b.sessionId,
          book_id: b.bookId,
          book: b.bookName,
          book_status: b.bookStatus,
          current_lesson: r.value.current_lesson,
          missing: r.value.missing,
          blocks: r.value.blocks.map((x) => ({ lessons: `${x.from_lesson}-${x.exam_lesson}`, state: x.state, end_meeting: x.end_meeting, report: x.covered_by?.name })),
          reports: r.value.reports,
          warnings: r.value.warnings,
        };
      });
      return {
        books_checked: books.length,
        truncated_at_cap: truncated,
        reminders,
        errors: scanErrors,
        note: "Based only on report names (Meeting A - Meeting B) versus meeting history. Portal status flags are not used. Check anything marked partial or unlocatable by hand.",
        detail,
      };
    }),
);

server.registerTool(
  "tms_list_low_scores",
  {
    description: `List pending (not yet submitted) journals where a lesson quiz score is below ${LOW_SCORE_THRESHOLD}. Read only. Only meetings still in the pending list expose scores. A score of 0 or blank is treated as not scored, not as low. This tool never changes grades.`,
    inputSchema: { threshold: z.number().optional().describe(`Default ${LOW_SCORE_THRESHOLD}`) },
  },
  async (a) =>
    guarded(async (s) => {
      const threshold = a.threshold === undefined ? LOW_SCORE_THRESHOLD : clampInt("threshold", a.threshold, 1, 100, LOW_SCORE_THRESHOLD);
      const rows = await fetchPendingRows(s);
      const low = lowScoreRows(rows, threshold);
      return { threshold, pending_rows_checked: rows.length, count: low.length, rows: low };
    }),
);

const reportArgs = {
  student_id: meetingArgs.student_id,
  learning_session_id: meetingArgs.learning_session_id,
  book_id: meetingArgs.book_id,
  exam_lesson: z.number().optional().describe("Exam lesson number (8, 16, 24, ...). Use this OR from_meeting and until_meeting."),
  span: z.number().optional().describe("Lessons per block, default 8"),
  from_meeting: z.number().optional().describe("Meeting number to start from, for example 17 for 'Meeting 17'"),
  until_meeting: z.number().optional().describe("Meeting number to end at"),
};

server.registerTool(
  "tms_prepare_report",
  {
    description:
      "Read only. Gets everything needed to write a student report: the meeting range, the student's report LANGUAGE (en or id, from the portal), ALL report criteria for that course (3 or 4, they differ per course) with the portal's starting template in that language, the journals inside the range, and quiz scores below 75. Then ask the teacher for a score for every criterion and draft one note per criterion in the stated language.",
    inputSchema: reportArgs,
  },
  async (a) => guarded((s) => prepareReport(s, parseReportInput(a))),
);

server.registerTool(
  "tms_create_report",
  {
    description:
      "Create the student report in the portal. Books on the portal's new lesson based report builder (most now) go by lesson range: pass exam_lesson (8, 16, 24 ...) and the portal's own range containing it is used; the portal refuses while any learned lesson in the range has no daily journal. Needs a score (0 to 100) and a note for EVERY criterion of the course, notes in the student's language, no leftover placeholders like (student_name). Without confirm=true it only returns a preview and sends nothing. Refuses duplicates and ranges whose first or last meeting has no created journal. The portal report form has no draft step, so a confirmed call creates the report for real.",
    inputSchema: {
      ...reportArgs,
      criteria: z.array(z.object({ id: z.number(), score: z.number(), note: z.string() })).describe("One entry per course criterion: id from tms_prepare_report, score 0 to 100, note text"),
      confirm: z.boolean().optional().describe("Must be true to actually create the report"),
      allow_language_mismatch: z.boolean().optional(),
    },
  },
  async (a) => guarded((s) => createReport(s, parseReportInput(a), a.confirm === true, { allowLanguageMismatch: a.allow_language_mismatch === true })),
);

server.registerTool(
  "tms_check_attendance_gaps",
  {
    description:
      "Read only. Finds class sessions that already ended but still have no attendance recorded (still active, no attendance status), sessions whose attendance is not approved, and a per student absence and lateness count. Default range is the last 30 days. Sessions marked drop are treated as cancelled.",
    inputSchema: { start_date: z.string().optional().describe("YYYY-MM-DD"), end_date: z.string().optional().describe("YYYY-MM-DD, default today") },
  },
  async (a) =>
    guarded(async (s) => {
      const range = parseAttendanceRange(a);
      const rows = await fetchAttendance(s, range.start, range.end);
      return findAttendanceGaps(rows, range);
    }),
);

server.registerTool(
  "tms_update_lesson_scores",
  {
    description:
      "Change lesson quiz scores on an EXISTING journal, draft or already created. Without confirm=true it only shows the before and after and sends nothing. Refuses journals already sent to the parent unless allow_sent=true. Existing photos stay as they are (no re upload needed), and so do the teacher note and AI summary. Reads the journal back to verify scores, notes and photo count. This write path comes from the portal's own code and has not been proven on the live site yet, so test it on one draft first.",
    inputSchema: {
      ...meetingArgs,
      changes: z.array(z.object({ lesson: z.number().optional(), activity_id: z.number().optional(), score: z.number() })).describe("Lesson number (or activity_id) and the new score 0 to 100"),
      confirm: z.boolean().optional(),
      allow_sent: z.boolean().optional().describe("Also allow a journal already sent to the parent"),
    },
  },
  async (a) =>
    guarded(async (s) => {
      const ref = parseMeetingRef(a);
      const changes = parseScoreChanges(a.changes);
      return updateLessonScores(s, ref, changes, a.confirm === true, a.allow_sent === true);
    }),
);

server.registerTool(
  "tms_submit_journal",
  {
    description:
      "Submit (finalise) an EXISTING draft journal. Needs a teacher note, an AI summary and 1 to 2 photos already on the draft (it re sends the saved photos, no re upload). Without confirm=true it only previews and sends nothing, and lists quiz scores below 75. Show the teacher the note and photos and get a clear yes before confirm=true. Reads the journal back to verify. Built from the portal's own code, not yet proven live.",
    inputSchema: { ...meetingArgs, confirm: z.boolean().optional().describe("Must be true to actually submit") },
  },
  async (a) =>
    guarded(async (s) => submitJournal(s, parseMeetingRef(a), a.confirm === true)),
);

server.registerTool(
  "tms_list_journals_to_send",
  {
    description:
      "Read only. Lists daily journals that are submitted but NOT yet sent to parents (status created or revision), class by class, using the Class Attendance pages. Each row has the student, class, date, book and the exact ids for tms_send_journal_to_parent. Default range is the last 7 days. Give attendance_id for one class session, or class_search to match a class name.",
    inputSchema: {
      start_date: z.string().optional().describe("YYYY-MM-DD, default 7 days before end_date"),
      end_date: z.string().optional().describe("YYYY-MM-DD, default today (Jakarta time)"),
      attendance_id: z.number().optional().describe("One class session (the number in /tms/class-attendance/<id>)"),
      class_search: z.string().max(100).optional().describe("Only classes whose name contains this text"),
      include_all: z.boolean().optional().describe("Also return every student row with its journal status, not only the ones ready to send"),
    },
  },
  async (a) =>
    guarded(async (s) => {
      const range = parseAttendanceRange({ start_date: a.start_date, end_date: a.end_date }, undefined, 7);
      const attendanceId = a.attendance_id === undefined ? undefined : clampInt("attendance_id", a.attendance_id, 1, 2_000_000_000, 1);
      return listClassJournals(s, { ...range, attendanceId, classSearch: a.class_search?.trim() || undefined, includeAll: a.include_all === true });
    }),
);

server.registerTool(
  "tms_send_journal_to_parent",
  {
    description:
      "Send one submitted daily journal to the student's parents (the portal sends it via WhatsApp). Works by opening the journal in the portal and pressing its own 'Send to Parent' button, so the portal renders and sends the journal exactly as it would by hand. The journal must already be submitted (status created). Without confirm=true it only previews: it shows the note, AI summary, photo count and quiz scores below 75 and checks the button exists, but sends nothing. Show the teacher the preview and get a clear yes before confirm=true. Never re sends a journal that is already sent. Reads the journal back to verify.",
    inputSchema: { ...meetingArgs, confirm: z.boolean().optional().describe("Must be true to actually send to parents") },
  },
  async (a) =>
    guarded(async (s) => {
      const ref = parseMeetingRef(a);
      const out = await sendJournalToParent(s, ref, a.confirm === true);
      if (a.confirm === true) await logAction({ action: "journal_sent_to_parent", via: "manual", ok: out.sent === true, ...ref });
      return out;
    }),
);

const presenceChangeSchema = z.object({
  name: z.string().min(1).max(100).optional().describe("Student name exactly as in the class list (not case sensitive). Use row_id if two students share a name."),
  row_id: z.number().int().optional().describe("Student row id from tms_get_class_attendance"),
  status: z.enum(["present", "late", "absent"]),
  late_minutes: z.number().int().min(1).max(180).optional().describe("Required when status is late: minutes late, 1 to 180"),
  rent_laptop: z.boolean().optional().describe("true ticks the laptop rent box for this student, false unticks it. Leave out to keep the current tick. Only for students who have a rent option (see laptop_rent in tms_get_class_attendance)."),
});
const classArgs = {
  attendance_id: z.number().int().min(1).describe("Class session id (the number in /tms/class-attendance/<id>)"),
  changes: z.array(presenceChangeSchema).min(1).max(100).describe("Who is present, late or absent. Students not listed keep their current status."),
  confirm: z.boolean().optional().describe("Must be true to actually change the portal. Without it, only a preview is returned."),
};

server.registerTool(
  "tms_get_class_attendance",
  {
    description: "Read only. Lists one class session with its status and every student row (row_id, name, current presence and late minutes). Use it to find names or row ids before tms_start_class or tms_mark_attendance.",
    inputSchema: { attendance_id: classArgs.attendance_id },
  },
  async (a) =>
    guarded(async (s) => {
      const d = await fetchClassDetail(s, a.attendance_id);
      return {
        attendance_id: d.id,
        class: d.cls,
        date: d.date,
        class_status: d.status,
        // "active" only means scheduled. The model once read it as running and skipped the start.
        started: d.status === "ongoing" || d.status === "finish",
        students: d.students.map((r) => ({
          row_id: r.id,
          name: r.name,
          status: r.presence?.is_present === false || !r.presence ? "absent" : (r.presence.late_time ?? 0) > 0 ? `late ${r.presence.late_time}m` : "present",
          key_sent: r.is_key_send === true,
          laptop_rent: (r.rents ?? []).some((x) => !!x) ? (isRenting(r) ? "rented" : "not rented") : "no option",
        })),
      };
    }),
);

server.registerTool(
  "tms_start_class",
  {
    description:
      "Start a class session (the portal's Start Class button, status becomes ongoing), save who is present, late or absent and who rents a laptop, then send the key to every present student who has none. Students not listed keep their current status. Without confirm=true it only previews the change and sends nothing: show the teacher the preview and get a clear yes before confirm=true. Reads the class back and verifies the status, presence, laptop rent and keys; report any mismatches to the teacher.",
    inputSchema: classArgs,
  },
  async (a) =>
    guarded(async (s) => {
      const out = await setClassPresence(s, a.attendance_id, a.changes, { mode: "start", confirm: a.confirm === true });
      if (a.confirm === true) await logAction({ action: "class_started", via: "manual", ok: out.verified === true, attendance_id: a.attendance_id, changes: a.changes.length });
      return out;
    }),
);

server.registerTool(
  "tms_mark_attendance",
  {
    description:
      "Mark students present, late or absent (and tick or untick the laptop rent box) in a class session, then send the key to every present student who has none. If the class was not started yet it is started first (same as tms_start_class; the preview says will_start_class). Students not listed keep their current status. Without confirm=true it only previews and sends nothing: show the teacher the preview and get a clear yes before confirm=true. Reads the class back and verifies presence, laptop rent and keys; report any mismatches to the teacher.",
    inputSchema: classArgs,
  },
  async (a) =>
    guarded(async (s) => {
      const out = await setClassPresence(s, a.attendance_id, a.changes, { mode: "update", confirm: a.confirm === true });
      if (a.confirm === true) await logAction({ action: "attendance_marked", via: "manual", ok: out.verified === true, attendance_id: a.attendance_id, changes: a.changes.length });
      return out;
    }),
);

server.registerTool(
  "tms_finish_class",
  {
    description:
      "Finish a class session (the portal's Finish Class button, status becomes finish). Without confirm=true it only previews: it shows the class, the present and absent counts, and present students with no key yet. Show the teacher the preview and get a clear yes before confirm=true. Reads the class back to verify.",
    inputSchema: { attendance_id: classArgs.attendance_id, confirm: classArgs.confirm },
  },
  async (a) =>
    guarded(async (s) => {
      const out = await finishClass(s, a.attendance_id, a.confirm === true);
      if (a.confirm === true) await logAction({ action: "class_finished", via: "manual", ok: out.verified === true, attendance_id: a.attendance_id });
      return out;
    }),
);

server.registerTool(
  "tms_batch_journal_drafts",
  {
    description:
      "Save several journal DRAFTS in one call (max 10), optionally generating the portal's AI summary for each. Without confirm=true every item is only checked (dry run) and nothing is saved or generated. Never submits. One failing item does not stop the others. Each item reports quiz scores below 75.",
    inputSchema: {
      items: z
        .array(
          z.object({
            ...meetingArgs,
            teacher_notes: z.string(),
            project: z.string().optional(),
            active_project: z.boolean().optional(),
            generate_ai_summary: z.boolean().optional(),
          }),
        )
        .max(10),
      confirm: z.boolean().optional().describe("Must be true to actually save"),
    },
  },
  async (a) =>
    guarded(async (s) => {
      if (!Array.isArray(a.items) || a.items.length === 0) throw new ValidationError("items must be a non empty list");
      const inputs = a.items.map((it, i) => {
        try {
          return parseDraftInput({ ...it, dry_run: a.confirm !== true });
        } catch (e) {
          throw new ValidationError(`items[${i}]: ${(e as Error).message}`);
        }
      });
      const results = [];
      for (const [i, input] of inputs.entries()) {
        try {
          const quiz = await quizCheckForMeeting(s, input.ref.studentId, input.ref.meetingId);
          const saved = await saveJournalDraft(s, input);
          results.push({ index: i, ok: true, meeting_id: input.ref.meetingId, ...saved, quiz_check: quiz, sheet_sync: await sheetSyncAfterSave(s, input) });
        } catch (e) {
          results.push({ index: i, ok: false, meeting_id: input.ref.meetingId, error: redact(String((e as Error).message), [process.env.TMS_PASSWORD, process.env.TMS_USERNAME]).slice(0, 300) });
        }
      }
      return { confirmed: a.confirm === true, results };
    }),
);

server.registerTool(
  "tms_forget_session",
  {
    description: "Deletes the saved login (session file) so the next call logs in with the password again. Use if the login seems stuck or after changing the password.",
    inputSchema: {},
  },
  async () =>
    guarded(async (s) => {
      await s.forget();
      return { forgotten: true, session_file: s.sessionFile };
    }),
);

server.registerTool(
  "tms_list_my_classes",
  {
    description: "Read only. The classes where you are the MAIN teacher (these are the only classes the automatic actions touch), plus the teacher id used to decide that.",
    inputSchema: {},
  },
  async () => guarded(async (s) => loadMyClasses(s)),
);

server.registerTool(
  "tms_list_project_approvals",
  {
    description:
      "Read only. Student projects from the portal's Project Approvals page. Default: projects waiting for approval in your own main classes. Each row says whether a file or link is attached (the portal only lets you approve or reject when one is).",
    inputSchema: {
      class_id: z.number().optional().describe("One class only"),
      history: z.enum(["approved", "rejected", "approved,rejected"]).optional().describe("Show past decisions instead of the waiting list"),
      search: z.string().max(100).optional().describe("Student name search"),
      all_classes: z.boolean().optional().describe("Also show classes where you are not the main teacher"),
    },
  },
  async (a) =>
    guarded(async (s) => {
      if (a.class_id !== undefined || a.all_classes) {
        const rows = await listProjectApprovals(s, { classId: a.class_id, status: a.history, search: a.search });
        return { count: rows.length, rows };
      }
      const mine = await loadMyClasses(s);
      const rows = [];
      for (const c of mine.classes) {
        for (const r of await listProjectApprovals(s, { classId: c.id, status: a.history, search: a.search })) rows.push({ ...r, class: r.class || c.name });
      }
      return { classes: mine.classes.map((c) => c.name), count: rows.length, rows };
    }),
);

server.registerTool(
  "tms_set_project_status",
  {
    description:
      "Approve or reject ONE student project, exactly like the portal's own Approve and Reject buttons (one request, no undo button on the portal). Preview unless confirm=true. Ask the teacher before confirming, especially for rejections.",
    inputSchema: {
      student_id: z.number(),
      book_id: z.number(),
      project_id: z.number(),
      status: z.enum(["approved", "rejected"]),
      confirm: z.boolean().optional().describe("Must be true to actually change it"),
    },
  },
  async (a) =>
    guarded(async (s) => {
      const ids = [a.student_id, a.book_id, a.project_id];
      if (!ids.every((n) => Number.isInteger(n) && n > 0)) throw new ValidationError("student_id, book_id and project_id must be positive whole numbers");
      const all = await listProjectApprovals(s, { search: "" });
      const row = all.find((r) => r.project_id === a.project_id && r.student_id === a.student_id && r.book_id === a.book_id);
      if (!row) throw new ValidationError("That project is not in the waiting list (already decided, or the ids do not match each other). Nothing was changed.");
      if (!row.has_attachment) throw new ValidationError("That project has no file or link attached, and the portal does not allow approving or rejecting it. Nothing was changed.");
      if (a.confirm !== true) return { changed: false, preview: row, message: `Preview only. Run again with confirm=true to mark it ${a.status}.` };
      const out = await setProjectStatus(s, row, a.status, { via: "manual", student: row.student });
      if (!out.ok) throw new ApiError(out.message, out.http_status);
      return { changed: true, status: a.status, project: row, message: out.message };
    }),
);

server.registerTool(
  "tms_auto_approve_projects",
  {
    description:
      "The automatic project rule: approves every project waiting for approval in classes where you are the MAIN teacher that has a file or link attached. Never rejects. Live only when confirm=true or autoApproveProjects is on in tms.config.json; otherwise a dry run listing what it would approve. Every approval is logged and read back.",
    inputSchema: {
      confirm: z.boolean().optional().describe("Run live now even if the switch is off"),
      max: z.number().optional().describe("Most approvals per run, default 30, max 100"),
    },
  },
  async (a) => guarded((s) => autoApproveProjects(s, { confirm: a.confirm, max: a.max })),
);

server.registerTool(
  "tms_auto_send_journals",
  {
    description:
      "The automatic parent rule: for the class sessions you taught on a date (default today, Jakarta time) in your MAIN classes, sends every submitted journal (status created) that is not sent yet to the parents. Any journal with a quiz score below 75 is HELD, not sent, and listed so the teacher can decide. Also lists journals not written or still draft. Live only when confirm=true or autoSendJournals is on in tms.config.json; otherwise a dry run.",
    inputSchema: {
      date: z.string().optional().describe("YYYY-MM-DD, default today in Jakarta"),
      confirm: z.boolean().optional().describe("Send now even if the switch is off"),
    },
  },
  async (a) => guarded((s) => autoSendJournals(s, { date: a.date, confirm: a.confirm })),
);

server.registerTool(
  "tms_automation_settings",
  {
    description:
      "Shows the automation switches (tms.config.json in the project folder). Pass a value to change one; only do that when the teacher asks. autoApproveProjects lets tms_auto_approve_projects run live without confirm; autoSendJournals does the same for tms_auto_send_journals.",
    inputSchema: {
      autoApproveProjects: z.boolean().optional(),
      autoSendJournals: z.boolean().optional(),
    },
  },
  async (a) =>
    guarded(async () => {
      const before = await readAutoConfig({});
      if (a.autoApproveProjects === undefined && a.autoSendJournals === undefined) return { ...before, file: path.join(PROJECT_DIR, "tms.config.json"), env_overrides: { TMS_AUTO_APPROVE_PROJECTS: process.env.TMS_AUTO_APPROVE_PROJECTS ?? null, TMS_AUTO_SEND_JOURNALS: process.env.TMS_AUTO_SEND_JOURNALS ?? null } };
      const next = { ...before, ...(a.autoApproveProjects !== undefined ? { autoApproveProjects: a.autoApproveProjects } : {}), ...(a.autoSendJournals !== undefined ? { autoSendJournals: a.autoSendJournals } : {}) };
      await writeFile(path.join(PROJECT_DIR, "tms.config.json"), JSON.stringify(next, null, 2) + "\n", "utf8");
      await logAction({ action: "automation_settings_changed", before, after: next });
      return { before, after: await readAutoConfig({}) };
    }),
);

server.registerTool(
  "tms_list_inbox_photos",
  {
    description:
      "Read only. Lists class photos waiting in the photo folder (TMS_PHOTO_DIR) with the time each was taken or saved (Jakarta time), newest first, so they can be matched to a class session by date and time and passed to tms_save_journal_draft as photos.",
    inputSchema: {
      date: z.string().optional().describe("Only photos from this day, YYYY-MM-DD"),
      limit: z.number().optional().describe("Default 30, max 200"),
    },
  },
  async (a) => guarded(async () => listInboxPhotos({ date: a.date, limit: a.limit })),
);

server.registerTool(
  "tms_sync_lesson_progress",
  {
    description:
      "Looks the student up in TMS first (must match exactly one), then updates the student progress Google Sheet for one lesson. Leave lesson out and it takes the highest lesson the portal shows as finished for the student (auto). If finished, the lesson's Date and Progress cells get your highlight colour (TMS_SHEET_HIGHLIGHT_COLOR) and the teacher's note goes into the next lesson's Progress cell. If not finished, the note goes into this lesson's Progress cell and nothing is coloured. Defaults to dry_run (shows the plan only). Writes happen only when TMS_SHEET_SYNC_ENABLED=true and dry_run is false. Refuses to replace a different existing note unless overwrite is true. If the name matches several sheet rows (one per course the student has taken), the tool picks the row whose course column is the same as the course the student is on in the portal now, and whose language agrees. If no row has exactly that course name it refuses and lists the rows: ask the teacher which row the student is on now and pass it as row (that row's name cell must contain the student's name).",
    inputSchema: {
      student_name: z.string().describe("Student name as it appears in the sheet, e.g. 'Samuel' or 'Samuel Adi Nugroho'"),
      lesson: z.number().int().optional().describe("Lesson number 1 to 32. Leave out to use the highest lesson the portal shows as finished for this student."),
      finished: z.boolean().optional().describe("true if the student completed this lesson. Needed when lesson is given."),
      teacher_notes: z.string().describe("Teacher notes for the progress cell, max 200 characters"),
      row: z.number().int().optional().describe("Sheet row number to write to, needed when the name matches several rows. The row's name cell must contain the student's name."),
      overwrite: z.boolean().optional().describe("Allow replacing a different note already in the target cell"),
      dry_run: z.boolean().optional().describe("Default true. Set false to write (also needs TMS_SHEET_SYNC_ENABLED=true)"),
    },
  },
  async (a) =>
    guarded(async (s) => {
      // Resolve the name through TMS first, so the sheet is matched on the portal's full name.
      const found = await findStudentsByName(s, a.student_name, { maxDetails: 0 });
      if (found.matches.length !== 1) {
        throw new ValidationError(
          `"${a.student_name}" matched ${found.matches.length} students in TMS. Use a fuller name so exactly one matches.`,
        );
      }
      const portalName = found.matches[0]?.name ?? a.student_name;
      let lesson = a.lesson;
      let finished = a.finished;
      let source = "the lesson you gave";
      // The student's one ongoing book says which course row to use when the name is on several sheet rows.
      const books = a.row === undefined || lesson === undefined ? (await listBooksForStudent(s, found.matches[0]!.id, portalName)).filter((b) => b.bookStatus === "ongoing") : [];
      const portal_course = a.row === undefined && books.length === 1 ? await portalCourseOf(s, books[0]!) : undefined;
      if (lesson === undefined) {
        // Auto: take the lesson from the student's real progress in the portal.
        if (books.length !== 1) throw new ValidationError(`${portalName} has ${books.length} ongoing books, so the lesson is not clear. Pass lesson and finished yourself.`);
        const done = (await getLessonAccess(s, books[0]!)).lessons.filter((l) => l.finished).map((l) => l.lesson);
        if (done.length === 0) throw new ValidationError(`The portal shows no finished lesson for ${portalName} in ${books[0]!.bookName}. Pass lesson and finished yourself.`);
        lesson = Math.max(...done);
        finished = true;
        source = `the portal: highest finished lesson in ${books[0]!.bookName}`;
      } else if (finished === undefined) {
        throw new ValidationError("When you give lesson, also give finished (true or false).");
      }
      const out = await runLessonSync(
        { ...a, lesson, finished, student_name: portalName, dry_run: a.dry_run !== false, pick_by_empty_note: true, portal_course },
        process.env,
      );
      return { ...out, lesson, finished, lesson_source: source };
    }),
);

const bookArgs = {
  student_id: meetingArgs.student_id,
  learning_session_id: meetingArgs.learning_session_id,
  book_id: z.number().describe("learning_session_book_id (the student's copy of the book, as in every other tool)"),
};
const accessRef = (a: { student_id: number; learning_session_id: number; book_id: number }) => {
  const ids = [a.student_id, a.learning_session_id, a.book_id];
  if (!ids.every((n) => Number.isInteger(n) && n > 0)) throw new ValidationError("student_id, learning_session_id and book_id must be positive whole numbers");
  return { studentId: a.student_id, sessionId: a.learning_session_id, bookId: a.book_id };
};

server.registerTool(
  "tms_get_lesson_access",
  {
    description:
      "Read only. One student's lessons in a book: which are unlocked or locked, the progress percent of each, and which are finished (the portal's student book page). Use it to check a student's real progress and before tms_set_lesson_access.",
    inputSchema: bookArgs,
  },
  async (a) =>
    guarded(async (s) => {
      const d = await getLessonAccess(s, accessRef(a));
      const done = d.lessons.filter((l) => l.finished).map((l) => l.lesson);
      return {
        book: d.book,
        book_status: d.book_status,
        learnable_stats: d.stats,
        highest_finished_lesson: done.length ? Math.max(...done) : null,
        lessons: d.lessons.map((l) => ({ lesson: l.lesson, title: l.title, chapter: l.chapter, unlocked: l.unlocked, progress_percentage: l.progress_percentage, finished: l.finished })),
      };
    }),
);

server.registerTool(
  "tms_set_lesson_access",
  {
    description:
      "Unlock or lock lessons for ONE student, like the portal's Unlock and Lock buttons on the student book page. unlock_through opens every lesson from the first up to and including the given lesson. lock_from locks the given lesson and every lesson after it. Without confirm=true it only previews which lessons would change. Show the teacher the preview and get a clear yes before confirm=true, especially before locking a lesson the student has progress in. Reads the lessons back to verify.",
    inputSchema: {
      ...bookArgs,
      action: z.enum(["unlock_through", "lock_from"]),
      lesson: z.number().int().min(1).describe("Lesson number, as in 'Lesson 16'"),
      confirm: z.boolean().optional().describe("Must be true to actually change the portal"),
    },
  },
  async (a) =>
    guarded(async (s) => {
      const out = await setLessonAccess(s, accessRef(a), a.action, a.lesson, a.confirm === true);
      if (out.sent === true) await logAction({ action: `lesson_${a.action}`, via: "manual", ok: out.verified === true, studentId: a.student_id, bookId: a.book_id, lesson: a.lesson });
      return out;
    }),
);

server.registerTool(
  "tms_list_courses",
  {
    description:
      "Read only. The portal's Course page. Without course_id: lists courses (id, name, program, number of books), optionally filtered by search. With course_id: lists that course's books (book id, code, name, languages). Use the book id with tms_get_book_lessons.",
    inputSchema: {
      search: z.string().max(100).optional().describe("Course name search"),
      course_id: z.number().int().positive().optional().describe("List the books of this course instead"),
      ...pageArgs,
    },
  },
  async (a) =>
    guarded(async (s) => {
      const query = { limit: clampInt("limit", a.limit), page: clampInt("page", a.page, 1, 10_000, 1), ...(a.search ? { search: a.search } : {}) };
      return portalGet(s, a.course_id ? `/api/tms/course/${a.course_id}/book` : "/api/tms/course", query);
    }),
);

server.registerTool(
  "tms_get_book_lessons",
  {
    description: "Read only. The chapters and lessons of a course book, in order (the portal's book content page). book_id here is the COURSE book id from tms_list_courses, not a student's learning_session_book_id.",
    inputSchema: {
      book_id: z.number().int().positive().describe("Course book id from tms_list_courses"),
      lang: z.enum(["en", "id"]).optional().describe("Content language. Default: the portal's default for the book."),
    },
  },
  async (a) =>
    guarded(async (s) => {
      const lessons = await fetchBookLessons(s, a.book_id, a.lang);
      return { book_id: a.book_id, total_lessons: lessons.length, lessons: lessons.map((l) => ({ lesson: l.lesson, title: l.title, chapter: l.chapter })) };
    }),
);

server.registerTool(
  "tms_set_report_status",
  {
    description:
      "Approve or delete ONE existing student report, like the Approve and Delete buttons on the portal's report list (report_id from tms_list_student_reports). Without confirm=true it only shows the report it would change. Deleting cannot be undone: show the teacher the report and get a clear yes first.",
    inputSchema: {
      ...bookArgs,
      report_id: z.number().int().positive(),
      action: z.enum(["approve", "delete"]),
      confirm: z.boolean().optional().describe("Must be true to actually change the portal"),
    },
  },
  async (a) =>
    guarded(async (s) => {
      const ref = accessRef(a);
      const base = `/api/tms/student/${ref.studentId}/learning-session/${ref.sessionId}/book/${ref.bookId}/report`;
      const list = async () => {
        const r = await s.api(base);
        if (r.status >= 400 || !Array.isArray((r.body as { data?: unknown })?.data)) throw new ApiError(`Report list failed with status ${r.status}`, r.status);
        return (r.body as { data: Array<{ id: number; name: string; status?: string }> }).data;
      };
      const report = (await list()).find((x) => x.id === a.report_id);
      if (!report) throw new ValidationError(`No report with id ${a.report_id} on this book. Nothing was changed.`);
      if (a.action === "approve" && report.status === "approved") throw new ValidationError("That report is already approved. Nothing was changed.");
      if (a.confirm !== true) return { changed: false, action: a.action, report, message: `Preview only. Run again with confirm=true to ${a.action} it.` };
      const r = a.action === "approve"
        ? await s.apiSend("PATCH", `${base}/${a.report_id}/update-status`, { json: { status: "approved" } })
        : await s.apiSend("DELETE", `${base}/${a.report_id}`, { json: {} });
      if (r.status >= 400) throw new ApiError(`The portal refused to ${a.action} the report (status ${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`, r.status);
      const after = (await list()).find((x) => x.id === a.report_id);
      const verified = a.action === "approve" ? after?.status === "approved" : !after;
      await logAction({ action: `report_${a.action}`, via: "manual", ok: verified, studentId: a.student_id, bookId: a.book_id, report_id: a.report_id, name: report.name });
      return { changed: true, action: a.action, verified, report: after ?? report };
    }),
);

server.registerTool(
  "tms_portal_get",
  {
    description:
      "Read only. GET any teacher API path of the portal, for pages with no dedicated tool. Only /api/tms/... and /api/v2/tms/... are allowed, never a write. Useful paths: /api/tms/schedule (teaching schedule; query start_date, end_date, limit, page), /api/tms/time-off (query date), /api/tms/dashboard/statistics, /api/tms/dashboard/quests, /api/tms/event, /api/tms/assestments/quiz-exams, /api/tms/attendance/summary, /api/tms/attendance/insight, /api/tms/program, /api/tms/learning-paths, /api/tms/profile, /api/tms/student/homeroom, /api/tms/student/replacement, /api/tms/student/{id}/learning-session/{sid}/note-schedule, /api/v2/tms/student/{id}/book/{courseBookId}/progress-detail. Query names are the portal's own and were not all verified: a 422 answer lists the fields it wants.",
    inputSchema: {
      path: z.string().max(300).describe('API path starting with /api/tms/ or /api/v2/tms/, without a query string'),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query parameters, for example {limit: 20, page: 1}"),
    },
  },
  async (a) => guarded((s) => portalGet(s, a.path, a.query)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
log("ready");

const shutdown = async () => {
  await session?.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
