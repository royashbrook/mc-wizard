import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packScript = await readFile(new URL(
  "../bedrock/behavior_packs/mc_wizard/scripts/main.js",
  import.meta.url,
), "utf8");
const e2eScript = await readFile(new URL(
  "../bedrock/behavior_packs/mc_wizard/scripts/e2e.js",
  import.meta.url,
), "utf8");
const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
const e2eRunner = await readFile(new URL("../scripts/run-e2e-container.sh", import.meta.url), "utf8");
const packInstaller = await readFile(new URL("../scripts/install-pack.mjs", import.meta.url), "utf8");

const start = packScript.indexOf("function travelDimension");
const end = packScript.indexOf("function castPotionRain", start);
const executor = packScript.slice(start, end);

test("dimension travel accepts every Bedrock realm and has a typed response branch", () => {
  assert.match(packScript, /overworld: \{ id: "minecraft:overworld", name: "overworld"/);
  assert.match(packScript, /nether: \{ id: "minecraft:nether", name: "nether"/);
  assert.match(packScript, /the_end: \{ id: "minecraft:the_end", name: "the_end"/);
  assert.match(executor, /requested === "end" \? "the_end" : requested/);
  assert.match(packScript, /action\?\.type === "dimension_travel" && action\.version === 1/);
  assert.match(packScript, /void applyDimensionTravel\(player, action\)/);
});

test("dimension travel moves the requester and nearby same-realm players as one party", () => {
  assert.match(executor, /return \[player, \.\.\.humanPlayers\(\)\.filter/);
  assert.match(executor, /candidate\.dimension\.id === player\.dimension\.id/);
  assert.match(executor, /distanceSquared\(candidate\.location, player\.location\) <= TRAVEL_PARTY_DISTANCE_SQUARED/);
  assert.match(executor, /capturedPartyIds = nearbyTravelParty\(player\)\.map/);
  assert.match(executor, /const party = capturedPartyIds\.map/);
  assert.match(executor, /party\.length !== capturedPartyIds\.length/);
  assert.match(executor, /const travelers = \[\.\.\.party, bot\]/);
  assert.match(executor, /travelers\.forEach\(teleportTraveler\)/);
});

test("dimension travel serializes behind Wizard body work without recapturing its party", () => {
  assert.match(executor, /if \(buildInProgress \|\| buildPreparing\) \{/);
  assert.match(executor, /\(current\) => applyDimensionTravel\(current, action, capturedPartyIds\)/);
  assert.match(executor, /const bot = bringWizardTo\(player\)/);
  assert.match(executor, /const reservation = beginBuildPreparation\(\)/);
  assert.match(executor, /endBuildPreparation\(reservation\)/);
});

test("dimension travel finds or creates a safe non-stacking arrival site", () => {
  assert.match(executor, /function travelCellIsSafe/);
  assert.match(executor, /!TRAVEL_GROUND_HAZARDS\.has\(ground\.typeId\)/);
  assert.match(executor, /SAFE_SPACE\.has\(feet\?\.typeId\)/);
  assert.match(executor, /SAFE_SPACE\.has\(head\?\.typeId\)/);
  assert.match(executor, /function travelPartyOffsets/);
  assert.match(executor, /async function waitForTravelChunk/);
  assert.match(executor, /if \(!await waitForTravelChunk\(targetDimension, anchor\)\)/);
  assert.match(executor, /findTravelSite\(targetDimension, anchor, offsets\)\s*\|\| prepareTravelPad/);
  assert.match(executor, /dimension\.setBlockType\(\{ x, y: anchor\.y - 1, z \}, "minecraft:obsidian"\)/);
  assert.match(executor, /dimension\.setBlockType\(\{ x, y, z \}, "minecraft:air"\)/);
});

test("dimension travel uses entity teleportation and never relays a teleport command", () => {
  assert.match(executor, /member\.teleport\(/);
  assert.match(executor, /\{ dimension: targetDimension \}/);
  assert.doesNotMatch(executor, /runCommand\(`(?:execute|tp|teleport)\b/);
  assert.doesNotMatch(executor, /\/(?:execute|tp|teleport)\b/);
});

test("dimension travel reports the observed destination result", () => {
  assert.match(executor, /const report = beginImmediateAction\(player\)/);
  assert.match(executor, /const allReached = \(dimensionId\) => travelers\.every/);
  assert.match(executor, /const restoreAll = async \(\) =>/);
  assert.match(executor, /if \(await restoreAll\(\)\) \{/);
  assert.match(executor, /captured players and Wizard in \$\{destination\.id\}/);
  assert.match(executor, /did not reach \$\{destination\.id\} atomically; rollback=\$\{restored\}/);
  assert.match(executor, /endImmediateAction\(report, "failed", "requested dimension was not supported"\)/);
});

test("live acceptance requires a lit portal and the visible Wizard to travel with the child", () => {
  const start = e2eScript.indexOf("function findLitNetherPortal");
  const end = e2eScript.indexOf("function isHouseWindow", start);
  const acceptance = e2eScript.slice(start, end);
  assert.match(acceptance, /minecraft:obsidian/);
  assert.match(acceptance, /minecraft:portal/);
  assert.match(acceptance, /hasCommittedBuild/);
  assert.match(acceptance, /kid\.dimension\.id === "minecraft:nether"/);
  assert.match(acceptance, /player\.name === "MC Wizard"/);
  assert.match(acceptance, /wizardPlayer\?\.dimension\.id === "minecraft:nether"/);
});

test("rollback fault injection is impossible outside its disposable E2E scope", () => {
  assert.match(executor, /variable\("mc_wizard_e2e", false\) !== true/);
  assert.match(executor, /variable\("mc_wizard_e2e_scope", ""\) !== "travel-rollback"/);
  assert.match(executor, /world\.getDynamicProperty\(E2E_TRAVEL_FAULT_PROPERTY\)/);
  assert.match(executor, /fault\.run === run && fault\.mode === "hold-last-traveler"/);
  assert.match(executor, /e2eFault && index === travelers\.length - 1/);
  assert.match(executor, /partialObserved: e2eFault\.partialObserved \|\| new Set\(dimensions\)\.size > 1/);
  assert.match(executor, /rollbackObserved: true/);
});

test("isolated disposable-world scope proves partial travel cannot split the party", () => {
  const start = e2eScript.indexOf("async function runDimensionTravelRollbackAcceptance");
  const end = e2eScript.indexOf("function analyzeCityGeometry", start);
  const acceptance = e2eScript.slice(start, end);
  assert.match(acceptance, /spawnSimulatedPlayer/);
  assert.match(acceptance, /mode: "hold-last-traveler"/);
  assert.match(acceptance, /teleport all of us to the Nether/);
  assert.match(acceptance, /state\.partialObserved/);
  assert.match(acceptance, /state\.rollbackObserved/);
  assert.match(acceptance, /new Set\(finalDimensions\)\.size === 1/);
  assert.match(acceptance, /!destination && !rolledBack/);
  assert.match(packageJson, /"test:e2e:travel-rollback": "MC_WIZARD_E2E_SCOPE=travel-rollback/);
  assert.match(e2eRunner, /E2E_SCOPE" != "travel-rollback"/);
  assert.match(packInstaller, /"travel-rollback"/);
});
