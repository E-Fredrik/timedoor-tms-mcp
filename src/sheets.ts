import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { lessonNumberOf, type PendingLesson } from "./scores.js";
import { teacherNotes } from "./validate.js";

/**
 * Lesson progress sync for the student progress Google Sheet.
 *
 * Rules (from the teacher's spec):
 * - Find the student by name in the name column.
 * - If the student finished lesson N: colour the Date and Progress cells of lesson N with TMS_SHEET_HIGHLIGHT_COLOR.
 *   The teacher's note goes into the Progress cell of lesson N+1, the lesson the student is on now.
 * - If the student has not finished lesson N: leave lesson N uncoloured and put the note in lesson N's Progress cell.
 * - Never edit anything outside those cells.
 *
 * Writes only happen when TMS_SHEET_SYNC_ENABLED=true AND dry_run is false. Otherwise the plan is returned only.
 */

export interface Rgb { red: number; green: number; blue: number }

/** "#00ffff" or "00ffff" to the 0..1 channels the Sheets API wants. */
export function parseHexColor(hex: string): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) throw new SheetSyncError("TMS_SHEET_HIGHLIGHT_COLOR must be a hex colour like #00ffff");
  const ch = (i: number) => parseInt(m[i] as string, 16) / 255;
  return { red: ch(1), green: ch(2), blue: ch(3) };
}
export const MAX_LESSON = 32;

export class SheetSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetSyncError";
  }
}

export interface SheetSettings {
  spreadsheetId: string;
  tabGid: number;
  highlightColor: Rgb; // each teacher picks their own in .env
  nameColumn: string; // column letter holding the student name, e.g. "B"
  firstDataRow: number; // first row (1-based) with a student
  lesson1DateColumn: string; // column letter of lesson 1's Date cell; Progress is the next column
  maxLesson: number;
  courseColumn?: string; // column with the course ("Level") of the row, default F
  languageColumn?: string; // column with the row's language (ID or EN), default G
}

// Column helpers ----------------------------------------------------------

export function columnToIndex(letters: string): number {
  const s = letters.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(s)) throw new SheetSyncError(`Invalid column letters: "${letters}"`);
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function indexToColumn(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new SheetSyncError(`Invalid column index: ${index}`);
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Name matching -----------------------------------------------------------

export function normalizeName(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Sheet names look like "Samuel Adi Nugroho (Samuel)" or "Kevin Budi Hartono (Kevin)".
 * A student matches by the full name without brackets, or by the name inside the brackets.
 */
export function namesFromCell(cell: string): string[] {
  const names: string[] = [];
  const full = normalizeName(cell.replace(/\([^)]*\)/g, " "));
  if (full) names.push(full);
  for (const m of cell.matchAll(/\(([^)]*)\)/g)) {
    const nick = normalizeName(m[1] ?? "");
    if (nick) names.push(nick);
  }
  return names;
}

/** Every 1-based sheet row whose name cell matches the student. */
export function findStudentRows(nameCells: string[], firstDataRow: number, studentName: string): number[] {
  const query = normalizeName(studentName);
  if (!query) throw new SheetSyncError("student_name is empty");
  const hits: number[] = [];
  nameCells.forEach((cell, i) => {
    if (namesFromCell(cell).includes(query)) hits.push(firstDataRow + i);
  });
  return hits;
}

/** Returns the 1-based sheet row of the one student whose name matches. Throws on zero or several matches. */
export function findStudentRow(nameCells: string[], firstDataRow: number, studentName: string): number {
  const hits = findStudentRows(nameCells, firstDataRow, studentName);
  if (hits.length === 0) throw new SheetSyncError(`No student named "${studentName}" was found in the name column`);
  if (hits.length > 1) {
    throw new SheetSyncError(`"${studentName}" matches ${hits.length} rows (${hits.join(", ")}). Use the full name so only one row matches.`);
  }
  return hits[0] as number;
}

// Lesson cells -----------------------------------------------------------

export function lessonCells(settings: SheetSettings, lesson: number): { date: string; progress: string } {
  if (!Number.isInteger(lesson) || lesson < 1 || lesson > settings.maxLesson) {
    throw new SheetSyncError(`lesson must be a whole number from 1 to ${settings.maxLesson}`);
  }
  const dateIdx = columnToIndex(settings.lesson1DateColumn) + 2 * (lesson - 1);
  return { date: indexToColumn(dateIdx), progress: indexToColumn(dateIdx + 1) };
}

// Plan --------------------------------------------------------------------

export interface ProgressSyncInput {
  studentName: string;
  lesson: number;
  finished: boolean;
  teacherNotes: string;
  overwrite: boolean;
  /** Sheet row to write to. Must be a row whose name cell contains the student's name. */
  row?: number;
  /** When the name matches several rows and no row is given, allow picking the one row with an empty note cell. */
  pickByEmptyNote?: boolean;
  /** The course the student is on in the portal right now (book and course names, and its language). Picks the row when the name matches several. */
  portalCourse?: { names: string[]; lang?: string };
}

export interface SyncPlan {
  studentRow: number;
  /** Lesson whose Date and Progress cells get the highlight colour (empty when not finished). */
  highlightLesson: number | null;
  /** Lesson whose Progress cell gets the teacher's note: the lesson the student is on now. */
  noteLesson: number;
  noteRange: string;
  note: string;
  highlightRanges: string[];
}

/**
 * Builds the write plan. existingNote is the current value of the note cell.
 * Refuses to replace a different non-empty note unless overwrite is true, so nothing is lost silently.
 */
export function buildSyncPlan(
  settings: SheetSettings,
  studentRow: number,
  input: ProgressSyncInput,
  existingNote: string,
): SyncPlan {
  const lesson = input.lesson;
  const cells = lessonCells(settings, lesson);
  const noteLesson = input.finished ? lesson + 1 : lesson;
  if (noteLesson > settings.maxLesson) {
    throw new SheetSyncError(`Lesson ${lesson} is the last lesson, so there is no next lesson to put the note in`);
  }
  const noteCells = lessonCells(settings, noteLesson);
  const noteRange = `${noteCells.progress}${studentRow}`;
  const note = teacherNotes(input.teacherNotes);

  const existing = existingNote.trim();
  if (existing && existing !== note.trim() && !input.overwrite) {
    throw new SheetSyncError(
      `${noteRange} already has text: "${existing.slice(0, 80)}". Set overwrite to true to replace it.`,
    );
  }

  const highlightRanges = input.finished
    ? [`${cells.date}${studentRow}`, `${cells.progress}${studentRow}`]
    : [];

  return {
    studentRow,
    highlightLesson: input.finished ? lesson : null,
    noteLesson,
    noteRange,
    note,
    highlightRanges,
  };
}

// Settings ----------------------------------------------------------------

export function loadSheetSettings(env: NodeJS.ProcessEnv): SheetSettings & { credentialsPath: string; syncEnabled: boolean } {
  const required = (key: string): string => {
    const v = env[key]?.trim();
    if (!v) throw new SheetSyncError(`${key} is not set in .env`);
    return v;
  };
  const firstDataRow = Number(required("TMS_SHEET_FIRST_ROW"));
  if (!Number.isInteger(firstDataRow) || firstDataRow < 1) throw new SheetSyncError("TMS_SHEET_FIRST_ROW must be a row number");
  const tabGid = Number(required("TMS_SHEET_GID"));
  if (!Number.isInteger(tabGid) || tabGid < 0) throw new SheetSyncError("TMS_SHEET_GID must be a number");
  return {
    spreadsheetId: required("TMS_SHEET_ID"),
    tabGid,
    highlightColor: parseHexColor(required("TMS_SHEET_HIGHLIGHT_COLOR")),
    nameColumn: (env["TMS_SHEET_NAME_COLUMN"] ?? "B").trim().toUpperCase(),
    firstDataRow,
    lesson1DateColumn: required("TMS_SHEET_LESSON1_DATE_COLUMN").toUpperCase(),
    maxLesson: MAX_LESSON,
    courseColumn: (env["TMS_SHEET_COURSE_COLUMN"] ?? "F").trim().toUpperCase(),
    languageColumn: (env["TMS_SHEET_LANGUAGE_COLUMN"] ?? "G").trim().toUpperCase(),
    credentialsPath: required("TMS_SHEET_CREDENTIALS"),
    syncEnabled: (env["TMS_SHEET_SYNC_ENABLED"] ?? "").trim().toLowerCase() === "true",
  };
}

// Google Sheets client ----------------------------------------------------

export interface SheetsApi {
  readRange(range: string): Promise<string[][]>;
  writeValue(range: string, value: string): Promise<void>;
  fillColor(a1Ranges: string[], tabGid: number, color: Rgb): Promise<void>;
}

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export class GoogleSheetsApi implements SheetsApi {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly spreadsheetId: string;
  private readonly clientEmail: string;
  private readonly privateKey: string;

  constructor(spreadsheetId: string, clientEmail: string, privateKey: string) {
    this.spreadsheetId = spreadsheetId;
    this.clientEmail = clientEmail;
    this.privateKey = privateKey;
  }

  static async fromCredentialsFile(spreadsheetId: string, path: string): Promise<GoogleSheetsApi> {
    const raw = JSON.parse(await readFile(path, "utf8")) as { client_email?: string; private_key?: string };
    if (!raw.client_email || !raw.private_key) throw new SheetSyncError("Credentials file is missing client_email or private_key");
    return new GoogleSheetsApi(spreadsheetId, raw.client_email, raw.private_key);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({ iss: this.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${signer.sign(this.privateKey, "base64url")}`;
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    if (!res.ok) throw new SheetSyncError(`Google sign-in failed with status ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.accessToken();
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new SheetSyncError(`Google Sheets ${method} failed with status ${res.status}`);
    return res.json();
  }

  async readRange(range: string): Promise<string[][]> {
    const body = (await this.call("GET", `/values/${encodeURIComponent(range)}`)) as { values?: string[][] };
    return body.values ?? [];
  }

  async writeValue(range: string, value: string): Promise<void> {
    await this.call("PUT", `/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      range,
      values: [[value]],
    });
  }

  async fillColor(a1Ranges: string[], tabGid: number, color: Rgb): Promise<void> {
    const requests = a1Ranges.map((r) => {
      const m = /^([A-Z]+)(\d+)$/.exec(r);
      if (!m) throw new SheetSyncError(`Bad cell address: ${r}`);
      const col = columnToIndex(m[1] as string);
      const row = Number(m[2]) - 1;
      return {
        repeatCell: {
          range: { sheetId: tabGid, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: col, endColumnIndex: col + 1 },
          cell: { userEnteredFormat: { backgroundColor: color } },
          fields: "userEnteredFormat.backgroundColor",
        },
      };
    });
    if (requests.length) await this.call("POST", ":batchUpdate", { requests });
  }
}

// Orchestration -----------------------------------------------------------

export interface SyncResult {
  dry_run: boolean;
  written: boolean;
  student_row: number;
  highlight_lesson: number | null;
  highlight_cells: string[];
  note_lesson: number;
  note_cell: string;
  note: string;
  replaced_existing: boolean;
  row_selected_by: RowSelection;
  candidate_rows: number[];
}

export type RowSelection = "row" | "name" | "course" | "empty_note";

/** "Fullstack Programming for Roblox" and "Full Stack Programming for Roblox" are the same course; "Game Dev 24" and "Kids Game Developer 24" are not. */
export function sameCourse(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
  return norm(a) !== "" && norm(a) === norm(b);
}

export interface RowChoice {
  row: number;
  selected_by: RowSelection;
  candidate_rows: number[];
}

/**
 * Decides which sheet row to write to.
 * 1. An explicit row is used only if that row's name cell contains the student's name.
 * 2. One name match is used directly.
 * 3. Several matches and the portal course is known: the one row whose course column is the same course
 *    (and whose language column agrees). If none or several are the same, it refuses and lists the rows,
 *    so the teacher says which one. It does not guess from a similar name.
 * 4. Several matches, no portal course: used only when exactly one of them has an empty note cell for the target note lesson.
 *    Anything else is refused, so the tool never writes to a row it cannot identify.
 */
export async function chooseStudentRow(
  api: SheetsApi,
  settings: SheetSettings,
  nameCells: string[],
  input: ProgressSyncInput,
): Promise<RowChoice> {
  const query = normalizeName(input.studentName);
  if (!query) throw new SheetSyncError("student_name is empty");

  if (input.row !== undefined) {
    const row = input.row;
    if (!Number.isInteger(row) || row < settings.firstDataRow) {
      throw new SheetSyncError(`row must be a whole number of at least ${settings.firstDataRow}`);
    }
    const cell = nameCells[row - settings.firstDataRow];
    if (cell === undefined) {
      throw new SheetSyncError(`Row ${row} has no name in column ${settings.nameColumn}. Nothing was written.`);
    }
    if (!namesFromCell(cell).includes(query)) {
      throw new SheetSyncError(
        `Row ${row} does not belong to "${input.studentName}". Its name cell is "${cell.slice(0, 80)}". Nothing was written.`,
      );
    }
    return { row, selected_by: "row", candidate_rows: [row] };
  }

  const hits = findStudentRows(nameCells, settings.firstDataRow, input.studentName);
  if (hits.length === 0) {
    throw new SheetSyncError(`No student named "${input.studentName}" was found in the name column`);
  }
  if (hits.length === 1) return { row: hits[0] as number, selected_by: "name", candidate_rows: hits };

  if (input.portalCourse?.names.length) {
    const pc = input.portalCourse;
    const cell = async (col: string, r: number) => ((await api.readRange(`${col}${r}`))[0]?.[0] ?? "").trim();
    const rows = [];
    for (const r of hits) rows.push({ r, course: await cell(settings.courseColumn ?? "F", r), lang: await cell(settings.languageColumn ?? "G", r) });
    const same = rows.filter((x) => pc.names.some((n) => sameCourse(n, x.course)) && (!pc.lang || !x.lang || x.lang.toLowerCase() === pc.lang.toLowerCase()));
    if (same.length === 1) return { row: same[0]!.r, selected_by: "course", candidate_rows: hits };
    throw new SheetSyncError(
      `"${input.studentName}" matches ${hits.length} rows and ${same.length === 0 ? "none of them has exactly" : `${same.length} of them have`} the course the portal shows ` +
        `("${pc.names[0]}"${pc.lang ? `, ${pc.lang.toUpperCase()}` : ""}). Rows: ${rows.map((x) => `${x.r} = "${x.course}"${x.lang ? ` (${x.lang})` : ""}`).join("; ")}. ` +
        `Ask the teacher which row the student is on now and pass it as row. Nothing was written.`,
    );
  }

  const noteLesson = input.finished ? input.lesson + 1 : input.lesson;
  const ambiguous = `"${input.studentName}" matches ${hits.length} rows (${hits.join(", ")}). Pass row to choose one.`;
  if (!input.pickByEmptyNote || noteLesson > settings.maxLesson) throw new SheetSyncError(ambiguous);

  const noteCol = lessonCells(settings, noteLesson).progress;
  const empty: number[] = [];
  for (const r of hits) {
    const cur = await api.readRange(`${noteCol}${r}`);
    if ((cur[0]?.[0] ?? "").trim() === "") empty.push(r);
  }
  if (empty.length === 1) {
    return { row: empty[0] as number, selected_by: "empty_note", candidate_rows: hits };
  }
  throw new SheetSyncError(
    `${ambiguous} ${empty.length} of them have an empty note cell in column ${noteCol}, so no row can be picked safely. Pass row to choose one.`,
  );
}

export async function syncLessonProgress(
  api: SheetsApi,
  settings: SheetSettings,
  input: ProgressSyncInput,
  opts: { dryRun: boolean },
): Promise<SyncResult> {
  const names = await api.readRange(`${settings.nameColumn}${settings.firstDataRow}:${settings.nameColumn}`);
  const nameCells = names.map((r) => r[0] ?? "");
  const choice = await chooseStudentRow(api, settings, nameCells, input);
  const studentRow = choice.row;

  const noteLesson = input.finished ? input.lesson + 1 : input.lesson;
  const noteCol = lessonCells(settings, noteLesson).progress;
  const current = await api.readRange(`${noteCol}${studentRow}`);
  const existingNote = current[0]?.[0] ?? "";

  const plan = buildSyncPlan(settings, studentRow, input, existingNote);
  const replaced = existingNote.trim() !== "" && existingNote.trim() !== plan.note.trim();

  if (!opts.dryRun) {
    if (plan.highlightRanges.length) await api.fillColor(plan.highlightRanges, settings.tabGid, settings.highlightColor);
    await api.writeValue(plan.noteRange, plan.note);
  }

  return {
    dry_run: opts.dryRun,
    written: !opts.dryRun,
    student_row: plan.studentRow,
    highlight_lesson: plan.highlightLesson,
    highlight_cells: plan.highlightRanges,
    note_lesson: plan.noteLesson,
    note_cell: plan.noteRange,
    note: plan.note,
    replaced_existing: replaced,
    row_selected_by: choice.selected_by,
    candidate_rows: choice.candidate_rows,
  };
}

// Entry point used by the MCP tool ---------------------------------------

export interface LessonSyncArgs {
  student_name: string;
  lesson: number;
  finished: boolean;
  teacher_notes: string;
  overwrite?: boolean;
  dry_run?: boolean;
  row?: number;
  pick_by_empty_note?: boolean;
  portal_course?: { names: string[]; lang?: string };
}

/**
 * Safety gate: the sheet is only written when TMS_SHEET_SYNC_ENABLED=true AND the caller passes dry_run=false.
 * Anything else returns the plan only.
 */
/** Writes only when sync is enabled AND the caller explicitly asked for dry_run=false. */
export function resolveDryRun(dryRunArg: boolean | undefined, syncEnabled: boolean): boolean {
  return dryRunArg !== false || !syncEnabled;
}

export async function runLessonSync(args: LessonSyncArgs, env: NodeJS.ProcessEnv): Promise<SyncResult & { sync_enabled: boolean }> {
  const settings = loadSheetSettings(env);
  const dryRun = resolveDryRun(args.dry_run, settings.syncEnabled);
  const api = await GoogleSheetsApi.fromCredentialsFile(settings.spreadsheetId, settings.credentialsPath);
  const result = await syncLessonProgress(
    api,
    settings,
    {
      studentName: args.student_name,
      lesson: args.lesson,
      finished: args.finished,
      teacherNotes: args.teacher_notes,
      overwrite: args.overwrite === true,
      row: args.row,
      pickByEmptyNote: args.pick_by_empty_note === true,
      portalCourse: args.portal_course,
    },
    { dryRun },
  );
  return { ...result, sync_enabled: settings.syncEnabled };
}

// Automatic sync after a journal save ------------------------------------

/**
 * Lesson the student finished in this journal: the highest "Lesson N" whose progress is 100.
 * Returns null when no lesson is at 100, so nothing is synced.
 */
export function pickFinishedLesson(lessons: PendingLesson[] | undefined): number | null {
  let best: number | null = null;
  for (const l of lessons ?? []) {
    const n = lessonNumberOf(l?.name ?? "");
    const p = typeof l?.progress === "number" ? l.progress : Number.NaN;
    if (n !== undefined && p >= 100 && (best === null || n > best)) best = n;
  }
  return best;
}

export interface AutoSyncOutcome {
  status: "skipped" | "dry_run" | "written" | "failed";
  reason?: string;
  lesson?: number;
  note_cell?: string;
  highlight_cells?: string[];
  replaced_existing?: boolean;
}

/** Runs after a journal draft is saved. Never throws: a sheet problem must not hide a saved journal. */
export async function syncAfterJournalSave(
  studentName: string,
  lessons: PendingLesson[] | undefined,
  teacherNotes: string,
  env: NodeJS.ProcessEnv,
  portalCourse?: { names: string[]; lang?: string },
): Promise<AutoSyncOutcome> {
  const lesson = pickFinishedLesson(lessons);
  if (lesson === null) {
    return { status: "skipped", reason: "No lesson in this journal is at 100%, so the sheet was not changed." };
  }
  try {
    const r = await runLessonSync(
      { student_name: studentName, lesson, finished: true, teacher_notes: teacherNotes, dry_run: false, portal_course: portalCourse },
      env,
    );
    return {
      status: r.written ? "written" : "dry_run",
      lesson,
      note_cell: r.note_cell,
      highlight_cells: r.highlight_cells,
      replaced_existing: r.replaced_existing,
    };
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 300);
    return { status: "failed", lesson, reason: msg };
  }
}
