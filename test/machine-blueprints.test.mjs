import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createAutomaticSmelterBlueprint } from "../bedrock/behavior_packs/mc_wizard/scripts/auto-smelter.js";
import {
  createItemSorterBlueprint,
  itemSorterFillerItem,
  itemSorterFillerName,
} from "../bedrock/behavior_packs/mc_wizard/scripts/item-sorter.js";
import { createTwoByTwoPistonDoorBlueprint } from "../bedrock/behavior_packs/mc_wizard/scripts/piston-door.js";

const packScript = readFileSync(new URL(
  "../bedrock/behavior_packs/mc_wizard/scripts/main.js",
  import.meta.url,
), "utf8");

const at = (blueprint, target) => blueprint.placements.find((placement) => (
  placement.itemId && placement.target.join(",") === target.join(",")
));

const assertSupportOrder = (blueprint) => {
  const built = new Set();
  for (const placement of blueprint.placements) {
    const target = placement.target.join(",");
    if (placement.action === "break") {
      assert.ok(built.delete(target), `${blueprint.id} breaks ${target} before building it`);
      continue;
    }
    const support = placement.support.join(",");
    assert.ok(placement.support[1] === -1 || built.has(support), `${blueprint.id} lacks support ${support} for ${target}`);
    built.add(target);
  }
};

test("2x2 piston door has four inward pistons, one control, and an open-state test", () => {
  const door = createTwoByTwoPistonDoorBlueprint();
  assert.equal(door.id, "two_by_two_piston_door");
  const pistons = door.placements.filter(({ itemId }) => itemId === "minecraft:sticky_piston");
  assert.equal(pistons.length, 4);
  assert.deepEqual(pistons.map(({ facingTarget }) => facingTarget), [
    [-3, 1, 1], [-3, 2, 1], [4, 1, 1], [4, 2, 1],
  ]);
  assert.deepEqual(pistons.map(({ orientationTarget }) => orientationTarget), [
    [-1, 1, 1], [-1, 2, 1], [2, 1, 1], [2, 2, 1],
  ]);
  assert.deepEqual(pistons.map(({ placementLookTarget }) => placementLookTarget), [
    [-3, 1, 1], [-3, 2, 1], [4, 1, 1], [4, 2, 1],
  ]);
  assert.match(packScript, /const PISTON_FACING_DIRECTION = \{[\s\S]*?west: 5,[\s\S]*?east: 4/);
  assert.match(packScript, /placement\.placementLookTarget[\s\S]*?: orientationTarget;/);
  assert.equal(door.placements.filter(({ itemId }) => itemId === "minecraft:redstone").length, 8);
  assert.equal(door.placements.filter(({ itemId }) => itemId === "minecraft:lever").length, 1);
  assert.equal(door.placements.filter(({ itemId }) => itemId === "minecraft:redstone_torch").length, 0);
  assert.deepEqual(at(door, [-2, 2, 2]).support, [-2, 1, 2]);
  assert.deepEqual(at(door, [3, 2, 2]).support, [3, 1, 2]);
  assert.deepEqual(
    door.placements.filter(({ itemId }) => itemId === "minecraft:repeater")
      .map(({ target, orientationTarget, placementLookTarget }) => ({
        target,
        orientationTarget,
        placementLookTarget,
      })),
    [
      {
        target: [-2, 1, 3],
        orientationTarget: [-2, 1, 2],
        placementLookTarget: [-2, 1, 2],
      },
      {
        target: [3, 1, 3],
        orientationTarget: [3, 1, 2],
        placementLookTarget: [3, 1, 2],
      },
    ],
  );
  for (const x of [-2, 3]) {
    assert.equal(at(door, [x, 1, 4]).itemId, "minecraft:redstone");
    assert.equal(at(door, [x, 1, 2]).itemId, "minecraft:smooth_stone");
    assert.equal(at(door, [x, 2, 2]).itemId, "minecraft:redstone");
    assert.equal(at(door, [x, 1, 1]).itemId, "minecraft:sticky_piston");
    assert.equal(at(door, [x, 2, 1]).itemId, "minecraft:sticky_piston");
  }
  assert.deepEqual(door.interactions.map(({ block, expectedState }) => ({ block, expectedState })), [
    { block: [0, 2, 5], expectedState: { state: "open_bit", value: true } },
    { block: [0, 2, 5], expectedState: { state: "open_bit", value: false } },
  ]);
  assert.deepEqual(door.verification[0].opening, { min: [0, 1, 1], max: [1, 2, 1] });
  assert.equal(door.verification[0].finalState, "open");
  assert.equal(door.verification[0].finalControlState, false);
  assert.equal(door.verification[0].pistons.length, 4);
  assert.equal(door.verification[0].closedBlocks.length, 4);
  assert.match(door.usage, /one lever/i);
  assertSupportOrder(door);
});

test("item sorter has the 41+1+1+1+1 filter and routes matches separately", () => {
  const sorter = createItemSorterBlueprint("minecraft:diamond");
  assert.equal(sorter.id, "item_sorter");
  assert.equal(sorter.filterItem, "minecraft:diamond");
  assert.deepEqual(at(sorter, [0, 1, 0]).facingTarget, [0, 1, -1]);
  assert.deepEqual(at(sorter, [0, 2, 0]).facingTarget, [0, 2, 1]);
  assert.deepEqual(at(sorter, [0, 3, 0]).facingTarget, [-1, 3, 0]);
  const comparator = at(sorter, [0, 2, 1]);
  assert.equal(comparator.itemId, "minecraft:comparator");
  assert.deepEqual(comparator.support, [0, 1, 1]);
  assert.deepEqual(comparator.orientationTarget, [0, 2, 2]);
  assert.equal(sorter.placements.filter(({ itemId }) => itemId === "minecraft:redstone").length, 3);
  assert.deepEqual(sorter.placements.find(({ itemId }) => itemId === "minecraft:repeater").orientationTarget, [0, 0, 2]);
  const load = sorter.interactions.find(({ action }) => action === "load_container");
  assert.deepEqual(load.block, [0, 2, 0]);
  assert.deepEqual(load.slots, [
    { slot: 0, itemId: "minecraft:diamond", amount: 41 },
    { slot: 1, itemId: itemSorterFillerItem, amount: 1, nameTag: itemSorterFillerName },
    { slot: 2, itemId: itemSorterFillerItem, amount: 1, nameTag: itemSorterFillerName },
    { slot: 3, itemId: itemSorterFillerItem, amount: 1, nameTag: itemSorterFillerName },
    { slot: 4, itemId: itemSorterFillerItem, amount: 1, nameTag: itemSorterFillerName },
  ]);
  assert.ok(sorter.verification.some(({ kind, from, to }) => (
    kind === "container_link" && from.join(",") === "0,1,0" && to.join(",") === "0,1,-1"
  )));
  assert.deepEqual(sorter.verification.find(({ kind }) => kind === "item_filter"), {
    kind: "item_filter",
    input: [0, 4, 0],
    filter: [0, 2, 0],
    filterItem: "minecraft:diamond",
    matchedOutput: [0, 1, -1],
    overflowOutput: [-1, 3, 0],
    overflowTestItem: "minecraft:feather",
  });
  assert.deepEqual(sorter.interactions.slice(1, 3).map(({ expectedState }) => expectedState), [
    { state: "output_subtract_bit", value: true },
    { state: "output_subtract_bit", value: false },
  ]);
  assert.deepEqual(sorter.interactions[3], {
    action: "load_container",
    block: [0, 4, 0],
    slots: [{ slot: 0, itemId: "minecraft:feather", amount: 1 }],
  });
  assert.deepEqual(sorter.interactions[4], { action: "wait_ticks", ticks: 40 });
  assert.deepEqual(sorter.interactions[5], {
    action: "load_container",
    block: [0, 4, 0],
    slots: [{ slot: 0, itemId: "minecraft:diamond", amount: 1 }],
  });
  assert.deepEqual(sorter.interactions[6], { action: "wait_ticks", ticks: 40 });
  assert.deepEqual(sorter.interactions[7], sorter.interactions[5]);
  assert.equal(createItemSorterBlueprint(itemSorterFillerItem).filterItem, "minecraft:stick");
  assertSupportOrder(sorter);
});

test("automatic smelter links input, fuel, and output through a furnace", () => {
  const smelter = createAutomaticSmelterBlueprint();
  assert.equal(smelter.id, "automatic_smelter");
  const links = smelter.verification.filter(({ kind }) => kind === "container_link");
  assert.deepEqual(links, [
    { kind: "container_link", from: [0, 2, 2], to: [0, 1, 2] },
    { kind: "container_link", from: [-1, 1, 2], to: [0, 1, 2] },
    { kind: "container_link", from: [0, 0, 2], to: [0, 0, 1] },
  ]);
  assert.deepEqual(at(smelter, [0, 2, 2]).facingTarget, [0, 1, 2]);
  assert.deepEqual(at(smelter, [-1, 1, 2]).facingTarget, [0, 1, 2]);
  assert.deepEqual(smelter.verification.at(-1), {
    kind: "smelter_pipeline",
    input: [0, 3, 2],
    fuel: [-1, 2, 2],
    furnace: [0, 1, 2],
    output: [0, 0, 1],
    expectedOutput: "minecraft:iron_ingot",
  });
  assert.equal(at(smelter, [-1, 2, 2]).itemId, "minecraft:chest");
  assert.deepEqual(smelter.interactions, [
    { action: "load_container", block: [0, 3, 2], slots: [{ slot: 0, itemId: "minecraft:raw_iron", amount: 1 }] },
    { action: "load_container", block: [-1, 2, 2], slots: [{ slot: 0, itemId: "minecraft:coal", amount: 1 }] },
  ]);
  assert.match(smelter.success, /raw iron and coal/i);
  assertSupportOrder(smelter);
});
