import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Point the config at the example vault before anything imports it.
const here = path.dirname(fileURLToPath(import.meta.url));
process.env.VAULT_DIR = path.join(here, "..", "example-vault");
process.env.DATA_DIR = path.join(here, "..", "data-test");

const { isSilent } = await import("../src/silent.ts");
const { enqueue } = await import("../src/queue.ts");
const { detectLimit } = await import("../src/limits.ts");
const { parseNote, roster, agentDef } = await import("../src/agents.ts");
const { split } = await import("../src/telegram.ts");
const { describeTool } = await import("../src/progress.ts");

test("a job is silent only when the marker stands alone or ends the reply", () => {
  assert.equal(isSilent("NOTHING_TO_SEND"), true);
  assert.equal(isSilent("Checked everything, all quiet.\n\nNOTHING_TO_SEND"), true);
  assert.equal(isSilent("**NOTHING_TO_SEND**"), true);
  assert.equal(isSilent(""), true);
  assert.equal(isSilent("Your deadline is tomorrow. (Otherwise I'd have said NOTHING_TO_SEND, but this matters.)"), false);
});

test("the queue runs one task at a time, in order, and survives a failure", async () => {
  const order: string[] = [];
  let running = 0;
  const task = (name: string, ms: number, fail = false) => () =>
    new Promise<string>((resolve, reject) => {
      running++;
      assert.equal(running, 1, "two tasks overlapped");
      setTimeout(() => {
        running--;
        order.push(name);
        fail ? reject(new Error(name)) : resolve(name);
      }, ms);
    });
  const a = enqueue(task("a", 30));
  const b = enqueue(task("b", 5, true));
  const c = enqueue(task("c", 1));
  await assert.rejects(b);
  assert.deepEqual(await Promise.all([a, c]), ["a", "c"]);
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("usage limits are told apart from ordinary errors", () => {
  assert.equal(detectLimit("Claude AI usage limit reached|1730000000")?.resetsAt, 1730000000);
  assert.ok(detectLimit("", { status: "rejected", resetsAt: 42 }));
  assert.equal(detectLimit("API Error: 529 overloaded"), undefined);
});

test("note frontmatter parses, quotes and all", () => {
  const n = parseNote('---\ndescription: "Does research: finds things"\nmodel: haiku\n---\n# Body\ntext');
  assert.equal(n?.meta.description, "Does research: finds things");
  assert.equal(n?.meta.model, "haiku");
  assert.equal(n?.body, "# Body\ntext");
  assert.equal(parseNote("no frontmatter"), undefined);
});

test("specialists load from the vault, with their tools and memory instructions", async () => {
  const team = await roster();
  assert.deepEqual(team.map((a) => a.id).sort(), ["scout", "scribe"]);
  const scribe = agentDef(team.find((a) => a.id === "scribe")!);
  assert.deepEqual(scribe.tools, ["Read", "Glob", "Grep", "Write", "Edit"]);
  assert.match(scribe.prompt, /Agents\/Scribe\/Memory\.md/);
  assert.match(scribe.description, /^Scribe: /);
});

test("long replies split under Telegram's limit, at paragraph breaks", () => {
  const para = "x".repeat(3000);
  const parts = split(`${para}\n\n${para}`);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 4000));
});

test("tool calls read as plain status lines", () => {
  assert.equal(describeTool("Read", { file_path: path.join(process.env.VAULT_DIR!, "Projects", "A.md") }), "reading Projects/A.md");
  assert.equal(describeTool("mcp__handoff__need_human", { reason: "captcha" }), "waiting on you: captcha");
  assert.equal(describeTool("mcp__browser__browser_navigate", { url: "https://example.com/x" }), "opening example.com");
});
