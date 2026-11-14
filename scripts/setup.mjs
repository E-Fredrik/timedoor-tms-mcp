#!/usr/bin/env node
// One command setup: npm install, browser install, build, credentials prompt, Claude Desktop registration.
// Run from the project folder with:  npm run setup
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { claudeDesktopConfigPath, envFileContent, mergeServerConfig, timestamp } from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_NAME = "timedoor-tms";
const args = new Set(process.argv.slice(2));
const win = process.platform === "win32";

const say = (m) => console.log(m);
const step = (n, m) => say(`\n[${n}] ${m}`);

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", shell: win });
  if (r.status !== 0) throw new Error(`"${cmd} ${cmdArgs.join(" ")}" failed (exit ${r.status}).`);
}

// One reader for the whole run. Fails loudly (never silently) if input ends early.
const interactive = Boolean(process.stdin.isTTY);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });
const lines = interactive ? null : rl[Symbol.asyncIterator]();
let muted = false;
let rejectPending = null;
if (interactive) {
  rl._writeToOutput = (s) => {
    if (!muted) process.stdout.write(s);
  };
  rl.on("close", () => rejectPending?.(new Error("Input was closed before setup finished.")));
}

async function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  if (!interactive) {
    const { value, done } = await lines.next();
    if (done) throw new Error("No input received (the input stream ended). Run setup in a normal terminal window.");
    process.stdout.write("\n");
    return value;
  }
  return new Promise((resolve, reject) => {
    rejectPending = reject;
    muted = hidden;
    rl.question("", (answer) => {
      muted = false;
      rejectPending = null;
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 12)) throw new Error(`Node 20.12 or newer is required (you have ${process.versions.node}).`);

  if (args.has("--skip-install")) {
    step("1-3", "Skipping install and build (--skip-install)");
  } else {
    step(1, "Installing dependencies");
    run("npm", ["install"]);

    step(2, "Installing the browser the server uses (one time, about 150 MB)");
    run("npx", ["playwright", "install", "chromium"]);

    step(3, "Building the server");
    run("npm", ["run", "build"]);
  }

  step(4, "Portal login for the teacher account");
  const envPath = path.join(root, ".env");
  let write = true;
  if (args.has("--skip-credentials")) write = false;
  else if (await exists(envPath)) {
    const a = (await ask("A .env file already exists. Replace it? (y/N) ")).trim().toLowerCase();
    write = a === "y" || a === "yes";
  }
  if (write) {
    say("Your password is typed here on your own computer, saved only in .env, and never shown again.");
    const user = (await ask("Teacher username: ")).trim();
    const pass = await ask("Teacher password (hidden): ", { hidden: true });
    await fs.writeFile(envPath, envFileContent(user, pass), { mode: 0o600 });
    say("Saved .env (owner read and write only).");
  } else {
    say("Keeping the existing .env.");
  }

  step(5, "Registering with Claude Desktop");
  if (args.has("--skip-register")) {
    say("Skipped.");
  } else {
    const cfgPath = claudeDesktopConfigPath();
    const entry = { command: process.execPath, args: [path.join(root, "dist", "index.js")] };
    const existing = (await exists(cfgPath)) ? await fs.readFile(cfgPath, "utf8") : "";
    const merged = mergeServerConfig(existing, SERVER_NAME, entry); // throws before touching anything if invalid
    await fs.mkdir(path.dirname(cfgPath), { recursive: true });
    if (existing) {
      const backup = `${cfgPath}.bak-${timestamp()}`;
      await fs.copyFile(cfgPath, backup);
      say(`Backed up your old config to: ${backup}`);
    }
    await fs.writeFile(cfgPath, merged);
    say(`Added "${SERVER_NAME}" to: ${cfgPath}`);
  }

  say("\nDone. Next:");
  say("  1. Fully quit and reopen Claude Desktop.");
  say('  2. Ask Claude: "Run tms_auth_status".');
  say("  3. Try a dry run before any real save: ask for tms_save_journal_draft with dry_run true.");
  say("\nUsing Claude Code instead? Register it with:");
  say(`  claude mcp add --scope user ${SERVER_NAME} -- "${process.execPath}" "${path.join(root, "dist", "index.js")}"`);
}

main()
  .then(() => rl.close())
  .catch((e) => {
    console.error(`\nSetup stopped: ${e.message}`);
    process.exit(1);
  });
