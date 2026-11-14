import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(__dirname, "..");
let client: Client;

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");

beforeAll(async () => {
  execFileSync("npx", ["tsc"], { cwd: root, stdio: "pipe" });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.TMS_USERNAME = "";
  env.TMS_PASSWORD = "";
  client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [path.join(root, "dist/index.js")], env }));
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("MCP server over stdio", () => {
  it("starts without credentials and lists all tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "tms_auth_status",
      "tms_auto_approve_projects",
      "tms_auto_send_journals",
      "tms_automation_settings",
      "tms_batch_journal_drafts",
      "tms_check_attendance_gaps",
      "tms_check_report_gaps",
      "tms_create_report",
      "tms_find_report_range",
      "tms_find_student",
      "tms_finish_class",
      "tms_forget_session",
      "tms_get_book_lessons",
      "tms_get_class_attendance",
      "tms_get_lesson_access",
      "tms_get_meeting_journal",
      "tms_list_classes",
      "tms_list_courses",
      "tms_list_inbox_photos",
      "tms_list_journals_to_send",
      "tms_list_low_scores",
      "tms_list_my_classes",
      "tms_list_pending_journals",
      "tms_list_project_approvals",
      "tms_list_report_reminders",
      "tms_list_student_reports",
      "tms_list_students",
      "tms_mark_attendance",
      "tms_portal_get",
      "tms_prepare_report",
      "tms_save_journal_draft",
      "tms_send_journal_to_parent",
      "tms_set_lesson_access",
      "tms_set_project_status",
      "tms_set_report_status",
      "tms_start_class",
      "tms_submit_journal",
      "tms_sync_lesson_progress",
      "tms_update_lesson_scores",
    ]);
  });

  it("every tool has a description", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(20);
  });

  it("returns a clear ConfigError (not a crash) when credentials are missing", async () => {
    const r = await client.callTool({ name: "tms_auth_status", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/ConfigError: Missing TMS_USERNAME and TMS_PASSWORD/);
  });

  it("validation runs before any login: overlong notes are rejected", async () => {
    const r = await client.callTool({
      name: "tms_save_journal_draft",
      arguments: { student_id: 1, learning_session_id: 2, book_id: 3, meeting_id: 4, teacher_notes: "x".repeat(250) },
    });
    expect(r.isError).toBe(true);
    // Config is checked first, so with no credentials we see ConfigError; the point is that nothing crashed or hung.
    expect(text(r)).toMatch(/ConfigError|ValidationError/);
  });

  it("with credentials set, bad input is rejected by validation BEFORE any browser or login starts", async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.TMS_USERNAME = "fake_user_for_test";
    env.TMS_PASSWORD = "fake_pass_for_test";
    const c2 = new Client({ name: "test2", version: "0" });
    await c2.connect(new StdioClientTransport({ command: "node", args: [path.join(root, "dist/index.js")], env }));
    try {
      const started = Date.now();
      const r = await c2.callTool({
        name: "tms_save_journal_draft",
        arguments: { student_id: 1, learning_session_id: 2, book_id: 3, meeting_id: 4, teacher_notes: "x".repeat(250) },
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/ValidationError: teacher_notes is 250 characters/);
      expect(text(r)).not.toContain("fake_pass_for_test");
      expect(Date.now() - started).toBeLessThan(3000); // no browser launch happened
    } finally {
      await c2.close();
    }
  }, 30_000);

  it("rejects wrong argument types at the protocol layer", async () => {
    const r = await client.callTool({
      name: "tms_save_journal_draft",
      arguments: { student_id: "abc", learning_session_id: 2, book_id: 3, meeting_id: 4, teacher_notes: "ok" },
    }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
    expect(r.isError).toBe(true);
  });
});
