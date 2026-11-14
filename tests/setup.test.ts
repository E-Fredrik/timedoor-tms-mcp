import { describe, expect, it } from "vitest";
import { parseEnv } from "node:util";
// @ts-expect-error plain JS module without types
import { claudeDesktopConfigPath, envFileContent, mergeServerConfig, timestamp } from "../scripts/lib.mjs";

const entry = { command: "/usr/bin/node", args: ["/x/dist/index.js"] };

describe("mergeServerConfig", () => {
  it("creates a config from nothing", () => {
    const out = JSON.parse(mergeServerConfig("", "timedoor-tms", entry));
    expect(out).toEqual({ mcpServers: { "timedoor-tms": entry } });
  });
  it("keeps other servers and other top level settings untouched", () => {
    const existing = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } });
    const out = JSON.parse(mergeServerConfig(existing, "timedoor-tms", entry));
    expect(out.theme).toBe("dark");
    expect(out.mcpServers.other).toEqual({ command: "x" });
    expect(out.mcpServers["timedoor-tms"]).toEqual(entry);
  });
  it("replaces an older entry of the same name and is idempotent", () => {
    const once = mergeServerConfig("", "timedoor-tms", { command: "old" });
    const twice = mergeServerConfig(once, "timedoor-tms", entry);
    expect(JSON.parse(twice).mcpServers["timedoor-tms"]).toEqual(entry);
    expect(mergeServerConfig(twice, "timedoor-tms", entry)).toBe(twice);
  });
  it("refuses invalid JSON, arrays, null and a bad mcpServers value without altering anything", () => {
    for (const bad of ["{ not json", "[]", "null", '{"mcpServers": []}', '{"mcpServers": null}', '{"mcpServers": 5}']) {
      expect(() => mergeServerConfig(bad, "timedoor-tms", entry)).toThrow(/did not change/);
    }
  });
  it("treats whitespace only as empty", () => {
    expect(JSON.parse(mergeServerConfig("  \n", "a", entry)).mcpServers.a).toEqual(entry);
  });
});

describe("claudeDesktopConfigPath", () => {
  it("uses the right place per OS", () => {
    expect(claudeDesktopConfigPath("darwin", {}, "/Users/x")).toBe("/Users/x/Library/Application Support/Claude/claude_desktop_config.json");
    expect(claudeDesktopConfigPath("linux", {}, "/home/x")).toBe("/home/x/.config/Claude/claude_desktop_config.json");
    expect(claudeDesktopConfigPath("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/x")).toBe("/cfg/Claude/claude_desktop_config.json");
    expect(claudeDesktopConfigPath("win32", { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "C:\\Users\\x")).toMatch(/Claude.claude_desktop_config\.json$/);
  });
});

describe("envFileContent round trip through Node's own .env parser", () => {
  const roundTrip = (user: string, pass: string) => {
    const parsed = parseEnv(envFileContent(user, pass));
    expect(parsed.TMS_USERNAME).toBe(user);
    expect(parsed.TMS_PASSWORD).toBe(pass);
  };
  it("plain values", () => roundTrip("TCR00000000000", "TCR00000000000"));
  it("values with spaces, hash, dollar, backslash and double quotes", () => {
    roundTrip("user", "pa ss#word");
    roundTrip("user", "pa$$w0rd");
    roundTrip("user", "back\\slash");
    roundTrip("user", 'say "hi"');
  });
  it("a value containing a single quote", () => roundTrip("user", "it's-fine"));
  it("rejects line breaks and empty values, and refuses unsafe mixes instead of corrupting", () => {
    expect(() => envFileContent("user", "a\nb")).toThrow();
    expect(() => envFileContent("", "x")).toThrow();
    expect(() => envFileContent("user", "")).toThrow();
    expect(() => envFileContent("user", `both ' and " and $`)).toThrow(/mixes quote/);
  });
  it("error messages never contain the password", () => {
    try {
      envFileContent("user", `S3cret' and " and $`);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("S3cret");
    }
  });
});

describe("timestamp", () => {
  it("formats as YYYYMMDD-HHMMSS", () => {
    expect(timestamp(new Date(2026, 9, 24, 9, 5, 7))).toBe("20261024-090507");
  });
});
