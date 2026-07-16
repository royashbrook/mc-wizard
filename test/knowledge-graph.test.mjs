import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  KNOWLEDGE_GRAPH_EXTRACTION_VERSION,
  buildKnowledgeGraph,
  createKnowledgeGraph,
  validateKnowledgeGraph,
} from "../src/knowledge-graph.mjs";
import { loadCorpus } from "../src/rag.mjs";

function chunk(id, text, overrides = {}) {
  return {
    id,
    title: overrides.title || id,
    text,
    source: overrides.source || `https://example.test/${id}`,
    sourcePolicy: "test-fixture",
    edition: "bedrock",
    channel: "stable",
    version: "current",
    kind: "official-doc",
    ...overrides,
  };
}

test("builds a deterministic, evidenced graph with typed components and release provenance", () => {
  const chunks = [
    chunk("cats", "Cats can be tamed with raw cod and raw salmon. The minecraft:tameable component records tame items."),
    chunk("commands", "A command block can execute /give for a player. The minecraft:behavior.follow_owner component is documented separately. The minecraft:amethyst_block block and minecraft:camel entity are also named."),
    chunk("patch", "Changed cat taming in this update: cats can be tamed with raw cod.", { kind: "patch-note", version: "1.21.100" }),
    chunk("preview", "Preview cats can be tamed with raw cod.", { channel: "preview" }),
    chunk("java", "Java cats can be tamed with raw cod.", { edition: "java" }),
  ];
  const first = buildKnowledgeGraph(chunks);
  const reversed = buildKnowledgeGraph([...chunks].reverse());

  assert.deepEqual(first, reversed);
  assert.equal(first.extractionVersion, KNOWLEDGE_GRAPH_EXTRACTION_VERSION);
  assert.ok(first.nodes.some(({ id }) => id === "component:minecraft_tameable"));
  assert.ok(first.nodes.some(({ id }) => id === "component:minecraft_behavior_follow_owner"));
  assert.ok(first.nodes.some(({ id }) => id === "block:minecraft_amethyst_block"));
  assert.ok(first.nodes.some(({ id }) => id === "entity:minecraft_camel"));
  assert.ok(first.edges.some(({ from, type, to, evidence }) => (
    from === "entity:cat" && type === "TAMED_WITH" && to === "item:raw_cod" && evidence.includes("cats")
  )));
  assert.ok(first.edges.some(({ from, type, to, evidence }) => (
    from === "block:command_block" && type === "RUNS_COMMAND" && to === "command:give" && evidence.includes("commands")
  )));
  assert.ok(first.edges.some(({ from, type, to, evidence }) => (
    from === "entity:cat" && type === "CHANGED_IN" && to === "release:1.21.100" && evidence.includes("patch")
  )));

  const graph = createKnowledgeGraph(first);
  const visible = graph.search("how do I tame a cat", { limit: 20 }).map(({ id }) => id);
  assert.ok(visible.includes("cats"));
  assert.equal(visible.includes("preview"), false);
  assert.equal(visible.includes("java"), false);
  assert.ok(graph.search("how do I tame a cat", { limit: 20, includePreview: true }).some(({ id }) => id === "preview"));
});

test("does not turn negated co-occurrence into a Minecraft fact", () => {
  const artifact = buildKnowledgeGraph([
    chunk("negative", "Cats cannot be tamed with raw cod, and command blocks cannot execute /give in this imaginary example.", {
      kind: "patch-note", version: "1.2.3",
    }),
  ]);
  assert.equal(artifact.edges.some(({ type }) => type === "TAMED_WITH" || type === "RUNS_COMMAND" || type === "CHANGED_IN"), false);
});

test("rejects stale graph artifacts when evidence or extraction metadata changes", () => {
  const chunks = [chunk("cats", "Cats can be tamed with raw cod. This sentence is intentionally long enough to be evidence.")];
  const artifact = buildKnowledgeGraph(chunks);
  assert.ok(validateKnowledgeGraph(artifact, chunks));

  const changedText = [chunk("cats", "Cats now have a changed source body that must invalidate the old evidence artifact.")];
  assert.equal(validateKnowledgeGraph(artifact, changedText), undefined);

  const changedMetadata = structuredClone(artifact);
  changedMetadata.documents[0].edition = "java";
  assert.equal(validateKnowledgeGraph(changedMetadata, chunks), undefined);

  const changedExtractor = structuredClone(artifact);
  changedExtractor.extractionVersion -= 1;
  assert.equal(validateKnowledgeGraph(changedExtractor, chunks), undefined);
});

test("hybrid retrieval reuses a persisted graph, excludes unsafe editions, and keeps lexical relevance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-graph-"));
  const root = join(directory, "corpus");
  const graphFile = join(directory, "knowledge-graph.json");
  const write = (file, body) => writeFile(join(root, file), body);
  try {
    await mkdir(root);
    await write("cats.md", `---\nedition: bedrock\nchannel: stable\nsource: https://example.test/cats\n---\n\n# Cats\n\nCats can be tamed with raw cod or raw salmon. This Bedrock guide explains how a player earns a pet cat.`);
    await write("cat-lore.md", `---\nedition: bedrock\nchannel: stable\nsource: https://example.test/lore\n---\n\n# Cat lore\n\nA cat statue is a nice decoration. This unrelated Bedrock story mentions cats but never explains taming food.`);
    await write("preview.md", `---\nedition: bedrock\nchannel: preview\nsource: https://example.test/preview\n---\n\n# Preview cats\n\nPreview cats can be tamed with raw cod. This sentence is only for explicit preview questions.`);
    await write("legacy-java.md", `---\nedition: bedrock\nchannel: stable\nsource: https://example.test/java\n---\n\n# Minecraft: Java Edition - 26.2\n\nJava cats can be tamed with raw cod. The legacy front matter is deliberately mislabeled.`);

    const roots = [{ dir: root, kind: "official-doc", id: "fixture" }];
    const fresh = await loadCorpus({ roots });
    await writeFile(graphFile, JSON.stringify(fresh.graphArtifact));
    const corpus = await loadCorpus({ roots, graphFile });
    assert.equal(corpus.graph.revision, fresh.graph.revision);

    const results = corpus.search("how do I tame a cat with raw cod", { limit: 10 });
    assert.match(results[0].title, /Cats/i);
    assert.equal(results.some(({ title }) => /Java Edition/i.test(title)), false);
    assert.equal(results.some(({ title }) => /Preview cats/i.test(title)), false);
    assert.ok(corpus.search("how do I tame a cat with raw cod", { limit: 10, includePreview: true })
      .some(({ title }) => /Preview cats/i.test(title)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a graph built in staging remains valid after promotion with the same creator revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-graph-promotion-"));
  const staging = join(directory, "releases", ".staging", "minecraft-creator", "creator", "Documents");
  const promoted = join(directory, "releases", "release-1", "minecraft-creator", "creator", "Documents");
  const markdown = `---\nedition: bedrock\nchannel: stable\n---\n\n# Cats\n\nCats can be tamed with raw cod. This Creator document has enough text to form a stable graph chunk.`;
  const creatorRef = "a".repeat(40);
  const id = "minecraft-creator/creator/Documents";
  try {
    await Promise.all([mkdir(staging, { recursive: true }), mkdir(promoted, { recursive: true })]);
    await Promise.all([writeFile(join(staging, "cats.md"), markdown), writeFile(join(promoted, "cats.md"), markdown)]);
    const staged = await loadCorpus({
      roots: [{ dir: staging, kind: "official-doc", id }],
      creatorRef,
    });
    const afterPromotion = await loadCorpus({
      roots: [{ dir: promoted, kind: "official-doc", id }],
      creatorRef,
      graphArtifact: staged.graphArtifact,
    });
    assert.equal(afterPromotion.graph.revision, staged.graph.revision);
    assert.equal(afterPromotion.graphArtifact.revision, staged.graphArtifact.revision);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
