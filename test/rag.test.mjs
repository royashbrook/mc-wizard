import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractiveAnswer, loadCorpus } from "../src/rag.mjs";

const KNOWLEDGE_DIR = fileURLToPath(new URL("../knowledge", import.meta.url));

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

// Issue #35: extractive offline answers from the vetted corpus.
test("extractiveAnswer returns a verbatim, attributed sentence for a taming question", async (t) => {
  t.mock.method(console, "warn", () => {});
  const corpus = await loadCorpus({ roots: [{ dir: KNOWLEDGE_DIR, kind: "mechanic-card", id: "knowledge" }] });
  const hits = corpus.search("how do I tame a cat");
  assert.ok(hits.length > 0);

  const answer = extractiveAnswer("how do I tame a cat", hits);
  assert.ok(answer, "expected an extractive answer");
  assert.ok(answer.length <= 420);
  assert.match(answer, /raw cod or raw salmon/);
  assert.match(answer, /^Here's what my spellbook says: /);
  assert.ok(answer.endsWith(`(from my ${hits[0].title} notes)`));

  const body = answer
    .slice("Here's what my spellbook says: ".length, answer.lastIndexOf(" (from my"));
  for (const sentence of body.split(/(?<=[.!?])\s+/)) {
    assert.ok(hits[0].text.includes(sentence), `sentence not verbatim from source: ${sentence}`);
  }
});

test("extractiveAnswer returns null for zero hits and for weak overlap", () => {
  assert.equal(extractiveAnswer("how do I tame a cat", []), null);
  assert.equal(extractiveAnswer("how do I tame a cat", undefined), null);
  // No sentence shares any stemmed question token: no hallucinated stitching.
  const hits = [{
    title: "Redstone Basics",
    text: "Redstone repeaters delay signals by up to four ticks. Observers detect block updates and emit a pulse.",
  }];
  assert.equal(extractiveAnswer("how do I tame a cat", hits), null);
});

// Adversarial finding: "what is X" / one-word child questions reduce to a single
// content token after stopword removal, so the old 2-token overlap floor could never
// fire and the wizard falsely claimed its spellbook was empty while holding the card.
test("extractiveAnswer answers short one-token questions ('what is redstone')", async (t) => {
  t.mock.method(console, "warn", () => {});
  const corpus = await loadCorpus({ roots: [{ dir: KNOWLEDGE_DIR, kind: "mechanic-card", id: "knowledge" }] });
  for (const question of ["what is redstone", "whats redstone", "creepers?"]) {
    const hits = corpus.search(question);
    assert.ok(hits.length > 0, `expected corpus hits for: ${question}`);
    const answer = extractiveAnswer(question, hits);
    assert.ok(answer, `expected an extractive answer for: ${question}`);
    assert.ok(answer.length <= 420);
    assert.match(answer, /^Here's what my spellbook says: /);
    assert.ok(answer.endsWith(`(from my ${hits[0].title} notes)`));
    const body = answer.slice("Here's what my spellbook says: ".length, answer.lastIndexOf(" (from my"));
    for (const sentence of body.split(/(?<=[.!?])\s+/)) {
      assert.ok(hits[0].text.includes(sentence), `sentence not verbatim from source: ${sentence}`);
    }
  }
});

test("extractiveAnswer keeps the 2-token floor for longer questions and rejects gibberish", () => {
  const hits = [{
    title: "Redstone Basics",
    text: "Redstone repeaters delay signals by up to four ticks. Bamboo grows tall in jungle biomes.",
  }];
  // Four content tokens (breed/panda/bamboo/forest); best sentence matches only one.
  assert.equal(extractiveAnswer("how do you breed pandas with bamboo forests", hits), null);
  // A gibberish single token still returns null even when hits are present.
  assert.equal(extractiveAnswer("zxqvbn", hits), null);
  assert.equal(extractiveAnswer("what is a zxqvbn", hits), null);
});

test("extractiveAnswer never emits '/'-prefixed command text", () => {
  const hits = [{
    title: "Cats in Minecraft Bedrock",
    text: "Run /summon cat to spawn a tame cat instantly with commands. To tame a cat, hold raw fish and approach slowly. Use /give to hand yourself a cat spawn egg.",
  }];
  const answer = extractiveAnswer("how do I tame a cat", hits);
  assert.ok(answer);
  assert.doesNotMatch(answer, /(^|[\s(`"'[])\/[a-z]/i);
  assert.match(answer, /hold raw fish/);

  // When every overlapping sentence documents commands, extraction refuses entirely.
  const commandOnly = [{
    title: "Commands",
    text: "Run /summon cat to spawn a tame cat. Use /ride to tame a cat mount.",
  }];
  assert.equal(extractiveAnswer("how do I tame a cat", commandOnly), null);
});

// Issue #35: loud empty-corpus flag when only base knowledge/ cards loaded.
test("loadCorpus flags base-only corpora and warns once naming sync-docs", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const corpus = await loadCorpus({ roots: [{ dir: KNOWLEDGE_DIR, kind: "mechanic-card", id: "knowledge" }] });
  assert.equal(corpus.baseOnly, true);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /scripts\/sync-docs\.mjs/);
});

test("loadCorpus with a synthetic synced release sets baseOnly false and stays quiet", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const temp = await mkdtemp(join(tmpdir(), "mc-wizard-rag-"));
  const docs = join(temp, "Documents");
  await mkdir(docs);
  await writeFile(join(docs, "cats.md"), "# Cat Behaviors\n\nCats frighten creepers and phantoms in Bedrock Edition. A tamed cat follows its owner unless told to sit.");
  try {
    const corpus = await loadCorpus({
      roots: [
        { dir: KNOWLEDGE_DIR, kind: "mechanic-card", id: "knowledge" },
        { dir: docs, kind: "official-doc", id: "minecraft-creator/creator/Documents" },
      ],
    });
    assert.equal(corpus.baseOnly, false);
    assert.equal(warn.mock.callCount(), 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("loadCorpus stays non-fatal when a root or file is missing", async (t) => {
  t.mock.method(console, "warn", () => {});
  const temp = await mkdtemp(join(tmpdir(), "mc-wizard-rag-"));
  const root = join(temp, "cards");
  await mkdir(root);
  await writeFile(join(root, "real.md"), "# Real Card\n\nStray cats appear around populated villages and can be tamed with raw fish over time.");
  // Broken symlink: the directory listing includes it, loading must skip it.
  await symlink(join(temp, "deleted.md"), join(root, "ghost.md"));
  try {
    const corpus = await loadCorpus({
      roots: [
        { dir: root, kind: "mechanic-card", id: "cards" },
        { dir: join(temp, "does-not-exist"), kind: "official-doc", id: "missing" },
      ],
    });
    assert.ok(corpus.size >= 1);
    assert.equal(corpus.baseOnly, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
