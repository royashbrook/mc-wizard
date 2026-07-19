import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildPlanSchemaPrompt,
  planBounds,
  validateBuildPlan,
} from "../bedrock/behavior_packs/mc_wizard/scripts/build-plan.js";

const block = (itemId, target, support = null) => ({ itemId, target, support });
const key = ([x, y, z]) => `${x},${y},${z}`;

// Every output block must rest on ground (y=-1 under a y=0 target) or on a block
// that appears earlier in the returned ordering, touching it face-to-face.
const assertGroundUpOrdering = (plan) => {
  const earlier = new Set();
  for (const entry of plan.blocks) {
    const { target, support } = entry;
    const distance = Math.abs(target[0] - support[0]) + Math.abs(target[1] - support[1])
      + Math.abs(target[2] - support[2]);
    assert.equal(distance, 1, `support must touch its target: ${key(target)}`);
    const isGround = support[1] === -1 && target[1] === 0;
    assert.ok(isGround || earlier.has(key(support)),
      `support for ${key(target)} must be ground or an earlier block`);
    earlier.add(key(target));
  }
};

const towerPlan = () => {
  // 20-block ground row plus a 20-block second layer, so drops stay well above
  // the survival floor.
  const blocks = [];
  for (let z = 0; z < 20; z += 1) blocks.push(block("minecraft:stone", [0, 0, z]));
  for (let z = 0; z < 20; z += 1) blocks.push(block("minecraft:oak_planks", [0, 1, z]));
  return { title: "Tower wall", blocks };
};

test("salvages a shuffled plan with garbage supports into a ground-up ordering", () => {
  const plan = towerPlan();
  // Deterministic shuffle: reverse, so every second-layer block precedes its ground
  // support, and poison every authored support.
  plan.blocks.reverse();
  plan.blocks.forEach((entry, index) => {
    entry.support = index % 3 === 0 ? [99, 99, 99] : (index % 3 === 1 ? "garbage" : null);
  });
  const validated = validateBuildPlan(plan);
  assert.equal(validated.title, "Tower wall");
  assert.equal(validated.blocks.length, 40);
  assertGroundUpOrdering(validated);
  assert.deepEqual(validated.salvage.dropped, []);
  assert.equal(validated.salvage.repairedSupports, 40);
  assert.deepEqual(planBounds(validated), { min: [0, 0, 0], max: [0, 1, 19] });
});

test("drops disallowed-item entries and keeps the rest", () => {
  const plan = towerPlan();
  plan.blocks[21] = block("minecraft:command_block", [0, 1, 1]);
  plan.blocks[22] = block("minecraft:mob_spawner", [0, 1, 2]);
  plan.blocks[23] = block("minecraft:tnt", [0, 1, 3]);
  const validated = validateBuildPlan(plan);
  assert.equal(validated.blocks.length, 37);
  assert.equal(validated.salvage.dropped.length, 3);
  for (const violation of validated.salvage.dropped) {
    assert.match(violation.reason, /itemId is not allowed/);
    assert.ok(Number.isInteger(violation.index));
  }
  assert.ok(!validated.blocks.some((entry) => /command_block|mob_spawner|tnt/.test(entry.itemId)));
});

test("banned block ids are always entry drops, never allowed through", () => {
  for (const banned of [
    "minecraft:command_block",
    "minecraft:structure_block",
    "minecraft:mob_spawner",
    "minecraft:barrier",
    "minecraft:tnt",
  ]) {
    const plan = towerPlan();
    plan.blocks[25] = block(banned, [0, 1, 5]);
    const validated = validateBuildPlan(plan);
    assert.equal(validated.blocks.length, 39, banned);
    assert.equal(validated.salvage.dropped.length, 1, banned);
    assert.match(validated.salvage.dropped[0].reason, /not allowed/, banned);
  }
});

test("drops out-of-bounds and duplicate targets as violations", () => {
  const plan = towerPlan();
  plan.blocks[20] = block("minecraft:stone", [9, 0, 0]);
  plan.blocks[21] = block("minecraft:stone", [0, 13, 0]);
  plan.blocks[22] = block("minecraft:stone", [0, 0, 0]);
  const validated = validateBuildPlan(plan);
  assert.equal(validated.blocks.length, 37);
  const reasons = validated.salvage.dropped.map((entry) => entry.reason).join("\n");
  assert.match(reasons, /outside the build bounds/);
  assert.match(reasons, /duplicated/);
});

test("rejects an all-floating plan with the violation list as JSON", () => {
  const plan = {
    blocks: [
      block("minecraft:stone", [0, 2, 0]),
      block("minecraft:stone", [0, 3, 0]),
      block("minecraft:stone", [1, 2, 0]),
      block("minecraft:stone", [1, 3, 0]),
      block("minecraft:stone", [2, 2, 0]),
    ],
  };
  let violations;
  assert.throws(() => validateBuildPlan(plan), (error) => {
    violations = JSON.parse(error.message);
    return true;
  });
  assert.equal(violations.length, 5);
  for (const violation of violations) {
    assert.match(violation.reason, /ground or an earlier planned block/);
  }
});

test("rejects the whole plan when more than half the entries are disallowed", () => {
  const blocks = [];
  for (let z = 0; z < 4; z += 1) blocks.push(block("minecraft:stone", [0, 0, z]));
  for (let z = 4; z < 10; z += 1) blocks.push(block("minecraft:command_block", [0, 0, z]));
  let violations;
  assert.throws(() => validateBuildPlan({ blocks }), (error) => {
    violations = JSON.parse(error.message);
    return true;
  });
  assert.equal(violations.length, 6);
  for (const violation of violations) assert.match(violation.reason, /not allowed/);
});

test("small fully valid plans still validate whole", () => {
  const validated = validateBuildPlan({
    title: "Tiny arch",
    blocks: [
      block("minecraft:oak_planks", [0, 0, 1]),
      block("minecraft:oak_log", [0, 1, 1]),
      block("minecraft:oak_log", [1, 1, 1]),
    ],
  });
  assert.equal(validated.blocks.length, 3);
  assertGroundUpOrdering(validated);
});

test("small plans reject when any entry drops", () => {
  assert.throws(() => validateBuildPlan({
    blocks: [
      block("minecraft:oak_planks", [0, 0, 1]),
      block("minecraft:tnt", [0, 1, 1]),
    ],
  }), /not allowed/);
});

test("redstone below-only rule still enforced as an entry drop", () => {
  const plan = {
    blocks: [
      block("minecraft:stone", [0, 0, 0]),
      block("minecraft:stone", [0, 0, 1]),
      block("minecraft:stone", [0, 0, 2]),
      block("minecraft:stone", [0, 0, 3]),
      // Nothing at [1, 0, 0], so this wire has no block directly below.
      block("minecraft:redstone", [1, 1, 0]),
    ],
  };
  const validated = validateBuildPlan(plan);
  assert.equal(validated.blocks.length, 4);
  assert.equal(validated.salvage.dropped.length, 1);
  assert.match(validated.salvage.dropped[0].reason, /requires support directly below/);
});

test("redstone sorts after the block beneath it with support directly below", () => {
  const validated = validateBuildPlan({
    blocks: [
      block("minecraft:redstone_torch", [0, 1, 0]),
      block("minecraft:stone", [0, 0, 0]),
      block("minecraft:stone", [0, 0, 1]),
      block("minecraft:redstone", [0, 1, 1]),
    ],
  });
  assert.equal(validated.blocks.length, 4);
  assertGroundUpOrdering(validated);
  const torch = validated.blocks.find((entry) => entry.itemId === "minecraft:redstone_torch");
  const wire = validated.blocks.find((entry) => entry.itemId === "minecraft:redstone");
  assert.deepEqual(torch.support, [0, 0, 0]);
  assert.deepEqual(wire.support, [0, 0, 1]);
  const torchIndex = validated.blocks.indexOf(torch);
  const stoneIndex = validated.blocks.findIndex((entry) => key(entry.target) === "0,0,0");
  assert.ok(stoneIndex < torchIndex);
  assert.equal(wire.expectedType, "minecraft:redstone_wire");
});

test("widened palette accepts inert decorative blocks with correct expected types", () => {
  const validated = validateBuildPlan({
    blocks: [
      block("minecraft:magenta_concrete", [0, 0, 0]),
      block("minecraft:light_gray_wool", [0, 0, 1]),
      block("minecraft:oak_stairs", [0, 0, 2]),
      block("minecraft:ladder", [0, 1, 2]),
      block("minecraft:torch", [0, 1, 0]),
      block("minecraft:stone_bricks", [0, 0, 3]),
      block("minecraft:quartz_block", [0, 1, 3]),
    ],
  });
  assert.equal(validated.blocks.length, 7);
  assertGroundUpOrdering(validated);
  for (const entry of validated.blocks) assert.equal(entry.expectedType, entry.itemId);
});

test("salvage:false keeps strict first-violation throw semantics", () => {
  assert.throws(() => validateBuildPlan({
    blocks: [block("minecraft:tnt", [0, 0, 0], [0, -1, 0])],
  }, { salvage: false }), /not allowed/);
  assert.throws(() => validateBuildPlan({
    blocks: [block("minecraft:stone", [0, 5, 0], [0, 4, 0])],
  }, { salvage: false }), /ground or an earlier planned block/);
});

test("structural impossibilities still throw plain errors", () => {
  assert.throws(() => validateBuildPlan(null), /plan must be an object/);
  assert.throws(() => validateBuildPlan({ blocks: [] }), /plan must contain/);
  const oversized = { blocks: Array.from({ length: 129 }, (_, z) => block("minecraft:stone", [0, 0, z % 21])) };
  assert.throws(() => validateBuildPlan(oversized), /plan must contain/);
});

test("schema prompt tells the model order and support are computed server-side", () => {
  const prompt = buildPlanSchemaPrompt();
  assert.match(prompt, /Order and support are computed for you/);
  assert.doesNotMatch(prompt, /earlier target/);
  assert.match(prompt, /minecraft:magenta_concrete/);
  assert.doesNotMatch(prompt, /command_block|structure_block|mob_spawner|barrier|tnt/);
});

test("module stays dependency-free plain JS loadable in the Bedrock runtime", async () => {
  const source = await readFile(new URL("../bedrock/behavior_packs/mc_wizard/scripts/build-plan.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bimport\b/);
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.doesNotMatch(source, /node:/);
  assert.doesNotMatch(source, /command_block":|structure_block":|mob_spawner":|barrier":|:tnt"/);
});
