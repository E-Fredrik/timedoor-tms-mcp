import { ApiError, TmsSession } from "./session.js";
import { unwrap } from "./sendparent.js";
import { ValidationError } from "./validate.js";

// Teacher class attendance, using the same calls as the portal's own pages
// (read from the portal's front end bundle, Nov 13 2026):
//   Start Class button:              POST  /api/cms/attendance/{id}/start                      -> status "ongoing"
//   presence dialog Save (teacher):  POST  /api/tms/attendance/{id}/start-update-and-send-key  {payload}
//   student list Save after start:   PATCH /api/tms/attendance/{id}/update-participant        {payload}
//   student card Send Key button:    POST  /api/cms/attendance/{id}/send-key                   {session_schedule_id: row id}
//   Finish Class button:             POST  /api/cms/attendance/{id}/finish                     -> status "finish"
//   read back:                       GET   /api/tms/attendance/{id}
// Saving presence alone does not start the class or send keys, so those are separate calls here too.

export type PresenceStatus = "present" | "late" | "absent";

export interface PresenceChange {
  name?: string; // exact name from the class list, case insensitive
  row_id?: number; // the student row id from the class detail (use when two names are the same)
  status: PresenceStatus;
  late_minutes?: number; // required for late, 1 to 180
  rent_laptop?: boolean; // tick (true) or untick (false) the rent box; left out keeps the current tick
}

export interface RentOption {
  id: number;
  product_variant_id?: number;
  name?: string;
  variant_name?: string;
  is_rented?: boolean;
  [k: string]: unknown;
}

export interface StudentRow {
  id: number;
  name: string;
  presence: { is_present?: boolean; late?: boolean; late_time?: number; note?: string } | null;
  rents?: Array<RentOption | null>;
  is_key_send?: boolean;
  [k: string]: unknown;
}

const LATE_MIN = 1;
const LATE_MAX = 180;

/** Reads the class session detail and returns its name, date, status and student rows. */
export async function fetchClassDetail(session: TmsSession, attendanceId: number): Promise<{ id: number; cls: string; date: string; status: string; students: StudentRow[] }> {
  const r = await session.api(`/api/tms/attendance/${attendanceId}`);
  if (r.status >= 400) throw new ApiError(`Class attendance ${attendanceId} could not be read (status ${r.status})`, r.status);
  const d = unwrap(r.body);
  const students = (Array.isArray(d.students) ? d.students : []).filter((s: unknown): s is StudentRow => !!s && typeof s === "object" && typeof (s as any).id === "number");
  return {
    id: attendanceId,
    cls: String(d.class?.name ?? d.reservationable?.name ?? "(unnamed class)"),
    date: String(d.date ?? ""),
    status: String(d.status ?? ""),
    students,
  };
}

const rentsOf = (row: StudentRow | undefined): RentOption[] => (row?.rents ?? []).filter((x): x is RentOption => !!x);
/** True when any rent option (the laptop) is ticked for this student. */
export const isRenting = (row: StudentRow | undefined): boolean => rentsOf(row).some((r) => r.is_rented === true);
export const isPresent = (row: StudentRow | undefined): boolean => row?.presence?.is_present === true;

/** Matches each requested change to one student row. Throws if a name is unknown or ambiguous. */
export function matchChanges(students: StudentRow[], changes: PresenceChange[]): Map<number, PresenceChange> {
  const out = new Map<number, PresenceChange>();
  for (const c of changes) {
    if (c.status === "late") {
      if (!Number.isInteger(c.late_minutes) || (c.late_minutes as number) < LATE_MIN || (c.late_minutes as number) > LATE_MAX) {
        throw new ValidationError(`late_minutes must be a whole number from ${LATE_MIN} to ${LATE_MAX} for a late student`);
      }
    }
    let row: StudentRow | undefined;
    if (c.row_id !== undefined) {
      row = students.find((s) => s.id === c.row_id);
      if (!row) throw new ValidationError(`No student row with row_id ${c.row_id} in this class`);
    } else if (c.name !== undefined) {
      const want = c.name.trim().toLowerCase();
      const hits = students.filter((s) => String(s.name ?? "").trim().toLowerCase() === want);
      if (hits.length === 0) throw new ValidationError(`No student named "${c.name}" in this class`);
      if (hits.length > 1) throw new ValidationError(`More than one student named "${c.name}". Pass row_id instead (${hits.map((h) => h.id).join(", ")}).`);
      row = hits[0];
    } else {
      throw new ValidationError("Each change needs a name or a row_id");
    }
    if (out.has(row.id)) throw new ValidationError(`Two changes point at the same student (${row.name})`);
    if (c.rent_laptop === true && c.status === "absent") throw new ValidationError(`${row.name} is marked absent, so a laptop cannot be rented`);
    if (c.rent_laptop !== undefined && rentsOf(row).length === 0) {
      throw new ValidationError(`${row.name} has no laptop rent option in this class, so the rent box cannot be changed`);
    }
    out.set(row.id, c);
  }
  return out;
}

/**
 * Builds the payload the portal's presence dialog sends: one {id, presence, rents} entry per student row.
 * Rows without a change keep their current presence and rent ticks. Absent rows send no rents, like the portal.
 */
export function buildPresencePayload(students: StudentRow[], changes: Map<number, PresenceChange>): Array<Record<string, unknown>> {
  return students.map((row) => {
    const change = changes.get(row.id);
    const cur = row.presence ?? {};
    const status: PresenceStatus = change ? change.status : cur.is_present !== true ? "absent" : (cur.late_time ?? 0) > 0 ? "late" : "present";
    const present = status !== "absent";
    const lateTime = status === "late" ? (change?.late_minutes ?? cur.late_time ?? 0) : 0;
    // shortcut: rent_laptop ticks every rent option the student has (live data shows one, the laptop); pick by name if several appear.
    const rents = present
      ? rentsOf(row).map((r) => ({ is_rented: change?.rent_laptop ?? r.is_rented === true, id: r.id, product_variant_id: r.product_variant_id }))
      : [];
    return {
      id: row.id,
      presence: { is_present: present, late: status === "late", late_time: lateTime, note: present ? cur.note ?? "" : "" },
      rents,
    };
  });
}

export interface ClassPreview {
  attendance_id: number;
  class: string;
  date: string;
  class_status: string;
  planned: Array<{ row_id: number; name: string; status: PresenceStatus; late_minutes: number | null; rent_laptop?: boolean }>;
  unchanged_students: number;
  keys_to_send: string[];
  sent: boolean;
  will_start_class: boolean;
  class_started?: boolean;
  keys_sent?: string[];
  key_failures?: Array<{ name: string; error: string }>;
  verified?: boolean;
  mismatches?: Array<{ row_id: number; name: string; expected: string; found: string }>;
  notes: string[];
}

function describe(row: StudentRow | undefined): string {
  const p = row?.presence;
  if (!p || p.is_present !== true) return "absent";
  const base = (p.late_time ?? 0) > 0 ? `late ${p.late_time}m` : "present";
  return isRenting(row) ? `${base}, laptop` : base;
}

/** Present students in the payload whose key has not been sent yet. */
function keyTargets(students: StudentRow[], payload: Array<Record<string, unknown>>): StudentRow[] {
  return students.filter((s) => {
    const p = payload.find((x) => x.id === s.id) as { presence: { is_present: boolean } } | undefined;
    return p?.presence.is_present === true && s.is_key_send !== true;
  });
}

/**
 * Start mode: starts the class (Start Class button) if it is not running yet, then saves presence.
 * Update mode: changes presence on a class that is already started (and starts it first if it was not).
 * Both then send the key to every present student who has not had one, and read the class back to verify.
 * Without confirm it only previews and sends nothing.
 */
export async function setClassPresence(
  session: TmsSession,
  attendanceId: number,
  changes: PresenceChange[],
  opts: { mode: "start" | "update"; confirm: boolean },
): Promise<ClassPreview> {
  const detail = await fetchClassDetail(session, attendanceId);
  if (detail.status === "drop") throw new ValidationError("This class is marked drop (cancelled), so attendance cannot be set.");
  if (opts.mode === "start" && detail.status === "finish") throw new ValidationError("This class is already finished. Use tms_mark_attendance to correct presence.");
  if (changes.length === 0) throw new ValidationError("Give at least one student change");
  const matched = matchChanges(detail.students, changes);
  const payload = buildPresencePayload(detail.students, matched);
  // A class that was never started cannot just take a presence save: the portal then shows the students
  // present but leaves the class not started and sends no keys. So update mode starts it first, like the portal's dialog.
  const mode = detail.status === "ongoing" || detail.status === "finish" ? opts.mode : "start";
  const needsStart = mode === "start" && detail.status !== "ongoing";
  const planned = [...matched.entries()].map(([rowId, c]) => {
    const row = detail.students.find((s) => s.id === rowId)!;
    return { row_id: rowId, name: row.name, status: c.status, late_minutes: c.status === "late" ? c.late_minutes! : null, ...(c.rent_laptop !== undefined ? { rent_laptop: c.rent_laptop } : {}) };
  });
  const preview: ClassPreview = {
    attendance_id: attendanceId,
    class: detail.cls,
    date: detail.date,
    class_status: detail.status,
    planned,
    unchanged_students: detail.students.length - matched.size,
    keys_to_send: keyTargets(detail.students, payload).map((s) => s.name),
    sent: false,
    will_start_class: needsStart,
    notes: [
      mode === "start"
        ? needsStart
          ? "Start mode: starts the class (status becomes ongoing), then saves presence."
          : "Start mode: the class is already ongoing, so only presence is saved."
        : "Update mode: changes presence on a class that is already started.",
      "Every present student without a key gets one sent after the save.",
      "Students not listed keep their current presence and laptop rent tick.",
    ],
  };
  if (!opts.confirm) {
    preview.notes.push("Preview only. Nothing was sent. Call again with confirm=true after the teacher agrees.");
    return preview;
  }

  if (needsStart) {
    const st = await session.apiSend("POST", `/api/cms/attendance/${attendanceId}/start`, { json: {} });
    if (st.status >= 400) throw new ApiError(`Starting the class failed with status ${st.status}. Nothing else was changed.`, st.status);
  }
  const path = mode === "start" ? `/api/tms/attendance/${attendanceId}/start-update-and-send-key` : `/api/tms/attendance/${attendanceId}/update-participant`;
  const r = await session.apiSend(mode === "start" ? "POST" : "PATCH", path, { json: { payload } });
  if (r.status >= 400) throw new ApiError(`Saving presence failed with status ${r.status}${needsStart ? " (the class was already started)" : ""}`, r.status);
  preview.sent = true;

  // Keys: the save does not reliably send them, so send each missing one like the portal's Send Key button.
  const mid = await fetchClassDetail(session, attendanceId);
  preview.keys_sent = [];
  for (const s of mid.students.filter((x) => isPresent(x) && x.is_key_send !== true)) {
    const k = await session.apiSend("POST", `/api/cms/attendance/${attendanceId}/send-key`, { json: { session_schedule_id: s.id } });
    if (k.status >= 400) (preview.key_failures ??= []).push({ name: s.name, error: `status ${k.status}` });
    else preview.keys_sent.push(s.name);
  }

  // Read back and compare the rows we changed, the keys, and the class status.
  const after = await fetchClassDetail(session, attendanceId);
  const mismatches: NonNullable<ClassPreview["mismatches"]> = [];
  for (const [rowId, c] of matched) {
    const row = after.students.find((s) => s.id === rowId);
    const before = detail.students.find((s) => s.id === rowId);
    const rent = c.status !== "absent" && (c.rent_laptop ?? isRenting(before));
    const expected = (c.status === "absent" ? "absent" : c.status === "late" ? `late ${c.late_minutes}m` : "present") + (rent ? ", laptop" : "");
    const found = describe(row);
    if (!row || found !== expected) mismatches.push({ row_id: rowId, name: row?.name ?? "(missing)", expected, found });
  }
  for (const s of after.students.filter((x) => isPresent(x) && x.is_key_send !== true)) {
    mismatches.push({ row_id: s.id, name: s.name, expected: "key sent", found: "key not sent" });
  }
  if (mode === "start") {
    preview.class_started = after.status === "ongoing";
    if (!preview.class_started) mismatches.push({ row_id: 0, name: "(class)", expected: "status ongoing", found: `status ${after.status || "(empty)"}` });
  }
  preview.class_status = after.status;
  preview.verified = mismatches.length === 0;
  if (mismatches.length) preview.mismatches = mismatches;
  return preview;
}

export interface FinishResult {
  attendance_id: number;
  class: string;
  date: string;
  class_status: string;
  present: number;
  absent: number;
  present_without_key: string[];
  sent: boolean;
  verified?: boolean;
  notes: string[];
}

/** Finishes a class (Finish Class button). Without confirm it only previews and sends nothing. */
export async function finishClass(session: TmsSession, attendanceId: number, confirm: boolean): Promise<FinishResult> {
  const d = await fetchClassDetail(session, attendanceId);
  if (d.status === "drop") throw new ValidationError("This class is marked drop (cancelled), so it cannot be finished.");
  if (d.status === "finish") throw new ValidationError("This class is already finished.");
  const present = d.students.filter(isPresent);
  const out: FinishResult = {
    attendance_id: attendanceId,
    class: d.cls,
    date: d.date,
    class_status: d.status,
    present: present.length,
    absent: d.students.length - present.length,
    present_without_key: present.filter((s) => s.is_key_send !== true).map((s) => s.name),
    sent: false,
    notes: [],
  };
  if (d.status !== "ongoing") out.notes.push(`The class status is "${d.status}", not ongoing. The portal may refuse to finish a class that was not started.`);
  if (out.present_without_key.length) out.notes.push("Some present students have no key yet. Run tms_mark_attendance first if they should get one.");
  if (!confirm) {
    out.notes.push("Preview only. Nothing was sent. Call again with confirm=true after the teacher agrees.");
    return out;
  }
  const r = await session.apiSend("POST", `/api/cms/attendance/${attendanceId}/finish`, { json: {} });
  if (r.status >= 400) throw new ApiError(`Finishing the class failed with status ${r.status}`, r.status);
  out.sent = true;
  const after = await fetchClassDetail(session, attendanceId);
  out.class_status = after.status;
  out.verified = after.status === "finish";
  return out;
}
