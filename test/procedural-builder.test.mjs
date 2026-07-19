import assert from "node:assert/strict";
import test from "node:test";

import {
  STRUCTURE_LIMITS,
  STRUCTURE_PHASES,
  STRUCTURE_PRIMITIVE_LIMIT,
  validateBuildStructurePlan,
} from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";
import {
  SILHOUETTES,
  composeStructurePlan,
  describeProceduralBuild,
  extractDescriptor,
} from "../src/procedural-builder.mjs";

const compose = (question, overrides) => composeStructurePlan(extractDescriptor(question, overrides));

const SIZES = ["", "tiny ", "small ", "big ", "giant "];
const COLORS = ["", "red ", "light blue "];

test("every silhouette noun x size x color passes the real pack validator", () => {
  for (const { template, nouns } of SILHOUETTES) {
    for (const noun of nouns) {
      for (const size of SIZES) {
        for (const color of COLORS) {
          const question = `build me a ${size}${color}${noun}`;
          const descriptor = extractDescriptor(question);
          assert.equal(descriptor.template, template, question);
          const plan = composeStructurePlan(descriptor);
          const validated = validateBuildStructurePlan(plan);
          assert.ok(plan.primitives.length >= 8, `${question} authored ${plan.primitives.length} primitives`);
          assert.ok(plan.primitives.length <= STRUCTURE_PRIMITIVE_LIMIT, question);
          assert.match(validated.title, /^Blocky /i, question);
          const solidPhases = new Set(validated.primitives
            .filter(({ blockId }) => blockId !== "minecraft:air")
            .map(({ phase }) => phase));
          for (const phase of STRUCTURE_PHASES) assert.ok(solidPhases.has(phase), `${question} lacks ${phase}`);
          for (const axis of ["width", "depth", "height"]) {
            assert.ok(validated.dimensions[axis] <= STRUCTURE_LIMITS[axis], question);
          }
        }
      }
    }
  }
});

test("requested color drives the palette and appears in the built shape", () => {
  const plan = compose("build me a pink cat");
  assert.equal(plan.materials.primary, "minecraft:pink_concrete");
  assert.ok(plan.primitives.some(({ blockId }) => blockId === "minecraft:pink_concrete"));
  const spaced = compose("build me a light blue fish");
  assert.equal(spaced.materials.primary, "minecraft:light_blue_concrete");
});

test("rainbow builds are banded with at least five distinct concrete colors", () => {
  const descriptor = extractDescriptor("build me a giant rainbow");
  assert.equal(descriptor.template, "arch");
  assert.equal(descriptor.rainbow, true);
  const plan = composeStructurePlan(descriptor);
  validateBuildStructurePlan(plan);
  const colors = new Set(plan.primitives
    .map(({ blockId }) => blockId)
    .filter((blockId) => /_concrete$/.test(blockId)));
  assert.ok(colors.size >= 5, `only ${colors.size} concrete colors`);
});

test("explicit dimensions are respected exactly", () => {
  const parsed = compose("build a pink cat 20x10x8");
  assert.deepEqual(parsed.dimensions, { width: 20, depth: 10, height: 8 });
  validateBuildStructurePlan(parsed);
  const overridden = compose("build me a dog", { dimensions: { width: 24, depth: 12, height: 10 } });
  assert.deepEqual(overridden.dimensions, { width: 24, depth: 12, height: 10 });
  validateBuildStructurePlan(overridden);
});

test("a quadruped has four disjoint leg columns and an elevated head box", () => {
  const plan = compose("build me a dog");
  const validated = validateBuildStructurePlan(plan);
  const legs = validated.primitives.filter(({ phase, blockId }) => (
    phase === "foundation" && blockId !== "minecraft:air"
  ));
  assert.ok(legs.length >= 4, `only ${legs.length} foundation legs`);
  for (let a = 0; a < 4; a += 1) {
    for (let b = a + 1; b < 4; b += 1) {
      const separated = legs[a].to[0] < legs[b].from[0] || legs[b].to[0] < legs[a].from[0]
        || legs[a].to[2] < legs[b].from[2] || legs[b].to[2] < legs[a].from[2];
      assert.ok(separated, `legs ${a} and ${b} overlap`);
    }
  }
  const legTop = Math.max(...legs.map(({ to }) => to[1]));
  const head = validated.primitives.find(({ phase }) => phase === "roof");
  assert.ok(head, "no head primitive");
  assert.ok(head.from[1] > legTop, "head is not elevated above the legs");
  assert.equal(head.to[1], validated.dimensions.height - 1);
});

test("a creeper is a green biped with feet, a body, a bigger head, and a face", () => {
  const descriptor = extractDescriptor("build me a creeper");
  assert.equal(descriptor.template, "creeper");
  assert.equal(descriptor.palette.primary, "minecraft:lime_concrete");
  const validated = validateBuildStructurePlan(composeStructurePlan(descriptor));
  const feet = validated.primitives.filter(({ phase, blockId }) => (
    phase === "foundation" && blockId !== "minecraft:air"
  ));
  assert.ok(feet.length >= 2, `only ${feet.length} foundation feet`);
  const head = validated.primitives.find(({ phase }) => phase === "roof");
  const body = validated.primitives.find(({ phase }) => phase === "shell");
  assert.ok(head && body, "creeper lacks a head or body");
  assert.equal(head.to[1], validated.dimensions.height - 1, "head does not reach the top");
  assert.ok(head.from[1] > body.from[1], "head is not above the body");
  const headDepth = head.to[2] - head.from[2];
  const bodyDepth = body.to[2] - body.from[2];
  assert.ok(headDepth > bodyDepth, "head is not bigger than the body");
  const face = validated.primitives.filter(({ phase, blockId, from }) => (
    phase === "details" && blockId === "minecraft:black_concrete" && from[2] === 0
  ));
  assert.ok(face.length >= 3, `only ${face.length} face detail blocks`);
});

test("a unicorn is a quadruped with a distinct horn block on the top row", () => {
  const descriptor = extractDescriptor("build me a unicorn");
  assert.equal(descriptor.template, "unicorn");
  const validated = validateBuildStructurePlan(composeStructurePlan(descriptor));
  const legs = validated.primitives.filter(({ phase, blockId }) => (
    phase === "foundation" && blockId !== "minecraft:air"
  ));
  assert.ok(legs.length >= 4, `only ${legs.length} legs`);
  const topY = validated.dimensions.height - 1;
  const horn = validated.primitives.find(({ from, to, blockId }) => (
    from[1] === topY && to[1] === topY && blockId === descriptor.palette.roof
  ));
  assert.ok(horn, "no horn block on the top row");
  assert.notEqual(horn.blockId, descriptor.palette.primary, "horn is not a distinct color");
  const head = validated.primitives.find(({ phase }) => phase === "roof");
  assert.ok(head, "no head primitive");
  assert.ok(horn.from[0] >= head.from[0] && horn.from[0] <= head.to[0], "horn is not on the head");
});

test("an airplane has full-span wings, a tail fin at the top, and a cockpit", () => {
  for (const question of ["make an airplane", "build me a plane", "build a jet"]) {
    const descriptor = extractDescriptor(question);
    assert.equal(descriptor.template, "airplane", question);
    const validated = validateBuildStructurePlan(composeStructurePlan(descriptor));
    const { width, depth, height } = validated.dimensions;
    const wings = validated.primitives.find(({ phase, from, to }) => (
      phase === "shell" && from[2] === 0 && to[2] === depth - 1
    ));
    assert.ok(wings, `${question} has no full-span wings`);
    const fuselage = validated.primitives.find(({ phase, from, to }) => (
      phase === "shell" && from[0] === 0 && to[0] === width - 1
    ));
    assert.ok(fuselage, `${question} has no full-length fuselage`);
    const fin = validated.primitives.find(({ phase, to }) => phase === "roof" && to[1] === height - 1);
    assert.ok(fin, `${question} tail fin does not reach the top`);
    assert.ok(validated.primitives.some(({ blockId }) => blockId === "minecraft:glass"), `${question} has no cockpit`);
  }
});

test("a rollercoaster track rises to a roof-phase peak on supported columns", () => {
  const descriptor = extractDescriptor("can you make a rollercoaster");
  assert.equal(descriptor.template, "coaster");
  const validated = validateBuildStructurePlan(composeStructurePlan(descriptor));
  const topY = validated.dimensions.height - 1;
  const peak = validated.primitives.find(({ phase, from }) => phase === "roof" && from[1] === topY);
  assert.ok(peak, "no track segment at the peak height");
  const trackHeights = new Set(validated.primitives
    .filter(({ phase }) => phase === "shell")
    .map(({ from }) => from[1]));
  assert.ok(trackHeights.size >= 3, `track only spans ${trackHeights.size} heights, so it does not rise and fall`);
  const supports = validated.primitives.filter(({ phase, from, to }) => (
    phase === "foundation" && from[1] >= 1 && to[1] > from[1]
  ));
  assert.ok(supports.length >= 2, `only ${supports.length} support columns`);
  const twoWords = extractDescriptor("build me a roller coaster");
  assert.equal(twoWords.template, "coaster");
});

test("near-miss nouns do not false-positive onto the new templates", () => {
  // "planet" must not match "plane", "creepy" must not match "creeper",
  // and "corn" must not match "unicorn".
  for (const question of ["build me a planet", "build me a creepy thing", "build me a corn stand"]) {
    const descriptor = extractDescriptor(question);
    assert.notEqual(descriptor.template, "airplane", question);
    assert.notEqual(descriptor.template, "creeper", question);
    assert.notEqual(descriptor.template, "unicorn", question);
    validateBuildStructurePlan(composeStructurePlan(descriptor));
  }
});

test("gibberish subjects fall to the abstract template and still validate", () => {
  const descriptor = extractDescriptor("build me a zorblax");
  assert.equal(descriptor.template, "abstract");
  assert.equal(descriptor.kind, "zorblax");
  const validated = validateBuildStructurePlan(composeStructurePlan(descriptor));
  assert.ok(validated.primitives.length >= 8);
});

test("giant sizes never exceed the pack limits or the primitive cap", () => {
  for (const noun of ["dragon", "heart", "rainbow", "rocket", "whale"]) {
    const plan = compose(`build me a giant ${noun}`);
    const validated = validateBuildStructurePlan(plan);
    assert.ok(validated.dimensions.width <= STRUCTURE_LIMITS.width);
    assert.ok(validated.dimensions.depth <= STRUCTURE_LIMITS.depth);
    assert.ok(validated.dimensions.height <= STRUCTURE_LIMITS.height);
    assert.ok(validated.primitives.length <= STRUCTURE_PRIMITIVE_LIMIT);
  }
});

test("oversized explicit requests are clamped and stay under the primitive cap", () => {
  const plan = compose("build me a heart 120x20x60");
  const validated = validateBuildStructurePlan(plan);
  assert.ok(validated.primitives.length <= STRUCTURE_PRIMITIVE_LIMIT);
  const absurd = compose("build me a house 900x900x99");
  const checked = validateBuildStructurePlan(absurd);
  assert.ok(checked.dimensions.width <= STRUCTURE_LIMITS.width);
  assert.ok(checked.dimensions.height <= STRUCTURE_LIMITS.height);
});

test("disallowed material overrides coerce to the nearest allowed block", () => {
  const wool = compose("build me a dog", { material: "minecraft:pink_wool" });
  assert.equal(wool.materials.primary, "minecraft:pink_concrete");
  validateBuildStructurePlan(wool);
  const mud = compose("build me a dog", { material: "minecraft:mud" });
  assert.equal(mud.materials.primary, "minecraft:brown_concrete");
  validateBuildStructurePlan(mud);
  const banned = compose("build me a dog", { material: "minecraft:command_block" });
  assert.notEqual(banned.materials.primary, "minecraft:command_block");
  assert.ok(!banned.primitives.some(({ blockId }) => blockId === "minecraft:command_block"));
  validateBuildStructurePlan(banned);
});

test("compound nouns like doghouse resolve to the house template, not an animal", () => {
  const descriptor = extractDescriptor("build a doghouse");
  assert.equal(descriptor.template, "house");
  assert.notEqual(descriptor.template, "quadruped");
  assert.equal(descriptor.kind, "doghouse");
  validateBuildStructurePlan(composeStructurePlan(descriptor));
  const birdhouse = extractDescriptor("build me a birdhouse");
  assert.equal(birdhouse.template, "house");
});

test("city-like kinds never trip the authored city geometry gate", () => {
  const plan = compose("build me a city", { kind: "city" });
  assert.notEqual(plan.kind, "city");
  validateBuildStructurePlan(plan);
});

test("entity overrides keep only allowed types placed inside the plan", () => {
  const plan = compose("build me a house", {
    entities: [
      { typeId: "minecraft:iron_golem" },
      { typeId: "minecraft:creeper" },
      "minecraft:goat",
      { typeId: "minecraft:villager_v2", location: [999, 999, 999] },
    ],
  });
  const validated = validateBuildStructurePlan(plan);
  assert.deepEqual(validated.entities.map(({ typeId }) => typeId), [
    "minecraft:iron_golem",
    "minecraft:goat",
    "minecraft:villager_v2",
  ]);
  for (const { location } of validated.entities) {
    assert.ok(location[0] < validated.dimensions.width);
    assert.ok(location[1] < validated.dimensions.height);
    assert.ok(location[2] < validated.dimensions.depth);
  }
});

test("narration is honest prose with no commands or block ids", () => {
  for (const question of ["build me a dog", "build me a giant rainbow", "build me a zorblax"]) {
    const descriptor = extractDescriptor(question);
    const narration = describeProceduralBuild(descriptor);
    assert.ok(narration.includes(descriptor.kind), narration);
    assert.ok(!narration.includes("/"), narration);
    assert.ok(!narration.includes("minecraft:"), narration);
    assert.match(narration, /grade/i);
  }
});

test("wizard-style overrides win over question parsing", () => {
  const descriptor = extractDescriptor("build me something cool", {
    kind: "puppy",
    material: "minecraft:white_concrete",
    features: ["lighting", "not-a-feature"],
  });
  assert.equal(descriptor.template, "quadruped");
  assert.equal(descriptor.kind, "puppy");
  assert.equal(descriptor.palette.primary, "minecraft:white_concrete");
  assert.ok(descriptor.features.includes("lighting"));
  assert.ok(!descriptor.features.includes("not-a-feature"));
  validateBuildStructurePlan(composeStructurePlan(descriptor));
});
