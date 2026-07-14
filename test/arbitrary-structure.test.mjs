import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  expansionClearOperations,
  obsoleteExpansionOperations,
  primitiveStructureOperations,
  validateBuildStructurePlan,
} from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";
import { classifyAction, createWizard } from "../src/wizard.mjs";

const customPlan = {
  title: "Emerald Dragon",
  kind: "dragon statue",
  dimensions: { width: 12, depth: 8, height: 10 },
  materials: {
    primary: "minecraft:green_concrete",
    accent: "minecraft:lime_concrete",
    roof: "minecraft:stone",
  },
  features: ["supports"],
  phases: ["foundation", "shell", "roof", "details"],
  primitives: [
    { shape: "line", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 3], to: [11, 0, 3] },
    { shape: "box", phase: "shell", blockId: "minecraft:green_concrete", from: [4, 1, 0], to: [7, 5, 7] },
    { shape: "line", phase: "roof", blockId: "minecraft:lime_concrete", from: [5, 6, 3], to: [5, 9, 3] },
    { shape: "box", phase: "details", blockId: "minecraft:white_concrete", from: [5, 7, 2], to: [5, 7, 2] },
  ],
};

test("validates compact phased primitives inside the requested bounds", () => {
  const plan = validateBuildStructurePlan(customPlan);
  assert.equal(plan.primitives.length, 4);
  assert.deepEqual(primitiveStructureOperations(plan), plan.primitives.map(({ phase, blockId, from, to }) => ({
    phase, blockId, from, to,
  })));
  assert.throws(() => validateBuildStructurePlan({
    ...customPlan,
    primitives: customPlan.primitives.map((primitive, index) => (
      index === 3 ? { ...primitive, to: [12, 7, 2] } : primitive
    )),
  }), /outside the requested dimensions/);
  assert.throws(() => validateBuildStructurePlan({
    ...customPlan,
    primitives: [customPlan.primitives[0], customPlan.primitives[2], customPlan.primitives[1], customPlan.primitives[3]],
  }), /phase order/);
  assert.throws(() => validateBuildStructurePlan({
    ...customPlan,
    primitives: customPlan.primitives.map((primitive, index) => (
      index === 2 ? { ...primitive, shape: "line", from: [1, 2, 1], to: [3, 4, 1] } : primitive
    )),
  }), /axis-aligned/);
  assert.throws(() => validateBuildStructurePlan({
    ...customPlan,
    primitives: customPlan.primitives.map((primitive, index) => (
      index === 0 ? { ...primitive, from: [1, 0, 3], to: [10, 0, 3] } : primitive
    )),
  }), /bounds must match/);
});

test("new primitive structures require solid geometry in every phase and across every bound", () => {
  const allAir = [
    { shape: "box", phase: "foundation", blockId: "minecraft:air", from: [0, 0, 0], to: [11, 0, 7] },
    { shape: "box", phase: "shell", blockId: "minecraft:air", from: [0, 1, 0], to: [0, 8, 7] },
    { shape: "box", phase: "roof", blockId: "minecraft:air", from: [0, 9, 0], to: [11, 9, 7] },
    { shape: "box", phase: "details", blockId: "minecraft:air", from: [11, 1, 7], to: [11, 8, 7] },
  ];
  assert.throws(() => validateBuildStructurePlan({ ...customPlan, primitives: allAir }), /solid primitives must include/);

  const airOnlyBounds = [
    { ...customPlan.primitives[0], from: [1, 0, 3], to: [10, 0, 3] },
    ...customPlan.primitives.slice(1),
    { shape: "box", phase: "details", blockId: "minecraft:air", from: [0, 0, 0], to: [11, 9, 7] },
  ];
  assert.throws(
    () => validateBuildStructurePlan({ ...customPlan, primitives: airOnlyBounds }),
    /solid primitive bounds must match/,
  );

  const airOnlyRoof = customPlan.primitives.map((primitive) => (
    primitive.phase === "roof" ? { ...primitive, blockId: "minecraft:air" } : primitive
  ));
  assert.throws(
    () => validateBuildStructurePlan({ ...customPlan, primitives: airOnlyRoof }),
    /solid primitives must include/,
  );
});

test("validates bounded in-place structure modifications, inhabitants, and primitive-only lava", () => {
  const modification = validateBuildStructurePlan({
    ...customPlan,
    mode: "modify",
    features: ["rooms", "second_floor", "decorations", "towers"],
    primitives: [
      { shape: "box", phase: "details", blockId: "minecraft:air", from: [2, 1, 2], to: [3, 2, 3] },
    ],
    entities: [
      { typeId: "minecraft:villager_v2", location: [4, 1, 4] },
      { typeId: "minecraft:goat", location: [6, 1, 4] },
      { typeId: "minecraft:iron_golem", location: [8, 1, 4] },
    ],
  });
  assert.equal(modification.mode, "modify");
  assert.deepEqual(modification.features, ["rooms", "second_floor", "decorations", "towers"]);
  assert.equal(modification.primitives[0].blockId, "minecraft:air");
  assert.deepEqual(modification.entities, [
    { typeId: "minecraft:villager_v2", location: [4, 1, 4] },
    { typeId: "minecraft:goat", location: [6, 1, 4] },
    { typeId: "minecraft:iron_golem", location: [8, 1, 4] },
  ]);

  const lavaMoat = validateBuildStructurePlan({
    ...customPlan,
    mode: "modify",
    primitives: [{ shape: "line", phase: "foundation", blockId: "minecraft:lava", from: [-1, 0, 0], to: [-1, 0, 7] }],
  });
  assert.equal(lavaMoat.primitives[0].blockId, "minecraft:lava");
  assert.throws(() => validateBuildStructurePlan({
    ...customPlan,
    materials: { ...customPlan.materials, primary: "minecraft:lava" },
  }), /materials\.primary is not allowed/);

  const generatedModification = validateBuildStructurePlan({
    ...customPlan,
    mode: "modify",
    features: ["rooms", "second_floor", "decorations"],
    primitives: undefined,
  });
  assert.equal(generatedModification.mode, "modify");
  assert.equal(generatedModification.primitives, undefined);

  assert.throws(() => validateBuildStructurePlan({
    ...customPlan,
    materials: { ...customPlan.materials, primary: "minecraft:air" },
  }), /materials\.primary is not allowed/);
  assert.throws(() => validateBuildStructurePlan({ ...customPlan, mode: "replace" }), /mode must be modify/);
  assert.throws(() => validateBuildStructurePlan({
    ...customPlan,
    entities: [{ typeId: "minecraft:zombie", location: [1, 1, 1] }],
  }), /typeId is not allowed/);
  assert.throws(() => validateBuildStructurePlan({
    ...customPlan,
    entities: [{ typeId: "minecraft:villager_v2", location: [12, 1, 1] }],
  }), /outside the requested dimensions/);
  assert.throws(() => validateBuildStructurePlan({
    ...customPlan,
    entities: [{ typeId: "minecraft:villager_v2", location: [1.5, 1, 1] }],
  }), /outside the requested dimensions/);
  assert.throws(() => validateBuildStructurePlan({
    ...customPlan,
    entities: Array.from({ length: 9 }, () => ({
      typeId: "minecraft:villager_v2",
      location: [1, 1, 1],
    })),
  }), /0-8 entries/);
});

test("preserves a provider-authored shape while appending a follow-up detail", () => {
  const action = classifyAction("add a balcony to the dragon statue", [{
    question: "Build a 12x8x10 dragon statue",
    answer: "The dragon statue is complete.",
    action: { type: "build_structure", version: 1, plan: customPlan },
  }]);
  const plan = validateBuildStructurePlan(action.plan);
  assert.equal(plan.mode, "modify");
  assert.deepEqual(plan.primitives.slice(0, customPlan.primitives.length), customPlan.primitives);
  const balcony = plan.primitives.slice(customPlan.primitives.length);
  assert.ok(balcony.length >= 6);
  assert.ok(balcony.every(({ phase }) => phase === "details"));
  assert.ok(balcony.some(({ from, to }) => from[2] < 0 || to[2] < 0));
});

test("an expansion removes only the wizard's obsolete exterior shell and roof", () => {
  const oldOperations = [
    { phase: "foundation", blockId: "minecraft:stone_bricks", from: [0, 0, 0], to: [11, 0, 7] },
    { phase: "shell", blockId: "minecraft:stone_bricks", from: [0, 1, 0], to: [11, 6, 0] },
    { phase: "shell", blockId: "minecraft:oak_planks", from: [1, 1, 4], to: [10, 6, 4] },
    { phase: "shell", blockId: "minecraft:oak_planks", from: [1, 3, 1], to: [10, 3, 6] },
    { phase: "roof", blockId: "minecraft:spruce_planks", from: [0, 7, 0], to: [11, 7, 7] },
    { phase: "details", blockId: "minecraft:glass", from: [2, 2, 0], to: [2, 2, 0] },
    { phase: "details", blockId: "minecraft:sea_lantern", from: [5, 2, 4], to: [5, 2, 4] },
  ];
  const expanded = {
    ...customPlan,
    dimensions: { width: 20, depth: 16, height: 12 },
  };
  const cleanup = obsoleteExpansionOperations(customPlan, expanded, oldOperations);
  assert.ok(cleanup.length >= 3);
  assert.ok(cleanup.every(({ phase, blockId, replaceBlockId }) => (
    phase === "cleanup" && blockId === "minecraft:air" && replaceBlockId !== "minecraft:air"
  )));
  assert.deepEqual(
    new Set(cleanup.map(({ replaceBlockId }) => replaceBlockId)),
    new Set(["minecraft:stone_bricks", "minecraft:spruce_planks", "minecraft:glass"]),
  );
  assert.equal(cleanup.some(({ from, to }) => from[2] === 4 && to[2] === 4), false);
  assert.equal(cleanup.some(({ from, to }) => from[1] === 3 && to[1] === 3 && from[2] === 1), false);
  assert.deepEqual(obsoleteExpansionOperations(customPlan, customPlan, oldOperations), []);
  const expansionClears = expansionClearOperations(customPlan, expanded);
  assert.ok(expansionClears.length >= 3);
  assert.ok(expansionClears.every(({ blockId, from, to }) => (
    blockId === "minecraft:air" && from.every((value, axis) => value <= to[axis])
  )));
  assert.deepEqual(expansionClearOperations(customPlan, customPlan), []);

  const shrunk = { ...customPlan, dimensions: { width: 8, depth: 6, height: 6 } };
  const shrinkCleanup = obsoleteExpansionOperations(customPlan, shrunk, oldOperations);
  assert.ok(shrinkCleanup.some(({ from, to }) => from[1] === 0 && to[1] === 0));
  assert.ok(shrinkCleanup.some(({ from, to }) => from[2] === 4 && to[2] === 4));
  assert.ok(shrinkCleanup.some(({ from, to }) => from[1] === 2 && to[1] === 2));
});

test("a full same-size build removes every first-pass marker before rebuilding", () => {
  const firstPass = {
    ...customPlan,
    title: "First pass dragon statue",
  };
  const markerOperations = [
    { phase: "foundation", blockId: "minecraft:green_concrete", from: [0, 0, 0], to: [11, 0, 0] },
    { phase: "shell", blockId: "minecraft:green_concrete", from: [0, 0, 0], to: [0, 0, 7] },
    { phase: "roof", blockId: "minecraft:green_concrete", from: [0, 0, 0], to: [0, 9, 0] },
    { phase: "details", blockId: "minecraft:light_blue_concrete", from: [11, 0, 7], to: [11, 0, 7] },
  ];
  const cleanup = obsoleteExpansionOperations(firstPass, customPlan, markerOperations);
  assert.ok(markerOperations.every((marker) => cleanup.some((operation) => (
    operation.replaceBlockId === marker.blockId
    && operation.from.every((coordinate, axis) => coordinate === marker.from[axis])
    && operation.to.every((coordinate, axis) => coordinate === marker.to[axis])
  ))));
  assert.ok(cleanup.every(({ phase, blockId }) => phase === "cleanup" && blockId === "minecraft:air"));
});

test("asks the model for an unusual exact-size structure instead of making a generic box", async () => {
  assert.equal(classifyAction("Build a 12x8x10 dragon statue"), null);
  assert.equal(classifyAction("Build a 14x12 treehouse"), null);
  assert.equal(classifyAction("Build a statue of my cat"), null);
  let providerCalled = false;
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalled = true;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "Stand back—this emerald dragon will rise from its feet to its horns.",
        action: { type: "build_structure", version: 1, plan: customPlan },
      }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await wizard.ask({ player: "BuilderKid", question: "Build a 12x8x10 dragon statue" });
  assert.equal(providerCalled, true);
  assert.equal(result.mode, "chat:model");
  assert.equal(result.action.plan.kind, "dragon statue");
  assert.deepEqual(result.action.plan.dimensions, { width: 12, depth: 8, height: 10 });
  assert.equal(result.action.plan.primitives.length, 4);
  assert.doesNotMatch(result.answer, /house|generic|prototype|pad/i);
});

test("the structured response lets ordinary buildings omit primitives while validating authored geometry", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/wizard-response.schema.json", import.meta.url), "utf8"));
  const structureAction = schema.properties.action.anyOf.find((candidate) => (
    candidate.properties?.type?.const === "build_structure"
  ));
  assert.equal(structureAction.properties.plan.required.includes("primitives"), false);
  assert.equal(structureAction.properties.plan.properties.primitives.minItems, 1);
  const solidRequirements = structureAction.properties.plan.allOf[0]
    .then.properties.primitives.allOf;
  assert.deepEqual(solidRequirements.map(({ contains }) => contains.$ref), [
    "#/$defs/solidFoundationPrimitive",
    "#/$defs/solidShellPrimitive",
    "#/$defs/solidRoofPrimitive",
    "#/$defs/solidDetailsPrimitive",
  ]);
  assert.ok(solidRequirements.every(({ contains }) => (
    schema.$defs[contains.$ref.split("/").at(-1)].properties.blockId.not.const === "minecraft:air"
  )));
  const pack = readFileSync(new URL("../bedrock/behavior_packs/mc_wizard/scripts/main.js", import.meta.url), "utf8");
  assert.match(pack, /function structurePlanOperations\(plan, previousPlan\)/);
  assert.match(pack, /sameGeneratedStructureBase\(plan, previousPlan\)/);
  assert.match(pack, /else if \(detailOnlyPatch\)/);
  assert.match(pack, /previousPrimitiveKeys\.has\(JSON\.stringify\(operation\)\)/);
  assert.match(pack, /\[\.\.\.structureOperations\(plan\), \.\.\.primitives\]/);
  assert.match(pack, /obsoleteExpansionOperations\(modificationSite\.previous\.plan, plan, previousOperations\)/);
  assert.match(pack, /worldStructureBox\(\s*modificationSite\.previous\.origin,/);
  assert.match(pack, /\[\.\.\.obsoleteWorldOperations, \.\.\.operations\.flatMap/);
  assert.match(pack, /replaceBlockId \? ` replace \$\{replaceBlockId\}`/);
});

test("runtime replaces an unusual provider structure that omits authored primitives", async () => {
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      answer: "I’ll build the dragon statue now.",
      action: {
        type: "build_structure",
        version: 1,
        plan: {
          title: "Dragon Statue",
          kind: "dragon statue",
          dimensions: { width: 12, depth: 8, height: 10 },
          materials: {
            primary: "minecraft:green_concrete",
            accent: "minecraft:dark_prismarine",
            roof: "minecraft:orange_concrete"
          },
          features: ["floor"],
          phases: ["foundation", "shell", "roof", "details"]
        }
      }
    }) } }] }), { status: 200 }),
  });

  const result = await wizard.ask({ player: "BuilderKid", question: "Build a 12x8x10 dragon statue" });
  assert.equal(result.mode, "local-structure-fallback");
  assert.equal(result.action.plan.kind, "dragon statue");
  assert.deepEqual(result.action.plan.dimensions, { width: 12, depth: 8, height: 10 });
  assert.ok(result.action.plan.primitives.length >= 4);
});

test("rejects a line-only provider scaffold that only names the requested subject", async () => {
  const scaffold = {
    ...customPlan,
    title: "Fake Dragon", kind: "dragon statue",
    primitives: [
      { shape: "line", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 3], to: [11, 0, 3] },
      { shape: "line", phase: "shell", blockId: "minecraft:green_concrete", from: [5, 4, 0], to: [5, 4, 7] },
      { shape: "line", phase: "roof", blockId: "minecraft:lime_concrete", from: [5, 0, 3], to: [5, 9, 3] },
      { shape: "box", phase: "details", blockId: "minecraft:white_concrete", from: [5, 7, 2], to: [5, 7, 2] },
    ],
  };
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      answer: "I’ll build the complete dragon now.",
      action: { type: "build_structure", version: 1, plan: scaffold },
    }) } }] }), { status: 200 }),
  });
  const result = await wizard.ask({ player: "ScaffoldKid", question: "Build a 12x8x10 dragon statue" });
  assert.equal(result.mode, "local-structure-fallback");
  assert.notDeepEqual(result.action.plan.primitives, validateBuildStructurePlan(scaffold).primitives);
  assert.ok(result.action.plan.primitives.some(({ shape, from, to }) => (
    shape === "box" && from.every((coordinate, axis) => to[axis] > coordinate)
  )));
});

test("rejects a generic full-envelope room labeled as a sculpture", async () => {
  const fakeDuck = {
    title: "Giant Rubber Duck", kind: "giant rubber duck",
    dimensions: { width: 11, depth: 7, height: 6 },
    materials: {
      primary: "minecraft:yellow_concrete", accent: "minecraft:orange_concrete", roof: "minecraft:yellow_concrete",
    },
    features: ["supports"], phases: ["foundation", "shell", "roof", "details"],
    primitives: [
      { shape: "box", phase: "foundation", blockId: "minecraft:yellow_concrete", from: [0, 0, 0], to: [10, 0, 6] },
      { shape: "hollow_box", phase: "shell", blockId: "minecraft:yellow_concrete", from: [0, 0, 0], to: [10, 5, 6] },
      { shape: "box", phase: "roof", blockId: "minecraft:yellow_concrete", from: [0, 5, 0], to: [10, 5, 6] },
      { shape: "box", phase: "details", blockId: "minecraft:orange_concrete", from: [5, 3, 6], to: [5, 3, 6] },
    ],
  };
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      answer: "I’ll build the whole duck now.",
      action: { type: "build_structure", version: 1, plan: fakeDuck },
    }) } }] }), { status: 200 }),
  });
  const result = await wizard.ask({ player: "RoomDuckKid", question: "Build me an 11x7x6 giant rubber duck" });
  assert.notEqual(result.mode, "chat:model");
  assert.notDeepEqual(result.action?.plan?.primitives, validateBuildStructurePlan(fakeDuck).primitives);
  assert.equal(result.goal.status, "active");
});

test("wires a bounded live scope that verifies an exact-size dragon in the world", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageJson.scripts["test:e2e:arbitrary"],
    "MC_WIZARD_E2E_SCOPE=arbitrary sh scripts/run-e2e-container.sh",
  );
  const runner = readFileSync(new URL("../scripts/run-e2e-container.sh", import.meta.url), "utf8");
  assert.match(runner, /E2E_SCOPE.*arbitrary/);
  assert.match(runner, /E2E_TIMEOUT_MS=300000/);
  const pack = readFileSync(new URL("../bedrock/behavior_packs/mc_wizard/scripts/e2e.js", import.meta.url), "utf8");
  assert.match(pack, /"build me a 20x10x12 dragon"/);
  assert.match(pack, /bounds=20x10x12/);
  assert.match(pack, /density < 0\.35/);
  assert.match(pack, /Boolean\(wingLayer\)/);
  assert.match(pack, /bodyDepth >= 8/);
  assert.match(pack, /Boolean\(head\)/);
});
