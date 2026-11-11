import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { directAgent } from "./agents.ts";
import { runClaude, TimeoutError, type RunOptions, type RunResult } from "./claude.ts";
import { turnPreamble, type Channel } from "./context.ts";
import { LimitError } from "./limits.ts";
import { log } from "./log.ts";
import type { ProgressFn } from "./progress.ts";
import { enqueue } from "./queue.ts";
import { isSilent } from "./silent.ts";
import * as vault from "./vault.ts";

/**
 * Conversations. A Claude session is resumed while the conversation is active and retired after
 * SESSION_IDLE_HOURS of silence (or /new). A retired session gets one last "wrap-up" turn that
 * files anything durable into the vault, so nothing said is lost when the chat resets.
 *
 * Continuity across conversations comes from the vault, not from an ever-growing transcript:
 * context stays small, and everything the agent knows is a note you can read and correct.
 */
interface Session {
  id: string;
  lastUsed: number;
  turns: number;
  agent?: string; // a direct conversation with a specialist
}

interface Store {
  active: Record<string, Session>;
  wrapQueue: (Session & { attempts?: number })[];
}

const file = () => path.join(config.dataDir, "sessions.json");

async function load(): Promise<Store> {
  try {
    return JSON.parse(await fs.readFile(file(), "utf8"));
  } catch (err: any) {
    if (err?.code !== "ENOENT") log.error("sessions.json unreadable, starting empty", err);
    return { active: {}, wrapQueue: [] };
  }
}

async function save(s: Store) {
  await fs.mkdir(config.dataDir, { recursive: true });
  // Write then rename, so a crash mid-write never leaves half a file.
  await fs.writeFile(`${file()}.tmp`, JSON.stringify(s, null, 2));
  await fs.rename(`${file()}.tmp`, file());
}

const expired = (s: Session) => Date.now() - s.lastUsed >= config.sessionIdleHours * 3600_000;

function retire(store: Store, key: string) {
  const s = store.active[key];
  if (!s) return;
  delete store.active[key];
  if (config.wrapUp && s.turns >= config.wrapUpMinTurns) store.wrapQueue.push(s);
}

const WRAP_UP = `This conversation has ended and your owner isn't here.

Before it closes, make sure nothing worth keeping is lost:
1. Go back over the whole conversation and list, for yourself, every durable fact, decision, commitment, deadline, idea or preference that came up.
2. For each one, check whether it's already in the right note. File only what's missing, where IDENTITY.md says it goes. Commitments go in that day's Daily note as unchecked boxes.

Don't pad, don't re-file, don't invent. Output one short line saying what you filed and where, or exactly NOTHING_TO_SEND if there was nothing to file.`;

/** Run queued wrap-ups. Call from inside the queue. Stops at a usage limit; gives up on one after 3 failures. */
async function drainWrapUps(store: Store): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  while (store.wrapQueue.length) {
    const s = store.wrapQueue[0];
    try {
      await vault.pull();
      const r = await runClaude({ prompt: (await turnPreamble(false)) + WRAP_UP, channel: "wrapup", resume: s.id, model: config.jobModel, agent: s.agent });
      await vault.commit(`Wrap up conversation ${s.id.slice(0, 8)}`);
      out.set(s.id, r.text);
      store.wrapQueue.shift();
    } catch (err) {
      if (err instanceof LimitError) {
        log.warn("wrap-up postponed: usage limit");
        await save(store);
        break;
      }
      s.attempts = (s.attempts ?? 0) + 1;
      log.warn(`wrap-up of ${s.id.slice(0, 8)} failed (attempt ${s.attempts})`, err);
      if (s.attempts >= 3) store.wrapQueue.shift();
      else {
        await save(store);
        break;
      }
    }
    await save(store);
  }
  return out;
}

/** End a conversation now (/new). Resolves with the wrap-up's one-line report, if it had one. */
export function resetSession(key: string): Promise<string | undefined> {
  return enqueue(async () => {
    const store = await load();
    const id = store.active[key]?.id;
    retire(store, key);
    await save(store);
    const text = id ? (await drainWrapUps(store)).get(id) : undefined;
    return text && !isSilent(text) ? text : undefined;
  });
}

/** Retire idle conversations and file them. Called on a timer. */
export function sweepIdleSessions(): Promise<void> {
  return enqueue(async () => {
    const store = await load();
    const idle = Object.keys(store.active).filter((k) => expired(store.active[k]));
    if (!idle.length && !store.wrapQueue.length) return;
    for (const k of idle) retire(store, k);
    await save(store);
    await drainWrapUps(store);
  });
}

export interface Reply extends RunResult {
  filesChanged: string[];
}

/** A message in a conversation: to the main agent, or straight to a specialist when `agent` is set. */
export function chat(key: string, message: string, channel: Channel, onProgress?: ProgressFn, agent?: string): Promise<Reply> {
  return enqueue(async () => {
    const who = agent ? await directAgent(agent) : undefined;
    if (agent && !who) throw new Error(`There's no active specialist called ${agent}.`);
    if (who) key = `${key}:${who.id}`;
    const store = await load();
    let existing: Session | undefined = store.active[key];
    if (existing && expired(existing)) {
      // File the old conversation first, so the new one can already see what it filed.
      retire(store, key);
      existing = undefined;
      onProgress?.("filing the last conversation first");
      await drainWrapUps(store);
    }

    await vault.pull();
    // Specialists start from their own memory, so they skip the recent-notes preamble.
    const preamble = (fresh: boolean) => turnPreamble(!who && fresh);
    let fresh = !existing;
    let result: RunResult;
    try {
      result = await runWithFallback({ prompt: (await preamble(fresh)) + message, channel, resume: existing?.id, onProgress, agent: who?.id, model: who?.meta.model });
    } catch (err) {
      // A timeout may already have edited files, so never silently re-run the message.
      if (!existing || err instanceof LimitError || err instanceof TimeoutError) throw err;
      // A stale session shouldn't break the conversation: start fresh, and still wrap up the old one.
      log.warn("resume failed, starting a fresh session", err);
      retire(store, key);
      fresh = true;
      result = await runWithFallback({ prompt: (await preamble(true)) + message, channel, onProgress, agent: who?.id, model: who?.meta.model });
    }
    const filesChanged = await vault.commit(`${who?.name ?? config.agentName} (${channel}): ${oneLine(message)}`);
    store.active[key] = { id: result.sessionId, lastUsed: Date.now(), turns: (fresh ? 0 : existing!.turns) + 1, agent: who?.id };
    await save(store);
    return { ...result, filesChanged };
  });
}

/** One-shot run with no conversation, for scheduled jobs. */
export function runTask(name: string, prompt: string, model?: string): Promise<Reply> {
  return enqueue(async () => {
    await vault.pull();
    const result = await runWithFallback({ prompt: (await turnPreamble(true)) + prompt, channel: "job", model: model ?? config.jobModel });
    return { ...result, filesChanged: await vault.commit(`${config.agentName} job: ${name}`) };
  });
}

/** If the usage limit refuses a run and LIMIT_FALLBACK_MODEL is set, try once on that model. */
async function runWithFallback(opts: RunOptions): Promise<RunResult> {
  try {
    return await runClaude(opts);
  } catch (err) {
    const fallback = config.limitFallbackModel;
    if (!(err instanceof LimitError) || !fallback || fallback === (opts.model ?? config.chatModel)) throw err;
    opts.onProgress?.(`usage limit, switching to ${fallback}`);
    return runClaude({ ...opts, model: fallback });
  }
}

function oneLine(s: string, max = 60): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
