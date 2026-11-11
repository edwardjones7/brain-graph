import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { log } from "./log.ts";

/**
 * Specialists: named subagents with their own personality and memory, living in the vault at
 * AGENTS_DIR/<Name>/:
 *
 *   <Name>.md   who they are. Frontmatter: description (when to hand off to them), model, tools
 *               (comma separated allowlist), enabled, parent (the specialist they report to; absent
 *               means the main agent), and `vault: false` for one that reads untrusted pages, so a
 *               page can't talk it into leaking your notes. The body is their personality and job.
 *   Memory.md   their working memory, which they keep up to date themselves.
 *
 * Read fresh on every run and handed to Claude Code with --agents, so editing a specialist in
 * Obsidian takes effect on the next message. The main agent delegates with the Agent tool.
 */
export interface AgentDef {
  description: string;
  prompt: string;
  model?: string;
  tools?: string[];
}

/** Memory goes into the prompt; past this the agent reads the rest itself. */
const MEMORY_CAP = 16_000;

export function parseNote(raw: string): { meta: Record<string, string>; body: string } | undefined {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return undefined;
  const meta = Object.fromEntries(
    m[1]
      .split(/\r?\n/)
      .filter((l) => l.includes(":"))
      .map((l) => {
        const i = l.indexOf(":");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      }),
  );
  return { meta, body: m[2].trim() };
}

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
export const agentName = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export interface Specialist {
  id: string;
  name: string;
  meta: Record<string, string>;
  body: string;
  memory: string;
  isolated: boolean;
}

/** Every enabled specialist folder in the vault. */
export async function roster(): Promise<Specialist[]> {
  const root = path.join(config.vaultDir, config.agentsDir);
  const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const out: Specialist[] = [];
  for (const d of dirs) {
    if (!d.isDirectory() || /^[_.]/.test(d.name)) continue;
    const dir = path.join(root, d.name);
    const parsed = parseNote(await fs.readFile(path.join(dir, `${d.name}.md`), "utf8").catch(() => ""));
    if (!parsed?.meta.description) {
      if (parsed) log.warn(`agent ${d.name}: needs a description in its frontmatter, skipping`);
      continue;
    }
    if (parsed.meta.enabled === "false") continue;
    const isolated = parsed.meta.vault === "false";
    const memory = isolated ? "" : (await fs.readFile(path.join(dir, "Memory.md"), "utf8").catch(() => "")).trim();
    out.push({ id: slug(d.name), name: d.name, meta: parsed.meta, body: parsed.body, memory, isolated });
  }
  return out;
}

export function agentDef(a: Specialist): AgentDef {
  const memPath = path.posix.join(config.agentsDir, a.name, "Memory.md");
  const lead = a.meta.parent;
  const intro = lead
    ? `You are ${a.name}, on ${lead}'s team. ${lead} hands you work and you report back to ${lead}, so write your final answer as a working result for ${lead} to use.`
    : `You are ${a.name}, one of ${config.agentName}'s specialists. ${config.agentName} hands you work in your area and relays your answer, so write your final answer as the message your owner should read, in your own voice.`;
  // An isolated agent reads untrusted pages: it gets no vault, no memory, and only the tools it lists.
  const prompt = a.isolated
    ? `${intro}\n\n${a.body}`
    : [
        intro,
        "You work inside your owner's Obsidian vault (the current directory). Who they are: USER.md.",
        "",
        a.body,
        "",
        "## Your memory",
        `Your memory file is \`${memPath}\`. You remember nothing between runs that isn't in it, and nobody else keeps it for you.`,
        "- Before you finish ANY run, update it: current state, what changed, what you told your owner, what to check next time. Rewrite stale lines instead of only appending, and keep it under ~300 lines.",
        a.memory
          ? `\nCurrent contents${a.memory.length > MEMORY_CAP ? " (truncated: read the file for the rest)" : ""}:\n<memory>\n${a.memory.slice(0, MEMORY_CAP)}\n</memory>`
          : `\nIt doesn't exist yet. Create it on this run.`,
      ].join("\n");
  return {
    // --agents has no scoping, so the main agent sees team members too. This keeps it going through their lead.
    description: `${a.name}: ${lead ? `Only ${lead} delegates to this agent. ` : ""}${a.meta.description}`,
    prompt,
    ...(a.meta.model ? { model: a.meta.model } : {}),
    ...(a.meta.tools ? { tools: a.meta.tools.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
  };
}

/** Write this run's specialists to a file for --agents. Undefined when there are none. */
export async function agentsFile(): Promise<string | undefined> {
  const list = await roster().catch((err) => (log.warn("agents: could not load", err), []));
  if (!list.length) return undefined;
  const file = path.join(config.dataDir, "agents.json");
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(Object.fromEntries(list.map((a) => [a.id, agentDef(a)])), null, 2));
  return file;
}

/** A specialist you can talk to directly. Isolated ones can't: a normal chat starts inside the vault. */
export async function directAgent(id: string): Promise<Specialist | undefined> {
  return (await roster()).find((a) => a.id === id && !a.isolated);
}
