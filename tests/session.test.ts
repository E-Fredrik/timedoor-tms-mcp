import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoginError, parseTokenResponse, TmsSession, type SessionConfig } from "../src/session.js";

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };

/** A fake portal. `routes` decides the answer for each call. */
function fakePortal(routes: (c: Call, n: number) => { status: number; body: unknown } | undefined) {
  const calls: Call[] = [];
  const f = async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: any = init.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { /* keep */ }
    }
    const c = { url, method: String(init.method ?? "GET"), headers, body };
    calls.push(c);
    const r = routes(c, calls.length) ?? { status: 404, body: { message: "no route" } };
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  };
  return { f, calls };
}

const LOGIN_OK = {
  status: 200,
  body: { access_token: "AT1", refresh_token: "RT1", ws_token: "WS", user: { id: 1001, name: "Test Teacher", detail: { roles: ["teacher"], branches: [{ id: 367 }] } } },
};

let dirs: string[] = [];
async function cfg(over: Partial<SessionConfig> = {}): Promise<SessionConfig> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "tms-sess-"));
  dirs.push(d);
  return { username: "teacher.user", password: "Sup3rSecret!", baseUrl: "https://x.test", headless: true, sessionFile: path.join(d, "sub", "session.json"), ...over };
}
afterEach(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  dirs = [];
});

describe("parseTokenResponse", () => {
  it("reads a flat answer", () => {
    expect(parseTokenResponse({ access_token: "a", refresh_token: "r", user: { id: 1 } })).toEqual({ accessToken: "a", refreshToken: "r", user: { id: 1 } });
  });
  it("reads a {data} wrapped answer", () => {
    expect(parseTokenResponse({ data: { access_token: "a" } }).accessToken).toBe("a");
  });
  it("treats empty, null and non string tokens as missing", () => {
    expect(parseTokenResponse(null).accessToken).toBeUndefined();
    expect(parseTokenResponse({ access_token: "" }).accessToken).toBeUndefined();
    expect(parseTokenResponse({ access_token: 123 }).accessToken).toBeUndefined();
    expect(parseTokenResponse("<html>").accessToken).toBeUndefined();
  });
});

describe("TmsSession login without a browser", () => {
  it("logs in with the API, saves an owner only session file, and sends the bearer token", async () => {
    const c = await cfg();
    const p = fakePortal((x) => (x.url.endsWith("/api/tms/auth/login") ? LOGIN_OK : x.url.includes("/api/tms/class") ? { status: 200, body: { data: [] } } : undefined));
    const s = new TmsSession(c, p.f);
    const r = await s.api("/api/tms/class", { limit: 5 });
    expect(r.status).toBe(200);
    expect(p.calls[0].body).toEqual({ username: "teacher.user", password: "Sup3rSecret!" });
    expect(p.calls[1].headers.authorization).toBe("Bearer AT1");
    expect(p.calls[1].url).toBe("https://x.test/api/tms/class?limit=5");
    const st = await fs.stat(c.sessionFile);
    expect(st.mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await fs.readFile(c.sessionFile, "utf8"));
    expect(saved).toMatchObject({ username: "teacher.user", accessToken: "AT1", refreshToken: "RT1", userId: 1001, branchIds: [367] });
    expect(JSON.stringify(saved)).not.toContain("Sup3rSecret!");
    expect(s.lastAuth).toBe("password login");
  });

  it("reuses the saved session after a restart without logging in again", async () => {
    const c = await cfg();
    const p1 = fakePortal((x) => (x.url.endsWith("/auth/login") ? LOGIN_OK : { status: 200, body: {} }));
    await new TmsSession(c, p1.f).api("/api/tms/profile");
    const p2 = fakePortal(() => ({ status: 200, body: {} }));
    const s2 = new TmsSession(c, p2.f);
    await s2.api("/api/tms/profile");
    expect(p2.calls.some((x) => x.url.endsWith("/auth/login"))).toBe(false);
    expect(p2.calls[0].headers.authorization).toBe("Bearer AT1");
    expect(s2.lastAuth).toBe("saved session");
  });

  it("on 401 uses the refresh token, saves the new tokens, and retries once", async () => {
    const c = await cfg();
    await fs.mkdir(path.dirname(c.sessionFile), { recursive: true });
    await fs.writeFile(c.sessionFile, JSON.stringify({ baseUrl: c.baseUrl, username: c.username, accessToken: "OLD", refreshToken: "RT1", savedAt: "x" }));
    const p = fakePortal((x) => {
      if (x.url.endsWith("/api/auth/refresh-token")) return { status: 200, body: { data: { access_token: "NEW", refresh_token: "RT2" } } };
      return x.headers.authorization === "Bearer NEW" ? { status: 200, body: { ok: 1 } } : { status: 401, body: {} };
    });
    const s = new TmsSession(c, p.f);
    const r = await s.api("/api/tms/profile");
    expect(r.status).toBe(200);
    expect(p.calls.map((x) => x.url.replace("https://x.test", ""))).toEqual(["/api/tms/profile", "/api/auth/refresh-token", "/api/tms/profile"]);
    expect(p.calls[1].body).toEqual({ refresh_token: "RT1" });
    const saved = JSON.parse(await fs.readFile(c.sessionFile, "utf8"));
    expect(saved.accessToken).toBe("NEW");
    expect(saved.refreshToken).toBe("RT2");
    expect(s.lastAuth).toBe("refreshed");
  });

  it("keeps the old refresh token when the refresh answer has no new one", async () => {
    const c = await cfg();
    await fs.mkdir(path.dirname(c.sessionFile), { recursive: true });
    await fs.writeFile(c.sessionFile, JSON.stringify({ baseUrl: c.baseUrl, username: c.username, accessToken: "OLD", refreshToken: "RT1", savedAt: "x" }));
    const p = fakePortal((x) => (x.url.endsWith("/refresh-token") ? { status: 200, body: { data: { access_token: "NEW" } } } : x.headers.authorization === "Bearer NEW" ? { status: 200, body: {} } : { status: 401, body: {} }));
    await new TmsSession(c, p.f).api("/api/tms/profile");
    expect(JSON.parse(await fs.readFile(c.sessionFile, "utf8")).refreshToken).toBe("RT1");
  });

  it("falls back to the password when the refresh token is dead", async () => {
    const c = await cfg();
    await fs.mkdir(path.dirname(c.sessionFile), { recursive: true });
    await fs.writeFile(c.sessionFile, JSON.stringify({ baseUrl: c.baseUrl, username: c.username, accessToken: "OLD", refreshToken: "DEAD", savedAt: "x" }));
    const p = fakePortal((x) => {
      if (x.url.endsWith("/refresh-token")) return { status: 401, body: { message: "expired" } };
      if (x.url.endsWith("/auth/login")) return LOGIN_OK;
      return x.headers.authorization === "Bearer AT1" ? { status: 200, body: {} } : { status: 401, body: {} };
    });
    const s = new TmsSession(c, p.f);
    expect((await s.api("/api/tms/profile")).status).toBe(200);
    expect(s.lastAuth).toBe("password login");
  });

  it("falls back to the password when there is no refresh token at all", async () => {
    const c = await cfg();
    await fs.mkdir(path.dirname(c.sessionFile), { recursive: true });
    await fs.writeFile(c.sessionFile, JSON.stringify({ baseUrl: c.baseUrl, username: c.username, accessToken: "OLD", savedAt: "x" }));
    const p = fakePortal((x) => (x.url.endsWith("/auth/login") ? LOGIN_OK : x.headers.authorization === "Bearer AT1" ? { status: 200, body: {} } : { status: 401, body: {} }));
    expect((await new TmsSession(c, p.f).api("/api/x")).status).toBe(200);
    expect(p.calls.some((x) => x.url.endsWith("/refresh-token"))).toBe(false);
  });

  it("wrong password: clear LoginError, and no password or username in the message", async () => {
    const c = await cfg();
    const p = fakePortal(() => ({ status: 401, body: { message: "Invalid credentials for teacher.user / Sup3rSecret!" } }));
    const s = new TmsSession(c, p.f);
    let err: Error | undefined;
    try { await s.api("/api/tms/profile"); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(LoginError);
    expect(err!.message).toMatch(/Login failed \(status 401\)/);
    expect(err!.message).not.toContain("Sup3rSecret!");
    expect(err!.message).not.toContain("teacher.user");
    await expect(fs.stat(c.sessionFile)).rejects.toThrow();
  });

  it("a 200 login answer without a token is still a failure", async () => {
    const c = await cfg();
    const p = fakePortal(() => ({ status: 200, body: { data: { message: "otp required" } } }));
    await expect(new TmsSession(c, p.f).api("/api/x")).rejects.toThrow(/Login failed \(status 200\)/);
  });

  it("refuses a non teacher account", async () => {
    const c = await cfg();
    const p = fakePortal(() => ({ status: 200, body: { access_token: "A", user: { detail: { roles: ["admin"] } } } }));
    await expect(new TmsSession(c, p.f).api("/api/x")).rejects.toThrow(/not a teacher account/);
  });

  it("network failure while logging in: LoginError without secrets", async () => {
    const c = await cfg();
    const s = new TmsSession(c, async () => { throw new Error("ECONNRESET talking as teacher.user"); });
    let err: Error | undefined;
    try { await s.api("/api/x"); } catch (e) { err = e as Error; }
    expect(err!.name).toBe("LoginError");
    expect(err!.message).toMatch(/Could not reach the portal/);
    expect(err!.message).not.toContain("teacher.user");
  });

  it("ignores a corrupted session file and logs in fresh", async () => {
    const c = await cfg();
    await fs.mkdir(path.dirname(c.sessionFile), { recursive: true });
    await fs.writeFile(c.sessionFile, "{not json");
    const p = fakePortal((x) => (x.url.endsWith("/auth/login") ? LOGIN_OK : { status: 200, body: {} }));
    await new TmsSession(c, p.f).api("/api/x");
    expect(p.calls[0].url).toMatch(/auth\/login$/);
  });

  it("ignores a saved session for a different account or site", async () => {
    for (const other of [{ username: "someone.else" }, { baseUrl: "https://evil.test" }]) {
      const c = await cfg();
      await fs.mkdir(path.dirname(c.sessionFile), { recursive: true });
      await fs.writeFile(c.sessionFile, JSON.stringify({ baseUrl: c.baseUrl, username: c.username, accessToken: "FOREIGN", savedAt: "x", ...other }));
      const p = fakePortal((x) => (x.url.endsWith("/auth/login") ? LOGIN_OK : { status: 200, body: {} }));
      await new TmsSession(c, p.f).api("/api/x");
      expect(p.calls[0].url).toMatch(/auth\/login$/);
      expect(p.calls.some((x) => x.headers.authorization === "Bearer FOREIGN")).toBe(false);
    }
  });

  it("two calls that both get a 401 share one refresh", async () => {
    const c = await cfg();
    await fs.mkdir(path.dirname(c.sessionFile), { recursive: true });
    await fs.writeFile(c.sessionFile, JSON.stringify({ baseUrl: c.baseUrl, username: c.username, accessToken: "OLD", refreshToken: "RT1", savedAt: "x" }));
    const p = fakePortal((x) => (x.url.endsWith("/refresh-token") ? { status: 200, body: { access_token: "NEW" } } : x.headers.authorization === "Bearer NEW" ? { status: 200, body: {} } : { status: 401, body: {} }));
    const s = new TmsSession(c, p.f);
    const [a, b] = await Promise.all([s.api("/api/a"), s.api("/api/b")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(p.calls.filter((x) => x.url.endsWith("/refresh-token"))).toHaveLength(1);
  });

  it("a 401 that survives re-auth is returned, not retried forever", async () => {
    const c = await cfg();
    const p = fakePortal((x) => (x.url.endsWith("/auth/login") ? LOGIN_OK : { status: 401, body: {} }));
    const r = await new TmsSession(c, p.f).api("/api/x");
    expect(r.status).toBe(401);
    expect(p.calls.filter((x) => !x.url.includes("/auth/")).length).toBe(2);
  });

  it("apiSend sends JSON or multipart form, PATCH included", async () => {
    const c = await cfg();
    const p = fakePortal((x) => (x.url.endsWith("/auth/login") ? LOGIN_OK : { status: 200, body: { ok: true } }));
    const s = new TmsSession(c, p.f);
    await s.apiSend("PATCH", "/api/v2/x", { json: { status: "approved" } });
    const j = p.calls.at(-1)!;
    expect(j.method).toBe("PATCH");
    expect(j.body).toEqual({ status: "approved" });
    expect(j.headers["content-type"]).toBe("application/json");
    await s.apiSend("POST", "/api/y", { form: { a: "1", b: "[2]" } });
    const fcall = p.calls.at(-1)!;
    expect(fcall.body instanceof FormData).toBe(true);
    expect((fcall.body as FormData).get("b")).toBe("[2]");
    expect(fcall.headers["content-type"]).toBeUndefined();
  });

  it("keeps non JSON answers as text", async () => {
    const c = await cfg();
    const p = fakePortal((x) => (x.url.endsWith("/auth/login") ? LOGIN_OK : { status: 502, body: "<html>Bad gateway</html>" }));
    const r = await new TmsSession(c, p.f).api("/api/x");
    expect(r).toEqual({ status: 502, body: "<html>Bad gateway</html>" });
  });

  it("forget() deletes the file and the next call logs in again", async () => {
    const c = await cfg();
    const p = fakePortal((x) => (x.url.endsWith("/auth/login") ? LOGIN_OK : { status: 200, body: {} }));
    const s = new TmsSession(c, p.f);
    await s.api("/api/x");
    await s.forget();
    await expect(fs.stat(c.sessionFile)).rejects.toThrow();
    await s.api("/api/x");
    expect(p.calls.filter((x) => x.url.endsWith("/auth/login"))).toHaveLength(2);
  });

  it("two calls at a fresh start share one password login", async () => {
    const c = await cfg();
    const p = fakePortal((x) => (x.url.endsWith("/auth/login") ? LOGIN_OK : { status: 200, body: {} }));
    const s = new TmsSession(c, p.f);
    await Promise.all([s.api("/api/a"), s.api("/api/b"), s.api("/api/c")]);
    expect(p.calls.filter((x) => x.url.endsWith("/auth/login"))).toHaveLength(1);
  });

  it("a failed login can be retried later (the shared promise is cleared)", async () => {
    const c = await cfg();
    let n = 0;
    const p = fakePortal((x) => (x.url.endsWith("/auth/login") ? (++n === 1 ? { status: 500, body: {} } : LOGIN_OK) : { status: 200, body: {} }));
    const s = new TmsSession(c, p.f);
    await expect(s.api("/api/a")).rejects.toThrow(/status 500/);
    expect((await s.api("/api/a")).status).toBe(200);
  });

  it("safeText hides the tokens too", async () => {
    const c = await cfg();
    const p = fakePortal((x) => (x.url.endsWith("/auth/login") ? LOGIN_OK : { status: 200, body: {} }));
    const s = new TmsSession(c, p.f);
    await s.api("/api/x");
    expect(s.safeText("token AT1 and RT1 and Sup3rSecret!")).not.toMatch(/AT1|RT1|Sup3rSecret!/);
  });

  it("browser cookies match what the portal sets (single and multi branch)", async () => {
    const c = await cfg();
    const p = fakePortal((x) => (x.url.endsWith("/auth/login") ? LOGIN_OK : { status: 200, body: {} }));
    const s = new TmsSession(c, p.f);
    await s.api("/api/x");
    const one = Object.fromEntries(s.browserCookies().map((k) => [k.name, k.value]));
    expect(one).toEqual({ access_token: "AT1", refresh_token: "RT1", "timedoorAcademy-appBranch": "367", "timedoorAcademy-allBranch": "%22367%22" });
    const p2 = fakePortal((x) => (x.url.endsWith("/auth/login") ? { status: 200, body: { access_token: "A", user: { detail: { roles: ["teacher"], branches: [{ id: 1 }, { id: 2 }] } } } } : { status: 200, body: {} }));
    const s2 = new TmsSession(await cfg(), p2.f);
    await s2.api("/api/x");
    const two = Object.fromEntries(s2.browserCookies().map((k) => [k.name, k.value]));
    expect(two["timedoorAcademy-appBranch"]).toBe("*");
    expect(two["timedoorAcademy-allBranch"]).toBe("%221%2C2%22");
    expect(two.refresh_token).toBeUndefined();
  });
});
