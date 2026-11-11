import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { config } from "./config.ts";
import { currentHandoff, driveTab, finishHandoff, liveTabs, liveToken, streamTab } from "./live.ts";
import { log } from "./log.ts";

/**
 * The /live page and its small API. Security model:
 * - Bind WEB_HOST to a private address (a Tailscale IP, or 127.0.0.1 behind a tunnel).
 * - Every call that shows or drives the browser needs the random token from the link.
 * - API calls also need a custom header, which a cross-site page can't send without a CORS
 *   preflight that's never approved.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();
const tokenOk = (t: unknown) => typeof t === "string" && timingSafeEqual(digest(t), digest(liveToken()));

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readBody(req: http.IncomingMessage, max = 10_000): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new Error("body too large");
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://local");
  const p = url.pathname;

  if (req.method === "GET" && p === "/live") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "x-frame-options": "DENY",
      // The token is in the URL, so never leak it to another site.
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    });
    return res.end(await fs.readFile(path.join(config.root, "web", "live.html")));
  }
  // EventSource can't send headers, so the stream takes the token in the query. Read-only.
  if (req.method === "GET" && p === "/live/stream") {
    if (!tokenOk(url.searchParams.get("t"))) return json(res, 401, { error: "bad link" });
    return streamTab(url.searchParams.get("tab") ?? "", req, res);
  }
  if (!p.startsWith("/api/live")) return json(res, 404, { error: "not found" });
  if (!tokenOk(req.headers["x-live-token"])) return json(res, 401, { error: "bad link" });

  if (req.method === "GET" && p === "/api/live") return json(res, 200, { handoff: (await currentHandoff()) ?? null, tabs: await liveTabs() });
  if (req.method === "POST" && p === "/api/live/input") {
    const b = await readBody(req);
    await driveTab(String(b.tab ?? ""), b);
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/live/done") return json(res, 200, { ok: await finishHandoff(String((await readBody(req)).note ?? "")) });
  return json(res, 404, { error: "not found" });
}

export function liveUrl(): string | undefined {
  if (!config.webHost) return undefined;
  return config.publicUrl || `http://${config.webHost}:${config.webPort}`;
}

export function startWeb(): void {
  if (!config.webHost || !config.browserLive) return;
  http
    .createServer((req, res) =>
      route(req, res).catch((err) => {
        if (!res.headersSent) json(res, 500, { error: (err as Error).message });
        else res.end();
      }),
    )
    .listen(config.webPort, config.webHost, () => log.info(`/live page on http://${config.webHost}:${config.webPort}/live`));
}
