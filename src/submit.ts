import { API } from "./config.js";
import { ApiError, TmsSession } from "./session.js";
import { ValidationError } from "./validate.js";
import type { MeetingRef } from "./journal.js";
import { LOW_SCORE_THRESHOLD } from "./scores.js";

/**
 * Submits an EXISTING draft journal by re sending it with status "created", the same multipart save the portal
 * form uses. Dry run unless confirm is true. Needs a teacher note, an AI summary and 1 to 2 photos (the portal's
 * rule for created journals). Photos already on the draft are passed back as references, never re uploaded.
 * Built from the portal's own code. "created" means submitted; sending to parents is a separate step (status "sent"),
 * done by tms_send_journal_to_parent.
 */
export async function submitJournal(session: TmsSession, ref: MeetingRef, confirm: boolean) {
  const path = API.journal(ref.studentId, ref.sessionId, ref.bookId, ref.meetingId);
  const got = await session.api(path);
  if (got.status === 404) throw new ValidationError("No draft exists for this meeting. Save a draft first (with photos), then submit.");
  if (got.status >= 400) throw new ApiError(`Journal lookup failed with status ${got.status}`, got.status);
  const j = ((got.body as { data?: Record<string, any> })?.data ?? got.body) as Record<string, any>;
  const status = String(j.status ?? "");
  if (status === "created" || j.sent_at) {
    return { submitted: false, already_submitted: true, status, message: "This journal is already submitted. Nothing was changed." };
  }
  if (status !== "draft") throw new ValidationError(`This journal's status is "${status}", expected draft.`);

  const photos: any[] = Array.isArray(j.evidence_photos) ? j.evidence_photos : [];
  const note = String(j.teacher_note ?? "").trim();
  const summary = String(j.note ?? "").replace(/<[^>]+>/g, " ").trim();
  const problems: string[] = [];
  if (!note) problems.push("the teacher note is empty");
  if (!summary) problems.push("there is no AI summary yet (run the draft again with generate_ai_summary=true)");
  if (photos.length < 1) problems.push("it has no evidence photo");
  if (photos.length > 2) problems.push("it has more than 2 photos");
  const activities: any[] = Array.isArray(j.activities) ? j.activities : [];
  const low = activities.filter((a) => typeof a.score === "number" && a.score > 0 && a.score < LOW_SCORE_THRESHOLD).map((a) => `${a.data?.content ?? a.id}: ${a.score}`);
  const preview = {
    status,
    photos: photos.length,
    teacher_note: note,
    ai_summary_chars: summary.length,
    quiz_scores_below_75: low,
    blocked_by: problems,
  };
  if (problems.length) return { submitted: false, message: `Not ready to submit: ${problems.join("; ")}.`, ...preview };
  if (!confirm) {
    return { submitted: false, message: "Preview only. Nothing was sent. Run again with confirm=true after the teacher approves." + (low.length ? " Note: some quiz scores are below 75." : ""), ...preview };
  }

  const photoRefs = photos.map((p) => {
    if (p && typeof p === "object" && "file" in p) {
      const { file, ...rest } = p;
      return { ...rest, path: file };
    }
    return p;
  });
  const form: Record<string, string> = {
    status: "created",
    project: JSON.stringify(j.project ?? { is_active: false, project_name: "" }),
    teacher_note: String(j.teacher_note ?? ""),
    note: String(j.note ?? ""),
    learning_session_book_meeting_activities: JSON.stringify(activities.map((a) => ({ id: a.id, score: typeof a.score === "number" ? a.score : 0 }))),
    existing_evidence_photos: JSON.stringify(photoRefs),
  };
  const res = await session.apiSend("POST", path, { form });
  if (res.status < 200 || res.status >= 300) throw new ApiError(`The portal rejected the submit (status ${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`, res.status);
  const back = await session.api(path);
  const bj = ((back.body as { data?: Record<string, any> })?.data ?? back.body) as Record<string, any>;
  const nowStatus = String(bj.status ?? "");
  const nowPhotos = Array.isArray(bj.evidence_photos) ? bj.evidence_photos.length : 0;
  const ok = nowStatus === "created" && nowPhotos === photos.length && String(bj.teacher_note ?? "") === form.teacher_note;
  return {
    submitted: nowStatus === "created",
    verified: ok,
    status_after: nowStatus,
    photos_after: nowPhotos,
    message: ok ? "Submitted and confirmed by reading the journal back." : "The portal accepted the request but the read back does not match. Check this journal in the portal now.",
    ...preview,
  };
}
