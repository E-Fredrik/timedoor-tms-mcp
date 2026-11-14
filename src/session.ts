import type { Browser, BrowserContext, Page } from "playwright";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { API, DEFAULT_BASE_URL, PATHS, TIMEOUTS } from "./config.js";
import { redact } from "./validate.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}
export class ApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

export interface SessionConfig {
  username: string;
  password: string;
  baseUrl: string;
  headless: boolean;
  /** Where the login tokens are kept between restarts (owner only file). */
  sessionFile: string;
}

export function defaultSessionFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.TMS_SESSION_FILE?.trim() || path.join(homedir(), ".config", "timedoor-tms-mcp", "session.json");
}

/** Reads credentials from the environment. Never echoes their values in errors. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SessionConfig {
  const username = env.TMS_USERNAME?.trim();
  const password = env.TMS_PASSWORD;
  const missing: string[] = [];
  if (!username) missing.push("TMS_USERNAME");
  if (!password) missing.push("TMS_PASSWORD");
  if (missing.length) {
    throw new ConfigError(
      `Missing ${missing.join(" and ")}. Copy .env.example to .env in the project folder and fill it in, then restart the MCP server.`,
    );
  }
  const baseUrl = (env.TMS_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!/^https:\/\//.test(baseUrl)) throw new ConfigError("TMS_BASE_URL must start with https://");
  return {
    username: username!,
    password: password!,
    baseUrl,
    headless: env.TMS_HEADLESS?.toLowerCase() !== "false",
    sessionFile: defaultSessionFile(env),
  };
}

/** What is saved to the session file. Tokens only; the password is never written here. */
export interface StoredSession {
  baseUrl: string;
  username: string;
  accessToken: string;
  refreshToken?: string;
  userId?: number;
  name?: string;
  branchIds?: number[];
  savedAt: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

type Query = Record<string, string | number | boolean | Array<string | number> | undefined>;
type AuthVia = "saved session" | "refreshed" | "password login";

/** Pulls the token fields out of a login or refresh response. The portal wraps some answers in {data}. */
export function parseTokenResponse(body: unknown): { accessToken?: string; refreshToken?: string; user?: Record<string, any> } {
  const b = (body ?? {}) as Record<string, any>;
  const d = (b.data && typeof b.data === "object" ? b.data : b) as Record<string, any>;
  const accessToken = typeof d.access_token === "string" && d.access_token ? d.access_token : undefined;
  const refreshToken = typeof d.refresh_token === "string" && d.refresh_token ? d.refresh_token : undefined;
  const user = d.user && typeof d.user === "object" ? (d.user as Record<string, any>) : undefined;
  return { accessToken, refreshToken, user };
}

function branchIdsOf(user: Record<string, any> | undefined): number[] | undefined {
  const list = user?.detail?.branches ?? user?.branches;
  if (!Array.isArray(list)) return undefined;
  const ids = list.map((b: any) => Number(b?.id)).filter((n: number) => Number.isInteger(n) && n > 0);
  return ids.length ? ids : undefined;
}

export class TmsSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private stored?: StoredSession;
  private loading?: Promise<void>;
  private refreshing?: Promise<boolean>;
  private loggingIn?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private browserReady = false;
  /** How the current tokens were obtained, for tms_auth_status. */
  lastAuth?: AuthVia;

  constructor(
    private readonly cfg: SessionConfig,
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {}

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  get sessionFile(): string {
    return this.cfg.sessionFile;
  }

  /** The logged in user's numeric id from the login response, when the portal gave one. */
  get userId(): number | undefined {
    return this.stored?.userId;
  }

  private scrub(text: string): string {
    return redact(text, [this.cfg.password, this.cfg.username, this.stored?.accessToken, this.stored?.refreshToken]);
  }

  /** Runs jobs one at a time so two tool calls can never drive the same page at once. */
  run<T>(job: () => Promise<T>): Promise<T> {
    const p = this.queue.then(async () => {
      try {
        return await job();
      } finally {
        await this.syncTokensFromBrowser().catch(() => undefined);
      }
    });
    this.queue = p.catch(() => undefined);
    return p;
  }

  // ---------- token storage ----------

  /** Loads the saved session once. Concurrent callers wait for the same read, so none of them logs in early. */
  private loadStored(): Promise<void> {
    if (!this.loading) this.loading = this.readStored();
    return this.loading;
  }

  private async readStored(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.cfg.sessionFile, "utf8")) as Partial<StoredSession>;
      // A file for another account or another site is ignored, never used.
      if (
        raw &&
        typeof raw.accessToken === "string" &&
        raw.accessToken &&
        raw.username === this.cfg.username &&
        raw.baseUrl === this.cfg.baseUrl
      ) {
        this.stored = raw as StoredSession;
        this.lastAuth = "saved session";
      }
    } catch {
      /* no file, or unreadable: log in fresh */
    }
  }

  private async saveStored(): Promise<void> {
    if (!this.stored) return;
    const dir = path.dirname(this.cfg.sessionFile);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(this.cfg.sessionFile, JSON.stringify(this.stored, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(this.cfg.sessionFile, 0o600).catch(() => undefined);
  }

  /** Deletes the saved session file and forgets the tokens. The next call logs in with the password again. */
  async forget(): Promise<void> {
    this.stored = undefined;
    this.lastAuth = undefined;
    await rm(this.cfg.sessionFile, { force: true });
    await this.closeBrowser();
  }

  // ---------- login and refresh (plain HTTPS API calls, no browser) ----------

  private async postJson(pathname: string, body: unknown): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.cfg.baseUrl + pathname, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUTS.login),
      });
    } catch (e) {
      throw new LoginError(`Could not reach the portal: ${this.scrub(String((e as Error).message)).slice(0, 200)}`);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: res.status, body: parsed };
  }

  /** Username and password login through the teacher login API. Single flight: concurrent callers share one login. */
  async passwordLogin(): Promise<void> {
    if (this.loggingIn) return this.loggingIn;
    this.loggingIn = (async () => {
      const r = await this.postJson(API.teacherLogin, { username: this.cfg.username, password: this.cfg.password });
      const t = parseTokenResponse(r.body);
      if (r.status < 200 || r.status >= 300 || !t.accessToken) {
        const msg = (r.body as any)?.message ?? (r.body as any)?.data?.message;
        throw new LoginError(
          `Login failed (status ${r.status}). Check TMS_USERNAME and TMS_PASSWORD, and that the account is not locked.` +
            (typeof msg === "string" && msg ? ` Site message: ${this.scrub(msg).slice(0, 200)}` : ""),
        );
      }
      const roles = t.user?.detail?.roles ?? t.user?.roles;
      if (Array.isArray(roles) && roles.length && roles[0] !== "teacher") {
        throw new LoginError("This account logged in, but it is not a teacher account, so the teacher portal will refuse it.");
      }
      this.stored = {
        baseUrl: this.cfg.baseUrl,
        username: this.cfg.username,
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        userId: Number.isInteger(Number(t.user?.id)) ? Number(t.user?.id) : undefined,
        name: typeof t.user?.name === "string" ? t.user.name : typeof t.user?.detail?.name === "string" ? t.user.detail.name : undefined,
        branchIds: branchIdsOf(t.user),
        savedAt: new Date().toISOString(),
      };
      this.lastAuth = "password login";
      await this.saveStored();
    })();
    try {
      await this.loggingIn;
    } finally {
      this.loggingIn = undefined;
    }
  }

  /** Swaps the refresh token for a new access token, like the portal does after a 401. False when it no longer works. */
  async refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const rt = this.stored?.refreshToken;
      if (!rt) return false;
      let r: { status: number; body: unknown };
      try {
        r = await this.postJson(API.refreshToken, { refresh_token: rt });
      } catch {
        return false;
      }
      const t = parseTokenResponse(r.body);
      if (r.status < 200 || r.status >= 300 || !t.accessToken) return false;
      this.stored = {
        ...this.stored!,
        accessToken: t.accessToken,
        refreshToken: t.refreshToken ?? this.stored!.refreshToken,
        savedAt: new Date().toISOString(),
      };
      this.lastAuth = "refreshed";
      await this.saveStored();
      return true;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  /** Makes sure there is an access token: saved file first, then the password login. */
  async ensureToken(): Promise<void> {
    await this.loadStored();
    if (!this.stored?.accessToken) await this.passwordLogin();
  }

  /** After a 401: try the refresh token, then fall back to the password. Throws when both fail. */
  private async reauth(): Promise<void> {
    if (await this.refresh()) return;
    await this.passwordLogin();
  }

  get apiReady(): boolean {
    return !!this.stored?.accessToken;
  }

  async status(): Promise<Record<string, unknown>> {
    await this.ensureToken();
    // Prove the token works with a cheap read, refreshing if needed.
    const r = await this.api(API.profile);
    const ok = r.status >= 200 && r.status < 300;
    const p = ((r.body as any)?.data ?? r.body) as Record<string, any>;
    return {
      loggedIn: ok,
      apiReady: ok,
      via: this.lastAuth,
      name: typeof p?.name === "string" ? p.name : this.stored?.name,
      session_file: this.cfg.sessionFile,
      browser_used: false,
      note: ok
        ? "Logged in through the portal's own login API. The tokens are saved to the session file (owner only) and refreshed automatically, so the password is only used again if the refresh token stops working."
        : `The portal answered the profile check with status ${r.status}.`,
    };
  }

  // ---------- API calls ----------

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.stored!.accessToken}`, accept: "application/json", ...extra };
  }

  private async send(url: string, init: RequestInit, timeout: number): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw new ApiError(`Request to the portal failed: ${this.scrub(String((e as Error).message)).slice(0, 200)}`);
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: res.status, body };
  }

  /** GET an API path with the saved token. On a 401 it refreshes (or logs in again) once and retries. */
  async api(pathname: string, query?: Query): Promise<{ status: number; body: unknown }> {
    await this.ensureToken();
    const url = new URL(this.cfg.baseUrl + pathname);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
      else url.searchParams.set(k, String(v));
    }
    const once = () => this.send(url.toString(), { method: "GET", headers: this.headers() }, TIMEOUTS.api);
    let r = await once();
    if (r.status === 401) {
      await this.reauth();
      r = await once();
    }
    return r;
  }

  /**
   * Write request (POST, PATCH or DELETE) with the saved token. JSON body or multipart form fields.
   * Retries once only after a 401, which means the server rejected the call before doing anything.
   */
  async apiSend(
    method: "POST" | "PATCH" | "DELETE",
    pathname: string,
    payload: { json?: unknown; form?: Record<string, string> },
  ): Promise<{ status: number; body: unknown }> {
    await this.ensureToken();
    const url = this.cfg.baseUrl + pathname;
    const once = () => {
      if (payload.form) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(payload.form)) fd.append(k, v);
        return this.send(url, { method, headers: this.headers(), body: fd }, TIMEOUTS.save);
      }
      return this.send(
        url,
        { method, headers: this.headers({ "content-type": "application/json" }), body: JSON.stringify(payload.json ?? {}) },
        TIMEOUTS.save,
      );
    };
    let r = await once();
    if (r.status === 401) {
      await this.reauth();
      r = await once();
    }
    return r;
  }

  // ---------- browser, only for steps that need the real page ----------

  /** The cookies the portal itself sets after login, so the page opens already signed in. */
  browserCookies(): { name: string; value: string; url: string }[] {
    const s = this.stored!;
    const url = this.cfg.baseUrl;
    const c = [
      { name: "access_token", value: s.accessToken, url },
      ...(s.refreshToken ? [{ name: "refresh_token", value: s.refreshToken, url }] : []),
    ];
    const ids = s.branchIds ?? [];
    if (ids.length === 1) c.push({ name: "timedoorAcademy-appBranch", value: String(ids[0]), url });
    else if (ids.length > 1) c.push({ name: "timedoorAcademy-appBranch", value: "*", url });
    if (ids.length) c.push({ name: "timedoorAcademy-allBranch", value: encodeURIComponent(JSON.stringify(ids.join(","))), url });
    return c;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    const { chromium } = await import("playwright");
    try {
      this.browser = await chromium.launch({ headless: this.cfg.headless });
    } catch (e) {
      throw new ConfigError(
        `Could not start the browser. Run "npx playwright install chromium" once in the project folder. Details: ${this.scrub(String((e as Error).message).slice(0, 300))}`,
      );
    }
    this.context = await this.browser.newContext({ locale: "en-US", timezoneId: "Asia/Jakarta" });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(TIMEOUTS.api);
    return this.page;
  }

  /**
   * Opens a browser page that is already signed in, by giving it the saved tokens as the portal's own cookies.
   * Only the photo upload and the Send to Parent step use this. Falls back to the login form only if the
   * tokens are refused, and then saves the new tokens.
   */
  async ensureLoggedIn(): Promise<Page> {
    await this.ensureToken();
    const page = await this.ensurePage();
    if (this.browserReady) return page;
    await this.context!.addCookies(this.browserCookies());
    await page.goto(this.cfg.baseUrl + PATHS.pendingJournalsPage, { waitUntil: "domcontentloaded" });
    const onLogin = () => /\/login\/?$/.test(new URL(page.url()).pathname);
    await page.waitForTimeout(1500);
    if (onLogin()) {
      // Saved tokens refused by the page: get fresh ones through the API and try once more.
      await this.reauth();
      await this.context!.clearCookies();
      await this.context!.addCookies(this.browserCookies());
      await page.goto(this.cfg.baseUrl + PATHS.pendingJournalsPage, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      if (onLogin()) throw new LoginError("The portal page did not accept the saved login. Run tms_forget_session, then tms_auth_status, and try again.");
    }
    this.browserReady = true;
    return page;
  }

  /** If the page refreshed its tokens on its own, keep the newest ones so the saved session stays valid. */
  async syncTokensFromBrowser(): Promise<void> {
    if (!this.context || !this.stored) return;
    const cookies = await this.context.cookies(this.cfg.baseUrl);
    const at = cookies.find((c) => c.name === "access_token")?.value;
    const rt = cookies.find((c) => c.name === "refresh_token")?.value;
    const clean = (v?: string) => (v ? decodeURIComponent(v).replace(/^"|"$/g, "") : undefined);
    const a = clean(at);
    const r = clean(rt);
    if ((a && a !== this.stored.accessToken) || (r && r !== this.stored.refreshToken)) {
      this.stored = { ...this.stored, accessToken: a ?? this.stored.accessToken, refreshToken: r ?? this.stored.refreshToken, savedAt: new Date().toISOString() };
      await this.saveStored();
    }
  }

  private async closeBrowser(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
    this.browserReady = false;
  }

  async close(): Promise<void> {
    await this.syncTokensFromBrowser().catch(() => undefined);
    await this.closeBrowser();
  }

  /** Redact secrets from any text before it leaves the server. */
  safeText(text: string): string {
    return this.scrub(text);
  }
}
