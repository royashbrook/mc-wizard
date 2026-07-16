import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createFilePlayerPreferenceStore,
  createMemoryPlayerPreferenceStore,
  describePlayerPreferences,
  parsePlayerPreferenceInstruction,
  playerPreferencePrompt,
} from "../src/player-preferences.mjs";

test("keeps normalized player preferences private and independently deletable", async () => {
  const preferences = createMemoryPlayerPreferenceStore({ now: () => 1_000 });
  await preferences.set("player-a", { kind: "proximity", minimumDistance: 8 });
  await preferences.set("player-a", {
    kind: "material", blockId: "minecraft:red_mushroom_block", label: "mushroom blocks", exclusive: true,
  });
  await preferences.set("player-b", { kind: "teleport", askBeforeTeleport: true });

  assert.deepEqual(preferences.get("player-a").map(({ kind }) => kind), ["material", "proximity"]);
  assert.deepEqual(preferences.get("player-b").map(({ kind }) => kind), ["teleport"]);
  assert.deepEqual(preferences.get("spoofed-player-a"), []);
  const removed = await preferences.remove("player-a", "material");
  assert.equal(removed.removed, true);
  assert.deepEqual(preferences.get("player-a").map(({ kind }) => kind), ["proximity"]);
  assert.equal((await preferences.clear("player-a")).removed, true);
  assert.deepEqual(preferences.get("player-a"), []);
  assert.deepEqual(preferences.get("player-b").map(({ kind }) => kind), ["teleport"]);
});

test("persists opaque actor-keyed preferences without identities or goals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-preferences-"));
  const filePath = join(directory, "preferences.json");
  try {
    const store = await createFilePlayerPreferenceStore({
      filePath,
      salt: "test-preference-salt-long-enough",
      now: () => 2_000,
    });
    await store.set("stable-bedrock-player-id", { kind: "proximity", minimumDistance: 9 });
    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /stable-bedrock-player-id|goal|requestId|question/i);
    const reloaded = await createFilePlayerPreferenceStore({
      filePath,
      salt: "test-preference-salt-long-enough",
      now: () => 3_000,
    });
    assert.equal(reloaded.get("stable-bedrock-player-id")[0].minimumDistance, 9);
    assert.deepEqual(reloaded.get("other-bedrock-player-id"), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recognizes child-friendly memory requests without accepting a foreign target", () => {
  assert.deepEqual(parsePlayerPreferenceInstruction("you are standing too close"), {
    type: "set", preference: { kind: "proximity", minimumDistance: 8 },
  });
  assert.deepEqual(parsePlayerPreferenceInstruction("from now on build my stuff with only mushroom blocks"), {
    type: "set", preference: {
      kind: "material", blockId: "minecraft:red_mushroom_block", label: "mushroom blocks", exclusive: true,
    },
  });
  assert.deepEqual(parsePlayerPreferenceInstruction("don't do that again", {
    previousQuestion: "take me to the Nether", previousAction: { type: "dimension_travel" },
  }), { type: "set", preference: { kind: "teleport", askBeforeTeleport: true } });
  assert.deepEqual(parsePlayerPreferenceInstruction("forget everything about me"), { type: "clear" });
  assert.deepEqual(parsePlayerPreferenceInstruction("forget everything"), { type: "clear" });
  assert.deepEqual(parsePlayerPreferenceInstruction("remove all my notes"), { type: "clear" });
  assert.deepEqual(parsePlayerPreferenceInstruction("show my notes"), { type: "list" });
  assert.deepEqual(parsePlayerPreferenceInstruction("tell me what you remember about me"), { type: "list" });
  assert.deepEqual(parsePlayerPreferenceInstruction("forget Alex's material preference"), { type: "private" });
  assert.deepEqual(parsePlayerPreferenceInstruction("forget Alex’s material preference"), { type: "private" });
  assert.deepEqual(parsePlayerPreferenceInstruction("delete all of Alex’s memories"), { type: "private" });
  assert.equal(parsePlayerPreferenceInstruction("remove all the mushroom blocks"), undefined);
  assert.equal(parsePlayerPreferenceInstruction("delete all the zombies"), undefined);
  assert.deepEqual(parsePlayerPreferenceInstruction("always ask before teleporting me"), {
    type: "set", preference: { kind: "teleport", askBeforeTeleport: true },
  });
  assert.deepEqual(parsePlayerPreferenceInstruction("remove my mushroom block preference"), { type: "remove", kind: "material" });
  assert.deepEqual(parsePlayerPreferenceInstruction("forget that"), { type: "remove-last" });
  assert.deepEqual(parsePlayerPreferenceInstruction("what do you remember about Alex"), { type: "private" });
});

test("turns only the current player's compact policy into safe planning context", () => {
  const preferences = [
    { kind: "proximity", minimumDistance: 8, createdAt: 1, updatedAt: 1 },
    { kind: "material", blockId: "minecraft:red_mushroom_block", label: "mushroom blocks", exclusive: true, createdAt: 1, updatedAt: 1 },
    { kind: "teleport", askBeforeTeleport: true, createdAt: 1, updatedAt: 1 },
  ];
  const description = describePlayerPreferences(preferences);
  assert.match(description, /8 blocks/i);
  assert.match(description, /mushroom/i);
  assert.match(description, /ask before/i);
  const prompt = playerPreferencePrompt(preferences, "Build me a castle");
  assert.match(prompt, /8 blocks/i);
  assert.match(prompt, /only mushroom blocks/i);
  assert.match(prompt, /Do not teleport/i);
  assert.doesNotMatch(playerPreferencePrompt(preferences, "Build a stone castle"), /mushroom/i);
  assert.doesNotMatch(playerPreferencePrompt(preferences, "Take me to the Nether"), /Do not teleport/i);
  assert.match(playerPreferencePrompt(preferences, "Move Wizard to the castle"), /Do not teleport/i);
});
