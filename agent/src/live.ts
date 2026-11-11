import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { config } from "./config.ts";
import { log } from "./log.ts";

/**
 * The live browser: the agent's own Chromium, which Playwright MCP drives over DevTools (CDP) and
 * you can watch and drive from the /live page. It exists for the two things a throwaway headless
 * browser can't get past alone: captchas, which want a human, and accounts, which need logins
 * that stick between runs (the profile is saved in data/browser-profile).
 *
 * It doesn't try to beat captchas or bot checks. The agent calls need_human (handoff-mcp.mjs),
 * which writes data/handoff.json; the watcher here sends you the /live link; you tap through it on
 * your phone and press Done, which the tool is polling for.
 *
 * Trade-off of the saved profile: a page the agent opens can act with whatever sessions it holds.
 * Keep it to the sites the agent works on. Never sign into email or banking in it.
 */

const cdpBase = () => `http://127.0.0.1:${config.browserCdpPort}`;
const profileDir = () => path.join(config.dataDir, "browser-profile");
const handoffFile = () => path.join(config.dataDir, "handoff.json");

// ---------- Chromium ----------

/** Newest Chromium Playwright downloaded, for when its own pinned build isn't installed. */
function cachedChromium(): string | undefined {
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
      : process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local", "ms-playwright")
      : path.join(os.homedir(), ".cache", "ms-playwright"));
  const dirs = fsSync.existsSync(cache)
    ? fsSync.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    : [];
  const inner = [
    ["chrome-linux64", "chrome"],
    ["chrome-linux", "chrome"],
    ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-win64", "chrome.exe"],
    ["chrome-win", "chrome.exe"],
  ];
  for (const d of dirs) for (const parts of inner) {
    const p = path.join(cache, d, ...parts);
    if (fsSync.existsSync(p)) return p;
  }
  return undefined;
}

async function chromiumPath(): Promise<string> {
  if (config.browserExecutable) return config.browserExecutable;
  const pinned = await import("playwright-core").then((m) => m.chromium.executablePath(), () => "");
  const found = pinned && fsSync.existsSync(pinned) ? pinned : cachedChromium();
  if (!found) throw new Error("No Chromium for the live browser. Run `npx playwright install chromium` or set BROWSER_EXECUTABLE.");
  return found;
}

async function cdpUp(): Promise<boolean> {
  return fetch(`${cdpBase()}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
}

let starting: Promise<void> | undefined;

/**
 * Start the live browser unless it's already up. Detached, so it outlives `npm run ask` and keeps
 * a tab open while the agent waits on you; one profile means one Chromium, so every run shares it.
 */
export function ensureLiveBrowser(): Promise<void> {
  starting ??= (async () => {
    if (await cdpUp()) return;
    await fs.mkdir(profileDir(), { recursive: true });
    const args = [
      `--remote-debugging-port=${config.browserCdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir()}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      // A real window when there's a display (Xvfb on the server makes one); new headless otherwise.
      ...(process.platform === "linux" && !process.env.DISPLAY ? ["--headless=new"] : []),
      // Ubuntu 23.10+ blocks the user namespaces Chromium's sandbox needs. Playwright launches
      // without it by default too, so this matches the headless browser it replaces.
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      "about:blank",
    ];
    const child = spawn(await chromiumPath(), args, { detached: true, stdio: "ignore" });
    child.on("error", (err) => log.error("live browser failed to start", err));
    child.unref();
    for (let i = 0; i < 40; i++) {
      if (await cdpUp()) return log.info(`live browser up on ${cdpBase()}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`live browser didn't open DevTools on ${cdpBase()}`);
  })().finally(() => (starting = undefined));
  return starting;
}

export const liveCdpEndpoint = cdpBase;

// ---------- handoff ----------

/**
 * The secret in the /live link. Whoever has it can drive the browser, so it's random, kept in
 * data/ (survives restarts, so an old link still works) and never logged.
 */
let token: string | undefined;
export function liveToken(): string {
  if (token) return token;
  const f = path.join(config.dataDir, "live-token");
  try {
    token = fsSync.readFileSync(f, "utf8").trim();
  } catch {}
  if (!token) {
    token = randomBytes(24).toString("base64url");
    fsSync.mkdirSync(config.dataDir, { recursive: true });
    fsSync.writeFileSync(f, token, { mode: 0o600 });
  }
  return token;
}

export interface Handoff {
  reason: string;
  at: number;
  until: number;
  status: "waiting" | "done" | "timeout";
  note?: string;
}

function readHandoffSync(): Handoff | undefined {
  try {
    return JSON.parse(fsSync.readFileSync(handoffFile(), "utf8")) as Handoff;
  } catch {
    return undefined;
  }
}

/**
 * How much longer the current run should be allowed while the agent waits on you, so the run
 * timeout doesn't kill a task you're halfway through unblocking. 0 when nobody's waiting.
 */
export function handoffHoldMs(): number {
  const h = readHandoffSync();
  return h?.status === "waiting" && h.until > Date.now() ? h.until - Date.now() + 90_000 : 0;
}

export async function currentHandoff(): Promise<Handoff | undefined> {
  const h = readHandoffSync();
  return h?.status === "waiting" && h.until > Date.now() ? h : undefined;
}

/** You pressed Done on /live. need_human is polling the file and returns to the agent. */
export async function finishHandoff(note: string): Promise<boolean> {
  const h = readHandoffSync();
  if (h?.status !== "waiting") return false;
  const tmp = handoffFile() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify({ ...h, status: "done", note: note.slice(0, 300) }));
  await fs.rename(tmp, handoffFile());
  return true;
}

/** Message you once per handoff. The MCP tool can't reach Telegram itself, so this polls the file. */
export function startHandoffWatcher(notify: (text: string) => Promise<void>, liveUrl: string | undefined): void {
  if (!config.browserLive) return;
  let told = 0;
  setInterval(() => {
    const h = readHandoffSync();
    if (h?.status !== "waiting" || h.at === told || h.until < Date.now()) return;
    told = h.at;
    const mins = Math.max(1, Math.round((h.until - Date.now()) / 60_000));
    const link = liveUrl ? `\n${liveUrl}/live?t=${liveToken()}` : "\n(The /live page is off, so there's no link. Set WEB_HOST.)";
    void notify(`${config.agentName} needs you: ${h.reason}${link}\nTap through it and press Done. It'll wait ${mins} min.`).catch((err) =>
      log.error("handoff notify failed", err),
    );
  }, 2000).unref();
}

// ---------- viewing and driving a tab over CDP ----------

export interface Tab {
  id: string;
  title: string;
  url: string;
}

interface Target extends Tab {
  type: string;
  webSocketDebuggerUrl?: string;
}

async function targets(): Promise<Target[]> {
  const r = await fetch(`${cdpBase()}/json/list`, { signal: AbortSignal.timeout(3000) });
  return ((await r.json()) as Target[]).filter((t) => t.type === "page" && !t.url.startsWith("devtools://") && t.webSocketDebuggerUrl);
}

/** Open tabs, the one most likely to be the agent's first (Chrome lists the last active first). */
export async function liveTabs(): Promise<Tab[]> {
  if (!config.browserLive || !(await cdpUp())) return [];
  const ts = await targets();
  const real = ts.filter((t) => t.url !== "about:blank");
  return [...real, ...ts.filter((t) => t.url === "about:blank")].map(({ id, title, url }) => ({ id, title, url }));
}

/** One DevTools connection to one tab. A second client next to Playwright's is fine with Chrome. */
class TabSession {
  private ws: WebSocket;
  private seq = 0;
  private waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private listeners = new Set<(method: string, params: any) => void>();
  readonly open: Promise<void>;
  closed = false;
  /** Size of the page in CSS pixels, from the last screencast frame, for mapping taps. */
  view = { w: 1280, h: 900 };

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.open = new Promise((ok, fail) => {
      this.ws.addEventListener("open", () => ok(), { once: true });
      this.ws.addEventListener("error", () => fail(new Error("couldn't connect to the tab")), { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const w = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) w?.fail(new Error(msg.error.message));
        else w?.ok(msg.result);
      } else for (const l of this.listeners) l(msg.method, msg.params);
    });
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const w of this.waiting.values()) w.fail(new Error("tab closed"));
      this.waiting.clear();
      for (const l of this.listeners) l("closed", {});
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    await this.open;
    const id = ++this.seq;
    return new Promise((ok, fail) => {
      this.waiting.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(l: (method: string, params: any) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  close() {
    this.ws.close();
  }
}

const sessions = new Map<string, TabSession>();

async function session(tabId: string): Promise<TabSession> {
  const have = sessions.get(tabId);
  if (have && !have.closed) return have;
  const t = (await targets()).find((x) => x.id === tabId);
  if (!t?.webSocketDebuggerUrl) throw new Error("That tab is gone.");
  const s = new TabSession(t.webSocketDebuggerUrl);
  sessions.set(tabId, s);
  await s.open;
  return s;
}

/**
 * Stream a tab as Server-Sent Events of JPEG frames. Chrome only sends a frame when the page
 * changes, so an idle page costs nothing. Ends when the viewer leaves.
 */
export async function streamTab(tabId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const s = await session(tabId);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
  const off = s.on((method, params) => {
    if (method === "Page.screencastFrame") {
      s.view = { w: params.metadata.deviceWidth, h: params.metadata.deviceHeight };
      s.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
      res.write(`data: ${JSON.stringify({ img: params.data, w: s.view.w, h: s.view.h })}\n\n`);
    } else if (method === "closed") res.end();
  });
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    off();
    s.send("Page.stopScreencast").catch(() => {});
  });
  await s.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 2000 });
}

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Backspace: { code: "Backspace", vk: 8 },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
};

/** A tap, typing, a key, a scroll or a link from the /live page. x and y are fractions of the frame. */
export async function driveTab(tabId: string, a: Record<string, unknown>): Promise<void> {
  const s = await session(tabId);
  const frac = (v: unknown) => Math.min(Math.max(Number(v) || 0, 0), 1);
  const x = frac(a.x) * s.view.w;
  const y = frac(a.y) * s.view.h;
  if (a.type === "tap") {
    await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  } else if (a.type === "scroll") {
    const dy = Math.min(Math.max(Number(a.dy) || 0, -3000), 3000);
    await s.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy });
  } else if (a.type === "text") {
    await s.send("Input.insertText", { text: String(a.text ?? "").slice(0, 2000) });
  } else if (a.type === "key") {
    const key = String(a.key);
    const k = KEYS[key];
    if (!k) throw new Error(`Unsupported key ${key}`);
    await s.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: k.code, windowsVirtualKeyCode: k.vk, ...(k.text ? { text: k.text } : {}) });
    await s.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: k.code, windowsVirtualKeyCode: k.vk });
  } else if (a.type === "back") {
    await s.send("Runtime.evaluate", { expression: "history.back()" });
  } else if (a.type === "goto") {
    // So you can sign in to a site ahead of time. https only: no file:// or anything local.
    const url = new URL(String(a.url ?? ""));
    if (url.protocol !== "https:") throw new Error("Only https links.");
    await s.send("Page.navigate", { url: url.href });
  } else throw new Error("Unknown input");
}
