import { LIST_LIMIT, PROJECT_MAX, TEACHER_NOTES_MAX } from "./config.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function positiveInt(name: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
    throw new ValidationError(`${name} must be a positive whole number`);
  }
  return v;
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function teacherNotes(v: unknown): string {
  if (typeof v !== "string") throw new ValidationError("teacher_notes must be text");
  const s = v.trim();
  if (!s) throw new ValidationError("teacher_notes cannot be empty");
  if (CONTROL_CHARS.test(s)) throw new ValidationError("teacher_notes contains control characters");
  if (s.length > TEACHER_NOTES_MAX) {
    throw new ValidationError(
      `teacher_notes is ${s.length} characters but the form allows ${TEACHER_NOTES_MAX}. Shorten it by ${s.length - TEACHER_NOTES_MAX}.`,
    );
  }
  return s;
}

export function optionalText(name: string, v: unknown, max = PROJECT_MAX): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ValidationError(`${name} must be text`);
  const s = v.trim();
  if (!s) return undefined;
  if (CONTROL_CHARS.test(s)) throw new ValidationError(`${name} contains control characters`);
  if (s.length > max) throw new ValidationError(`${name} is ${s.length} characters, the limit I enforce is ${max}`);
  return s;
}

export function isoDate(name: string, v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new ValidationError(`${name} must look like YYYY-MM-DD`);
  }
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new ValidationError(`${name} is not a real calendar date: ${v}`);
  }
  return v;
}

export function dateRange(from: unknown, until: unknown): { from: string; until: string } {
  const f = isoDate("from", from);
  const u = isoDate("until", until);
  if (f > u) throw new ValidationError("from must be on or before until");
  return { from: f, until: u };
}

export function clampInt(
  name: string,
  v: unknown,
  min: number = LIST_LIMIT.min,
  max: number = LIST_LIMIT.max,
  def: number = LIST_LIMIT.default,
): number {
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationError(`${name} must be a number`);
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/** Replace every occurrence of each secret with a marker. Used on all text that leaves the server. */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join("[redacted]");
  }
  return out;
}
