import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { allowedWizardAction, wizardSkillPrompt } from "../src/skills.mjs";
import { classifyAction, createWizard } from "../src/wizard.mjs";
import {
  machineBlueprint,
  validateMachinePlan,
} from "../bedrock/behavior_packs/mc_wizard/scripts/machine-plan.js";

const place = (itemId, target, support, orientationTarget = null) => ({
  itemId, target, support, orientationTarget,
});

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
  assert.match(pack, /import \{ machineBlueprint \} from "\.\/machine-plan\.js"/);
  assert.match(pack, /action\?\.type === "build_machine"/);
  assert.match(pack, /buildInteractiveBlueprint\(player, machineBlueprint\(value\)\)/);
  assert.match(pack, /interaction\.expectedFaceType/);
  assert.match(pack, /blueprint\.preInteractions/);
  assert.match(pack, /check\.kind === "block_facing"/);
});
