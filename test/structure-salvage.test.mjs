import assert from "node:assert/strict";
import test from "node:test";

import {
  STRUCTURE_LIMITS,
  validateBuildStructurePlan,
} from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";

const materials = {
  primary: "minecraft:green_concrete",
  accent: "minecraft:lime_concrete",
  roof: "minecraft:stone",
};

const plan = (primitives, overrides = {}) => ({
  title: "Emerald Dragon",
  kind: "dragon statue",
  dimensions: { width: 12, depth: 8, height: 10 },
  materials,
  features: ["supports"],
  phases: ["foundation", "shell", "roof", "details"],
  primitives,
  ...overrides,
});

const dragonPrimitives = [
  { shape: "line", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 3], to: [11, 0, 3] },
  { shape: "box", phase: "shell", blockId: "minecraft:green_concrete", from: [4, 1, 0], to: [7, 5, 7] },
  { shape: "line", phase: "roof", blockId: "minecraft:lime_concrete", from: [5, 6, 3], to: [5, 9, 3] },
  { shape: "box", phase: "details", blockId: "minecraft:white_concrete", from: [5, 7, 2], to: [5, 7, 2] },
];

test("salvages a scrambled dragon with an out-of-bounds wing instead of rejecting it", () => {
  const scrambled = plan([
    dragonPrimitives[3],
    dragonPrimitives[2],
    dragonPrimitives[0],
    dragonPrimitives[1],
    { shape: "box", phase: "shell", blockId: "minecraft:green_concrete", from: [8, 2, 3], to: [13, 3, 4] },
  ]);
  const validated = validateBuildStructurePlan(scrambled);
  assert.equal(validated.primitives.length, 5);
  assert.deepEqual(validated.salvage.dropped, []);
  assert.ok(validated.salvage.warnings.some((warning) => /re-sorted into phase order/.test(warning)));
  assert.ok(validated.salvage.warnings.some((warning) => /renormalized/.test(warning)));
  assert.equal(validated.dimensions.width, 14);
  const order = ["foundation", "shell", "roof", "details"];
  const indices = validated.primitives.map(({ phase }) => order.indexOf(phase));
  assert.ok(indices.every((index, position) => !position || indices[position - 1] <= index));
});

test("maps an unknown inert vanilla material to the primary material with a warning", () => {
  const validated = validateBuildStructurePlan(plan(dragonPrimitives.map((primitive, index) => (
    index === 3 ? { ...primitive, blockId: "minecraft:mud" } : primitive
  ))));
  assert.equal(validated.primitives[3].blockId, "minecraft:green_concrete");
  assert.ok(validated.salvage.warnings.some((warning) => /minecraft:mud/.test(warning)));
  assert.deepEqual(validated.salvage.dropped, []);
});

test("renormalizes solids spanning [2..20] to the origin, translating entities too", () => {
  const validated = validateBuildStructurePlan(plan([
    { shape: "box", phase: "foundation", blockId: "minecraft:stone", from: [2, 2, 2], to: [20, 2, 20] },
    { shape: "box", phase: "shell", blockId: "minecraft:green_concrete", from: [2, 3, 2], to: [20, 10, 20] },
    { shape: "box", phase: "roof", blockId: "minecraft:lime_concrete", from: [2, 11, 2], to: [20, 15, 20] },
    { shape: "box", phase: "details", blockId: "minecraft:white_concrete", from: [2, 16, 2], to: [20, 20, 20] },
  ], {
    dimensions: { width: 19, depth: 19, height: 19 },
    entities: [{ typeId: "minecraft:villager_v2", location: [4, 3, 4] }],
  }));
  assert.deepEqual(validated.dimensions, { width: 19, height: 19, depth: 19 });
  assert.deepEqual(validated.primitives[0].from, [0, 0, 0]);
  assert.deepEqual(validated.primitives[3].to, [18, 18, 18]);
  assert.deepEqual(validated.entities, [{ typeId: "minecraft:villager_v2", location: [2, 1, 2] }]);
  assert.ok(validated.salvage.warnings.some((warning) => /translated/.test(warning)));

  const revalidated = validateBuildStructurePlan({ ...validated, entities: validated.entities.map((entity) => ({ ...entity })) });
  assert.deepEqual(revalidated.primitives, validated.primitives);
  assert.deepEqual(revalidated.salvage, { warnings: [], dropped: [] });
});

test("re-bins solids into phases by height when a phase lacks solid coverage", () => {
  const validated = validateBuildStructurePlan(plan([
    { shape: "box", phase: "shell", blockId: "minecraft:stone", from: [0, 0, 0], to: [9, 0, 9] },
    { shape: "box", phase: "shell", blockId: "minecraft:green_concrete", from: [0, 3, 0], to: [9, 3, 9] },
    { shape: "box", phase: "shell", blockId: "minecraft:lime_concrete", from: [0, 6, 0], to: [9, 6, 9] },
    { shape: "box", phase: "shell", blockId: "minecraft:white_concrete", from: [0, 9, 0], to: [9, 9, 9] },
  ], { dimensions: { width: 10, depth: 10, height: 10 } }));
  assert.deepEqual(validated.primitives.map(({ phase }) => phase), ["foundation", "shell", "roof", "details"]);
  assert.ok(validated.salvage.warnings.some((warning) => /re-binned/.test(warning)));
});

test("drops only the out-of-margin entry from a modify patch", () => {
  const validated = validateBuildStructurePlan(plan([
    { shape: "box", phase: "details", blockId: "minecraft:glass", from: [0, 1, 0], to: [2, 2, 2] },
    { shape: "box", phase: "details", blockId: "minecraft:glass", from: [-9, 1, 0], to: [-9, 2, 2] },
  ], { mode: "modify" }));
  assert.equal(validated.primitives.length, 1);
  assert.equal(validated.salvage.dropped.length, 1);
  assert.equal(validated.salvage.dropped[0].index, 1);
  assert.match(validated.salvage.dropped[0].reason, /outside the requested dimensions/);
});

test("demotes city-quality geometry from rejection to a warning", () => {
  const validated = validateBuildStructurePlan(plan([
    { shape: "line", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 3], to: [8, 0, 3] },
    { shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks", from: [0, 0, 0], to: [8, 5, 6] },
    { shape: "line", phase: "roof", blockId: "minecraft:stone", from: [0, 5, 3], to: [8, 5, 3] },
    { shape: "box", phase: "details", blockId: "minecraft:sea_lantern", from: [4, 3, 3], to: [4, 3, 3] },
  ], {
    kind: "city",
    dimensions: { width: 9, depth: 7, height: 6 },
  }));
  assert.ok(validated.salvage.warnings.some((warning) => /at least four distinct habitable/.test(warning)));
});

test("still rejects plans with more than 96 primitives", () => {
  const box = { shape: "box", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 0], to: [1, 0, 1] };
  assert.throws(
    () => validateBuildStructurePlan(plan(Array.from({ length: 97 }, () => ({ ...box })))),
    /primitives must contain 4-96 entries/,
  );
});

test("still rejects a volume bomb", () => {
  const full = STRUCTURE_LIMITS;
  assert.throws(() => validateBuildStructurePlan(plan([
    { shape: "box", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 0], to: [full.width - 1, full.height - 1, full.depth - 1] },
    { shape: "box", phase: "shell", blockId: "minecraft:stone", from: [0, 0, 0], to: [full.width - 1, full.height - 1, full.depth - 1] },
    { shape: "box", phase: "roof", blockId: "minecraft:stone", from: [0, full.height - 1, 0], to: [1, full.height - 1, 1] },
    { shape: "box", phase: "details", blockId: "minecraft:glowstone", from: [0, full.height - 1, 2], to: [0, full.height - 1, 2] },
  ], { dimensions: { width: full.width, depth: full.depth, height: full.height } })), /primitive plan is too large/);
});

test("rejects a plan whose every primitive drops, with the violation list in the message", () => {
  assert.throws(
    () => validateBuildStructurePlan(plan(dragonPrimitives.map((primitive) => (
      { ...primitive, blockId: "cobblestone" }
    )))),
    (error) => /has no buildable primitives/.test(error.message)
      && /blockId is not allowed/.test(error.message),
  );
});

test("non-minecraft-namespace blockIds always drop, never map", () => {
  for (const blockId of ["cobblestone", "mod:fancy_block", "minecraft:Uppercase", "minecraft:mud!"]) {
    const validated = validateBuildStructurePlan(plan([
      ...dragonPrimitives,
      { shape: "box", phase: "details", blockId, from: [1, 1, 1], to: [1, 1, 1] },
    ]));
    assert.equal(validated.salvage.dropped.length, 1, blockId);
    assert.equal(validated.salvage.dropped[0].index, 4);
    assert.match(validated.salvage.dropped[0].reason, /blockId is not allowed/);
  }
});

test("command_block, structure_block, mob_spawner, barrier, and tnt are always dropped, never repaired", () => {
  for (const banned of [
    "minecraft:command_block",
    "minecraft:repeating_command_block",
    "minecraft:chain_command_block",
    "minecraft:structure_block",
    "minecraft:mob_spawner",
    "minecraft:barrier",
    "minecraft:tnt",
  ]) {
    const validated = validateBuildStructurePlan(plan([
      ...dragonPrimitives,
      { shape: "box", phase: "details", blockId: banned, from: [1, 1, 1], to: [1, 1, 1] },
    ]));
    assert.equal(validated.primitives.length, 4, banned);
    assert.ok(validated.primitives.every(({ blockId }) => blockId !== banned));
    assert.deepEqual(validated.salvage.dropped, [{ index: 4, reason: "primitives[4].blockId is not allowed" }]);
    assert.ok(validated.salvage.warnings.every((warning) => !warning.includes(banned)));
  }
});

const volcanoSolids = [
  { shape: "box", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 0], to: [9, 0, 9] },
  { shape: "hollow_box", phase: "shell", blockId: "minecraft:stone", from: [2, 0, 2], to: [7, 5, 7] },
  { shape: "box", phase: "roof", blockId: "minecraft:stone", from: [2, 6, 2], to: [7, 6, 7] },
  { shape: "box", phase: "details", blockId: "minecraft:glowstone", from: [0, 6, 0], to: [0, 6, 0] },
];
const craterLava = { shape: "box", phase: "details", blockId: "minecraft:lava", from: [3, 1, 3], to: [6, 4, 6] };
const volcanoDimensions = { dimensions: { width: 10, depth: 10, height: 7 } };

test("keeps contained lava when the salvage pass touched nothing", () => {
  const validated = validateBuildStructurePlan(plan([...volcanoSolids, craterLava], volcanoDimensions));
  assert.deepEqual(validated.salvage.dropped, []);
  assert.ok(validated.primitives.some(({ blockId }) => blockId === "minecraft:lava"));
});

test("drops surviving lava when its containment wall is dropped during salvage", () => {
  const validated = validateBuildStructurePlan(plan([
    volcanoSolids[0],
    { ...volcanoSolids[1], phase: "walls" },
    { shape: "box", phase: "shell", blockId: "minecraft:stone", from: [1, 1, 1], to: [8, 4, 8] },
    volcanoSolids[2],
    craterLava,
    volcanoSolids[3],
  ], volcanoDimensions));
  assert.equal(validated.primitives.length, 4);
  assert.ok(validated.primitives.every(({ blockId }) => blockId !== "minecraft:lava"));
  assert.equal(validated.salvage.dropped.length, 2);
  assert.match(validated.salvage.dropped[0].reason, /phase is unsupported/);
  const lavaDrop = validated.salvage.dropped.find(({ index }) => index === 4);
  assert.match(lavaDrop.reason, /minecraft:lava dropped: salvage removed or clamped/);
});

test("drops lava when any primitive was bounds-clamped, even with nothing dropped", () => {
  const validated = validateBuildStructurePlan(plan([
    ...volcanoSolids,
    craterLava,
    { shape: "box", phase: "details", blockId: "minecraft:air", from: [3, 1, 3], to: [12, 4, 6] },
  ], volcanoDimensions));
  assert.ok(validated.salvage.warnings.some((warning) => /clamped to the structure bounds/.test(warning)));
  assert.ok(validated.primitives.every(({ blockId }) => blockId !== "minecraft:lava"));
  assert.ok(validated.salvage.dropped.some(({ reason }) => /minecraft:lava dropped/.test(reason)));
});

test("drops lava from a modify patch when salvage dropped a sibling entry", () => {
  const validated = validateBuildStructurePlan(plan([
    { shape: "box", phase: "details", blockId: "minecraft:glass", from: [0, 1, 0], to: [2, 2, 2] },
    { shape: "box", phase: "details", blockId: "minecraft:lava", from: [1, 1, 1], to: [1, 1, 1] },
    { shape: "box", phase: "walls", blockId: "minecraft:stone", from: [0, 0, 0], to: [1, 0, 1] },
  ], { mode: "modify" }));
  assert.equal(validated.primitives.length, 1);
  assert.equal(validated.primitives[0].blockId, "minecraft:glass");
  assert.ok(validated.salvage.dropped.some(({ index, reason }) => index === 1 && /minecraft:lava dropped/.test(reason)));
});

test("re-sorting never moves a door carve before the wall it cuts", () => {
  const validated = validateBuildStructurePlan(plan([
    { shape: "box", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 0], to: [6, 0, 6] },
    { shape: "hollow_box", phase: "shell", blockId: "minecraft:oak_planks", from: [0, 0, 0], to: [6, 4, 6] },
    { shape: "box", phase: "roof", blockId: "minecraft:spruce_planks", from: [0, 4, 0], to: [6, 4, 6] },
    { shape: "box", phase: "details", blockId: "minecraft:glowstone", from: [3, 3, 3], to: [3, 3, 3] },
    // Door carve authored last but mis-phased as foundation: a naive re-sort
    // would run it first, no-op on empty space, and the wall would seal it.
    { shape: "box", phase: "foundation", blockId: "minecraft:air", from: [3, 1, 0], to: [3, 2, 0] },
  ], { dimensions: { width: 7, depth: 7, height: 5 } }));
  assert.ok(validated.salvage.warnings.some((warning) => /re-sorted into phase order/.test(warning)));
  assert.ok(validated.salvage.warnings.some((warning) => /air carve primitives moved to the details phase/.test(warning)));
  const airIndex = validated.primitives.findIndex(({ blockId }) => blockId === "minecraft:air");
  const wallIndex = validated.primitives.findIndex(({ shape }) => shape === "hollow_box");
  assert.equal(airIndex, validated.primitives.length - 1);
  assert.equal(validated.primitives[airIndex].phase, "details");
  assert.ok(airIndex > wallIndex);
  const order = ["foundation", "shell", "roof", "details"];
  const indices = validated.primitives.map(({ phase }) => order.indexOf(phase));
  assert.ok(indices.every((index, position) => !position || indices[position - 1] <= index));
});

test("height re-binning keeps an air carve after the re-binned solids", () => {
  const validated = validateBuildStructurePlan(plan([
    { shape: "box", phase: "shell", blockId: "minecraft:stone", from: [0, 0, 0], to: [9, 0, 9] },
    { shape: "box", phase: "shell", blockId: "minecraft:green_concrete", from: [0, 3, 0], to: [9, 3, 9] },
    { shape: "box", phase: "shell", blockId: "minecraft:lime_concrete", from: [0, 6, 0], to: [9, 6, 9] },
    { shape: "box", phase: "shell", blockId: "minecraft:white_concrete", from: [0, 9, 0], to: [9, 9, 9] },
    { shape: "box", phase: "shell", blockId: "minecraft:air", from: [4, 1, 0], to: [5, 2, 0] },
  ], { dimensions: { width: 10, depth: 10, height: 10 } }));
  assert.ok(validated.salvage.warnings.some((warning) => /re-binned/.test(warning)));
  const last = validated.primitives[validated.primitives.length - 1];
  assert.equal(last.blockId, "minecraft:air");
  assert.equal(last.phase, "details");
});

test("an all-air plan is still rejected for missing solid geometry", () => {
  assert.throws(
    () => validateBuildStructurePlan(plan(dragonPrimitives.map((primitive) => (
      { ...primitive, blockId: "minecraft:air" }
    )))),
    /solid primitives must include/,
  );
});

test("rejects when drops leave fewer than four primitives, naming the defect", () => {
  assert.throws(
    () => validateBuildStructurePlan(plan(dragonPrimitives.map((primitive, index) => (
      index === 2 ? { ...primitive, shape: "line", from: [1, 2, 1], to: [3, 4, 1] } : primitive
    )))),
    (error) => /after salvage/.test(error.message) && /axis-aligned/.test(error.message),
  );
});

test("renormalized dimensions stay hard-capped at the structure limits", () => {
  assert.throws(() => validateBuildStructurePlan(plan([
    { shape: "box", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 0], to: [199, 0, 10] },
    { shape: "box", phase: "shell", blockId: "minecraft:stone", from: [0, 1, 0], to: [199, 3, 10] },
    { shape: "box", phase: "roof", blockId: "minecraft:stone", from: [0, 4, 0], to: [10, 4, 10] },
    { shape: "box", phase: "details", blockId: "minecraft:glowstone", from: [0, 5, 0], to: [0, 5, 0] },
  ], { dimensions: { width: 100, depth: 11, height: 6 } })), /width must be an integer from 1-128/);
});
