#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { anonymize, scanVault } from "../src/scan.mjs";

const USAGE = `Usage: brain-graph <path to vault> [options]

  --out <file>    write one standalone HTML file instead of starting a server
  --anonymous     strip every note and folder name (use this before sharing)
  --port <n>      local port (default 4173)
  --no-open       don't open the browser
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    anonymous: { type: "boolean", default: false },
    port: { type: "string", default: "4173" },
    "no-open": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const vault = positionals[0];
if (opts.help || !vault) {
  process.stdout.write(USAGE);
  process.exit(opts.help ? 0 : 1);
}
const stat = await fs.stat(vault).catch(() => undefined);
if (!stat?.isDirectory()) {
  console.error(`Not a folder: ${vault}`);
  process.exit(1);
}

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const read = (f) => fs.readFile(path.join(web, f), "utf8");

async function page() {
  const scanned = await scanVault(vault);
  const data = opts.anonymous ? anonymize(scanned) : scanned;
  // A note called </script> must not end the data block early.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const [html, css, js] = await Promise.all([read("index.html"), read("graph.css"), read("graph.js")]);
  return {
    html: html.replace("/*CSS*/", () => css).replace("/*DATA*/", () => json).replace("/*JS*/", () => js),
    notes: data.notes.filter((n) => !n.unresolved).length,
    links: data.edges.length,
  };
}

if (opts.out) {
  const { html, notes, links } = await page();
  await fs.writeFile(opts.out, html);
  console.log(`Wrote ${opts.out}: ${notes} notes, ${links} links.`);
  if (!opts.anonymous) console.log("It contains your note names. Use --anonymous before sharing it.");
  process.exit(0);
}

const port = Number(opts.port);
// Bound to this machine only: the page lists every note name in the vault.
http.createServer(async (req, res) => {
  if (new URL(req.url, "http://x").pathname !== "/") { res.writeHead(404).end(); return; }
  try {
    const { html } = await page(); // Rescans on each load, so a refresh shows the vault as it is now.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(err));
  }
}).listen(port, "127.0.0.1", () => {
  const url = `http://localhost:${port}`;
  console.log(`Brain graph running at ${url}`);
  if (!opts["no-open"]) {
    const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd);
  }
});
