#!/usr/bin/env node
// need_human: the agent hands its live browser to you (captchas, logins, verification codes) and
// waits until you press Done on /live. An MCP server over stdio, started by Claude Code per run.
// It can't reach Telegram itself: it writes DATA_DIR/handoff.json, which the main process watches
// (src/live.ts) and turns into a message with the link.
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const FILE = path.join(process.env.DATA_DIR || "data", "handoff.json");
const WAIT = Number(process.env.HANDOFF_WAIT_MS) || 5 * 60_000;

async function write(v) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE + ".tmp", JSON.stringify(v));
  await fs.rename(FILE + ".tmp", FILE);
}
const read = () => fs.readFile(FILE, "utf8").then(JSON.parse, () => ({}));

const TOOLS = [
  {
    name: "need_human",
    description:
      "Hand the browser to your owner for something only they can do: a captcha or 'are you human' check, signing in or creating an account, a verification code or email link. " +
      `They get a link to watch and drive your current tab from their phone. This call waits (up to ${Math.round(WAIT / 60_000)} minutes) until they press Done. ` +
      "Leave the tab where it is while you wait, and take a fresh browser snapshot afterwards. Never try to solve or get around a captcha or bot check yourself.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", description: "What they need to do, in a few words, e.g. 'hCaptcha on the sign-up page'." } },
      required: ["reason"],
    },
  },
];

async function needHuman({ reason }) {
  reason = String(reason || "").trim().slice(0, 200);
  if (!reason) throw new Error("Say what they need to do.");
  const at = Date.now();
  await write({ reason, at, until: at + WAIT, status: "waiting" });
  while (Date.now() < at + WAIT) {
    await new Promise((r) => setTimeout(r, 1500));
    const h = await read();
    if (h.at !== at) return "Another handoff replaced this one. Take a snapshot and check where things stand.";
    if (h.status === "done") return `They pressed Done${h.note ? ` and said: "${h.note}"` : ""}. Take a fresh browser snapshot and carry on from where the page is now.`;
  }
  await write({ reason, at, until: at + WAIT, status: "timeout" });
  return `They didn't get to it in time. Don't submit anything. Stop here and tell them in a line or two what's left ("${reason}"). The browser keeps its logins, so the next attempt can pick up from there.`;
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (id === undefined) return;
  if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "handoff", version: "1.0.0" } } });
  else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  else if (method === "tools/call") {
    try {
      if (params.name !== "need_human") throw new Error(`Unknown tool ${params.name}`);
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: await needHuman(params.arguments ?? {}) }] } });
    } catch (err) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Handoff error: ${err.message}` }], isError: true } });
    }
  } else if (method === "ping") send({ jsonrpc: "2.0", id, result: {} });
  else send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
});
