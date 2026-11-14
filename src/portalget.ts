import { TmsSession } from "./session.js";
import { ValidationError } from "./validate.js";

// Read only window onto the teacher API, for portal pages that have no dedicated tool (schedule, time off,
// dashboard, events, quiz and exam lists, courses). GET only, and only under the teacher namespaces.
const TEACHER_PATH = /^\/api\/(v2\/)?tms\/[A-Za-z0-9_\-/]+$/;
const BLOCKED = /\/(auth|dev-tool)(\/|$)/; // login and the portal's developer tools are not for reading
export const MAX_BODY_CHARS = 30000;

export function checkReadPath(path: unknown): string {
  if (typeof path !== "string" || !TEACHER_PATH.test(path) || path.includes("//") || BLOCKED.test(path)) {
    throw new ValidationError('path must be a teacher API path such as "/api/tms/schedule" (letters, digits, - _ / only, under /api/tms/ or /api/v2/tms/). Put filters in query, not in the path.');
  }
  return path;
}

export async function portalGet(session: TmsSession, path: unknown, query?: Record<string, string | number | boolean>) {
  const r = await session.api(checkReadPath(path), query);
  const text = JSON.stringify(r.body) ?? "";
  if (text.length <= MAX_BODY_CHARS) return { status: r.status, body: r.body };
  return { status: r.status, truncated: true, note: `The response is ${text.length} characters. Only the first ${MAX_BODY_CHARS} are shown: narrow it with query (for example limit, page, search).`, body_text: text.slice(0, MAX_BODY_CHARS) };
}
