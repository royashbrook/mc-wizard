import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { machineBlueprint, validateMachinePlan } from "../bedrock/behavior_packs/mc_wizard/scripts/machine-plan.js";
import { commonFarmAction } from "../src/common-farms.mjs";
import { allowedWizardAction } from "../src/skills.mjs";

const cases = [
  ["Build me an automatic sugar cane farm", "minecraft:sugar_cane", true, 1, true],
  ["I need a sugar cane farm", "minecraft:sugar_cane", true, 1, true],
  ["Make a bamboo harvester", "minecraft:bamboo", true, 0, true],
  ["I want an automated cactus farm", "minecraft:cactus", false, 3, false],
  ["I want a cactus farm", "minecraft:cactus", false, 3, false],
];

test("returns validated, collected automatic farms supported by the machine contract", () => {
  for (const [question, crop, pistonDriven, waterSources, usesMinecart] of cases) {
    const action = commonFarmAction(question);
    assert.equal(action.type, "build_machine");
    assert.deepEqual(validateMachinePlan(action.plan), action.plan);
    assert.equal(allowedWizardAction(action)?.type, "build_machine");

    const blueprint = machineBlueprint(action.plan);
    assert.ok(action.plan.placements.some(({ itemId }) => itemId === crop));
    assert.ok(action.plan.placements.some(({ itemId }) => itemId === "minecraft:chest"));
    assert.equal(action.plan.placements.some(({ itemId }) => itemId === "minecraft:rail"), usesMinecart);
    assert.ok(action.plan.placements.some(({ itemId, orientationTarget }) => (
      itemId === "minecraft:hopper" && orientationTarget?.join(",") === "0,0,0"
    )));
    assert.equal(
      blueprint.preInteractions.some(({ itemId }) => itemId === "minecraft:water_bucket"),
      waterSources > 0,
    );
    assert.equal(blueprint.interactions.some(({ itemId, expectedEntity }) => (
      itemId === "minecraft:hopper_minecart" && expectedEntity === "minecraft:hopper_minecart"
    )), usesMinecart);
    assert.ok(blueprint.verification.some(({ kind }) => kind === "container_link"));
    assert.equal(blueprint.verification.some(({ kind, entityType, bounds }) => (
      kind === "entity_count"
      && entityType === "minecraft:hopper_minecart"
      && bounds.min.join(",") === "0,1,1"
    )), usesMinecart);
    const pipeline = blueprint.verification.find(({ kind }) => kind === "crop_farm_pipeline");
    assert.equal(pipeline.expectedOutput, crop);
    assert.ok(pipeline.plantTypes.includes(crop));
    assert.equal(pipeline.collectionWater.length, waterSources);
    if (usesMinecart) {
      assert.deepEqual(pipeline.collector, [0, 1, 1]);
      assert.deepEqual(pipeline.testDrop, [0, 4, 1]);
    } else {
      assert.equal(pipeline.collector, undefined);
      assert.equal(pipeline.testDrop, undefined);
    }
    assert.ok(pipeline.hopperPath.length >= 1);
    assert.match(blueprint.success, /real .+ item.+output chest/i);
    assert.equal(action.plan.placements.some(({ itemId }) => itemId === "minecraft:piston"), pistonDriven);
    assert.equal(action.plan.placements.some(({ itemId }) => itemId === "minecraft:observer"), pistonDriven);
  }
});

test("builds the collection path before pouring water and planting the crop", () => {
  for (const [question, crop, , , usesMinecart] of cases) {
    const blueprint = machineBlueprint(commonFarmAction(question).plan);
    const cropIndex = blueprint.placements.findIndex(({ itemId }) => itemId === crop);
    const hopperIndex = blueprint.placements.findIndex(({ itemId }) => itemId === "minecraft:hopper");
    const railIndex = blueprint.placements.findIndex(({ itemId }) => itemId === "minecraft:rail");
    assert.ok(hopperIndex >= 0 && hopperIndex < blueprint.preInteractionBefore, question);
    assert.equal(railIndex >= 0 && railIndex < blueprint.preInteractionBefore, usesMinecart, question);
    assert.equal(blueprint.preInteractionBefore, cropIndex, question);
  }
});

test("the cactus has permanent support and breaks into a retained water collector", () => {
  const plan = commonFarmAction("Build a cactus farm")?.plan;
  const breaker = plan.placements.find(({ target }) => target.join(",") === "1,4,3");
  assert.equal(breaker.itemId, "minecraft:smooth_stone");
  assert.deepEqual(plan.interactions.map(({ faceTarget }) => faceTarget), [
    [-1, 2, 4], [0, 2, 4], [1, 2, 4],
  ]);
  assert.equal(plan.placements.filter(({ itemId }) => itemId === "minecraft:hopper").length, 4);
  assert.equal(plan.placements.some(({ action }) => action === "break"), false);
  assert.equal(plan.placements.some(({ itemId }) => itemId === "minecraft:rail"), false);
  const occupied = new Set(plan.placements.map(({ target }) => target.join(",")));
  assert.ok(occupied.has("0,1,3"));
  assert.ok(occupied.has("0,2,3"));
  assert.ok(occupied.has("0,3,3"));
  for (const y of [0, 1, 2, 3, 4]) assert.ok(occupied.has(`2,${y},3`));
  const hopperTargets = new Map(plan.placements
    .filter(({ itemId }) => itemId === "minecraft:hopper")
    .map(({ target, orientationTarget }) => [target.join(","), orientationTarget.join(",")]));
  assert.deepEqual(Object.fromEntries(hopperTargets), {
    "0,0,1": "0,0,0",
    "0,1,1": "0,0,1",
    "-1,1,1": "0,1,1",
    "1,1,1": "0,1,1",
  });
});

test("piston crops are enclosed over the collector with an explicit Bedrock redstone path", () => {
  for (const question of ["Build a sugar cane farm", "Build a bamboo farm"]) {
    const plan = commonFarmAction(question)?.plan;
    for (const target of ["-1,1,1", "0,1,0", "0,1,2", "1,1,1"]) assert.equal(
      plan.placements.find(({ target: point }) => point.join(",") === target)?.itemId,
      "minecraft:glass",
    );
    for (const x of [-1, 1]) {
      for (const y of [3, 4, 5]) assert.equal(
        plan.placements.find(({ target }) => target.join(",") === `${x},${y},1`)?.itemId,
        "minecraft:glass",
      );
    }
    for (const target of ["0,5,3", "1,5,3", "2,4,3", "2,4,2"]) {
      assert.equal(
        plan.placements.find(({ itemId, target: point }) => (
          itemId === "minecraft:redstone" && point.join(",") === target
        ))?.itemId,
        "minecraft:redstone",
      );
    }
    const repeater = plan.placements.find(({ itemId }) => itemId === "minecraft:repeater");
    assert.deepEqual(repeater.target, [1, 4, 2]);
    assert.deepEqual(repeater.orientationTarget, [0, 4, 2]);
  }
});

test("runtime completion waits for a real crop item in the output chest", async () => {
  const pack = await readFile(new URL(
    "../bedrock/behavior_packs/mc_wizard/scripts/main.js",
    import.meta.url,
  ), "utf8");
  assert.match(pack, /check\.kind === "crop_farm_pipeline"/);
  assert.match(pack, /outputContainer\.getItem\(slot\)\?\.typeId === check\.expectedOutput/);
  assert.match(pack, /sent a \$\{check\.expectedOutput\} test item through the farm collector/);
  assert.match(pack, /collectorContainer\.addItem\(new ItemStack\(check\.expectedOutput, 1\)\)/);
  assert.match(pack, /entityInBlock\(dimension, check\.collectorEntity, collector\)/);
});

test("does not turn explanations or unsupported crop lifecycles into fake farms", () => {
  assert.equal(commonFarmAction("Tell me how a sugar cane farm works"), null);
  assert.equal(commonFarmAction("I want to learn how a bamboo farm works"), null);
  assert.equal(commonFarmAction("Don't build a bamboo farm"), null);
  assert.equal(commonFarmAction("Make an automatic melon and pumpkin farm"), null);
});

test("routes kelp to its lifecycle-specific fixed blueprint", () => {
  const action = commonFarmAction("Build an automatic kelp farm");
  assert.deepEqual(action, { type: "place_blueprint", id: "automatic_kelp_farm", version: 1 });
  assert.deepEqual(allowedWizardAction(action), action);
  assert.deepEqual(commonFarmAction("I need a kelp farm"), action);
});
