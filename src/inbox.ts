import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { jakartaNow } from "./attendance.js";
import { ConfigError } from "./session.js";
import { clampInt, ValidationError } from "./validate.js";

const run = promisify(execFile);
export const PHOTO_EXT = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".pdf"]);

/** Parses mdls output like `kMDItemContentCreationDate = 2026-11-01 08:12:33 +0000`. Pure, unit tested. */
export function parseMdlsDate(out: string): Date | undefined {
  const m = /=\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})/.exec(out);
  if (!m) return undefined;
  const d = new Date(`${m[1]}T${m[2]}${m[3].slice(0, 3)}:${m[3].slice(3)}`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

async function takenAt(file: string, fallback: Date): Promise<{ at: Date; source: string }> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await run("mdls", ["-name", "kMDItemContentCreationDate", file], { timeout: 5000 });
      const d = parseMdlsDate(stdout);
      if (d) return { at: d, source: "photo metadata" };
    } catch {
      /* fall back */
    }
  }
  return { at: fallback, source: "file date" };
}

export async function listInboxPhotos(opts: { date?: string; limit?: number; dir?: string } = {}) {
  const dir = opts.dir ?? process.env.TMS_PHOTO_DIR?.trim();
  if (!dir) throw new ConfigError("TMS_PHOTO_DIR is not set. Put the folder your class photos go into in .env as TMS_PHOTO_DIR, then restart.");
  if (opts.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new ValidationError("date must be YYYY-MM-DD");
  const limit = clampInt("limit", opts.limit, 1, 200, 30);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    throw new ConfigError(`Cannot read the photo folder (${dir}). Check TMS_PHOTO_DIR.`);
  }
  const rows = [];
  for (const n of names) {
    if (n.startsWith(".")) continue;
    const ext = path.extname(n).toLowerCase();
    if (!PHOTO_EXT.has(ext)) continue;
    const full = path.join(dir, n);
    const st = await stat(full).catch(() => undefined);
    if (!st?.isFile() || st.size === 0) continue;
    const t = await takenAt(full, st.birthtimeMs > 0 ? st.birthtime : st.mtime);
    const local = jakartaNow(t.at);
    if (opts.date && local.date !== opts.date) continue;
    rows.push({ path: full, name: n, date: local.date, time: local.time, time_source: t.source, size_mb: Math.round((st.size / 1048576) * 10) / 10, _t: t.at.getTime() });
  }
  rows.sort((a, b) => b._t - a._t);
  return { folder: dir, count: rows.length, photos: rows.slice(0, limit).map(({ _t, ...r }) => r) };
}
