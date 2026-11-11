import path from "node:path";
import { fileURLToPath } from "node:url";

/** Every setting comes from the environment (.env). See .env.example for what each one does. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

const num = (name: string, fallback: number) => Number(env(name, String(fallback)));
const on = (name: string, fallback = "false") => env(name, fallback) === "true";

export const config = {
  root,
  /** What the agent calls itself. Its personality lives in the vault (IDENTITY.md, SOUL.md), not here. */
  agentName: env("AGENT_NAME", "Rook"),

  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  /** The only Telegram user the bot answers. Everyone else is ignored. */
  ownerId: Number(process.env.TELEGRAM_OWNER_ID ?? 0),

  vaultDir: path.resolve(root, env("VAULT_DIR", "example-vault")),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, "data")),
  jobsDir: path.resolve(root, env("JOBS_DIR", "jobs")),
  agentsDir: env("AGENTS_DIR", "Agents").replace(/[\\/]+$/, ""),
  dailyDir: env("DAILY_DIR", "Daily").replace(/[\\/]+$/, ""),
  timezone: env("TZ_NAME", Intl.DateTimeFormat().resolvedOptions().timeZone),

  /** Pull before every run, commit and push after. Off for a vault that isn't a git repo with a remote. */
  gitSync: on("GIT_SYNC"),

  claudeBin: env("CLAUDE_BIN", "claude"),
  chatModel: env("CHAT_MODEL", "sonnet"),
  jobModel: env("JOB_MODEL", "sonnet"),
  /** Tried once when the usage limit refuses a run. Some limits are per model. Empty = no fallback. */
  limitFallbackModel: process.env.LIMIT_FALLBACK_MODEL ?? "",
  /** default | acceptEdits | bypassPermissions. See the README before choosing bypassPermissions. */
  permissionMode: env("PERMISSION_MODE", "acceptEdits"),
  claudeTimeoutMs: num("CLAUDE_TIMEOUT_MS", 10 * 60_000),

  /** A conversation is retired (and wrapped up into the vault) after this much silence. */
  sessionIdleHours: num("SESSION_IDLE_HOURS", 6),
  wrapUp: on("WRAP_UP", "true"),
  wrapUpMinTurns: num("WRAP_UP_MIN_TURNS", 2),
  recentDailyNotes: num("RECENT_DAILY_NOTES", 2),

  /** Give the agent a browser (Playwright MCP). */
  browser: on("BROWSER"),
  /** Run that browser as a real Chromium with a saved profile that you can take over from /live. */
  browserLive: on("BROWSER_LIVE"),
  browserCdpPort: num("BROWSER_CDP_PORT", 9223),
  browserExecutable: process.env.BROWSER_EXECUTABLE ?? "",
  /** How long the agent waits for you on a handoff before giving up. */
  handoffWaitMs: num("HANDOFF_WAIT_MS", 5 * 60_000),

  /**
   * The /live page. Bind WEB_HOST to a private address (a Tailscale IP, or 127.0.0.1 behind an SSH
   * tunnel): whoever can open it can drive the browser. Empty WEB_HOST = off.
   */
  webHost: process.env.WEB_HOST ?? "127.0.0.1",
  webPort: num("WEB_PORT", 8787),
  /** The address you open on your phone, if it differs from WEB_HOST (e.g. a MagicDNS name). */
  publicUrl: (process.env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
};
