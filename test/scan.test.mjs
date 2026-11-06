import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { anonymize, scanVault } from "../src/scan.mjs";

async function vault(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-"));
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

test("resolves links by path and name, and makes ghosts for missing notes", async () => {
  const g = await scanVault(await vault({
    "Projects/Alpha.md": "[[Beta|the beta]] and [[Missing Note]] and `[[Not A Link]]`",
    "Areas/Beta.md": "---\nup: \"[[Projects/Alpha]]\"\n---\nbody",
  }));
  assert.equal(g.notes.filter((n) => !n.unresolved).length, 2);
  assert.deepEqual(g.notes.filter((n) => n.unresolved).map((n) => n.title), ["Missing Note"]);
  assert.equal(g.edges.length, 2); // Alpha-Beta merged, Alpha-ghost
  assert.deepEqual(g.groups.map((x) => x.name), ["Areas", "Projects"]);
});

test("ignores dot folders", async () => {
  const g = await scanVault(await vault({ ".trash/Old.md": "x", "Keep.md": "y" }));
  assert.deepEqual(g.notes.map((n) => n.title), ["Keep"]);
});

test("anonymous output contains no names", async () => {
  const g = anonymize(await scanVault(await vault({
    "Secret Folder/Private Person.md": "[[Hidden Ghost]]",
    "Secret Folder/Other Private.md": "[[Private Person]]",
  })));
  const json = JSON.stringify(g);
  for (const word of ["Secret", "Private", "Hidden", "Ghost"]) assert.ok(!json.includes(word), word);
  assert.equal(g.notes.length, 3);
  assert.equal(g.edges.length, 2);
  assert.equal(g.vault, "");
});
