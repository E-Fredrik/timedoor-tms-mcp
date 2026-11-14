import { describe, expect, it } from "vitest";
import { filterStudentsByName, findStudentsByName } from "../src/students.js";
import type { TmsSession } from "../src/session.js";

const ROWS = [
  { id: 1, name: "Ali Rahman", code: "STD1", status: "active" },
  { id: 2, name: "Siti  Ali", code: "STD2", status: "active" },
  { id: 3, name: "Budi Santoso", code: "STD3", status: "inactive" },
];

describe("filterStudentsByName", () => {
  it("matches part of a name, ignoring case and extra spaces", () => {
    expect(filterStudentsByName(ROWS, "ALI").map((r) => r.id)).toEqual([1, 2]);
    expect(filterStudentsByName(ROWS, "  siti ali ").map((r) => r.id)).toEqual([2]);
  });

  it("returns nothing for an unknown name", () => {
    expect(filterStudentsByName(ROWS, "zed")).toEqual([]);
  });
});

function fakeSession(rows: any[], detailStatus = 200) {
  const calls: string[] = [];
  const s = {
    api: async (path: string, q?: Record<string, unknown>) => {
      calls.push(path);
      if (path === "/api/tms/student") return { status: 200, body: { data: rows, meta: { last_page: 1 } } };
      if (path.startsWith("/api/tms/student/")) return { status: detailStatus, body: { data: { id: Number(path.split("/").pop()), note: "detail" } } };
      throw new Error("unexpected " + path);
    },
  } as unknown as TmsSession;
  return { s, calls };
}

describe("findStudentsByName", () => {
  it("returns matches with details and filters loose portal matches out", async () => {
    const { s, calls } = fakeSession([...ROWS]);
    const out = await findStudentsByName(s, "ali");
    expect(out.total_matches).toBe(2);
    expect(out.matches.map((m) => m.id)).toEqual([1, 2]);
    expect(out.matches[0].detail).toEqual({ data: { id: 1, note: "detail" } });
    expect(calls).toContain("/api/tms/student/2");
  });

  it("caps detail calls and says so", async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `Test ${i}`, code: "X", status: "active" }));
    const { s, calls } = fakeSession(many);
    const out = await findStudentsByName(s, "test", { maxDetails: 5 });
    expect(out.total_matches).toBe(7);
    expect(calls.filter((c) => c.startsWith("/api/tms/student/")).length).toBe(5);
    expect(out.matches[6].detail).toBeUndefined();
    expect(out.notes.join(" ")).toMatch(/first 5/);
  });

  it("reports no match with a note", async () => {
    const { s } = fakeSession(ROWS);
    const out = await findStudentsByName(s, "zed");
    expect(out.total_matches).toBe(0);
    expect(out.notes[0]).toMatch(/No student/);
  });

  it("records a detail error without failing the search", async () => {
    const { s } = fakeSession(ROWS, 500);
    const out = await findStudentsByName(s, "budi");
    expect(out.matches[0].detail_error).toBe("status 500");
  });
});
