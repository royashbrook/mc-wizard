import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createAutomaticChickenFarmBlueprint } from "../bedrock/behavior_packs/mc_wizard/scripts/chicken-farm.js";
import { createRecipeDisplay, recipeFor, recipeItemIds } from "../bedrock/behavior_packs/mc_wizard/scripts/recipe-display.js";
import { createAutomaticWoolFarmBlueprint } from "../bedrock/behavior_packs/mc_wizard/scripts/wool-farm.js";

const key = (point) => point.join(",");

test("automatic chicken farm physically collects eggs and starts with chickens", () => {
  const farm = createAutomaticChickenFarmBlueprint();
  assert.equal(farm.id, "automated_chicken_farm");
  assert.deepEqual(farm.bounds, { min: [-1, -1, 1], max: [1, 2, 3] });
  const hopper = farm.placements.find(({ itemId }) => itemId === "minecraft:hopper");
  const chest = farm.placements.find(({ itemId }) => itemId === "minecraft:chest");
  assert.deepEqual(hopper, {
    itemId: "minecraft:hopper",
    target: [0, 0, 2],
    support: [0, 0, 1],
    expectedType: "minecraft:hopper",
    facingTarget: [0, 0, 1],
  });
  assert.deepEqual(chest.target, [0, 0, 1]);
  assert.ok(farm.placements.some(({ action, target }) => action === "break" && key(target) === key(chest.target)));
  assert.equal(farm.placements.filter(({ itemId }) => itemId === "minecraft:glass").length, 7);
  assert.equal(farm.interactions.length, 4);
  assert.ok(farm.interactions.every(({ action, itemId, expectedEntity }) => (
    action === "use_item_on_block"
      && itemId === "minecraft:chicken_spawn_egg"
      && expectedEntity === "minecraft:chicken"
  )));
  assert.deepEqual(farm.verification[0], { kind: "container_link", from: hopper.target, to: chest.target });
  assert.deepEqual(farm.verification[1], {
    kind: "entity_count",
    entityType: "minecraft:chicken",
    min: 4,
    bounds: { min: [0, 0, 2], max: [0, 2, 2] },
  });
  assert.match(farm.success, /hopper moves every egg into the chest/i);
  assert.match(farm.usage, /five to ten minutes/i);
});

test("automatic wool farm shears one sheep and collects through grass", () => {
  const farm = createAutomaticWoolFarmBlueprint();
  assert.equal(farm.id, "automatic_wool_farm");
  assert.deepEqual(farm.bounds, { min: [-1, -1, 1], max: [1, 4, 4] });

  const placements = new Map(farm.placements
    .filter(({ action }) => action !== "break")
    .map((placement) => [key(placement.target), placement]));
  assert.deepEqual(placements.get("0,0,2").facingTarget, [0, 0, 1]);
  assert.equal(placements.get("0,0,1").itemId, "minecraft:chest");
  assert.equal(placements.get("0,1,2").itemId, "minecraft:rail");
  assert.equal(placements.get("0,2,2").itemId, "minecraft:grass_block");
  assert.deepEqual(placements.get("0,2,2").expectedType, ["minecraft:grass_block", "minecraft:dirt"]);
  for (const source of ["-1,2,2", "1,2,2", "0,2,1"]) {
    assert.equal(placements.get(source).itemId, "minecraft:grass_block");
  }
  assert.deepEqual(placements.get("0,2,3").orientationTarget, [0, 2, 2]);
  assert.deepEqual(placements.get("0,3,3").orientationTarget, [0, 3, 2]);
  assert.equal(placements.get("0,3,4").expectedType, "minecraft:redstone_wire");
  assert.ok(farm.placements.some(({ action, target }) => action === "break" && key(target) === "0,1,2"));

  const dispenserLoad = farm.interactions.find(({ action, block }) => (
    action === "load_container" && key(block) === "0,3,3"
  ));
  assert.deepEqual(dispenserLoad.slots, [{ slot: 0, itemId: "minecraft:shears", amount: 1 }]);
  assert.ok(farm.interactions.some(({ itemId, block, expectedEntity }) => (
    itemId === "minecraft:hopper_minecart"
      && key(block) === "0,1,2"
      && expectedEntity === "minecraft:hopper_minecart"
  )));
  assert.ok(farm.interactions.some(({ itemId, block, expectedEntity }) => (
    itemId === "minecraft:sheep_spawn_egg"
      && key(block) === "0,2,2"
      && expectedEntity === "minecraft:sheep"
  )));
  assert.deepEqual(
    farm.interactions.filter(({ expectedState }) => expectedState).map(({ expectedState }) => expectedState.value),
    [true, false],
  );

  const pipeline = farm.verification.find(({ kind }) => kind === "wool_farm_pipeline");
  assert.deepEqual(pipeline.grassSources, [[-1, 2, 2], [1, 2, 2], [0, 2, 1]]);
  assert.deepEqual(pipeline.output, [0, 0, 1]);
  assert.equal(pipeline.expectedOutputSuffix, "_wool");
  assert.match(farm.success, /hopper minecart carries the wool into the front chest/i);
  assert.match(farm.usage, /grass can grow back/i);
});

test("recipe catalog produces exact three-by-three ingredient displays", () => {
  assert.deepEqual(recipeFor("minecraft:hopper").grid, [
    "minecraft:iron_ingot", null, "minecraft:iron_ingot",
    "minecraft:iron_ingot", "minecraft:chest", "minecraft:iron_ingot",
    null, "minecraft:iron_ingot", null,
  ]);
  assert.deepEqual(recipeFor("minecraft:redstone_lamp").grid, [
    null, "minecraft:redstone", null,
    "minecraft:redstone", "minecraft:glowstone", "minecraft:redstone",
    null, "minecraft:redstone", null,
  ]);
  for (const itemId of recipeItemIds()) {
    const display = createRecipeDisplay(itemId);
    assert.equal(display.id, "show_recipe");
    assert.equal(display.itemId, itemId);
    assert.equal(display.recipe.grid.length, 9);
    assert.equal(display.placements.filter(({ expectedType }) => expectedType === "minecraft:frame").length, 10);
    assert.equal(display.interactions.at(-1).itemId, itemId);
    assert.equal(display.interactions.length, display.recipe.grid.filter(Boolean).length + 1);
    const displayed = new Map(display.interactions.map(({ block, itemId: displayedItemId }) => (
      [key(block), displayedItemId]
    )));
    display.recipe.grid.forEach((ingredient, index) => {
      const frame = [-2 + (index % 3), 3 - Math.floor(index / 3), 2];
      assert.equal(displayed.get(key(frame)), ingredient || undefined);
    });
    assert.equal(displayed.get("3,2,2"), itemId);
    const finalTargets = display.placements
      .filter(({ action }) => action !== "break")
      .map(({ target }) => key(target));
    assert.equal(new Set(finalTargets).size, finalTargets.length);
    assert.match(display.success, /nine frames are the crafting grid/i);
  }
  assert.throws(() => createRecipeDisplay("minecraft:netherite_castle"), /unsupported recipe/);
});

test("offers a focused live child-action acceptance scope", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageJson.scripts["test:e2e:child"],
    "MC_WIZARD_E2E_SCOPE=child sh scripts/run-e2e-container.sh",
  );
  const pack = readFileSync(
    new URL("../bedrock/behavior_packs/mc_wizard/scripts/e2e.js", import.meta.url),
    "utf8",
  );
  assert.match(pack, /scope === "child"/);
  assert.match(pack, /runChildRequestAcceptance\(kid\)/);
});
