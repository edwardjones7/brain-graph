import fs from "node:fs/promises";
import path from "node:path";
import { Bot, type Context } from "grammy";
import { config } from "./config.ts";
import { directAgent, roster } from "./agents.ts";
import { loadJobs, runJob, type Notify } from "./jobs.ts";
import { LimitError } from "./limits.ts";
import { log } from "./log.ts";
import { queueDepth } from "./queue.ts";
import { chat, resetSession } from "./sessions.ts";

/**
 * The phone interface. One owner: the bot ignores everyone but TELEGRAM_OWNER_ID, because the
 * agent behind it can read your notes and, depending on PERMISSION_MODE, run commands.
 */
const key = (ctx: Context) => `telegram:${ctx.chat?.id}`;

/** Who you're talking to: the main agent, or a specialist after /talk <name>. Kept across restarts. */
const focusFile = () => path.join(config.dataDir, "focus.json");
const readFocus = async (): Promise<Record<string, string>> => JSON.parse(await fs.readFile(focusFile(), "utf8").catch(() => "{}"));
async function setFocus(k: string, agent?: string) {
  const f = await readFocus();
  if (agent) f[k] = agent;
  else delete f[k];
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(focusFile(), JSON.stringify(f));
}

/** Telegram caps a message at 4096 characters. Split on paragraph breaks where possible. */
export function split(text: string, max = 4000): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  return rest ? [...out, rest] : out;
}

/**
 * One status message that shows what the agent is doing ("reading Projects/X.md"). Created on
 * the first step, so quick replies never flash one; edits are throttled to stay inside
 * Telegram's rate limits; deleted when the reply lands.
 */
function liveStatus(ctx: Context) {
  const steps: string[] = [];
  let msgId: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let finished = false;
  const flush = () => {
    timer = undefined;
    chain = chain
      .then(async () => {
        if (finished) return;
        const body = ["⏳ Working…", ...steps.slice(-4).map((s) => `• ${s}`)].join("\n");
        if (msgId === undefined) msgId = (await ctx.reply(body)).message_id;
        else await ctx.api.editMessageText(ctx.chat!.id, msgId, body);
      })
      .catch(() => {});
  };
  return {
    update(step: string) {
      if (finished || steps.at(-1) === step) return;
      steps.push(step);
      timer ??= setTimeout(flush, 2500);
    },
    async done() {
      finished = true;
      clearTimeout(timer);
      await chain;
      if (msgId !== undefined) await ctx.api.deleteMessage(ctx.chat!.id, msgId).catch(() => {});
    },
  };
}

async function handle(ctx: Context, text: string) {
  const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 4500);
  const progress = liveStatus(ctx);
  if (queueDepth() > 0) progress.update("waiting for another task to finish");
  try {
    const agent = (await readFocus())[key(ctx)];
    const r = await chat(key(ctx), text, "telegram", progress.update, agent);
    await progress.done();
    for (const chunk of split((r.isError ? "⚠️ " : "") + (r.text || "(no reply)"))) await ctx.reply(chunk);
  } catch (err) {
    await progress.done();
    if (err instanceof LimitError) {
      const when = err.resetsAt ? new Date(err.resetsAt * 1000).toLocaleTimeString("en-US", { timeZone: config.timezone, hour: "numeric", minute: "2-digit" }) : "later";
      await ctx.reply(`⏸ Usage limit hit. It resets ${when}. Your message wasn't processed, so send it again then.`);
      return;
    }
    log.error("chat failed", err);
    await ctx.reply(`⚠️ Something broke: ${(err as Error).message}`);
  } finally {
    clearInterval(typing);
  }
}

export function createBot(): Bot {
  const bot = new Bot(config.telegramToken);

  // Owner only. Everyone else gets silence, not an error that confirms the bot exists.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id === config.ownerId) return next();
    log.warn(`ignored message from ${ctx.from?.id}`);
  });

  bot.command("start", (ctx) =>
    ctx.reply(
      [
        `${config.agentName} here. Just talk to me.`,
        "",
        "/new  end this conversation (I file what matters first)",
        "/talk <name>  talk to a specialist directly, /talk alone to come back",
        "/team  list the specialists",
        "/jobs  list scheduled jobs",
        "/run <job>  run a job now",
        "/status  what I'm doing",
      ].join("\n"),
    ),
  );

  bot.command("new", async (ctx) => {
    const report = await resetSession(key(ctx));
    await ctx.reply(report ? `New conversation. ${report}` : "New conversation.");
  });

  bot.command("team", async (ctx) => {
    const team = await roster();
    await ctx.reply(team.length ? team.map((a) => `${a.name}: ${a.meta.description}`).join("\n\n") : `No specialists yet. Add a folder under ${config.agentsDir}/ in the vault.`);
  });

  bot.command("talk", async (ctx) => {
    const name = ctx.match.trim().toLowerCase();
    if (!name) {
      await setFocus(key(ctx));
      return ctx.reply(`Back to ${config.agentName}.`);
    }
    const a = await directAgent(name);
    if (!a) return ctx.reply(`No specialist called ${name}. Try /team.`);
    await setFocus(key(ctx), a.id);
    await ctx.reply(`You're talking to ${a.name}. /talk on its own brings you back.`);
  });

  bot.command("jobs", async (ctx) => {
    const jobs = await loadJobs();
    await ctx.reply(jobs.map((j) => `${j.enabled ? "✓" : "–"} ${j.name}  (${j.schedule})`).join("\n") || "No jobs. Add one to jobs/.");
  });

  bot.command("run", async (ctx) => {
    const job = (await loadJobs()).find((j) => j.name === ctx.match.trim());
    if (!job) return ctx.reply("No job by that name. Try /jobs.");
    await ctx.reply(`Running ${job.name}…`);
    void runJob(job, async (t) => {
      for (const c of split(t)) await ctx.reply(c);
    });
  });

  bot.command("status", (ctx) => ctx.reply(queueDepth() ? `Busy: ${queueDepth()} task(s) running or queued.` : "Idle."));

  bot.on("message:text", (ctx) => handle(ctx, ctx.message.text));
  bot.catch((err) => log.error("telegram error", err.error));
  return bot;
}

/** Proactive messages (jobs, handoffs) go to the owner's private chat, which has the owner's id. */
export function ownerNotifier(bot: Bot): Notify {
  return async (text) => {
    for (const chunk of split(text)) await bot.api.sendMessage(config.ownerId, chunk);
  };
}
