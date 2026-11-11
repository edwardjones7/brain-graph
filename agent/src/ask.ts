import { chat } from "./sessions.ts";

// Talk to the agent from a terminal, without Telegram: npm run ask -- "what's on my plate today?"
const message = process.argv.slice(2).join(" ").trim();
if (!message) {
  console.error('Usage: npm run ask -- "your message"');
  process.exit(1);
}
const r = await chat("cli", message, "cli", (step) => console.error(`  · ${step}`));
console.log(r.text);
if (r.filesChanged.length) console.error(`\nchanged: ${r.filesChanged.join(", ")}`);
