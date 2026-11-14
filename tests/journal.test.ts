import { describe, expect, it } from "vitest";
import { API } from "../src/config.js";
import { parseDraftInput, saveJournalDraft } from "../src/journal.js";
import { ApiError, type TmsSession } from "../src/session.js";
import { ValidationError } from "../src/validate.js";

const ids = { student_id: 1, learning_session_id: 2, book_id: 3, meeting_id: 4 };
const meetingPath = API.meeting(1, 2, 3, 4);
const journalPath = API.journal(1, 2, 3, 4);

interface Opts {
  journalBefore?: { status: number; body?: unknown };
  journalAfter?: { status: number; body?: unknown };
  meeting?: { status: number; body?: unknown };
  noteEcho?: (v: string) => string;
  saveStatus?: number;
  saveNeverConfirms?: boolean;
  formLoads?: boolean;
  checkboxChecked?: boolean;
  photoNeverShows?: boolean;
}

function setup(o: Opts = {}) {
  const calls: string[] = [];
  let value = "";
  const field = (name: string) => ({
    waitFor: async () => {
      if (o.formLoads === false) throw new Error("timeout");
    },
    fill: async (v: string) => {
      calls.push(`fill:${name}`);
      value = v;
    },
    inputValue: async () => (o.noteEcho ? o.noteEcho(value) : value),
    isChecked: async () => o.checkboxChecked ?? false,
    setChecked: async (v: boolean) => {
      calls.push(`setChecked:${v}`);
    },
  });
  const page = {
    goto: async (u: string) => {
      calls.push(`goto:${u}`);
    },
    getByLabel: (label: string) => field(label),
    locator: () => ({
      setInputFiles: async (f: string) => {
        calls.push(`upload:${f.split(/[\\/]/).pop()}`);
      },
    }),
    evaluate: async () => 0,
    on: () => undefined,
    off: () => undefined,
    waitForFunction: async () => {
      if (o.photoNeverShows) throw new Error("timeout");
    },
    getByRole: () => ({
      click: async () => {
        calls.push("click:save");
      },
    }),
    waitForResponse: () =>
      o.saveNeverConfirms
        ? new Promise((_res, rej) => setTimeout(() => rej(new Error("timeout")), 10))
        : Promise.resolve({ status: () => o.saveStatus ?? 201 }),
  };
  let journalCalls = 0;
  const apiPaths: string[] = [];
  const session = {
    baseUrl: "https://x.test",
    ensureLoggedIn: async () => page,
    api: async (path: string) => {
      apiPaths.push(path);
      if (path === meetingPath) return o.meeting ?? { status: 200, body: {} };
      if (path === journalPath) {
        journalCalls++;
        if (journalCalls === 1) return o.journalBefore ?? { status: 404, body: {} };
        return o.journalAfter ?? { status: 200, body: { data: { status: "draft" } } };
      }
      throw new Error("unexpected path " + path);
    },
  } as unknown as TmsSession;
  return { session, calls, apiPaths };
}

const draft = (extra: Record<string, unknown> = {}) => parseDraftInput({ ...ids, teacher_notes: "Did well", ...extra });

describe("saveJournalDraft safety", () => {
  it("refuses to touch a journal that is not a draft", async () => {
    const { session, calls } = setup({ journalBefore: { status: 200, body: { data: { status: "submitted" } } } });
    await expect(saveJournalDraft(session, draft())).rejects.toThrow(ValidationError);
    expect(calls).toEqual([]); // never even opened the form
  });

  it("refuses when an existing journal has an unknown status", async () => {
    const { session } = setup({ journalBefore: { status: 200, body: { something: "else" } } });
    await expect(saveJournalDraft(session, draft())).rejects.toThrow(/status: unknown/);
  });

  it("allows editing an existing draft", async () => {
    const { session, calls } = setup({ journalBefore: { status: 200, body: { data: { status: "draft" } } } });
    const r = await saveJournalDraft(session, draft());
    expect(r.saved).toBe(true);
    expect(calls).toContain("click:save");
  });

  it("allows an unknown status only with overwrite_existing=true", async () => {
    const { session } = setup({ journalBefore: { status: 200, body: {} } });
    const r = await saveJournalDraft(session, draft({ overwrite_existing: true }));
    expect(r.saved).toBe(true);
  });

  it("fails clearly when the meeting does not exist", async () => {
    const { session } = setup({ meeting: { status: 404 } });
    await expect(saveJournalDraft(session, draft())).rejects.toThrow(/Meeting not found/);
  });

  it("surfaces a server error on the meeting lookup", async () => {
    const { session } = setup({ meeting: { status: 500 } });
    await expect(saveJournalDraft(session, draft())).rejects.toThrow(ApiError);
  });
});

describe("saveJournalDraft form handling", () => {
  it("dry run fills the form but never clicks save", async () => {
    const { session, calls } = setup();
    const r = await saveJournalDraft(session, draft({ dry_run: true }));
    expect(r.saved).toBe(false);
    expect(calls).not.toContain("click:save");
    expect(calls).toContain("fill:Teacher Notes");
  });

  it("stops without saving if the field does not keep the text", async () => {
    const { session, calls } = setup({ noteEcho: (v) => v.slice(0, 3) });
    await expect(saveJournalDraft(session, draft())).rejects.toThrow(/did not keep the text/);
    expect(calls).not.toContain("click:save");
  });

  it("errors if the form never loads", async () => {
    const { session, calls } = setup({ formLoads: false });
    await expect(saveJournalDraft(session, draft())).rejects.toThrow(/did not load/);
    expect(calls).not.toContain("click:save");
  });

  it("only toggles the checkbox when it differs", async () => {
    const same = setup({ checkboxChecked: true });
    await saveJournalDraft(same.session, draft({ active_project: true, dry_run: true }));
    expect(same.calls.some((c) => c.startsWith("setChecked"))).toBe(false);

    const diff = setup({ checkboxChecked: true });
    await saveJournalDraft(diff.session, draft({ active_project: false, dry_run: true }));
    expect(diff.calls).toContain("setChecked:false");
  });

  it("fills the project field only when given", async () => {
    const a = setup();
    await saveJournalDraft(a.session, draft({ dry_run: true }));
    expect(a.calls).not.toContain("fill:Project");
    const b = setup();
    await saveJournalDraft(b.session, draft({ dry_run: true, project: "Maze game" }));
    expect(b.calls).toContain("fill:Project");
  });
});

describe("saveJournalDraft save outcome", () => {
  it("reports success and verifies by reading back", async () => {
    const { session } = setup();
    const r = await saveJournalDraft(session, draft());
    expect(r).toMatchObject({ saved: true, verified: true });
  });

  it("does not claim success when the site rejects the save", async () => {
    const { session } = setup({ saveStatus: 500 });
    await expect(saveJournalDraft(session, draft())).rejects.toThrow(/status 500/);
  });

  it("does not claim success when the save is never confirmed", async () => {
    const { session } = setup({ saveNeverConfirms: true });
    await expect(saveJournalDraft(session, draft())).rejects.toThrow(/never saw the site confirm/);
  });

  it("is honest when the save was accepted but cannot be read back", async () => {
    const { session } = setup({ journalAfter: { status: 404 } });
    const r = await saveJournalDraft(session, draft());
    expect(r).toMatchObject({ saved: true, verified: false });
    expect(r.message).toMatch(/could not read it back/);
  });
});

describe("saveJournalDraft photos", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const mk = async (name: string) => {
    const { promises: fsp } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "jr-"));
    const p = path.join(dir, name);
    await fsp.writeFile(p, JPEG);
    return p;
  };

  it("uploads photos one at a time BEFORE clicking save", async () => {
    const a = await mk("one.jpg");
    const b = await mk("two.jpg");
    const { session, calls } = setup();
    const r = await saveJournalDraft(session, draft({ photos: [a, b] }));
    expect(r).toMatchObject({ saved: true, photosUploaded: 2 });
    const order = calls.filter((c) => c.startsWith("upload:") || c === "click:save");
    expect(order).toEqual(["upload:one.jpg", "upload:two.jpg", "click:save"]);
  });

  it("dry run checks the files but uploads nothing", async () => {
    const a = await mk("one.jpg");
    const { session, calls } = setup();
    const r = await saveJournalDraft(session, draft({ photos: [a], dry_run: true }));
    expect(r).toMatchObject({ saved: false, photosChecked: 1, photosUploaded: 0 });
    expect(calls.some((c) => c.startsWith("upload:"))).toBe(false);
  });

  it("a bad photo path fails BEFORE any portal call", async () => {
    const { session, calls, apiPaths } = setup();
    await expect(saveJournalDraft(session, draft({ photos: ["/definitely/not/here.jpg"] }))).rejects.toThrow(/not found/i);
    expect(apiPaths).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("does not save if an uploaded photo never appears on the form", async () => {
    const a = await mk("one.jpg");
    const { session, calls } = setup({ photoNeverShows: true });
    await expect(saveJournalDraft(session, draft({ photos: [a] }))).rejects.toThrow(/did not show up/);
    expect(calls).not.toContain("click:save");
  });

  it("works without photos exactly as before", async () => {
    const { session, calls } = setup();
    const r = await saveJournalDraft(session, draft());
    expect(r).toMatchObject({ saved: true, photosUploaded: 0 });
    expect(calls.some((c) => c.startsWith("upload:"))).toBe(false);
  });

  it("parseDraftInput rejects malformed photos arguments", () => {
    expect(() => draft({ photos: "a.jpg" })).toThrow(ValidationError);
    expect(() => draft({ photos: [1] })).toThrow(ValidationError);
    expect(() => draft({ photos: ["a", "b", "c"] })).toThrow(/at most 2/);
    expect(draft({ photos: [] }).photos).toBeUndefined();
  });
});
