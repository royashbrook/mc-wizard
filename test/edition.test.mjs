import assert from "node:assert/strict";
import test from "node:test";

import { classifyEdition, normalizeChannel } from "../src/edition.mjs";

test("classifies official release notes fail-closed by edition and channel", () => {
  assert.equal(classifyEdition({ title: "Minecraft: Java Edition - 26.2", kind: "patch-note" }), "java");
  assert.equal(classifyEdition({ title: "Minecraft - 1.21.132 (Bedrock)", kind: "patch-note" }), "bedrock");
  assert.equal(classifyEdition({ title: "Bedrock Preview 1.21.100.20", channel: "preview", kind: "patch-note" }), "bedrock");
  assert.equal(classifyEdition({ title: "Minecraft 1.21.100 Hotfix", kind: "patch-note" }), "unknown");
  assert.equal(classifyEdition({
    title: "Minecraft: Java Edition - 26.2", body: "This article compares Bedrock Edition behavior.", kind: "patch-note",
  }), "unknown");
  assert.equal(normalizeChannel("beta"), "unknown");
  assert.equal(normalizeChannel("preview"), "preview");
  assert.equal(classifyEdition({ title: "Creator API", kind: "official-doc" }), "bedrock");
});
