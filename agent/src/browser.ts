import path from "node:path";
import { config } from "./config.ts";
import { liveCdpEndpoint } from "./live.ts";

/**
 * The agent's browser: Microsoft's Playwright MCP server, for pages WebFetch can't handle
 * (JavaScript-heavy sites, clicking through, forms). Off unless BROWSER=true, because browsing is
 * token-hungry and widens the prompt-injection surface: a page can try to steer an agent that has
 * a shell.
 *
 * - Default: headless and --isolated, a fresh in-memory profile every run. No saved logins, so a
 *   hostile page can't act as you anywhere.
 * - BROWSER_LIVE=true: drive the agent's own Chromium instead (live.ts), with a saved profile you
 *   can take over from /live. Logins stick, which is the point and also the risk.
 * - The /live page itself is blocked, so a page can't make the browser drive itself.
 */
export function browserMcpServer(): Record<string, unknown> | undefined {
  if (!config.browser) return undefined;
  const mode = config.browserLive ? ["--cdp-endpoint", liveCdpEndpoint()] : ["--headless", "--isolated", "--browser", "chromium"];
  const own = [`http://127.0.0.1:${config.webPort}`, `http://localhost:${config.webPort}`, ...(config.webHost ? [`http://${config.webHost}:${config.webPort}`] : [])];
  return {
    command: process.execPath,
    args: [
      path.join(config.root, "node_modules", "@playwright", "mcp", "cli.js"),
      ...mode,
      "--blocked-origins", [...new Set(own)].join(";"),
      "--output-dir", path.join(config.dataDir, "browser"),
      "--idle-timeout", String(config.claudeTimeoutMs),
    ],
  };
}
