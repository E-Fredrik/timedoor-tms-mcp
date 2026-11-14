import { API } from "./config.js";
import { ApiError, TmsSession } from "./session.js";
import { positiveInt, ValidationError } from "./validate.js";
import type { MeetingRef } from "./journal.js";

interface Activity {
  id: number;
  score?: number | null;
  data?: { content?: string };
}

export interface ScoreChange {
  lesson?: number; // lesson number, for example 22
  activityId?: number;
  score: number;
}

export function parseScoreChanges(v: unknown): ScoreChange[] {
  if (!Array.isArray(v) || v.length === 0) throw new ValidationError("changes must be a non empty list of {lesson or activity_id, score}");
  if (v.length > 20) throw new ValidationError("Too many changes in one call (limit 20)");
  const out: ScoreChange[] = v.map((c, i) => {
    const o = (c ?? {}) as Record<string, unknown>;
    if ((o.lesson === undefined) === (o.activity_id === undefined)) throw new ValidationError(`changes[${i}] needs exactly one of lesson or activity_id`);
    const score = o.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) throw new ValidationError(`changes[${i}].score must be a number from 0 to 100`);
    return {
      lesson: o.lesson === undefined ? undefined : positiveInt(`changes[${i}].lesson`, o.lesson),
      activityId: o.activity_id === undefined ? undefined : positiveInt(`changes[${i}].activity_id`, o.activity_id),
      score,
    };
  });
  return out;
}

const lessonNo = (a: Activity) => {
  const m = /^\s*Lesson\s+(\d+)\b/i.exec(a.data?.content ?? "");
  return m ? Number(m[1]) : undefined;
};

/** Pure: works out the new activity list or explains why it cannot. */
export function applyScoreChanges(activities: Activity[], changes: ScoreChange[]) {
  const next = activities.map((a) => ({ id: a.id, score: typeof a.score === "number" ? a.score : 0, lesson: a.data?.content ?? "(unnamed)" }));
  const diff: Array<{ lesson: string; activity_id: number; from: number; to: number }> = [];
  for (const c of changes) {
    const hits =
      c.activityId !== undefined ? activities.filter((a) => a.id === c.activityId) : activities.filter((a) => lessonNo(a) === c.lesson);
    if (hits.length === 0) {
      throw new ValidationError(
        `No lesson on this journal matches ${c.activityId !== undefined ? `activity ${c.activityId}` : `Lesson ${c.lesson}`}. Lessons here: ${activities.map((a) => a.data?.content ?? a.id).join("; ") || "none"}.`,
      );
    }
    if (hits.length > 1) throw new ValidationError(`Lesson ${c.lesson} matches ${hits.length} entries on this journal. Use activity_id instead.`);
    const row = next.find((n) => n.id === hits[0].id)!;
    diff.push({ lesson: row.lesson, activity_id: row.id, from: row.score, to: c.score });
    row.score = c.score;
  }
  return { activities: next.map(({ id, score }) => ({ id, score })), diff };
}

/**
 * Changes lesson quiz scores on an EXISTING journal by re sending that journal with new scores, the same way
 * the portal form does. Dry run unless confirm is true. Created journals are allowed; sent ones need allow_sent. Existing photos
 * are passed back as references. This write path is built from the portal's own code, not yet proven live.
 */
export async function updateLessonScores(session: TmsSession, ref: MeetingRef, changes: ScoreChange[], confirm: boolean, allowSent = false) {
  const path = API.journal(ref.studentId, ref.sessionId, ref.bookId, ref.meetingId);
  const got = await session.api(path);
  if (got.status === 404) throw new ValidationError("No journal exists for this meeting yet, so there are no saved scores to change. Create the draft first.");
  if (got.status >= 400) throw new ApiError(`Journal lookup failed with status ${got.status}`, got.status);
  const j = ((got.body as { data?: Record<string, any> })?.data ?? got.body) as Record<string, any>;
  const status = String(j.status ?? "");
  if (j.sent_at && !allowSent) {
    throw new ValidationError("This journal was already sent to the parent. Changing its scores will not unsend it. Pass allow_sent=true only if you are sure.");
  }
  if (status !== "draft" && status !== "created") throw new ValidationError(`This journal's status is "${status}", which I do not know how to re save safely.`);
  // Photos are stored when uploaded, so only their references are sent back (no files), the same way the
  // portal form does: each existing photo is passed on with its `file` field renamed to `path`.
  const photos: any[] = Array.isArray(j.evidence_photos) ? j.evidence_photos : [];
  const photoRefs = photos.map((p) => {
    if (p && typeof p === "object" && "file" in p) {
      const { file, ...rest } = p;
      return { ...rest, path: file };
    }
    return p;
  });
  const photoIds = (list: any[]) => list.map((p) => String(p?.id ?? p?.path ?? p?.url ?? "")).sort().join("|");
  const { activities, diff } = applyScoreChanges(Array.isArray(j.activities) ? j.activities : [], changes);
  const project = j.project ?? { is_active: false, project_name: "" };
  const form: Record<string, string> = {
    status,
    project: JSON.stringify(project),
    teacher_note: String(j.teacher_note ?? ""),
    note: String(j.note ?? ""),
    learning_session_book_meeting_activities: JSON.stringify(activities),
    existing_evidence_photos: JSON.stringify(photoRefs),
  };
  const preview = { changes: diff, status, will_keep: { photos: photos.length, teacher_note_chars: form.teacher_note.length, ai_summary_chars: form.note.length } };
  if (!confirm) return { saved: false, message: "Preview only. Nothing was sent. Run again with confirm=true after the teacher approves.", ...preview };

  const res = await session.apiSend("POST", path, { form });
  if (res.status < 200 || res.status >= 300) throw new ApiError(`The portal rejected the score change (status ${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`, res.status);
  const back = await session.api(path);
  const bj = ((back.body as { data?: Record<string, any> })?.data ?? back.body) as Record<string, any>;
  const now = new Map<number, number>((Array.isArray(bj.activities) ? bj.activities : []).map((a: Activity) => [a.id, a.score ?? 0]));
  const verified = diff.every((d) => now.get(d.activity_id) === d.to);
  const kept = String(bj.teacher_note ?? "") === form.teacher_note && String(bj.note ?? "") === form.note;
  const photosKept = photoIds(Array.isArray(bj.evidence_photos) ? bj.evidence_photos : []) === photoIds(photos);
  return {
    saved: true,
    verified_scores: verified,
    teacher_note_and_summary_unchanged: kept,
    photos_unchanged: photosKept,
    message:
      verified && kept && photosKept
        ? "Scores changed and confirmed by reading the journal back (notes and photos unchanged)."
        : `The portal accepted the change but the read back did not match${photosKept ? "" : " and the PHOTOS differ from before"}. Check this journal in the portal now.`,
    ...preview,
  };
}
