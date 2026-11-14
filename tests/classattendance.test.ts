import { describe, expect, it } from "vitest";
import { buildPresencePayload, finishClass, matchChanges, setClassPresence, type StudentRow } from "../src/classattendance.js";
import type { TmsSession } from "../src/session.js";

const STUDENTS: StudentRow[] = [
  { id: 101, name: "Ali", code: "STD1", student: { id: 1 }, is_expired: false, is_key_send: false, presence: { is_present: false, late: false, late_time: 0, note: "" }, rents: [] },
  { id: 102, name: "Budi", presence: { is_present: true, late: true, late_time: 5, note: "bus" }, rents: [{ id: 9, product_variant_id: 77, name: "Laptop", is_rented: true }, null] },
  { id: 103, name: "Cici", presence: null, rents: [] },
  { id: 104, name: "Dodi", is_key_send: true, presence: { is_present: true, late: false, late_time: 0, note: "" }, rents: [{ id: 10, product_variant_id: 77, is_rented: false }] },
];

describe("matchChanges", () => {
  it("matches by name ignoring case and by row_id", () => {
    const m = matchChanges(STUDENTS, [{ name: "ali", status: "present" }, { row_id: 102, status: "late", late_minutes: 3 }]);
    expect([...m.keys()].sort()).toEqual([101, 102]);
  });

  it("refuses unknown and duplicate names", () => {
    expect(() => matchChanges(STUDENTS, [{ name: "Zed", status: "present" }])).toThrow(/No student named/);
    const dup = [...STUDENTS, { id: 105, name: "Ali", presence: null, rents: [] }];
    expect(() => matchChanges(dup, [{ name: "Ali", status: "present" }])).toThrow(/More than one student named "Ali"/);
  });

  it("requires late_minutes for late and keeps it in range", () => {
    expect(() => matchChanges(STUDENTS, [{ name: "Ali", status: "late" }])).toThrow(/late_minutes/);
    expect(() => matchChanges(STUDENTS, [{ name: "Ali", status: "late", late_minutes: 0 }])).toThrow(/late_minutes/);
    expect(() => matchChanges(STUDENTS, [{ name: "Ali", status: "late", late_minutes: 181 }])).toThrow(/late_minutes/);
  });

  it("refuses two changes for the same student and no target", () => {
    expect(() => matchChanges(STUDENTS, [{ name: "Ali", status: "present" }, { row_id: 101, status: "absent" }])).toThrow(/same student/);
    expect(() => matchChanges(STUDENTS, [{ status: "present" } as any])).toThrow(/needs a name or a row_id/);
  });
});

describe("buildPresencePayload", () => {
  it("marks a student late with minutes and keeps unlisted students as they were", () => {
    const changes = matchChanges(STUDENTS, [{ name: "Ali", status: "late", late_minutes: 7 }]);
    const p = buildPresencePayload(STUDENTS, changes) as any[];
    expect(p[0].presence).toMatchObject({ is_present: true, late: true, late_time: 7 });
    expect(p[1].presence).toMatchObject({ is_present: true, late: true, late_time: 5, note: "bus" });
    expect(p[1].rents).toEqual([{ id: 9, product_variant_id: 77, is_rented: true }]);
    expect(p[2].presence).toEqual({ is_present: false, late: false, late_time: 0, note: "" });
  });

  it("sets absent with no late time and no rents, and sends only the portal's fields", () => {
    const changes = matchChanges(STUDENTS, [{ name: "Budi", status: "absent" }]);
    const p = buildPresencePayload(STUDENTS, changes) as any[];
    expect(p[1].presence).toMatchObject({ is_present: false, late: false, late_time: 0, note: "" });
    expect(p[1].rents).toEqual([]);
    for (const row of p) expect(Object.keys(row).sort()).toEqual(["id", "presence", "rents"]);
  });

  it("marks present and clears late for a student who was late", () => {
    const changes = matchChanges(STUDENTS, [{ name: "Budi", status: "present" }]);
    const p = buildPresencePayload(STUDENTS, changes) as any[];
    expect(p[1].presence).toMatchObject({ is_present: true, late: false, late_time: 0 });
  });

  it("ticks and unticks the laptop rent box", () => {
    const p = buildPresencePayload(STUDENTS, matchChanges(STUDENTS, [{ name: "Dodi", status: "present", rent_laptop: true }, { name: "Budi", status: "present", rent_laptop: false }])) as any[];
    expect(p[3].rents).toEqual([{ id: 10, product_variant_id: 77, is_rented: true }]);
    expect(p[1].rents).toEqual([{ id: 9, product_variant_id: 77, is_rented: false }]);
  });

  it("refuses a rent for an absent student or one with no rent option", () => {
    expect(() => matchChanges(STUDENTS, [{ name: "Dodi", status: "absent", rent_laptop: true }])).toThrow(/absent/);
    expect(() => matchChanges(STUDENTS, [{ name: "Ali", status: "present", rent_laptop: true }])).toThrow(/no laptop rent option/);
  });
});

/** Fake portal for one class session. Records every write and behaves like the real calls. */
function fakePortal(initial: StudentRow[], status = "active", opts: { keyFails?: boolean; saveSendsKeys?: boolean } = {}) {
  let students = structuredClone(initial);
  let st = status;
  const writes: Array<{ method: string; path: string; body: any }> = [];
  const detail = () => ({ data: { id: 55, date: "2026-11-06", status: st, class: { name: "Class A" }, students: structuredClone(students) } });
  const s = {
    api: async (path: string) => {
      if (path !== "/api/tms/attendance/55") throw new Error("unexpected GET " + path);
      return { status: 200, body: detail() };
    },
    apiSend: async (method: string, path: string, payload: any) => {
      writes.push({ method, path, body: payload.json });
      if (path === "/api/cms/attendance/55/start") st = "ongoing";
      else if (path === "/api/cms/attendance/55/finish") st = "finish";
      else if (path === "/api/cms/attendance/55/send-key") {
        if (opts.keyFails) return { status: 422, body: {} };
        students = students.map((r) => (r.id === payload.json.session_schedule_id ? { ...r, is_key_send: true } : r));
      } else {
        students = students.map((r) => {
          const n = (payload.json.payload as any[]).find((x) => x.id === r.id);
          const rents = (r.rents ?? []).filter(Boolean).map((o: any) => ({ ...o, ...(n.rents.find((x: any) => x.id === o.id) ?? { is_rented: false }) }));
          return { ...r, presence: n.presence, rents, is_key_send: r.is_key_send || (opts.saveSendsKeys === true && n.presence.is_present) };
        });
      }
      return { status: 200, body: { data: {} } };
    },
  } as unknown as TmsSession;
  return { s, writes };
}

describe("setClassPresence", () => {
  it("previews and sends nothing without confirm", async () => {
    const { s, writes } = fakePortal(STUDENTS);
    const out = await setClassPresence(s, 55, [{ name: "Ali", status: "present" }], { mode: "start", confirm: false });
    expect(out.sent).toBe(false);
    expect(out.planned).toHaveLength(1);
    expect(out.keys_to_send).toEqual(["Ali", "Budi"]);
    expect(writes).toHaveLength(0);
  });

  it("update mode on a class that was never started starts it first (the Nov 14 bug: present but not started, no keys)", async () => {
    const { s, writes } = fakePortal(STUDENTS, "active");
    const preview = await setClassPresence(s, 55, [{ name: "Ali", status: "present" }], { mode: "update", confirm: false });
    expect(preview.will_start_class).toBe(true);
    const out = await setClassPresence(s, 55, [{ name: "Ali", status: "present" }], { mode: "update", confirm: true });
    expect(writes.map((w) => `${w.method} ${w.path}`).slice(0, 2)).toEqual([
      "POST /api/cms/attendance/55/start",
      "POST /api/tms/attendance/55/start-update-and-send-key",
    ]);
    expect(out.class_started).toBe(true);
    expect(out.class_status).toBe("ongoing");
    expect(out.keys_sent).toEqual(["Ali", "Budi"]);
    expect(out.verified).toBe(true);
  });

  it("start mode starts the class, saves presence, sends missing keys and verifies", async () => {
    const { s, writes } = fakePortal(STUDENTS);
    const out = await setClassPresence(s, 55, [{ name: "Ali", status: "late", late_minutes: 4 }, { name: "Cici", status: "absent" }], { mode: "start", confirm: true });
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      "POST /api/cms/attendance/55/start",
      "POST /api/tms/attendance/55/start-update-and-send-key",
      "POST /api/cms/attendance/55/send-key",
      "POST /api/cms/attendance/55/send-key",
    ]);
    expect(writes[1].body.payload).toHaveLength(4);
    expect(writes.slice(2).map((w) => w.body.session_schedule_id)).toEqual([101, 102]);
    expect(out.class_started).toBe(true);
    expect(out.class_status).toBe("ongoing");
    expect(out.keys_sent).toEqual(["Ali", "Budi"]);
    expect(out.verified).toBe(true);
    expect(out.mismatches).toBeUndefined();
  });

  it("does not call start again or resend keys when the class is ongoing and keys are sent", async () => {
    const { s, writes } = fakePortal(STUDENTS, "ongoing", { saveSendsKeys: true });
    const out = await setClassPresence(s, 55, [{ name: "Ali", status: "present" }], { mode: "start", confirm: true });
    expect(writes.map((w) => w.path)).toEqual(["/api/tms/attendance/55/start-update-and-send-key"]);
    expect(out.verified).toBe(true);
  });

  it("refuses to start a finished class", async () => {
    const { s, writes } = fakePortal(STUDENTS, "finish");
    await expect(setClassPresence(s, 55, [{ name: "Ali", status: "present" }], { mode: "start", confirm: true })).rejects.toThrow(/already finished/);
    expect(writes).toHaveLength(0);
  });

  it("update mode uses PATCH update-participant then sends the new present student's key", async () => {
    const { s, writes } = fakePortal(STUDENTS, "ongoing");
    const out = await setClassPresence(s, 55, [{ name: "Ali", status: "present" }, { name: "Budi", status: "absent" }], { mode: "update", confirm: true });
    expect(writes[0].method).toBe("PATCH");
    expect(writes[0].path).toBe("/api/tms/attendance/55/update-participant");
    expect(writes.slice(1).map((w) => w.body.session_schedule_id)).toEqual([101]);
    expect(out.verified).toBe(true);
  });

  it("saves the laptop rent and verifies it", async () => {
    const { s } = fakePortal(STUDENTS, "ongoing");
    const out = await setClassPresence(s, 55, [{ name: "Dodi", status: "present", rent_laptop: true }], { mode: "update", confirm: true });
    expect(out.planned[0]).toMatchObject({ rent_laptop: true });
    expect(out.verified).toBe(true);
  });

  it("reports a key that the portal refuses to send", async () => {
    const { s } = fakePortal(STUDENTS, "ongoing", { keyFails: true });
    const out = await setClassPresence(s, 55, [{ name: "Ali", status: "present" }], { mode: "update", confirm: true });
    expect(out.key_failures?.map((f) => f.name)).toEqual(["Ali", "Budi"]);
    expect(out.verified).toBe(false);
    expect(out.mismatches).toContainEqual({ row_id: 101, name: "Ali", expected: "key sent", found: "key not sent" });
  });

  it("refuses a dropped (cancelled) class", async () => {
    const { s, writes } = fakePortal(STUDENTS, "drop");
    await expect(setClassPresence(s, 55, [{ name: "Ali", status: "present" }], { mode: "start", confirm: true })).rejects.toThrow(/drop/);
    expect(writes).toHaveLength(0);
  });

  it("reports a mismatch when the portal does not keep the change", async () => {
    const { s } = fakePortal(STUDENTS, "ongoing");
    (s as any).apiSend = async () => ({ status: 200, body: {} });
    const out = await setClassPresence(s, 55, [{ name: "Ali", status: "present" }], { mode: "update", confirm: true });
    expect(out.verified).toBe(false);
    expect(out.mismatches?.[0]).toMatchObject({ name: "Ali", expected: "present", found: "absent" });
  });

  it("reports when start did not make the class ongoing", async () => {
    const { s } = fakePortal(STUDENTS, "active", { saveSendsKeys: true });
    const real = (s as any).apiSend;
    (s as any).apiSend = async (m: string, p: string, b: any) => (p.endsWith("/start") ? { status: 200, body: {} } : real(m, p, b));
    const out = await setClassPresence(s, 55, [{ name: "Ali", status: "present" }], { mode: "start", confirm: true });
    expect(out.class_started).toBe(false);
    expect(out.verified).toBe(false);
  });
});

describe("finishClass", () => {
  it("previews without sending, then finishes and verifies", async () => {
    const { s, writes } = fakePortal(STUDENTS, "ongoing");
    const pre = await finishClass(s, 55, false);
    expect(pre).toMatchObject({ sent: false, present: 2, absent: 2, present_without_key: ["Budi"] });
    expect(writes).toHaveLength(0);
    const out = await finishClass(s, 55, true);
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(["POST /api/cms/attendance/55/finish"]);
    expect(out).toMatchObject({ sent: true, verified: true, class_status: "finish" });
  });

  it("refuses a finished or dropped class", async () => {
    await expect(finishClass(fakePortal(STUDENTS, "finish").s, 55, true)).rejects.toThrow(/already finished/);
    await expect(finishClass(fakePortal(STUDENTS, "drop").s, 55, true)).rejects.toThrow(/drop/);
  });
});
