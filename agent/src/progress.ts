import path from "node:path";
import { config } from "./config.ts";

/** Called with a short, human description of each step the agent takes during a run. */
export type ProgressFn = (step: string) => void;

const clip = (s: unknown, max = 50) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

function rel(p: unknown): string {
  if (typeof p !== "string" || !p) return "";
  const r = path.relative(config.vaultDir, p);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r.replaceAll("\\", "/") : path.basename(p);
}

function host(u: unknown): string {
  try {
    return new URL(String(u)).hostname;
  } catch {
    return clip(u, 40);
  }
}

/** A Claude Code tool call as a phone-friendly status line ("reading Projects/X.md"). */
export function describeTool(name: string, input: any = {}): string {
  switch (name) {
    case "Read":
      return `reading ${rel(input.file_path)}`;
    case "Write":
    case "Edit":
    case "MultiEdit":
      return `updating ${rel(input.file_path)}`;
    case "Grep":
      return `searching the vault for "${clip(input.pattern, 40)}"`;
    case "Glob":
      return `looking for ${clip(input.pattern, 40)}`;
    case "WebSearch":
      return `searching the web: ${clip(input.query)}`;
    case "WebFetch":
      return `opening ${host(input.url)}`;
    case "TodoWrite":
      return "planning";
    case "Bash":
      return `running ${clip(String(input.command ?? "").split(/\s+/)[0], 20)}`;
  }
  if (name === "mcp__handoff__need_human") return `waiting on you: ${clip(input.reason)}`;
  if (name.startsWith("mcp__browser__")) {
    const t = name.replace(/^mcp__browser__(browser_)?/, "");
    if (t === "navigate") return `opening ${host(input.url)}`;
    return `browser: ${t.replaceAll("_", " ")}`;
  }
  return clip(name.replace(/^mcp__/, "").replaceAll("__", ": ").replaceAll("_", " "), 40);
}
