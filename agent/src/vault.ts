import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.ts";
import { log } from "./log.ts";

/**
 * The vault is the agent's long-term memory and a plain git repo, so every run starts from the
 * latest notes (you may have edited on your laptop) and ends with a commit you can read or revert.
 */
const exec = promisify(execFile);

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: config.vaultDir, maxBuffer: 10 * 1024 * 1024 });
  // trimEnd only: porcelain status lines start with a meaningful space.
  return stdout.trimEnd();
}

/** Pull before a run. Never throws: a failed pull shouldn't block a reply. */
export async function pull(): Promise<void> {
  if (!config.gitSync) return;
  try {
    await git("pull", "--rebase", "--autostash", "--quiet");
  } catch (err) {
    log.warn("git pull failed", err);
    await git("rebase", "--abort").catch(() => {});
  }
}

/** Commit and push whatever the run changed. Returns the changed files. */
export async function commit(message: string): Promise<string[]> {
  if (!config.gitSync) return [];
  try {
    const files = await changedFiles();
    if (!files.length) return [];
    await git("add", "-A");
    await git("commit", "--quiet", "-m", message);
    try {
      await git("push", "--quiet");
    } catch {
      // Someone (desktop Obsidian, another device) pushed in the meantime. Rebase and retry once.
      await git("pull", "--rebase", "--autostash", "--quiet");
      await git("push", "--quiet");
    }
    return files;
  } catch (err) {
    log.error("git commit/push failed", err);
    return [];
  }
}

/** Notes changed in the last `hours`, so a fresh session knows what's been going on. Never throws. */
export async function recentlyChanged(hours: number, max = 30): Promise<string[]> {
  if (!config.gitSync) return [];
  try {
    const out = await git("log", `--since=${hours} hours ago`, "--name-only", "--pretty=format:", "--", "*.md");
    return [...new Set(out.split("\n").map((l) => l.trim().replace(/^"|"$/g, "")).filter(Boolean))].slice(0, max);
  } catch {
    return [];
  }
}

async function changedFiles(): Promise<string[]> {
  const out = await git("status", "--porcelain");
  return out.split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ""));
}
