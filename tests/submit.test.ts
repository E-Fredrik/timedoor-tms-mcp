import { describe, expect, it } from "vitest";
import { submitJournal } from "../src/submit.js";
import type { TmsSession } from "../src/session.js";

const ref = { studentId: 1, sessionId: 2, bookId: 3, meetingId: 4 };
const acts = [{ id: 11, score: 90, data: { content: "Lesson 3" } }, { id: 12, score: 60, data: { content: "Lesson 4" } }];
const body = (o: any = {}) => ({ data: { status: "draft", sent_at: "", evidence_photos: [{ id: 7, file: "a.jpg" }], teacher_note: "good work", note: "<p>summary</p>", project: { is_active: false, project_name: "" }, activities: acts, ...o } });
const sess = (initial: any, after?: any) => {
  const writes: any[] = [];
  let posted = false;
  const s = {
    api: async () => (initial === 404 ? { status: 404, body: {} } : posted && after ? { status: 200, body: after } : { status: 200, body: initial }),
    apiSend: async (m: string, p: string, payload: any) => { posted = true; writes.push({ m, p, payload }); return { status: 200, body: {} }; },
  } as unknown as TmsSession;
  return { s, writes };
};

describe("submitJournal", () => {
  it("previews without sending and flags scores under 75", async () => {
    const f = sess(body());
    const r: any = await submitJournal(f.s, ref, false);
    expect(r.submitted).toBe(false);
    expect(f.writes).toHaveLength(0);
    expect(r.quiz_scores_below_75).toEqual(["Lesson 4: 60"]);
  });
  it("blocks when note, summary or photos are missing", async () => {
    for (const [o, re] of [[{ teacher_note: " " }, /teacher note/], [{ note: "" }, /AI summary/], [{ evidence_photos: [] }, /no evidence photo/], [{ evidence_photos: [{}, {}, {}] }, /more than 2/]] as const) {
      const f = sess(body(o));
      const r: any = await submitJournal(f.s, ref, true);
      expect(r.submitted).toBe(false);
      expect(r.message).toMatch(re);
      expect(f.writes).toHaveLength(0);
    }
  });
  it("submits with status created, photo refs only, and verifies", async () => {
    const f = sess(body(), body({ status: "created" }));
    const r: any = await submitJournal(f.s, ref, true);
    const form = f.writes[0].payload.form;
    expect(form.status).toBe("created");
    expect(JSON.parse(form.existing_evidence_photos)).toEqual([{ id: 7, path: "a.jpg" }]);
    expect(r.submitted).toBe(true);
    expect(r.verified).toBe(true);
  });
  it("warns if the read back lost the photo", async () => {
    const f = sess(body(), body({ status: "created", evidence_photos: [] }));
    const r: any = await submitJournal(f.s, ref, true);
    expect(r.verified).toBe(false);
    expect(r.message).toMatch(/does not match/);
  });
  it("does nothing for an already created journal and errors with no draft or odd status", async () => {
    const f = sess(body({ status: "created" }));
    expect(((await submitJournal(f.s, ref, true)) as any).already_submitted).toBe(true);
    expect(f.writes).toHaveLength(0);
    await expect(submitJournal(sess(404).s, ref, true)).rejects.toThrow(/No draft/);
    await expect(submitJournal(sess(body({ status: "weird" })).s, ref, true)).rejects.toThrow(/expected draft/);
  });
});
