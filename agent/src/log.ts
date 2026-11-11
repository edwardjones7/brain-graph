import { inspect } from "node:util";

// grammy's network errors carry the request URL, and that URL contains the bot token.
const TELEGRAM_TOKEN = /\b(?:bot)?\d{6,}:[\w-]{30,}/g;

function write(level: string, out: (...a: unknown[]) => void, a: unknown[]) {
  const text = a.map((x) => (typeof x === "string" ? x : inspect(x, { depth: 3 }))).join(" ").replace(TELEGRAM_TOKEN, "bot***");
  out(new Date().toISOString(), level, text);
}

export const log = {
  info: (...a: unknown[]) => write("INFO", console.log, a),
  warn: (...a: unknown[]) => write("WARN", console.warn, a),
  error: (...a: unknown[]) => write("ERROR", console.error, a),
};
