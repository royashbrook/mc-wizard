import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadCorpus } from "../src/rag.mjs";

test("resolves in-root JSON sources and rejects symlinks outside the corpus", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mc-wizard-rag-"));
  const root = join(temp, "corpus");
  await mkdir(root);
  await writeFile(join(root, "cat.json"), '{"minecraft:tameable":{"tame_items":["fish","salmon"]}}');
  await writeFile(join(root, "cat.md"), '# Cat\n\n:::code language="json" source="cat.json":::');
  await writeFile(join(temp, "private.json"), '{"secret":"must-not-enter-corpus"}');
  await symlink(join(temp, "private.json"), join(root, "outside.json"));
  await writeFile(join(root, "outside.md"), '# Outside\n\n:::code language="json" source="outside.json":::');

  try {
    const corpus = await loadCorpus({ roots: [{ dir: root, kind: "test" }] });
    assert.match(corpus.search("tameable cat")[0].text, /tame_items/);
    assert.deepEqual(corpus.search("must not enter corpus"), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
