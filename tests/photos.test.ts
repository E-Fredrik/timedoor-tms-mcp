import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { preparePhotos, renderPdfPages, sniffKind } from "../src/photos.js";
import { ValidationError } from "../src/validate.js";

const fixtures = path.resolve(__dirname, "fixtures");
let dir: string;
let jpg: string, png: string, heic: string, jpg2: string, fakeJpg: string, big: string;

// Minimal valid file headers. The sniffer only needs real magic bytes.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "photo-test-"));
  jpg = path.join(dir, "a.jpg");
  jpg2 = path.join(dir, "b.JPEG");
  png = path.join(dir, "c.png");
  heic = path.join(dir, "d.heic");
  fakeJpg = path.join(dir, "evil.jpg");
  big = path.join(dir, "big.jpg");
  await fs.writeFile(jpg, JPEG);
  await fs.writeFile(jpg2, JPEG);
  await fs.writeFile(png, PNG);
  await fs.writeFile(heic, HEIC);
  await fs.writeFile(fakeJpg, "this is a text file pretending to be a jpg");
  const f = await fs.open(big, "w");
  await f.write(JPEG);
  await f.truncate(15 * 1024 * 1024 + 1);
  await f.close();
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  delete process.env.TMS_PHOTO_DIR;
  while (cleanups.length) await cleanups.pop()!();
});
const prep = async (inputs: unknown) => {
  const p = await preparePhotos(inputs);
  cleanups.push(p.cleanup);
  return p;
};

describe("sniffKind", () => {
  it("recognises real headers", () => {
    expect(sniffKind(JPEG)).toBe("jpeg");
    expect(sniffKind(PNG)).toBe("png");
    expect(sniffKind(HEIC)).toBe("heic");
    expect(sniffKind(Buffer.from("%PDF-1.7 stuff"))).toBe("pdf");
  });
  it("rejects everything else, including empty and short input", () => {
    expect(sniffKind(Buffer.from("hello world, definitely text"))).toBeUndefined();
    expect(sniffKind(Buffer.alloc(0))).toBeUndefined();
    expect(sniffKind(Buffer.from([0xff, 0xd8]))).toBeUndefined();
  });
});

describe("preparePhotos: images", () => {
  it("accepts one or two valid images", async () => {
    expect((await prep([jpg])).files).toEqual([jpg]);
    expect((await prep([jpg, png])).files).toEqual([jpg, png]);
  });
  it("converts HEIC to a JPEG copy and leaves the original alone", async () => {
    const conv = async (_s: string, d: string) => { await fs.writeFile(d, Buffer.from([0xff, 0xd8, 0xff, 1])); };
    const p = await preparePhotos([heic], undefined, conv);
    cleanups.push(p.cleanup);
    expect(p.files).toHaveLength(1);
    expect(p.files[0]).toMatch(/\.jpg$/);
    expect(p.files[0]).not.toBe(heic);
    expect(p.warnings.join(" ")).toMatch(/converted to JPEG/);
    expect((await fs.stat(heic)).size).toBeGreaterThan(0);
  });
  it("gives a clear error if HEIC conversion fails or yields an empty file", async () => {
    await expect(preparePhotos([heic], undefined, async () => { throw new Error("no sips"); })).rejects.toThrow(/Could not convert .* HEIC/);
    await expect(preparePhotos([heic], undefined, async (_s, d) => { await fs.writeFile(d, ""); })).rejects.toThrow(/Could not convert/);
  });
  it("mixes a HEIC and a JPG within the 2 photo limit", async () => {
    const conv = async (_s: string, d: string) => { await fs.writeFile(d, Buffer.from([0xff, 0xd8, 0xff, 1])); };
    const p = await preparePhotos([heic, jpg], undefined, conv);
    cleanups.push(p.cleanup);
    expect(p.files).toHaveLength(2);
    await expect(preparePhotos([heic, jpg, png], undefined, conv)).rejects.toThrow(/at most 2/);
  });
  it("rejects three photos", async () => {
    await expect(preparePhotos([jpg, jpg2, png])).rejects.toThrow(/at most 2/);
  });
  it("rejects empty list, non list, and non string entries", async () => {
    for (const bad of [[], undefined, null, "a.jpg", [5], [""], ["   "]]) await expect(preparePhotos(bad)).rejects.toThrow(ValidationError);
  });
  it("rejects a missing file, a folder, and an empty file", async () => {
    await expect(preparePhotos([path.join(dir, "nope.jpg")])).rejects.toThrow(/not found/i);
    const sub = path.join(dir, "folder.jpg");
    await fs.mkdir(sub, { recursive: true });
    await expect(preparePhotos([sub])).rejects.toThrow(/Not a file/);
    const empty = path.join(dir, "empty.png");
    await fs.writeFile(empty, "");
    await expect(preparePhotos([empty])).rejects.toThrow(/empty/);
  });
  it("rejects wrong extensions and files whose contents do not match", async () => {
    const txt = path.join(dir, "notes.txt");
    await fs.writeFile(txt, "x");
    await expect(preparePhotos([txt])).rejects.toThrow(/Unsupported file type/);
    await expect(preparePhotos([fakeJpg])).rejects.toThrow(/not a real JPG/);
  });
  it("rejects images over 15 MB", async () => {
    await expect(preparePhotos([big])).rejects.toThrow(/larger than 15 MB/);
  });
  it("enforces TMS_PHOTO_DIR when set, including sibling folders with a similar prefix", async () => {
    process.env.TMS_PHOTO_DIR = dir;
    expect((await prep([jpg])).files).toEqual([jpg]);
    const sibling = dir + "-evil";
    await fs.mkdir(sibling, { recursive: true });
    const outside = path.join(sibling, "x.jpg");
    await fs.writeFile(outside, JPEG);
    await expect(preparePhotos([outside])).rejects.toThrow(/inside TMS_PHOTO_DIR/);
    await fs.rm(sibling, { recursive: true, force: true });
  });
  it("blocks path tricks out of TMS_PHOTO_DIR", async () => {
    process.env.TMS_PHOTO_DIR = path.join(dir, "only-here");
    await fs.mkdir(process.env.TMS_PHOTO_DIR, { recursive: true });
    await expect(preparePhotos([path.join(process.env.TMS_PHOTO_DIR, "..", "a.jpg")])).rejects.toThrow(/inside TMS_PHOTO_DIR/);
  });
});

describe("preparePhotos: PDFs (real rendering)", () => {
  it("renders a one page PDF to a PNG", async () => {
    const p = await prep([path.join(fixtures, "one-page.pdf")]);
    expect(p.files).toHaveLength(1);
    const head = new Uint8Array(8);
    const fh = await fs.open(p.files[0], "r");
    await fh.read(head, 0, 8, 0);
    await fh.close();
    expect(sniffKind(head)).toBe("png");
  }, 60_000);

  it("uses only the first 2 pages of a 3 page PDF and warns", async () => {
    const p = await prep([path.join(fixtures, "three-page.pdf")]);
    expect(p.files).toHaveLength(2);
    expect(p.warnings.join(" ")).toMatch(/Only the first 2 page/);
  }, 60_000);

  it("shares slots: one image plus a PDF gives 2 files, and two PDFs of one page each too", async () => {
    const a = await prep([jpg, path.join(fixtures, "three-page.pdf")]);
    expect(a.files).toHaveLength(2);
    expect(a.files[0]).toBe(jpg);
    const b = await prep([path.join(fixtures, "one-page.pdf"), path.join(fixtures, "one-page.pdf")]);
    expect(b.files).toHaveLength(2);
  }, 60_000);

  it("rejects a PDF when no slots are left", async () => {
    await expect(preparePhotos([jpg, png, path.join(fixtures, "one-page.pdf")])).rejects.toThrow(/at most 2/);
  });

  it("rejects a corrupt PDF cleanly and leaves no temp folder behind", async () => {
    const bad = path.join(dir, "bad.pdf");
    await fs.writeFile(bad, "%PDF-1.4\nthis is not really a pdf\n");
    const countTmp = async () => (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("tms-photos-")).length;
    const before = await countTmp();
    await expect(preparePhotos([bad])).rejects.toThrow(/Could not read/);
    expect(await countTmp()).toBe(before);
  }, 60_000);

  it("cleanup removes the rendered files", async () => {
    const p = await preparePhotos([path.join(fixtures, "one-page.pdf")]);
    expect(await fs.stat(p.files[0])).toBeTruthy();
    await p.cleanup();
    await expect(fs.stat(p.files[0])).rejects.toThrow();
  }, 60_000);

  it("renderPdfPages respects the page limit", async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), "render-"));
    const pages = await renderPdfPages(path.join(fixtures, "three-page.pdf"), 1, out);
    expect(pages).toHaveLength(1);
    await fs.rm(out, { recursive: true, force: true });
  }, 60_000);
});
