import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainScript = await readFile(new URL(
  "../bedrock/behavior_packs/mc_wizard/scripts/main.js",
  import.meta.url,
), "utf8");
const e2eScript = await readFile(new URL(
  "../bedrock/behavior_packs/mc_wizard/scripts/e2e.js",
  import.meta.url,
), "utf8");

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test("structure inhabitants are verified as a stable aggregate before completion", () => {
  assert.match(mainScript, /const STRUCTURE_ENTITY_STABLE_POLLS = 20/);
  const executor = sourceBetween(mainScript, "function structureEntitySteps", "async function buildStructure");
  assert.match(executor, /structureEntitiesInside\(dimension, typeId, bounds\)/);
  assert.match(executor, /present\.length === locations\.length/);
  assert.match(executor, /stablePolls >= STRUCTURE_ENTITY_STABLE_POLLS/);
  assert.match(executor, /return result === true \? false : result/);
  assert.match(executor, /outsideManaged\[0\]\.teleport/);
  assert.match(executor, /removeTag\(inhabitantTag\)/);
  assert.match(executor, /insideExcess\s*\?[^:]+\.slice\(-insideExcess\)\s*:\s*\[\]/s);
  assert.match(executor, /reachPolls >= STRUCTURE_ENTITY_REACH_POLLS/);
  assert.match(executor, /dimension\.spawnEntity\(typeId/);
  assert.doesNotMatch(executor, /attempts >= 40/);
});

test("structure entity spawns require a safe floor and two-block opening", () => {
  const compiler = sourceBetween(mainScript, "function structurePlanOperations", "function worldStructureBox");
  assert.match(compiler, /structureBox\("details", "minecraft:air", \[x, y, z\], \[x, y \+ 1, z\]\)/);
  assert.match(compiler, /return \[\.\.\.operations, \.\.\.clearance\]/);
  const safety = sourceBetween(mainScript, "function structureEntityTargetIsSafe", "function structureEntitySteps");
  assert.match(safety, /feetBlock && SAFE_SPACE\.has\(feetBlock\.typeId\)/);
  assert.match(safety, /headBlock && SAFE_SPACE\.has\(headBlock\.typeId\)/);
  assert.match(safety, /supportIsSolid/);
});

test("castle refinement acceptance is material-agnostic and feature-semantic", () => {
  const metrics = sourceBetween(e2eScript, "function castleUpgradeMetrics", "function removeAcceptanceEntities");
  assert.match(metrics, /towerCorners === 4/);
  assert.match(metrics, /villagers === 4/);
  assert.match(metrics, /villagerLocations/);
  assert.match(metrics, /castleBalconyProfile/);
  assert.doesNotMatch(metrics, /minecraft:(?:stone_bricks|cobblestone|sea_lantern)/);
});

test("live castle acceptance replays color, compound refinement, and lighting failures", () => {
  const helpers = sourceBetween(e2eScript, "const LIVE_CASTLE_RAINBOW_BLOCKS", "function castleUpgradeMetrics");
  const acceptance = sourceBetween(e2eScript, "async function runCastleRefinementAcceptance", "function commonFarmIsWorking");
  assert.match(acceptance, /build a 17x26 rainbow castle with 3 villagers and a goat in it/);
  assert.match(acceptance, /the colors are wrong\. fix the colors/);
  assert.match(acceptance, /castleWallColorSample/);
  assert.match(acceptance, /but it's not rainbow colored\. make it taller/);
  assert.match(acceptance, /moat filled with lava, a redstone powered bridge/);
  assert.match(acceptance, /it's too dark in the castle\. light it up/);
  assert.match(acceptance, /buildCommitToken/);
  assert.match(acceptance, /lightsBefore \+ 8/);
  assert.match(helpers, /LIVE_CASTLE_RAINBOW_BLOCKS\.length/);
  assert.match(helpers, /metrics\.lavaMoat >= metrics\.perimeter - 2/);
  assert.match(helpers, /minecraft:lit_redstone_lamp/);
  assert.match(helpers, /metrics\.redstoneBlocks >= 8/);
  assert.match(helpers, /metrics\.bridgeLamps >= 8/);
  assert.match(helpers, /metrics\.upperFloor >= innerArea \* 0\.9/);
  assert.match(helpers, /metrics\.villagers === 3/);
  assert.match(helpers, /metrics\.goats === 1/);
  assert.match(helpers, /metrics\.ironGolems === 4/);
});

test("balcony acceptance requires new attached projection, rail, and headroom", () => {
  const balcony = sourceBetween(e2eScript, "function castleBalconyProfile", "function removeAcceptanceEntities");
  assert.match(balcony, /!before\.has/);
  assert.match(balcony, /attachedRun >= 3/);
  assert.match(balcony, /area >= 6/);
  assert.match(balcony, /rail >= 3/);
  assert.match(balcony, /headroom >= 3/);
});

test("house acceptance verifies semantics without prescribing one palette or height", () => {
  const profile = sourceBetween(e2eScript, "function completedHouseProfile", "function findCompletedTenByTenHouse");
  assert.match(profile, /rectangleIsStructural/);
  assert.match(profile, /wallLayers >= 2/);
  assert.match(profile, /windows >= 4/);
  assert.match(profile, /lights >= 2/);
  assert.match(profile, /doorway/);
  assert.match(profile, /roofOffset = 3; roofOffset <= 10/);
  assert.doesNotMatch(profile, /minecraft:(?:oak_planks|spruce_planks|sea_lantern)/);
});

test("city acceptance requires several buildings, crossed roads, residents, and in-place growth", () => {
  const city = sourceBetween(e2eScript, "function analyzeCityGeometry", "function isHouseWindow");
  assert.match(city, /buildingHeights\.length >= 4/);
  assert.match(city, /accessibleBuildings >= 4/);
  assert.match(city, /roofCoverage >= 0\.6/);
  assert.match(city, /interiorHeadroom >= 4/);
  assert.match(city, /heightRange >= 2/);
  assert.match(city, /roadX >= 22 && roadZ >= 22/);
  assert.match(city, /lights >= 4 && villagers === 4/);
  assert.match(city, /tallerBuildings >= 2/);
  assert.match(city, /revised\.lights >= priorLights \+ 4/);
  assert.match(city, /cityGroundRetention/);
  assert.doesNotMatch(city, /minecraft:(?:oak_planks|spruce_planks)/);
});

test("bulk structures and inhabitant verification have terminal retry paths", () => {
  assert.match(mainScript, /const MAX_BULK_STRUCTURE_RETRIES = 8/);
  assert.match(mainScript, /const MAX_STRUCTURE_POST_RETRIES = 120/);
  assert.match(mainScript, /retries >= MAX_BULK_STRUCTURE_RETRIES/);
  assert.match(mainScript, /retries >= MAX_STRUCTURE_POST_RETRIES/);
  assert.match(mainScript, /endBuildAction\(token, "failed", detail\)/);
  assert.match(mainScript, /replanning instead of leaving you waiting/);
  assert.match(mainScript, /previousEntities = \[\]/);
  assert.match(mainScript, /if \(!groups\.has\(entity\.typeId\)\) groups\.set\(entity\.typeId, \[\]\)/);
});
