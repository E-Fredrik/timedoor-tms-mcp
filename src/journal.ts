import type { Page } from "playwright";
import { API, PATHS, TIMEOUTS } from "./config.js";
import { preparePhotos, type HeicConverter, type PdfRenderer } from "./photos.js";
import { ApiError, TmsSession } from "./session.js";
import { optionalText, positiveInt, teacherNotes, ValidationError } from "./validate.js";

export interface MeetingRef {
  studentId: number;
  sessionId: number;
  bookId: number;
  meetingId: number;
}

export function parseMeetingRef(input: {
  student_id: unknown;
  learning_session_id: unknown;
  book_id: unknown;
  meeting_id: unknown;
}): MeetingRef {
  return {
    studentId: positiveInt("student_id", input.student_id),
    sessionId: positiveInt("learning_session_id", input.learning_session_id),
    bookId: positiveInt("book_id", input.book_id),
    meetingId: positiveInt("meeting_id", input.meeting_id),
  };
}

export async function getJournal(session: TmsSession, ref: MeetingRef) {
  const meeting = await session.api(API.meeting(ref.studentId, ref.sessionId, ref.bookId, ref.meetingId));
  if (meeting.status === 404) throw new ApiError("Meeting not found for that student, session and book", 404);
  if (meeting.status >= 400) throw new ApiError(`Meeting lookup failed with status ${meeting.status}`, meeting.status);
  const journal = await session.api(API.journal(ref.studentId, ref.sessionId, ref.bookId, ref.meetingId));
  if (journal.status === 404) return { meeting: meeting.body, journalExists: false as const, journal: null };
  if (journal.status >= 400) throw new ApiError(`Journal lookup failed with status ${journal.status}`, journal.status);
  return { meeting: meeting.body, journalExists: true as const, journal: journal.body };
}

function journalStatus(journal: unknown): string | undefined {
  const j = (journal as { data?: Record<string, unknown> } | null)?.data ?? (journal as Record<string, unknown> | null);
  const s = j && (j["status"] ?? j["journal_status"]);
  return typeof s === "string" ? s.toLowerCase() : undefined;
}

export interface DraftInput {
  ref: MeetingRef;
  teacherNotes: string;
  project?: string;
  activeProject?: boolean;
  photos?: string[];
  generateAiSummary: boolean;
  dryRun: boolean;
  overwriteExisting: boolean;
}

export function parseDraftInput(input: {
  student_id: unknown;
  learning_session_id: unknown;
  book_id: unknown;
  meeting_id: unknown;
  teacher_notes: unknown;
  project?: unknown;
  active_project?: unknown;
  photos?: unknown;
  generate_ai_summary?: unknown;
  dry_run?: unknown;
  overwrite_existing?: unknown;
}): DraftInput {
  if (input.active_project !== undefined && typeof input.active_project !== "boolean") {
    throw new ValidationError("active_project must be true or false");
  }
  if (input.generate_ai_summary !== undefined && typeof input.generate_ai_summary !== "boolean") {
    throw new ValidationError("generate_ai_summary must be true or false");
  }
  let photos: string[] | undefined;
  if (input.photos !== undefined && input.photos !== null) {
    if (!Array.isArray(input.photos) || input.photos.some((p) => typeof p !== "string")) {
      throw new ValidationError("photos must be a list of file path strings");
    }
    if (input.photos.length > 2) throw new ValidationError("The form accepts at most 2 photos");
    photos = input.photos.length ? (input.photos as string[]) : undefined;
  }
  return {
    ref: parseMeetingRef(input),
    teacherNotes: teacherNotes(input.teacher_notes),
    project: optionalText("project", input.project),
    activeProject: input.active_project as boolean | undefined,
    photos,
    generateAiSummary: input.generate_ai_summary === true,
    dryRun: input.dry_run === true,
    overwriteExisting: input.overwrite_existing === true,
  };
}

/**
 * Fills the journal form and clicks "Save as Draft". Never clicks "Save & Continue",
 * so nothing is submitted to parents or finalised from here.
 */
export async function saveJournalDraft(session: TmsSession, d: DraftInput, render?: PdfRenderer, convert?: HeicConverter) {
  // Check the photo files first so a bad file fails before anything touches the portal.
  const prepared = d.photos ? await preparePhotos(d.photos, render, convert) : undefined;
  try {
    const result = await saveJournalDraftInner(session, d, prepared?.files);
    return prepared?.warnings.length ? { ...result, warnings: prepared.warnings } : result;
  } finally {
    await prepared?.cleanup();
  }
}

const PHOTO_MARKERS = 'main img, main canvas, main [style*="background-image"]';

async function countPhotoMarkers(page: Page): Promise<number> {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, PHOTO_MARKERS);
}

/** Uploads one file at a time (the site's file input is single file) and waits for it to appear. */
async function uploadPhotos(page: Page, files: string[]): Promise<void> {
  const input = page.locator('main input[type="file"]');
  const failures: string[] = [];
  const onResp = (r: import("playwright").Response) => {
    if (r.request().method() === "POST" && r.status() >= 400 && /upload|photo|evidence|file/i.test(r.url())) failures.push(`${r.status()} ${new URL(r.url()).pathname}`);
  };
  page.on("response", onResp);
  try {
  for (let i = 0; i < files.length; i++) {
    const before = await countPhotoMarkers(page);
    await input.setInputFiles(files[i]);
    try {
      await page.waitForFunction(
        ([sel, b, first]) => {
          const n = document.querySelectorAll(sel as string).length;
          const none = /no photo uploaded/i.test(document.body.innerText);
          return n > (b as number) || (first === true && !none);
        },
        [PHOTO_MARKERS, before, i === 0] as const,
        { timeout: TIMEOUTS.save },
      );
    } catch {
      throw new ApiError(
        `Photo ${i + 1} of ${files.length} did not show up on the form after uploading. Nothing was saved.${failures.length ? ` The portal answered: ${failures.join(", ")}.` : " The upload widget may have changed."}`,
      );
    }
  }
  } finally {
    page.off("response", onResp);
  }
}

async function saveJournalDraftInner(session: TmsSession, d: DraftInput, photoFiles?: string[]) {
  // 1. Refuse to clobber a journal that already exists unless told to.
  const existing = await getJournal(session, d.ref);
  if (existing.journalExists) {
    const st = journalStatus(existing.journal);
    if (st !== "draft" && !d.overwriteExisting) {
      throw new ValidationError(
        `A journal already exists for this meeting (status: ${st ?? "unknown"}). Not touching it. Pass overwrite_existing=true if you really want to edit it.`,
      );
    }
  }

  // 2. Fill the form in the browser.
  const page = await session.ensureLoggedIn();
  await page.goto(session.baseUrl + PATHS.meetingPage(d.ref.studentId, d.ref.sessionId, d.ref.bookId, d.ref.meetingId), {
    waitUntil: "domcontentloaded",
  });
  const notes = page.getByLabel("Teacher Notes", { exact: true });
  try {
    await notes.waitFor({ state: "visible", timeout: TIMEOUTS.login });
  } catch {
    throw new ApiError("The journal form did not load. The page layout may have changed or the meeting is not editable.");
  }
  if (d.project !== undefined) await page.getByLabel("Project", { exact: true }).fill(d.project);
  if (d.activeProject !== undefined) {
    const box = page.getByLabel("Active project", { exact: true });
    if ((await box.isChecked()) !== d.activeProject) await box.setChecked(d.activeProject, { force: true });
  }
  await notes.fill(d.teacherNotes);
  const filled = await notes.inputValue();
  if (filled !== d.teacherNotes) {
    throw new ApiError("The notes field did not keep the text I entered (the site may have trimmed or rejected it). Nothing was saved.");
  }

  if (d.dryRun) {
    return {
      saved: false,
      dryRun: true,
      message: "Form filled but not saved (dry run).",
      notesLength: filled.length,
      photosChecked: photoFiles?.length ?? 0,
      photosUploaded: 0,
      aiSummary: d.generateAiSummary ? "Not generated in a dry run (generating can save a draft on the portal)." : undefined,
      photoNote: photoFiles?.length ? "Photo files are valid but were NOT uploaded in a dry run, so nothing is stored on the portal." : undefined,
    };
  }

  if (photoFiles?.length) await uploadPhotos(page, photoFiles);

  // 2b. Optional: use the portal's own "Generate AI Summary" button (it sends the real request itself).
  let aiClicked = false;
  if (d.generateAiSummary) {
    const gen = page.waitForResponse((r) => r.request().method() === "POST" && /\/journal\/generate-summary$/.test(r.url()), { timeout: 90_000 });
    await page.getByRole("button", { name: /generate ai summary/i }).click();
    let genStatus: number;
    try {
      genStatus = (await gen).status();
    } catch {
      throw new ApiError("I clicked Generate AI Summary but the portal never answered in time. Check the journal in the portal before retrying.");
    }
    if (genStatus < 200 || genStatus >= 300) throw new ApiError(`The portal's AI summary request failed with status ${genStatus}. The journal was not saved as a final draft by me.`, genStatus);
    aiClicked = true;
    await page.waitForTimeout(500);
  }

  // 3. Click Save as Draft and wait for the site to confirm with a successful write request.
  const saveResponse = page.waitForResponse(
    (r) => r.request().method() !== "GET" && /\/meeting-history\/\d+\/journal(\?.*)?$/.test(r.url()),
    { timeout: TIMEOUTS.save },
  );
  await page.getByRole("button", { name: /save as draft/i }).click();
  let status: number;
  try {
    status = (await saveResponse).status();
  } catch {
    throw new ApiError("I clicked Save as Draft but never saw the site confirm it. Check the journal in the portal before retrying.");
  }
  if (status < 200 || status >= 300) throw new ApiError(`The site rejected the draft with status ${status}`, status);

  // 4. Verify by reading it back.
  const after = await getJournal(session, d.ref).catch(() => undefined);
  const jd = ((after?.journal as { data?: Record<string, unknown> } | null)?.data ?? (after?.journal as Record<string, unknown> | null)) ?? undefined;
  const aiNote = typeof jd?.note === "string" ? (jd.note as string) : "";
  return {
    saved: true,
    photosUploaded: photoFiles?.length ?? 0,
    aiSummary: aiClicked
      ? { requested: true, stored: aiNote.trim().length > 0, generatedAt: jd?.ai_summary_generated_at ?? null, preview: aiNote.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) }
      : undefined,
    verified: !!after?.journalExists,
    message: after?.journalExists
      ? "Draft saved and confirmed by reading it back. It is NOT submitted."
      : "The site accepted the draft but I could not read it back to confirm. Please check the portal.",
  };
}
