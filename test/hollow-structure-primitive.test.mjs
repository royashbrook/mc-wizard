import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStructureSchemaPrompt,
  primitiveStructureOperations,
  validateBuildStructurePlan,
} from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";

const materials = {
  primary: "minecraft:stone_bricks",
  accent: "minecraft:oak_planks",
  roof: "minecraft:spruce_planks",
};

const plan = (primitives, overrides = {}) => ({
  title: "Hollow Town House",
  kind: "town house",
  dimensions: { width: 9, depth: 7, height: 6 },
  materials,
  features: ["rooms", "door", "windows", "lighting"],
  phases: ["foundation", "shell", "roof", "details"],
  primitives,
  ...overrides,
});

test("expands a validated hollow box into ordered, non-overlapping surfaces", () => {
  const validated = validateBuildStructurePlan(plan([
    { shape: "line", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 3], to: [8, 0, 3] },
    { shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks", from: [0, 0, 0], to: [8, 5, 6] },
    { shape: "line", phase: "roof", blockId: "minecraft:spruce_planks", from: [0, 5, 3], to: [8, 5, 3] },
    { shape: "box", phase: "details", blockId: "minecraft:air", from: [4, 1, 0], to: [4, 2, 0] },
    { shape: "box", phase: "details", blockId: "minecraft:sea_lantern", from: [4, 3, 3], to: [4, 3, 3] },
  ]));

  assert.deepEqual(primitiveStructureOperations(validated), [
    { phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 3], to: [8, 0, 3] },
    { phase: "shell", blockId: "minecraft:stone_bricks", from: [0, 0, 0], to: [8, 0, 6] },
    { phase: "shell", blockId: "minecraft:stone_bricks", from: [0, 1, 0], to: [0, 4, 6] },
    { phase: "shell", blockId: "minecraft:stone_bricks", from: [8, 1, 0], to: [8, 4, 6] },
    { phase: "shell", blockId: "minecraft:stone_bricks", from: [1, 1, 0], to: [7, 4, 0] },
    { phase: "shell", blockId: "minecraft:stone_bricks", from: [1, 1, 6], to: [7, 4, 6] },
    { phase: "shell", blockId: "minecraft:stone_bricks", from: [0, 5, 0], to: [8, 5, 6] },
    { phase: "roof", blockId: "minecraft:spruce_planks", from: [0, 5, 3], to: [8, 5, 3] },
    { phase: "details", blockId: "minecraft:air", from: [4, 1, 0], to: [4, 2, 0] },
    { phase: "details", blockId: "minecraft:sea_lantern", from: [4, 3, 3], to: [4, 3, 3] },
  ]);
});

test("rejects invalid shells while allowing bounded horizontal modification extensions", () => {
  const modification = (primitive) => plan([primitive], { mode: "modify" });
  assert.throws(() => validateBuildStructurePlan(modification({
    shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks", from: [0, 0, 0], to: [1, 2, 2],
  })), /at least 3x3x3/);
  const attached = validateBuildStructurePlan(modification({
    shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks", from: [0, 0, 0], to: [8, 5, 7],
  }));
  assert.deepEqual(attached.primitives[0].to, [8, 5, 7]);
  assert.throws(() => validateBuildStructurePlan(modification({
    shape: "box", phase: "details", blockId: "minecraft:stone_bricks", from: [-5, 1, 0], to: [-1, 1, 2],
  })), /outside the requested dimensions/);
  assert.throws(() => validateBuildStructurePlan(plan([
    { shape: "box", phase: "foundation", blockId: "minecraft:stone", from: [-1, 0, 0], to: [8, 0, 6] },
    { shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks", from: [0, 0, 0], to: [8, 5, 6] },
    { shape: "line", phase: "roof", blockId: "minecraft:spruce_planks", from: [0, 5, 3], to: [8, 5, 3] },
    { shape: "box", phase: "details", blockId: "minecraft:glass", from: [4, 2, 0], to: [4, 2, 0] },
  ])), /outside the requested dimensions/);
});

test("charges hollow boxes for their actual shell volume under the existing plan limit", () => {
  const shell = {
    shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks", from: [0, 0, 0], to: [127, 63, 127],
  };
  const huge = (count) => plan(Array.from({ length: count }, () => shell), {
    mode: "modify",
    dimensions: { width: 128, depth: 128, height: 64 },
  });
  assert.equal(validateBuildStructurePlan(huge(31)).primitives.length, 31);
  assert.throws(() => validateBuildStructurePlan(huge(32)), /primitive plan is too large/);
});

test("keeps box and line operations compatible and tells the planner to build usable interiors", () => {
  const validated = validateBuildStructurePlan(plan([
    { shape: "box", phase: "details", blockId: "minecraft:oak_planks", from: [1, 1, 1], to: [3, 1, 3] },
    { shape: "line", phase: "details", blockId: "minecraft:glass", from: [1, 2, 1], to: [3, 2, 1] },
  ], { mode: "modify" }));
  assert.deepEqual(primitiveStructureOperations(validated), [
    { phase: "details", blockId: "minecraft:oak_planks", from: [1, 1, 1], to: [3, 1, 3] },
    { phase: "details", blockId: "minecraft:glass", from: [1, 2, 1], to: [3, 2, 1] },
  ]);
  const prompt = buildStructureSchemaPrompt();
  assert.match(prompt, /Use hollow_box for every habitable building or room/);
  assert.match(prompt, /city must contain at least four separated habitable hollow_box buildings/);
  assert.match(prompt, /Carve door and window openings with later minecraft:air box primitives/);
  assert.match(prompt, /extend x or z up to four blocks outside/i);
});

test("rejects a generic room labeled as a city and accepts a real multi-building plan", () => {
  const fakeCity = plan([
    { shape: "line", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 3], to: [8, 0, 3] },
    { shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks", from: [0, 0, 0], to: [8, 5, 6] },
    { shape: "line", phase: "roof", blockId: "minecraft:spruce_planks", from: [0, 5, 3], to: [8, 5, 3] },
    { shape: "box", phase: "details", blockId: "minecraft:sea_lantern", from: [4, 3, 3], to: [4, 3, 3] },
  ], { kind: "city" });
  assert.throws(() => validateBuildStructurePlan(fakeCity), /at least four distinct habitable/);

  const realCity = plan([
    { shape: "box", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 9], to: [19, 0, 10] },
    { shape: "box", phase: "foundation", blockId: "minecraft:stone", from: [9, 0, 0], to: [10, 0, 19] },
    { shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks", from: [1, 1, 1], to: [8, 8, 8] },
    { shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks", from: [11, 1, 1], to: [18, 10, 8] },
    { shape: "hollow_box", phase: "shell", blockId: "minecraft:oak_planks", from: [1, 1, 11], to: [8, 7, 18] },
    { shape: "hollow_box", phase: "shell", blockId: "minecraft:oak_planks", from: [11, 1, 11], to: [18, 8, 18] },
    { shape: "line", phase: "roof", blockId: "minecraft:spruce_planks", from: [11, 11, 1], to: [18, 11, 1] },
    { shape: "box", phase: "details", blockId: "minecraft:air", from: [4, 2, 8], to: [4, 3, 8] },
    { shape: "box", phase: "details", blockId: "minecraft:air", from: [14, 2, 8], to: [14, 3, 8] },
    { shape: "box", phase: "details", blockId: "minecraft:air", from: [4, 2, 11], to: [4, 3, 11] },
    { shape: "box", phase: "details", blockId: "minecraft:air", from: [14, 2, 11], to: [14, 3, 11] },
    { shape: "box", phase: "details", blockId: "minecraft:sea_lantern", from: [9, 1, 9], to: [10, 1, 10] },
  ], {
    kind: "city",
    dimensions: { width: 20, depth: 20, height: 12 },
  });
  assert.equal(validateBuildStructurePlan(realCity).primitives.filter(({ shape }) => shape === "hollow_box").length, 4);

  const overlapping = structuredClone(realCity);
  const oneShell = overlapping.primitives.find(({ shape }) => shape === "hollow_box");
  overlapping.primitives = overlapping.primitives.map((primitive) => (
    primitive.shape === "hollow_box" ? structuredClone(oneShell) : primitive
  ));
  assert.throws(() => validateBuildStructurePlan(overlapping), /distinct and separated/);

  const slabRoad = structuredClone(realCity);
  slabRoad.primitives = [
    { shape: "box", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 0], to: [19, 0, 19] },
    ...slabRoad.primitives.filter(({ phase }) => phase !== "foundation"),
  ];
  assert.throws(() => validateBuildStructurePlan(slabRoad), /two distinct thin connected paths/);
});
