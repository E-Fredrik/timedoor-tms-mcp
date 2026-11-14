import { ApiError, TmsSession } from "./session.js";
import { API } from "./config.js";

export interface StudentMatch {
  id: number;
  name: string;
  code: string | null;
  status: string | null;
  detail?: unknown;
  detail_error?: string;
}

/** Pure: keeps rows whose name contains the query (case and extra spaces ignored). */
export function filterStudentsByName(rows: any[], query: string): any[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  return rows.filter((r) => String(r?.name ?? "").toLowerCase().replace(/\s+/g, " ").includes(q));
}

/**
 * Finds the teacher's students whose name contains the text. The portal search is passed the text
 * too, then the rows are filtered here so a loose portal match is not returned as a hit.
 * Adds the student's own detail record for up to maxDetails matches.
 */
export async function findStudentsByName(session: TmsSession, name: string, opts: { maxDetails?: number; maxPages?: number } = {}): Promise<{ query: string; matches: StudentMatch[]; total_matches: number; notes: string[] }> {
  const query = name.trim();
  const maxPages = opts.maxPages ?? 10;
  const rows: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await session.api(API.students, { search: query, limit: 50, page });
    if (r.status >= 400) throw new ApiError(`Student search failed with status ${r.status}`, r.status);
    const body = r.body as { data?: any[]; meta?: { last_page?: number } };
    if (!Array.isArray(body.data)) throw new ApiError("Unexpected student list response shape");
    rows.push(...body.data);
    if (!body.meta?.last_page || page >= body.meta.last_page) break;
  }
  const hits = filterStudentsByName(rows, query);
  const maxDetails = opts.maxDetails ?? 5;
  const matches: StudentMatch[] = [];
  for (const h of hits) {
    const m: StudentMatch = { id: Number(h.id), name: String(h.name ?? ""), code: h.code ?? null, status: h.status ?? null };
    if (matches.length < maxDetails) {
      try {
        const d = await session.api(`/api/tms/student/${m.id}`);
        if (d.status >= 400) m.detail_error = `status ${d.status}`;
        else m.detail = d.body;
      } catch (e) {
        m.detail_error = String((e as Error).message).slice(0, 200);
      }
    }
    matches.push(m);
  }
  const notes = [];
  if (hits.length > maxDetails) notes.push(`Only the first ${maxDetails} matches include details. Give a fuller name to narrow the search.`);
  if (hits.length === 0) notes.push("No student name contains this text. Check the spelling or try part of the name.");
  return { query, matches, total_matches: hits.length, notes };
}
