import fs from "node:fs/promises";
import path from "node:path";

/**
 * Reads a vault the way Obsidian does: notes, wikilinks resolved by exact path and then by
 * file name, frontmatter links, and ghost nodes for links to notes that don't exist yet.
 * Only file names and links leave this function. Note bodies are never kept.
 */

const WIKILINK = /(!?)\[\[([^\]|#^\\]+)(?:\\?[#^][^\]|]*)?(?:\\?\|[^\]]*)?\]\]/g;
const PALETTE = ["#d7b5ff", "#9fd3c7", "#f2c879", "#8fb8f0", "#f0a6a6", "#b7d98c", "#e8a6d6", "#c9c3b4", "#7fd0e8"];

const titleOf = (p) => path.posix.basename(p).replace(/\.md$/i, "");
const folderOf = (p) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : "");
const stripCode = (s) => s.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
const hex = (rgb) => `#${Number(rgb).toString(16).padStart(6, "0")}`;

async function walk(dir, rel = "") {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue; // .git, .obsidian, .trash
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(abs, r)));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push({ rel: r, abs });
  }
  return out;
}

/** The vault's own Obsidian colour groups when it has simple path queries, else one group per top-level folder. */
async function colorGroups(vault, folders) {
  try {
    const g = JSON.parse(await fs.readFile(path.join(vault, ".obsidian", "graph.json"), "utf8"));
    const groups = (g.colorGroups ?? []).map((c) => {
      const parts = String(c.query ?? "").split(/\s+OR\s+/);
      if (!parts.every((p) => /^path:\S+$/.test(p))) return undefined;
      const prefixes = parts.map((p) => p.slice(5).replace(/^"|"$/g, ""));
      return { name: prefixes.join(" / "), prefixes, color: hex(c.color?.rgb ?? 0) };
    }).filter(Boolean);
    if (groups.length) return groups;
  } catch {}
  return folders.map((f, i) => ({ name: f, prefixes: [`${f}/`], color: PALETTE[i % PALETTE.length] }));
}

export async function scanVault(vault) {
  const files = await walk(vault);
  const byLen = (a, b) => a.length - b.length || a.localeCompare(b);
  const byPath = new Map(), byName = new Map();
  for (const p of files.map((f) => f.rel).sort(byLen)) {
    byPath.set(p.replace(/\.md$/i, "").toLowerCase(), p);
    const n = titleOf(p).toLowerCase();
    if (!byName.has(n)) byName.set(n, p);
  }
  const resolve = (raw) => {
    const k = raw.trim().replace(/^\/+/, "").replace(/\.md$/i, "").toLowerCase();
    return byPath.get(k) ?? byName.get(k.split("/").pop()) ?? null;
  };

  const outgoing = new Map(), ghosts = new Map();
  for (const f of files) {
    const raw = await fs.readFile(f.abs, "utf8").catch(() => "");
    const out = new Set();
    for (const m of stripCode(raw).matchAll(WIKILINK)) {
      const target = m[2].trim();
      if (!target) continue;
      const to = resolve(target);
      if (to) { if (to !== f.rel) out.add(to); }
      else if (!m[1] && !path.posix.extname(target)) {
        const key = target.toLowerCase();
        if (!ghosts.has(key)) ghosts.set(key, target.split("/").pop());
        out.add(`?${ghosts.get(key)}`);
      }
    }
    outgoing.set(f.rel, out);
  }

  const notes = [], idx = new Map();
  for (const f of files) { idx.set(f.rel, notes.length); notes.push({ id: f.rel, title: titleOf(f.rel), folder: folderOf(f.rel), degree: 0 }); }
  for (const name of new Set(ghosts.values())) { idx.set(`?${name}`, notes.length); notes.push({ id: `?${name}`, title: name, folder: "", unresolved: true, degree: 0 }); }

  const seen = new Set(), edges = [];
  for (const [from, out] of outgoing) {
    const a = idx.get(from);
    for (const to of out) {
      const b = idx.get(to);
      if (b === undefined || b === a) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([a, b, 1]);
      notes[a].degree++; notes[b].degree++;
    }
  }
  const folders = [...new Set(notes.map((n) => n.folder).filter(Boolean))].sort();
  return { notes, edges, groups: await colorGroups(vault, folders), vault: path.basename(path.resolve(vault)) };
}

/** Strips every name, so a graph can be shared without showing what's in the vault. Shape and colours stay. */
export function anonymize(graph) {
  const { groups } = graph;
  const gi = (n) => groups.findIndex((g) => g.prefixes.some((p) => n.id.startsWith(p)));
  return {
    anonymous: true,
    vault: "",
    edges: graph.edges,
    groups: groups.map((g, i) => ({ name: `Group ${i + 1}`, prefixes: [`g${i}/`], color: g.color })),
    notes: graph.notes.map((n, i) => n.unresolved
      ? { id: `?${i}`, title: "", folder: "", unresolved: true, degree: n.degree }
      : { id: `g${gi(n)}/${i}`, title: "", folder: "", degree: n.degree }),
  };
}
