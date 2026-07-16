import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { classifyAction, createWizard } from "../src/wizard.mjs";

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
const start = packScript.indexOf("function surfaceSearchCenters");
const end = packScript.indexOf("async function applyDimensionTravel", start);
const executor = packScript.slice(start, end);

test("live surface failures route to a typed local travel action", () => {
  for (const question of [
    "take us up on top of land",
    "teleport me up to the surface",
    "you brought us underground. take me to the surface",
    "get us above ground",
  ]) {
    assert.deepEqual(classifyAction(question), {
      type: "local_travel", version: 1, destination: "surface",
    }, question);
  }
});

test("nearest-village requests route to deterministic structure travel", () => {
  for (const question of [
    "teleport me to the nearest village",
    "find the closest village and take us there",
    "please bring me to the nearest village",
  ]) {
    assert.deepEqual(classifyAction(question), {
      type: "local_travel", version: 1, destination: "nearest_village",
    }, question);
  }
  for (const question of [
    "what can I find in a village?",
    "is there a village nearby?",
    "tell me about villagers",
  ]) assert.equal(classifyAction(question), null, question);
});

test("a fresh rescue request supersedes an unfinished older project", async () => {
  const wizard = createWizard({ corpus: { search: () => [] }, env: {} });
  await wizard.ask({ player: "TravelKid", question: "build me a castle" });
  const surface = await wizard.ask({ player: "TravelKid", question: "take us up on top of land" });
  assert.deepEqual(surface.action, { type: "local_travel", version: 1, destination: "surface" });
  const village = await wizard.ask({ player: "TravelKid", question: "teleport me to the nearest village" });
  assert.deepEqual(village.action, { type: "local_travel", version: 1, destination: "nearest_village" });
});

test("surface travel uses Bedrock topography and clamps fallback pads to the dimension", () => {
  assert.match(executor, /function travelHeightRange/);
  assert.match(executor, /dimension\.heightRange/);
  assert.match(executor, /maxFeet: max - 3/);
  assert.match(executor, /dimension\.getTopmostBlock/);
  assert.match(executor, /if \(travelSiteIsSafe\(dimension, origin, offsets\)\) return origin/);
  assert.match(executor, /surfaceFallbackAnchor/);
  assert.match(executor, /prepareTravelPad\(targetDimension, surfaceFallbackAnchor/);
  assert.match(packScript, /for \(let y = anchor\.y; y <= anchor\.y \+ 2; y \+= 1\)/);
});

test("village travel locates in Bedrock, loads the chunk, and moves the whole captured party with Wizard", () => {
  assert.match(executor, /async function locateVillageForPlayer/);
  assert.match(executor, /\/v1\/locate/);
  assert.match(executor, /await locateVillageForPlayer\(player, anchor\)/);
  assert.match(executor, /capturedPartyIds = nearbyTravelParty\(player\)\.map/);
  assert.match(executor, /const travelers = \[\.\.\.party, bot\]/);
  assert.match(executor, /tickingarea add circle/);
  assert.match(executor, /await waitForTravelChunk\(targetDimension, anchor\)/);
  assert.match(executor, /travelers\.forEach\(\(member, index\) =>/);
  assert.match(executor, /entityReachedDimension\(member, "minecraft:overworld"\)/);
  assert.match(executor, /endImmediateAction\(report, "completed"/);
  assert.match(executor, /function generatedVillageAtLocate/);
  assert.match(executor, /getGeneratedStructures/);
  assert.match(executor, /generatedVillageAtLocate\(targetDimension, anchor\)/);
  assert.match(executor, /const \{ minFeet \} = travelHeightRange\(dimension\)/);
  assert.match(executor, /located village was not observable at authoritative coordinate/);
  assert.doesNotMatch(executor, /throw new Error\("Bedrock's located village coordinate did not contain/);
  assert.match(executor, /const restoreAll = async \(\) =>/);
  assert.match(executor, /distanceSquared\(entity\.location, location\) <= 4/);
  assert.match(executor, /const sendAll = async \(\) =>/);
  assert.match(executor, /rollback=\$\{restored\}/);
  assert.match(executor, /This world has no generated village/);
  assert.match(executor, /My village map is fuzzy right now/);
  assert.match(executor, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
});

test("local travel does not use the rejected Java spreadplayers form", () => {
  assert.doesNotMatch(executor, /spreadplayers/);
  assert.doesNotMatch(packScript, /spreadplayers ~ ~ 1 8 false @s/);
  assert.match(packScript, /action\?\.type === "local_travel" && action\.version === 1/);
  assert.match(packScript, /void applyLocalTravel\(player, action\)/);
});

test("each travel owns and removes only its unique ticking area", () => {
  assert.match(packScript, /function allocateTravelTickingArea/);
  assert.match(packScript, /`mc_wiz_travel_\$\{nextTravelArea\}`/);
  assert.match(executor, /const tickingArea = allocateTravelTickingArea\(\)/);
  assert.match(executor, /tickingarea add circle \$\{anchor\.x\} \$\{anchor\.y\} \$\{anchor\.z\} 2 \$\{tickingArea\}/);
  assert.match(executor, /tickingarea remove \$\{tickingArea\}/);
  assert.doesNotMatch(packScript, /TRAVEL_TICKING_AREA/);
});

test("Nether-to-Overworld travel also resolves an open-sky surface", () => {
  const dimensionStart = packScript.indexOf("async function applyDimensionTravel");
  const dimensionEnd = packScript.indexOf("function castPotionRain", dimensionStart);
  const dimensionExecutor = packScript.slice(dimensionStart, dimensionEnd);
  assert.match(dimensionExecutor, /destination\.name === "overworld"/);
  assert.match(dimensionExecutor, /findSurfaceTravelSite\(targetDimension, anchor, offsets\)/);
  assert.match(dimensionExecutor, /surfaceFallbackAnchor\(targetDimension, anchor\)/);
});

test("a disposable-world simulated child verifies surface rescue and nearest-village travel", () => {
  const start = e2eScript.indexOf("async function runLocalTravelAcceptance");
  const end = e2eScript.indexOf("function runCustomPlanCheck", start);
  const acceptance = e2eScript.slice(start, end);
  assert.match(acceptance, /take us up on top of land/);
  assert.match(acceptance, /teleport me to the nearest village/);
  assert.match(acceptance, /getTopmostBlock/);
  assert.match(e2eScript, /function generatedVillageNear/);
  assert.match(e2eScript, /getGeneratedStructures/);
  assert.match(acceptance, /wizardPlayer\?\.dimension\.id === "minecraft:overworld"/);
  assert.match(acceptance, /"PASS", check/);
  assert.match(packageJson, /"test:e2e:local-travel": "MC_WIZARD_E2E_SCOPE=local-travel/);
  assert.match(e2eRunner, /BEDROCK_CONTAINER_NAME="\$NAME"/);
  assert.match(e2eRunner, /node --env-file-if-exists=.env src\/server\.mjs/);
  assert.match(e2eRunner, /INTERACTION_LOG_FILE="\$DATA\/interactions\.jsonl"/);
  assert.match(e2eRunner, /E2E_SCOPE" = "local-travel"/);
  assert.match(e2eRunner, /WORLD_TYPE=DEFAULT/);
  assert.match(e2eRunner, /WORLD_SEED=8675309/);
});
