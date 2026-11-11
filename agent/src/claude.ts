import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { agentName, agentsFile } from "./agents.ts";
import { browserMcpServer } from "./browser.ts";
import { buildAgentPrompt, buildSystemPrompt, type Channel } from "./context.ts";
import { ensureLiveBrowser, handoffHoldMs } from "./live.ts";
import { detectLimit, parseRateLimit, type RateLimitInfo } from "./limits.ts";
import { log } from "./log.ts";
import { describeTool, type ProgressFn } from "./progress.ts";

/**
 * The whole agent loop is Claude Code itself, run headless (`claude -p --output-format stream-json`)
 * inside the vault. This file builds the arguments, streams the events for live progress, and
 * turns the final `result` event into a reply. Runs on a Claude subscription: no API key, no
 * per-token billing, and the same tools Claude Code has on a laptop.
 *
 * Tools the agent may use without asking. Headless runs auto-deny anything else, so the shell is
 * limited to read-only commands. ALLOWED_TOOLS overrides the list; PERMISSION_MODE=bypassPermissions
 * ignores it entirely.
 */
const DEFAULT_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "TodoWrite",
  "WebSearch", "WebFetch", "Agent", "Task", "Skill",
  "Bash(ls:*)", "Bash(find:*)", "Bash(grep:*)", "Bash(wc:*)", "Bash(date:*)",
  "Bash(head:*)", "Bash(tail:*)", "Bash(cat:*)", "Bash(git log:*)", "Bash(git diff:*)",
  "mcp__browser", "mcp__handoff",
];

const allowedTools = process.env.ALLOWED_TOOLS
  ? process.env.ALLOWED_TOOLS.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_TOOLS;

/** MCP servers for the run, written once: they need absolute paths that differ per machine. */
let mcpFile: string | undefined;
async function mcpConfig(): Promise<string> {
  if (mcpFile) return mcpFile;
  const servers: Record<string, unknown> = {};
  const browser = browserMcpServer();
  if (browser) servers.browser = browser;
  if (config.browserLive) {
    servers.handoff = {
      command: process.execPath,
      args: [path.join(config.root, "src", "handoff-mcp.mjs")],
      env: { DATA_DIR: config.dataDir, HANDOFF_WAIT_MS: String(config.handoffWaitMs) },
    };
  }
  await fs.mkdir(config.dataDir, { recursive: true });
  const file = path.join(config.dataDir, "mcp.json");
  await fs.writeFile(file, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
  return (mcpFile = file);
}

export class TimeoutError extends Error {
  name = "TimeoutError";
}

export interface RunOptions {
  prompt: string;
  channel: Channel;
  model?: string;
  /** Resume this Claude session, to continue a conversation. */
  resume?: string;
  /** Run as this specialist (slug) instead of the main agent. */
  agent?: string;
  onProgress?: ProgressFn;
}

export interface RunResult {
  text: string;
  sessionId: string;
  isError: boolean;
  durationMs: number;
}

/** One headless Claude Code turn. Throws LimitError when the usage limit refused it. */
export async function runClaude(opts: RunOptions): Promise<RunResult> {
  await fs.mkdir(config.dataDir, { recursive: true });
  // A file, not an argument: the vault's core notes alone can pass Windows' command-line limit.
  const promptFile = path.join(config.dataDir, `system-${randomUUID()}.md`);
  await fs.writeFile(promptFile, opts.agent ? buildAgentPrompt(agentName(opts.agent), opts.channel) : await buildSystemPrompt(opts.channel));

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose", // stream-json in print mode requires it
    "--model", opts.model ?? config.chatModel,
    "--permission-mode", config.permissionMode,
    "--append-system-prompt-file", promptFile,
    "--allowedTools", allowedTools.join(","),
  ];
  // Every run, since Chromium may have exited since the last one. Without it the run just has no browser.
  if (config.browser && config.browserLive) await ensureLiveBrowser().catch((err) => log.error("live browser didn't start", err));
  args.push("--mcp-config", await mcpConfig());
  const agents = await agentsFile();
  if (agents) args.push("--agents", agents);
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.resume) args.push("--resume", opts.resume);
  const specialists = new Set(agents ? Object.keys(JSON.parse(await fs.readFile(agents, "utf8"))) : []);

  try {
    const { result, rateLimit, stderr } = await spawnClaude(args, opts.prompt, specialists, opts.onProgress);
    if (!result) throw detectLimit(stderr, rateLimit) ?? new Error(`claude produced no result: ${stderr.slice(0, 500)}`);
    const text = String(result.result ?? "").trim();
    const isError = Boolean(result.is_error);
    if (isError) {
      const limit = detectLimit(text, rateLimit);
      if (limit) throw limit;
    }
    return { text, sessionId: result.session_id, isError, durationMs: result.duration_ms ?? 0 };
  } finally {
    fs.rm(promptFile, { force: true }).catch(() => {});
  }
}

interface StreamOutcome {
  result?: any;
  rateLimit?: RateLimitInfo;
  stderr: string;
}

function spawnClaude(args: string[], prompt: string, specialists: Set<string>, onProgress?: ProgressFn): Promise<StreamOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.claudeBin, args, { cwd: config.vaultDir, env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const outcome: StreamOutcome = { stderr: "" };
    // Open hand-offs to specialists, by Agent tool_use id. Their own tool calls carry that id as
    // parent_tool_use_id, which is how a step gets shown as theirs.
    const delegations = new Map<string, string>();
    const emit = (step: string) => {
      try {
        onProgress?.(step);
      } catch {}
    };

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === "result") outcome.result = ev;
      else if (ev.type === "rate_limit_event") outcome.rateLimit = parseRateLimit(ev.rate_limit_info);
      else if (ev.type === "assistant") {
        const sub = ev.parent_tool_use_id ? delegations.get(ev.parent_tool_use_id) : undefined;
        for (const block of ev.message?.content ?? []) {
          if (block.type !== "tool_use") continue;
          const target = String(block.input?.subagent_type ?? "");
          if ((block.name === "Agent" || block.name === "Task") && specialists.has(target)) {
            delegations.set(block.id, target);
            emit(`handing to ${agentName(target)}: ${String(block.input?.description ?? "").slice(0, 80)}`);
            continue;
          }
          const step = describeTool(block.name, block.input);
          emit(sub ? `${agentName(sub)}: ${step}` : step);
        }
      }
    };

    // While a specialist waits on you to solve a captcha (see live.ts), the clock pauses until its wait runs out.
    const onTimeout = () => {
      const hold = handoffHoldMs();
      if (hold > 0) return void (timer = setTimeout(onTimeout, hold));
      child.kill();
      reject(new TimeoutError(`claude timed out after ${config.claudeTimeoutMs / 1000}s`));
    };
    let timer = setTimeout(onTimeout, config.claudeTimeoutMs);

    let buf = "";
    // Decode as a stream, so a multi-byte character split across chunks survives.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on("data", (d) => (outcome.stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      handleLine(buf);
      if (!outcome.result) log.error("claude exited without a result", code, outcome.stderr.slice(0, 1000));
      resolve(outcome);
    });
    // The prompt goes over stdin for the same command-line-length reason.
    child.stdin.end(prompt);
  });
}
