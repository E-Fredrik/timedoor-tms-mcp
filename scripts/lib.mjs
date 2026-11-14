import os from "node:os";
import path from "node:path";

/** Where Claude Desktop keeps its MCP server list on each operating system. */
export function claudeDesktopConfigPath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "claude_desktop_config.json");
}

/**
 * Adds or replaces one MCP server entry and keeps everything else untouched.
 * Refuses (throws) if the existing file is not valid JSON, so a broken config is never overwritten.
 */
export function mergeServerConfig(existingText, name, entry) {
  let obj = {};
  if (existingText && existingText.trim()) {
    try {
      obj = JSON.parse(existingText);
    } catch {
      throw new Error("The existing Claude Desktop config is not valid JSON. I did not change it. Fix or remove it, then run setup again.");
    }
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("The existing Claude Desktop config is not a JSON object. I did not change it.");
  }
  if (obj.mcpServers !== undefined && (obj.mcpServers === null || typeof obj.mcpServers !== "object" || Array.isArray(obj.mcpServers))) {
    throw new Error('The "mcpServers" entry in the existing config is not an object. I did not change it.');
  }
  const next = { ...obj, mcpServers: { ...(obj.mcpServers ?? {}), [name]: entry } };
  return JSON.stringify(next, null, 2) + "\n";
}

function quoteEnvValue(v) {
  if (/[\r\n\0]/.test(v)) throw new Error("Values with line breaks are not supported in .env");
  if (/^[A-Za-z0-9_.@+\-\/:,]+$/.test(v)) return v; // plain value, no quoting needed
  if (!v.includes("'")) return `'${v}'`; // single quotes keep every character literal
  if (!/["\\$`\n]/.test(v)) return `"${v}"`;
  throw new Error("That value mixes quote characters in a way .env cannot store safely. Set it as an environment variable instead.");
}

/** Builds the text of the .env file. Never logs or returns anything but the file text. */
export function envFileContent(username, password) {
  if (!username || !password) throw new Error("Both username and password are required");
  return `TMS_USERNAME=${quoteEnvValue(username)}\nTMS_PASSWORD=${quoteEnvValue(password)}\n`;
}

export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
