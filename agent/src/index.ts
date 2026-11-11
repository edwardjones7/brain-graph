import { config } from "./config.ts";
import { scheduleJobs } from "./jobs.ts";
import { startHandoffWatcher } from "./live.ts";
import { log } from "./log.ts";
import { sweepIdleSessions } from "./sessions.ts";
import { createBot, ownerNotifier } from "./telegram.ts";
import { liveUrl, startWeb } from "./web.ts";

if (!config.telegramToken || !config.ownerId) throw new Error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID in .env (see .env.example).");
log.info(`${config.agentName} starting. Vault: ${config.vaultDir}, git sync: ${config.gitSync}`);

const bot = createBot();
const notify = ownerNotifier(bot);

await scheduleJobs(notify);
startWeb();
startHandoffWatcher(notify, liveUrl());
// File idle conversations into the vault. Every 10 minutes is plenty for an hours-long idle window.
setInterval(() => void sweepIdleSessions().catch((err) => log.error("idle sweep failed", err)), 10 * 60_000);

for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void bot.stop().then(() => process.exit(0)));
await bot.start({ onStart: (me) => log.info(`Telegram bot @${me.username} online`) });
