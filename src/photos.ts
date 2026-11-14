import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ValidationError } from "./validate.js";

const run = promisify(execFile);

export type HeicConverter = (src: string, dest: string) => Promise<void>;

/** macOS ships `sips`, which converts HEIC to JPEG (also downsizes very large photos). */
export const convertHeicToJpeg: HeicConverter = async (src, dest) => {
  if (process.platform !== "darwin") throw new Error("HEIC conversion needs macOS (sips)");
  await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", "-Z", "2400", src, "--out", dest]);
};

// Limits shown on the journal form: "up to 2 photos ... Maximum size 15 MB".
export const PHOTO_MAX_COUNT = 2;
export const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
export const PDF_MAX_BYTES = 40 * 1024 * 1024;

export type PhotoKind = "jpeg" | "png" | "heic" | "pdf";

/** Detect the real type from the first bytes, so a renamed file cannot sneak through. */
export function sniffKind(head: Uint8Array): PhotoKind | undefined {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "png";
  if (head.length >= 5 && String.fromCharCode(...head.slice(0, 5)) === "%PDF-") return "pdf";
  if (head.length >= 12 && String.fromCharCode(...head.slice(4, 8)) === "ftyp") {
    const brand = String.fromCharCode(...head.slice(8, 12));
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return "heic";
  }
  return undefined;
}

const EXT_OK = new Set([".jpg", ".jpeg", ".png", ".heic", ".pdf"]);

export interface PreparedPhotos {
  files: string[];
  warnings: string[];
  cleanup: () => Promise<void>;
}

function allowedRoot(): string | undefined {
  const r = process.env.TMS_PHOTO_DIR?.trim();
  return r ? path.resolve(r) : undefined;
}

export type PdfRenderer = (pdfPath: string, maxPages: number, outDir: string) => Promise<string[]>;

/** Renders the first pages of a PDF to PNG files using pdf-to-img. */
export const renderPdfPages: PdfRenderer = async (pdfPath, maxPages, outDir) => {
  const { pdf } = await import("pdf-to-img");
  const doc = await pdf(pdfPath, { scale: 1.5 });
  const out: string[] = [];
  let i = 0;
  for await (const page of doc) {
    if (i >= maxPages) break;
    const p = path.join(outDir, `page-${i + 1}.png`);
    await fs.writeFile(p, page);
    out.push(p);
    i++;
  }
  return out;
};

/**
 * Validates photo paths (images or PDFs) and returns at most two image files ready to upload.
 * PDF pages are rendered to PNG in a temp folder that cleanup() removes.
 */
export async function preparePhotos(
  inputs: unknown,
  render: PdfRenderer = renderPdfPages,
  convert: HeicConverter = convertHeicToJpeg,
): Promise<PreparedPhotos> {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new ValidationError("photos must be a non empty list of file paths");
  if (inputs.length > PHOTO_MAX_COUNT) {
    throw new ValidationError(`The form accepts at most ${PHOTO_MAX_COUNT} photos but ${inputs.length} paths were given`);
  }
  const root = allowedRoot();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tms-photos-"));
  const cleanup = async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  };
  const files: string[] = [];
  const warnings: string[] = [];
  try {
    for (const raw of inputs) {
      if (typeof raw !== "string" || !raw.trim()) throw new ValidationError("each photo path must be non empty text");
      const abs = path.resolve(raw.trim());
      if (root && abs !== root && !abs.startsWith(root + path.sep)) {
        throw new ValidationError(`Photo paths must be inside TMS_PHOTO_DIR (${root})`);
      }
      const ext = path.extname(abs).toLowerCase();
      if (!EXT_OK.has(ext)) throw new ValidationError(`Unsupported file type ${ext || "(none)"}. Use JPG, PNG, HEIC or PDF.`);
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        throw new ValidationError(`File not found: ${abs}`);
      }
      if (!st.isFile()) throw new ValidationError(`Not a file: ${abs}`);
      if (st.size === 0) throw new ValidationError(`File is empty: ${abs}`);
      const fh = await fs.open(abs, "r");
      const head = new Uint8Array(16);
      try {
        await fh.read(head, 0, 16, 0);
      } finally {
        await fh.close();
      }
      const kind = sniffKind(head);
      if (!kind) throw new ValidationError(`${path.basename(abs)} is not a real JPG, PNG, HEIC or PDF file`);
      if (kind === "pdf") {
        if (st.size > PDF_MAX_BYTES) throw new ValidationError(`${path.basename(abs)} is larger than ${PDF_MAX_BYTES / 1048576} MB`);
        const slots = PHOTO_MAX_COUNT - files.length;
        if (slots <= 0) throw new ValidationError(`No photo slots left for ${path.basename(abs)}`);
        let pages: string[];
        try {
          pages = await render(abs, slots, tmp);
        } catch (e) {
          throw new ValidationError(`Could not read ${path.basename(abs)} as a PDF: ${String((e as Error).message).slice(0, 150)}`);
        }
        if (pages.length === 0) throw new ValidationError(`${path.basename(abs)} has no pages`);
        for (const p of pages) {
          if ((await fs.stat(p)).size > PHOTO_MAX_BYTES) throw new ValidationError(`A rendered page of ${path.basename(abs)} is over 15 MB`);
        }
        if (pages.length === slots) warnings.push(`Only the first ${slots} page(s) of ${path.basename(abs)} were used (limit is ${PHOTO_MAX_COUNT} photos).`);
        files.push(...pages);
      } else {
        if (st.size > PHOTO_MAX_BYTES) throw new ValidationError(`${path.basename(abs)} is larger than 15 MB`);
        if (kind === "heic") {
          // The portal answered 500 to a raw HEIC upload, so send a JPEG copy (the original is never touched).
          const dest = path.join(tmp, `${path.basename(abs, path.extname(abs))}-${files.length + 1}.jpg`);
          try {
            await convert(abs, dest);
            if ((await fs.stat(dest)).size === 0) throw new Error("empty output");
            files.push(dest);
            warnings.push(`${path.basename(abs)} was converted to JPEG for upload (original untouched).`);
          } catch (e) {
            throw new ValidationError(`Could not convert ${path.basename(abs)} from HEIC to JPEG: ${String((e as Error).message).slice(0, 150)}. Export it as JPG and retry.`);
          }
        } else files.push(abs);
      }
      if (files.length > PHOTO_MAX_COUNT) throw new ValidationError(`That would be more than ${PHOTO_MAX_COUNT} photos in total`);
    }
  } catch (e) {
    await cleanup();
    throw e;
  }
  return { files, warnings, cleanup };
}
