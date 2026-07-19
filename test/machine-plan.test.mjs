import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { allowedWizardAction, wizardSkillPrompt } from "../src/skills.mjs";
import { classifyAction, createWizard } from "../src/wizard.mjs";
import {
  foldPlacementSteps,
  machineBlueprint,
  machinePlanSchemaPrompt,
  validateMachinePlan,
} from "../bedrock/behavior_packs/mc_wizard/scripts/machine-plan.js";

const place = (itemId, target, support, orientationTarget = null) => ({
  itemId, target, support, orientationTarget,
});

const captureError = (fn) => {
  let error;
  assert.throws(fn, (thrown) => {
    error = thrown;
    return true;
  });
  return error;
};

const sugarCanePlan = {
  title: "Sugar Cane Farm",
  kind: "sugar cane farm",
  placements: [
    place("minecraft:smooth_stone", [0, 0, 1], [0, -1, 1]),
    place("minecraft:hopper", [0, 0, 2], [0, 0, 1], [0, 0, 1]),
    { action: "break", target: [0, 0, 1] },
    place("minecraft:chest", [0, 0, 1], [0, -1, 1]),
    place("minecraft:dirt", [0, 0, 3], [0, -1, 3]),
    place("minecraft:sugar_cane", [0, 1, 3], [0, 0, 3]),
    place("minecraft:smooth_stone", [0, 0, 5], [0, -1, 5]),
    place("minecraft:smooth_stone", [0, 1, 5], [0, 0, 5]),
    place("minecraft:smooth_stone", [0, 2, 5], [0, 1, 5]),
    place("minecraft:piston", [0, 2, 4], [0, 2, 5], [0, 2, 3]),
    place("minecraft:observer", [0, 3, 4], [0, 2, 4], [0, 3, 3]),
    place("minecraft:redstone", [0, 3, 5], [0, 2, 5]),
  ],
  interactions: [{
    action: "use_item_on_block",
    itemId: "minecraft:water_bucket",
    block: [1, -1, 3],
    faceTarget: [1, 0, 3],
  }],
};

const flyingMachinePlan = {
  title: "Flying Machine",
  kind: "flying machine",
  placements: [
    place("minecraft:smooth_stone", [0, 0, 2], [0, -1, 2]),
    place("minecraft:slime_block", [0, 1, 2], [0, 0, 2]),
    place("minecraft:sticky_piston", [0, 1, 3], [0, 1, 2], [0, 1, 4]),
    place("minecraft:observer", [0, 1, 1], [0, 1, 2], [0, 1, 0]),
    { action: "break", target: [0, 0, 2] },
  ],
  interactions: [],
};

const netherPortalPlan = {
  title: "Nether Portal",
  kind: "nether portal",
  placements: [
    place("minecraft:obsidian", [0, 0, 2], [0, -1, 2]),
    place("minecraft:obsidian", [1, 0, 2], [0, 0, 2]),
    place("minecraft:obsidian", [2, 0, 2], [1, 0, 2]),
    place("minecraft:obsidian", [3, 0, 2], [2, 0, 2]),
    place("minecraft:obsidian", [0, 1, 2], [0, 0, 2]),
    place("minecraft:obsidian", [0, 2, 2], [0, 1, 2]),
    place("minecraft:obsidian", [0, 3, 2], [0, 2, 2]),
    place("minecraft:obsidian", [0, 4, 2], [0, 3, 2]),
    place("minecraft:obsidian", [3, 1, 2], [3, 0, 2]),
    place("minecraft:obsidian", [3, 2, 2], [3, 1, 2]),
    place("minecraft:obsidian", [3, 3, 2], [3, 2, 2]),
    place("minecraft:obsidian", [3, 4, 2], [3, 3, 2]),
    place("minecraft:obsidian", [1, 4, 2], [0, 4, 2]),
    place("minecraft:obsidian", [2, 4, 2], [1, 4, 2]),
  ],
  interactions: [{
    action: "use_item_on_block",
    itemId: "minecraft:flint_and_steel",
    block: [1, 0, 2],
    faceTarget: [1, 1, 2],
  }],
};

test("validates bounded player-action plans for long-tail farms and machines", () => {
  const farm = machineBlueprint(sugarCanePlan);
  const flying = machineBlueprint(flyingMachinePlan);
  assert.equal(validateMachinePlan(sugarCanePlan).placements.length, 12);
  assert.deepEqual(farm.placements.find(({ itemId }) => itemId === "minecraft:sugar_cane").expectedType,
    ["minecraft:sugar_cane", "minecraft:reeds"]);
  assert.equal(farm.preInteractions[0].expectedFaceType, "minecraft:water");
  assert.ok(farm.verification.some(({ kind, typeId }) => kind === "block_type" && typeId === "minecraft:water"));
  assert.equal(farm.verification.filter(({ kind }) => kind === "block_facing").length, 2);
  assert.equal(flying.placements.at(-1).action, "break");
  assert.ok(flying.verification.some(({ kind }) => kind === "block_facing"));
  assert.equal(allowedWizardAction({ type: "build_machine", version: 1, plan: sugarCanePlan }).plan.kind, "sugar cane farm");
});

// #35: validateMachinePlan now drops invalid entries per-placement instead of
// throwing on the first one. These cases still reject the WHOLE plan because
// the drops breach the survival floor (fewer than max(4, 50%) placements
// survive) or drop every requested interaction; the error message is now a
// JSON violation list whose reasons still match the original patterns.
test("rejects unsafe machine items, arbitrary breaking, and unbounded directions", () => {
  assert.throws(() => validateMachinePlan({
    ...sugarCanePlan,
    placements: [place("minecraft:tnt", [0, 0, 2], [0, -1, 2])],
    interactions: [],
  }), /itemId is not allowed/);
  assert.throws(() => validateMachinePlan({
    ...flyingMachinePlan,
    placements: [{ action: "break", target: [0, 0, 2] }],
  }), /earlier stone scaffold/);
  assert.throws(() => validateMachinePlan({
    ...flyingMachinePlan,
    placements: [
      place("minecraft:smooth_stone", [0, 0, 2], [0, -1, 2]),
      place("minecraft:piston", [0, 1, 2], [0, 0, 2], [0, 1, 8]),
    ],
  }), /orientationTarget must touch/);
  assert.throws(() => validateMachinePlan({
    ...sugarCanePlan,
    interactions: [{ action: "use_item_on_block", itemId: "minecraft:lava_bucket", block: [0, -1, 2], faceTarget: [0, 0, 2] }],
  }), /itemId is not allowed/);
});

test("builds and lights a complete model-authored Nether portal before verifying its interior", () => {
  const portal = machineBlueprint(netherPortalPlan);
  assert.equal(portal.placements[0].expectedType, "minecraft:obsidian");
  assert.equal(portal.preInteractions.length, 0);
  assert.equal(portal.interactions[0].itemId, "minecraft:flint_and_steel");
  assert.equal(portal.interactions[0].expectedFaceType, "minecraft:portal");
  assert.equal(portal.interactions[0].expectedFaceBlocks.length, 6);
  assert.equal(portal.verification.filter(({ kind, typeId }) => (
    kind === "block_type" && typeId === "minecraft:portal"
  )).length, 6);
  assert.equal(allowedWizardAction({ type: "build_machine", version: 1, plan: netherPortalPlan }).plan.kind, "nether portal");
});

test("an unlit portal has no false portal verification and deactivation preserves the frame", () => {
  const unlit = machineBlueprint({ ...netherPortalPlan, interactions: [] });
  assert.equal(unlit.interactions.length, 0);
  assert.equal(unlit.verification.some(({ typeId }) => typeId === "minecraft:portal"), false);
  assert.match(unlit.success, /intentionally left unlit/i);

  const off = machineBlueprint({
    ...netherPortalPlan,
    mode: "modify",
    placements: [
      ...netherPortalPlan.placements,
      place("minecraft:smooth_stone", [1, 1, 2], [0, 1, 2]),
      { action: "break", target: [1, 1, 2] },
    ],
    interactions: [],
  });
  assert.equal(off.placements.at(-1).action, "break");
  assert.match(off.success, /switched off/i);
  assert.equal(foldPlacementSteps(off.placements).some(({ target }) => target?.join() === "1,1,2"), false);
});

test("folds ordered placement and break operations into final project state", () => {
  assert.deepEqual(foldPlacementSteps([
    place("minecraft:smooth_stone", [0, 0, 1], [0, -1, 1]),
    { action: "break", target: [0, 0, 1] },
    place("minecraft:chest", [0, 0, 1], [0, -1, 1]),
    place("minecraft:glass", [1, 0, 1], [1, -1, 1]),
    { action: "break", target: [1, 0, 1] },
  ]), [place("minecraft:chest", [0, 0, 1], [0, -1, 1])]);
});

// #35: whole-plan rejection here now flows through the all-interactions-dropped
// gate (flint_and_steel was the only interaction); the reason text is unchanged.
test("rejects ignition without a complete bounded obsidian portal frame", () => {
  assert.throws(() => validateMachinePlan({
    ...netherPortalPlan,
    placements: netherPortalPlan.placements.slice(0, -1),
  }), /complete vertical obsidian portal frame/);
  assert.throws(() => validateMachinePlan({
    ...netherPortalPlan,
    placements: [
      ...netherPortalPlan.placements,
      place("minecraft:smooth_stone", [2, 1, 2], [2, 0, 2]),
    ],
  }), /complete vertical obsidian portal frame/);
});

// #35: entry-drop validation — a single salvageable bad entry no longer
// rejects the whole plan; it drops with {index, reason} and the rest survives.
test("drops only the irreparable placement and keeps the surviving machine", () => {
  const placements = [];
  for (let z = 2; z <= 16; z += 1) placements.push(place("minecraft:smooth_stone", [0, 0, z], [0, -1, z]));
  for (let z = 2; z <= 15; z += 1) placements.push(place("minecraft:smooth_stone", [0, 1, z], [0, 0, z]));
  placements.push(place("minecraft:crafting_table", [5, 0, 18], [5, -1, 18]));
  assert.equal(placements.length, 30);
  const plan = validateMachinePlan({ title: "Long Wall", kind: "wall machine", placements, interactions: [] });
  assert.equal(plan.placements.length, 29);
  assert.equal(plan.dropped.length, 1);
  assert.deepEqual(plan.dropped[0], { index: 29, reason: "placements[29].itemId is not allowed" });
  // No reordering: survivors keep their original relative order.
  assert.deepEqual(plan.placements[0].target, [0, 0, 2]);
  assert.deepEqual(plan.placements.at(-1).target, [0, 1, 15]);
});

test("cascades drops through a dropped support without synthesizing repairs", () => {
  const plan = validateMachinePlan({
    title: "Tower",
    kind: "tower machine",
    placements: [
      place("minecraft:smooth_stone", [0, 0, 2], [0, -1, 2]),
      place("minecraft:smooth_stone", [0, 1, 2], [0, 0, 2]),
      place("minecraft:tnt", [0, 2, 2], [0, 1, 2]),
      place("minecraft:smooth_stone", [0, 3, 2], [0, 2, 2]),
      place("minecraft:smooth_stone", [1, 0, 2], [1, -1, 2]),
      place("minecraft:smooth_stone", [2, 0, 2], [2, -1, 2]),
      place("minecraft:smooth_stone", [3, 0, 2], [3, -1, 2]),
      place("minecraft:smooth_stone", [4, 0, 2], [4, -1, 2]),
    ],
    interactions: [],
  });
  assert.equal(plan.placements.length, 6);
  assert.deepEqual(plan.dropped.map(({ index }) => index), [2, 3]);
  assert.match(plan.dropped[0].reason, /itemId is not allowed/);
  assert.match(plan.dropped[1].reason, /support must be ground or an earlier placement/);
});

test("rejects the whole plan with a full JSON violation list when most placements are invalid", () => {
  const error = captureError(() => validateMachinePlan({
    title: "Bad Machine",
    kind: "bad machine",
    placements: [
      place("minecraft:smooth_stone", [0, 0, 2], [0, -1, 2]),
      place("minecraft:smooth_stone", [1, 0, 2], [1, -1, 2]),
      place("minecraft:tnt", [2, 0, 2], [2, -1, 2]),
      place("minecraft:command_block", [3, 0, 2], [3, -1, 2]),
      place("minecraft:mob_spawner", [4, 0, 2], [4, -1, 2]),
      place("minecraft:barrier", [5, 0, 2], [5, -1, 2]),
    ],
    interactions: [],
  }));
  const violations = JSON.parse(error.message);
  assert.equal(violations.length, 4);
  assert.deepEqual(violations.map(({ index }) => index), [2, 3, 4, 5]);
  for (const violation of violations) assert.match(violation.reason, /itemId is not allowed/);
});

test("permanently drops unsalvageable fire but keeps the plan when safe interactions survive", () => {
  const brokenFrame = netherPortalPlan.placements.slice(0, -1);
  const flint = {
    action: "use_item_on_block",
    itemId: "minecraft:flint_and_steel",
    block: [1, 0, 2],
    faceTarget: [1, 1, 2],
  };
  const water = {
    action: "use_item_on_block",
    itemId: "minecraft:water_bucket",
    block: [5, -1, 2],
    faceTarget: [5, 0, 2],
  };
  const plan = validateMachinePlan({
    ...netherPortalPlan,
    placements: brokenFrame,
    interactions: [flint, water],
  });
  // Fire is never salvaged: the ignition drops for good, water survives.
  assert.equal(plan.interactions.length, 1);
  assert.equal(plan.interactions[0].itemId, "minecraft:water_bucket");
  assert.equal(plan.dropped.length, 1);
  assert.match(plan.dropped[0].reason, /complete vertical obsidian portal frame/);

  // When the dropped ignition was the ONLY interaction, the whole plan fails.
  const error = captureError(() => validateMachinePlan({
    ...netherPortalPlan,
    placements: brokenFrame,
    interactions: [flint],
  }));
  const violations = JSON.parse(error.message);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].index, 0);
  assert.match(violations[0].reason, /complete vertical obsidian portal frame/);
});

test("accepts inert placement additions and hopper minecarts on rail variants", () => {
  const plan = validateMachinePlan({
    title: "Decor Depot",
    kind: "rail depot",
    placements: [
      place("minecraft:smooth_stone", [0, 0, 2], [0, -1, 2]),
      place("minecraft:target", [0, 1, 2], [0, 0, 2]),
      place("minecraft:golden_rail", [1, 0, 2], [1, -1, 2]),
      place("minecraft:detector_rail", [2, 0, 2], [2, -1, 2]),
      place("minecraft:activator_rail", [3, 0, 2], [3, -1, 2]),
      place("minecraft:stone_bricks", [4, 0, 2], [4, -1, 2]),
      place("minecraft:glass_pane", [4, 1, 2], [4, 0, 2]),
      place("minecraft:oak_fence", [5, 0, 2], [5, -1, 2]),
      place("minecraft:torch", [5, 1, 2], [5, 0, 2]),
    ],
    interactions: [{
      action: "use_item_on_block",
      itemId: "minecraft:hopper_minecart",
      block: [1, 0, 2],
      faceTarget: [1, 1, 2],
    }],
  });
  assert.equal(plan.placements.length, 9);
  assert.equal(plan.interactions.length, 1);
  assert.equal(plan.dropped, undefined);
});

test("command-adjacent items never enter the machine placement allowlist", () => {
  const prompt = machinePlanSchemaPrompt();
  for (const banned of [
    "minecraft:command_block",
    "minecraft:repeating_command_block",
    "minecraft:chain_command_block",
    "minecraft:structure_block",
    "minecraft:mob_spawner",
    "minecraft:barrier",
    "minecraft:tnt",
  ]) {
    assert.equal(prompt.includes(banned), false, `${banned} must not be offered to the model`);
    const plan = validateMachinePlan({
      title: "Probe",
      kind: "probe machine",
      placements: [
        place("minecraft:smooth_stone", [0, 0, 2], [0, -1, 2]),
        place("minecraft:smooth_stone", [1, 0, 2], [1, -1, 2]),
        place("minecraft:smooth_stone", [2, 0, 2], [2, -1, 2]),
        place("minecraft:smooth_stone", [3, 0, 2], [3, -1, 2]),
        place(banned, [4, 0, 2], [4, -1, 2]),
      ],
      interactions: [],
    });
    assert.equal(plan.placements.some(({ itemId }) => itemId === banned), false);
    assert.match(plan.dropped[0].reason, /itemId is not allowed/);
  }
});

test("validates a wheat farm with farmland, water, and a hopper path to a chest", () => {
  const wheatFarmPlan = {
    title: "Wheat Farm",
    kind: "wheat farm",
    placements: [
      place("minecraft:smooth_stone", [0, 0, 1], [0, -1, 1]),
      place("minecraft:hopper", [0, 0, 2], [0, 0, 1], [0, 0, 1]),
      { action: "break", target: [0, 0, 1] },
      place("minecraft:chest", [0, 0, 1], [0, -1, 1]),
      place("minecraft:farmland", [0, 0, 3], [0, -1, 3]),
      place("minecraft:wheat", [0, 1, 3], [0, 0, 3]),
    ],
    interactions: [{
      action: "use_item_on_block",
      itemId: "minecraft:water_bucket",
      block: [1, -1, 3],
      faceTarget: [1, 0, 3],
    }],
  };
  const farm = machineBlueprint(wheatFarmPlan);
  const pipeline = farm.verification.find(({ kind }) => kind === "crop_farm_pipeline");
  assert.equal(pipeline.expectedOutput, "minecraft:wheat");
  assert.deepEqual(pipeline.plantTypes, ["minecraft:wheat"]);
  assert.deepEqual(pipeline.output, [0, 0, 1]);

  // Wheat planted on plain dirt has no farmland below: the farm is rejected.
  assert.throws(() => machineBlueprint({
    ...wheatFarmPlan,
    placements: wheatFarmPlan.placements.map((placement) => (
      placement.itemId === "minecraft:farmland"
        ? place("minecraft:dirt", placement.target, placement.support)
        : placement
    )),
  }), /farmland directly below/);

  // Wheat with no water collector at all is rejected like sugar cane.
  assert.throws(() => machineBlueprint({
    ...wheatFarmPlan,
    interactions: [],
  }), /water/);
});

test("uses the local sugar-cane fallback and accepts model-authored long-tail machines", async () => {
  const ask = async (question, plan) => {
    let providerCalled = false;
    const wizard = createWizard({
      corpus: { search: () => [] },
      env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
      fetchImpl: async () => {
        providerCalled = true;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          answer: `I’ll place the bounded ${plan.kind} plan nearby and check each planned part.`,
          action: { type: "build_machine", version: 1, plan },
        }) } }] }), { status: 200 });
      },
    });
    const result = await wizard.ask({ player: plan.kind, question });
    assert.equal(providerCalled, true);
    assert.equal(result.mode, "chat:model");
    assert.equal(result.action.type, "build_machine");
    assert.equal(result.action.plan.kind, plan.kind);
    return result;
  };

  let sugarProviderCalled = false;
  const sugarWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      sugarProviderCalled = true;
      throw new Error("the local farm should win");
    },
  });
  const sugar = await sugarWizard.ask({ player: "sugar", question: "Build me a sugar cane farm" });
  assert.equal(sugarProviderCalled, false);
  assert.equal(sugar.mode, "local-skill");
  assert.equal(sugar.action.type, "build_machine");
  assert.equal(sugar.action.plan.kind, "automatic sugar cane farm");
  await ask("Build me a flying machine", flyingMachinePlan);
  assert.equal(classifyAction("Build an automatic smelter").id, "automatic_smelter");
  assert.equal(classifyAction("Build me a piston door").id, "two_by_two_piston_door");
});

test("wires the machine-plan schema through the model skill and Bedrock executor", async () => {
  const [schemaText, pack] = await Promise.all([
    readFile(new URL("../schemas/wizard-response.schema.json", import.meta.url), "utf8"),
    readFile(new URL("../bedrock/behavior_packs/mc_wizard/scripts/main.js", import.meta.url), "utf8"),
  ]);
  const schema = JSON.parse(schemaText);
  const action = schema.properties.action.anyOf.find((candidate) => candidate.properties?.type?.const === "build_machine");
  assert.ok(action.properties.plan.properties.placements);
  assert.match(wizardSkillPrompt(), /build_bounded_machine/);
  assert.match(pack, /import \{ foldPlacementSteps, machineBlueprint \} from "\.\/machine-plan\.js"/);
  assert.match(pack, /action\?\.type === "build_machine"/);
  assert.match(pack, /buildInteractiveBlueprint\(player, machineBlueprint\(value\)\)/);
  assert.match(pack, /interaction\.expectedFaceType/);
  assert.match(pack, /blueprint\.preInteractions/);
  assert.match(pack, /check\.kind === "block_facing"/);
  const useItem = pack.slice(pack.indexOf("function useItemAsWizard"), pack.indexOf("function expectedHopperFacing"));
  assert.match(useItem, /flint_and_steel[\s\S]*return "interaction-failed"/);
  assert.match(useItem, /interactionIsSatisfied/);
  assert.doesNotMatch(useItem, /setBlockType\(faceTarget, "minecraft:portal"\)/);
  const repair = pack.slice(pack.indexOf("function repairBlueprintVerification"), pack.indexOf("async function buildInteractiveBlueprint"));
  assert.match(repair, /check\.typeId !== "minecraft:portal"/);
});
