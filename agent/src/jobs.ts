import fs from "node:fs/promises";
import path from "node:path";
import cron from "node-cron";
import { config } from "./config.ts";
import { parseNote } from "./agents.ts";
import { LimitError } from "./limits.ts";
import { log } from "./log.ts";
import { runTask } from "./sessions.ts";
import { isSilent } from "./silent.ts";

/**
 * Proactive jobs: jobs/*.md, a cron `schedule` (plus optional `enabled` and `model`) in the
 * frontmatter and the prompt as the body. Add a job by adding a file. A job that finds nothing
 * worth your attention answers NOTHING_TO_SEND and stays quiet.
 */
export interface Job {
  name: string;
  schedule: string;
  enabled: boolean;
  model?: string;
  prompt: string;
}

export type Notify = (text: string) => Promise<void>;

export async function loadJobs(): Promise<Job[]> {
  const files = (await fs.readdir(config.jobsDir).catch(() => [] as string[])).filter((f) => f.endsWith(".md"));
  const jobs: Job[] = [];
  for (const f of files) {
    const parsed = parseNote(await fs.readFile(path.join(config.jobsDir, f), "utf8"));
    if (!parsed?.meta.schedule) {
      log.warn(`job ${f} has no schedule in its frontmatter, skipping`);
      continue;
    }
    jobs.push({ name: f.replace(/\.md$/, ""), schedule: parsed.meta.schedule, enabled: parsed.meta.enabled !== "false", model: parsed.meta.model || undefined, prompt: parsed.body });
  }
  return jobs;
}

export async function runJob(job: Job, notify: Notify, attempt = 1): Promise<void> {
  log.info(`job ${job.name}: start`);
  try {
    const r = await runTask(job.name, job.prompt, job.model);
    log.info(`job ${job.name}: done in ${Math.round(r.durationMs / 1000)}s, ${r.filesChanged.length} files changed`);
    if (r.isError) await notify(`⚠️ Job ${job.name} errored:\n${r.text}`);
    else if (!isSilent(r.text)) await notify(r.text);
  } catch (err) {
    // A morning brief that hit the limit should still arrive, late, rather than not at all.
    if (err instanceof LimitError && attempt <= 2) {
      const delay = err.resetsAt ? Math.max(60_000, err.resetsAt * 1000 - Date.now() + 120_000) : 3600_000;
      log.warn(`job ${job.name}: usage limit, retrying in ${Math.round(delay / 60_000)} min`);
      setTimeout(() => void runJob(job, notify, attempt + 1), delay);
      return;
    }
    log.error(`job ${job.name} failed`, err);
    await notify(`⚠️ Job ${job.name} failed: ${(err as Error).message}`).catch(() => {});
  }
}

export async function scheduleJobs(notify: Notify): Promise<Job[]> {
  const jobs = await loadJobs();
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (!cron.validate(job.schedule)) {
      log.warn(`job ${job.name}: invalid schedule "${job.schedule}"`);
      continue;
    }
    cron.schedule(job.schedule, () => void runJob(job, notify), { timezone: config.timezone });
    log.info(`scheduled ${job.name} @ "${job.schedule}" (${config.timezone})`);
  }
  return jobs;
}
