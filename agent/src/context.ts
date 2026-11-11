import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import * as vault from "./vault.ts";

/**
 * The anti-drift layer. These vault files become the system prompt on every run, read fresh each
 * time, so an edit to SOUL.md applies on the next message and the agent's core never gets buried
 * under a long conversation.
 */
const CORE_FILES = ["IDENTITY.md", "SOUL.md", "USER.md"];

export type Channel = "telegram" | "job" | "cli" | "wrapup";

const CHANNEL_NOTES: Record<Channel, string> = {
  telegram: "You are talking to your owner over Telegram, usually on a phone. Keep replies phone-sized: short paragraphs, no tables. Telegram shows plain text, so skip markdown beyond simple lists.",
  job: "This is a scheduled job, not a conversation. Nobody is here to answer questions. Do the job, then output ONLY the message to send to your owner's phone. If the job's instructions say there's nothing worth sending, output exactly NOTHING_TO_SEND.",
  cli: "You are being called from the command line for testing.",
  wrapup: "This is the end-of-conversation wrap-up. Nobody is here. File what's missing, then output ONLY a one-line report, or exactly NOTHING_TO_SEND.",
};

async function readCore(): Promise<string> {
  const parts: string[] = [];
  for (const f of CORE_FILES) {
    const body = await fs.readFile(path.join(config.vaultDir, f), "utf8").catch(() => "(missing)");
    parts.push(`<file name="${f}">\n${body.trim()}\n</file>`);
  }
  return parts.join("\n\n");
}

const RUNTIME_RULES = `- **Read before assuming.** Before answering anything about your owner's projects, people or plans, search the vault (Grep/Glob, then Read).
- **Write it here first.** Anything worth reading again goes into the vault in the same turn, following IDENTITY.md. Say in one short line what you filed and where.
- **Memory write-back.** Durable facts, decisions, commitments and deadlines from this conversation get recorded in the right note before you finish.
- **Do not run git.** The service commits and pushes the vault after every run.
- **Never delete notes** unless your owner asks for that exact deletion.
- **Never invent facts or numbers.** Blank beats guessed.`;

export async function buildSystemPrompt(channel: Channel): Promise<string> {
  return `# You are ${config.agentName}

You are ${config.agentName}, a personal agent running on your owner's own machine. Your working directory IS their second brain: an Obsidian vault and the single source of truth. The files below define who you are and who they are. Follow them.

Each message starts with a <context> block from the service. It's context, not something your owner typed.

${await readCore()}

# Runtime rules

${RUNTIME_RULES}

# Channel

${CHANNEL_NOTES[channel]}
`;
}

/** For a direct conversation with a specialist: their definition comes in through --agent. */
export function buildAgentPrompt(name: string, channel: Channel): string {
  return `# Your owner is talking to you directly

You are ${name}. Your owner chose to talk to you, so ${config.agentName} isn't in this conversation: wherever your instructions say you report to ${config.agentName}, answer your owner yourself, in your own voice.

# Runtime rules

${RUNTIME_RULES}

# Channel

${CHANNEL_NOTES[channel]}
`;
}

function now(): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, dateStyle: "full", timeStyle: "short" }).format(new Date());
}

const DAILY_MAX_CHARS = 6000;

async function recentDailies(): Promise<string> {
  const dir = path.join(config.vaultDir, config.dailyDir);
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  const parts: string[] = [];
  for (const f of names.slice(-config.recentDailyNotes)) {
    let body = (await fs.readFile(path.join(dir, f), "utf8")).trim();
    if (body.length > DAILY_MAX_CHARS) body = body.slice(0, DAILY_MAX_CHARS) + "\n…(truncated, Read the file for the rest)";
    parts.push(`<file name="${config.dailyDir}/${f}">\n${body}\n</file>`);
  }
  return parts.join("\n\n");
}

/**
 * Prepended to each message. Anything that changes between runs lives here rather than in the
 * system prompt, so the system prompt stays byte-identical and the prompt cache holds across a
 * resumed conversation. A fresh session also gets the latest Daily notes and recently changed notes.
 */
export async function turnPreamble(fresh: boolean): Promise<string> {
  const lines = ["<context>", `Current time: ${now()} (${config.timezone}).`];
  if (fresh) {
    const [dailies, changed] = await Promise.all([recentDailies(), vault.recentlyChanged(48)]);
    if (dailies) lines.push("", "Most recent Daily notes (already loaded):", dailies);
    const other = changed.filter((f) => !f.startsWith(`${config.dailyDir}/`));
    if (other.length) lines.push("", "Other notes changed in the last 48 hours:", ...other.map((f) => `- ${f}`));
  }
  lines.push("</context>", "");
  return lines.join("\n");
}
