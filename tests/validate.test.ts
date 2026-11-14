import { describe, expect, it } from "vitest";
import {
  clampInt,
  dateRange,
  isoDate,
  optionalText,
  positiveInt,
  redact,
  teacherNotes,
  ValidationError,
} from "../src/validate.js";
import { parseDraftInput, parseMeetingRef } from "../src/journal.js";
import { loadConfig, ConfigError } from "../src/session.js";

describe("teacherNotes", () => {
  it("accepts normal text and trims it", () => {
    expect(teacherNotes("  Good progress today.  ")).toBe("Good progress today.");
  });
  it("accepts exactly 200 characters", () => {
    expect(teacherNotes("a".repeat(200))).toHaveLength(200);
  });
  it("rejects 201 characters and says by how much", () => {
    expect(() => teacherNotes("a".repeat(201))).toThrow(/Shorten it by 1/);
  });
  it("rejects empty and whitespace only", () => {
    expect(() => teacherNotes("")).toThrow(ValidationError);
    expect(() => teacherNotes("   \n\t ")).toThrow(ValidationError);
  });
  it("rejects non strings", () => {
    for (const v of [undefined, null, 5, {}, []]) expect(() => teacherNotes(v)).toThrow(ValidationError);
  });
  it("rejects control characters but allows newlines", () => {
    expect(() => teacherNotes("bad\u0000text")).toThrow(ValidationError);
    expect(teacherNotes("line one\nline two")).toBe("line one\nline two");
  });
  it("counts length like the browser (UTF-16 units), so an emoji counts as 2", () => {
    expect(() => teacherNotes("😀".repeat(101))).toThrow(ValidationError); // 202 units
    expect(teacherNotes("😀".repeat(100))).toHaveLength(200);
  });
});

describe("positiveInt", () => {
  it("accepts positive whole numbers", () => expect(positiveInt("x", 31807)).toBe(31807));
  it("rejects zero, negatives, floats, NaN, Infinity, strings, unsafe ints", () => {
    for (const v of [0, -1, 1.5, NaN, Infinity, "12", null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => positiveInt("x", v)).toThrow(/positive whole number/);
    }
  });
});

describe("dates", () => {
  it("accepts real dates including leap day", () => {
    expect(isoDate("d", "2028-02-29")).toBe("2028-02-29");
    expect(isoDate("d", "2026-10-24")).toBe("2026-10-24");
  });
  it("rejects impossible dates", () => {
    for (const v of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31"]) {
      expect(() => isoDate("d", v)).toThrow(/real calendar date/);
    }
  });
  it("rejects wrong formats", () => {
    for (const v of ["2026-1-1", "24/10/2026", "2026-10-24T00:00:00Z", "", " 2026-10-24", 20261024, null]) {
      expect(() => isoDate("d", v)).toThrow(ValidationError);
    }
  });
  it("range: same day ok, reversed rejected", () => {
    expect(dateRange("2026-10-01", "2026-10-01")).toEqual({ from: "2026-10-01", until: "2026-10-01" });
    expect(() => dateRange("2026-10-02", "2026-10-01")).toThrow(/on or before/);
  });
});

describe("clampInt", () => {
  it("defaults when missing", () => expect(clampInt("limit", undefined)).toBe(20));
  it("clamps low and high", () => {
    expect(clampInt("limit", 0)).toBe(1);
    expect(clampInt("limit", -50)).toBe(1);
    expect(clampInt("limit", 100000)).toBe(100);
  });
  it("floors floats", () => expect(clampInt("limit", 7.9)).toBe(7));
  it("rejects NaN, Infinity and strings", () => {
    for (const v of [NaN, Infinity, "5"]) expect(() => clampInt("limit", v)).toThrow(ValidationError);
  });
});

describe("optionalText", () => {
  it("returns undefined for missing or blank", () => {
    expect(optionalText("p", undefined)).toBeUndefined();
    expect(optionalText("p", null)).toBeUndefined();
    expect(optionalText("p", "   ")).toBeUndefined();
  });
  it("rejects too long and non strings", () => {
    expect(() => optionalText("p", "x".repeat(201))).toThrow(ValidationError);
    expect(() => optionalText("p", 5)).toThrow(ValidationError);
  });
});

describe("redact", () => {
  it("removes every occurrence of each secret", () => {
    expect(redact("user=abc pass=abc and abc", ["abc"])).toBe("user=[redacted] pass=[redacted] and [redacted]");
  });
  it("ignores empty and undefined secrets without mangling text", () => {
    expect(redact("hello", ["", undefined])).toBe("hello");
  });
});

describe("journal input parsing", () => {
  const base = { student_id: 1, learning_session_id: 2, book_id: 3, meeting_id: 4, teacher_notes: "ok" };
  it("parses a valid draft request with safe defaults", () => {
    const d = parseDraftInput(base);
    expect(d.dryRun).toBe(false);
    expect(d.overwriteExisting).toBe(false);
    expect(d.ref).toEqual({ studentId: 1, sessionId: 2, bookId: 3, meetingId: 4 });
  });
  it("only treats literal true as dry_run or overwrite", () => {
    const d = parseDraftInput({ ...base, dry_run: "true", overwrite_existing: 1 });
    expect(d.dryRun).toBe(false);
    expect(d.overwriteExisting).toBe(false);
  });
  it("rejects bad ids, long notes and non boolean active_project", () => {
    expect(() => parseDraftInput({ ...base, student_id: 0 })).toThrow(ValidationError);
    expect(() => parseDraftInput({ ...base, teacher_notes: "x".repeat(300) })).toThrow(ValidationError);
    expect(() => parseDraftInput({ ...base, active_project: "yes" })).toThrow(ValidationError);
  });
  it("parseMeetingRef rejects missing ids", () => {
    expect(() => parseMeetingRef({ student_id: 1, learning_session_id: 2, book_id: 3, meeting_id: undefined })).toThrow(ValidationError);
  });
});

describe("loadConfig", () => {
  it("fails clearly when credentials are missing, without leaking anything", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ TMS_USERNAME: "u" })).toThrow(/TMS_PASSWORD/);
    expect(() => loadConfig({ TMS_PASSWORD: "p" })).toThrow(/TMS_USERNAME/);
  });
  it("treats empty strings as missing", () => {
    expect(() => loadConfig({ TMS_USERNAME: "", TMS_PASSWORD: "" })).toThrow(ConfigError);
  });
  it("error text never contains the password value", () => {
    try {
      loadConfig({ TMS_USERNAME: "someuser", TMS_PASSWORD: "s3cretvalue", TMS_BASE_URL: "http://insecure" });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("s3cretvalue");
    }
  });
  it("refuses a non https base url", () => {
    expect(() => loadConfig({ TMS_USERNAME: "u", TMS_PASSWORD: "p", TMS_BASE_URL: "http://x.test" })).toThrow(/https/);
  });
  it("strips trailing slashes and defaults to headless", () => {
    const c = loadConfig({ TMS_USERNAME: "u", TMS_PASSWORD: "p", TMS_BASE_URL: "https://x.test///" });
    expect(c.baseUrl).toBe("https://x.test");
    expect(c.headless).toBe(true);
  });
});
