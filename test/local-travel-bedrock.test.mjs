import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { classifyAction, createWizard } from "../src/wizard.mjs";
import { LOCATABLE_STRUCTURES } from "../src/skills.mjs";

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

test("all Bedrock generated-structure requests route to the same executable travel hand", () => {
  for (const [question, structure, dimension, label] of [
    ["wiz take us to the nearest woodland mansion", "mansion", "overworld", "woodland mansion"],
    ["teleport me to the closest ancient city", "ancient_city", "overworld", "ancient city"],
    ["find the nearest trial chamber and take us there", "trial_chambers", "overworld", "trial chambers"],
    ["bring us to the nearest nether fortress", "fortress", "nether", "Nether fortress"],
    ["tp us to the closest end city", "end_city", "the_end", "End city"],
    ["take us to the nearest ruined portal in the nether", "ruined_portal", "nether", "ruined portal"],
  ]) {
    assert.deepEqual(classifyAction(question), {
      type: "local_travel", version: 1, destination: "nearest_structure",
      structure, dimension, label,
    }, question);
  }
  assert.equal(classifyAction("build me a woodland mansion")?.type, "build_structure");
  assert.equal(classifyAction("tell me about the nearest monument"), null);
  assert.equal(classifyAction("take us to the nearest village in the nether"), null);
  assert.equal(classifyAction("take us to the nearest fortress in the overworld"), null);
  for (const question of [
    "how do I find the nearest fortress?",
    "can you explain how to find the closest trial chamber?",
    "tell me how to find the nearest woodland mansion",
    "make me a map to find the nearest mansion",
    "find out how to get to the nearest fortress",
    "find the nearest fortress and tell me how to get there",
  ]) assert.equal(classifyAction(question), null, question);
});

test("every stable Bedrock structure ID has a canonical deterministic travel route", () => {
  assert.equal(Object.keys(LOCATABLE_STRUCTURES).length, 17);
  for (const [structure, { label, dimensions }] of Object.entries(LOCATABLE_STRUCTURES)) {
    const action = classifyAction(`take us to the nearest ${label}`);
    if (structure === "village") {
      assert.deepEqual(action, { type: "local_travel", version: 1, destination: "nearest_village" });
    } else {
      assert.deepEqual(action, {
        type: "local_travel", version: 1, destination: "nearest_structure",
        structure, dimension: dimensions[0], label,
      }, structure);
    }
  }
  for (const imprecise of ["desert temple", "jungle temple", "witch hut", "igloo"]) {
    assert.equal(classifyAction(`take us to the nearest ${imprecise}`), null, imprecise);
  }
});

test("a fresh rescue request supersedes an unfinished older project", async () => {
  const wizard = createWizard({ corpus: { search: () => [] }, env: {} });
  await wizard.ask({ player: "TravelKid", question: "build me a castle" });
  const surface = await wizard.ask({ player: "TravelKid", question: "take us up on top of land" });
  assert.deepEqual(surface.action, { type: "local_travel", version: 1, destination: "surface" });
  const village = await wizard.ask({ player: "TravelKid", question: "teleport me to the nearest village" });
  assert.deepEqual(village.action, { type: "local_travel", version: 1, destination: "nearest_village" });
});

test("a provider cannot retarget an explicit structure trip to another realm", async () => {
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      answer: "I’ll find that ruined portal.",
      action: {
        type: "local_travel", version: 1, destination: "nearest_structure",
        structure: "ruined_portal", dimension: "overworld",
      },
    }) } }] }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const result = await wizard.ask({
    player: "TravelKid", question: "take us to the nearest ruined portal in the nether",
  });
  assert.equal(result.action.type, "local_travel");
  assert.equal(result.action.structure, "ruined_portal");
  assert.equal(result.action.dimension, "nether");
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

test("generated-structure travel locates in the right realm and moves the whole party with Wizard", () => {
  assert.match(executor, /async function locateStructureForPlayer/);
  assert.match(executor, /\/v1\/locate/);
  assert.match(executor, /await locateStructureForPlayer\(player, anchor, structure\.id, target\.name\)/);
  assert.match(executor, /const target = structure \? TRAVEL_DIMENSIONS\[structure\.dimension\]/);
  assert.match(executor, /capturedPartyIds = nearbyTravelParty\(player\)\.map/);
  assert.match(executor, /const travelers = \[\.\.\.party, bot\]/);
  assert.match(executor, /tickingarea add circle/);
  assert.match(executor, /await waitForTravelChunk\(targetDimension, anchor\)/);
  assert.match(executor, /travelers\.forEach\(\(member, index\) =>/);
  assert.match(executor, /entityReachedDimension\(member, target\.id\)/);
  assert.match(executor, /function generatedStructureAtLocate/);
  assert.match(executor, /getGeneratedStructures/);
  assert.match(executor, /generatedStructureAtLocate\(targetDimension, anchor, structure\.id\)/);
  assert.match(executor, /async function findGeneratedStructureTravelSite/);
  assert.match(executor, /UNDERGROUND_LOCATABLE_STRUCTURES\.has\(structure\.id\)/);
  assert.match(executor, /await findGeneratedStructureTravelSite\(targetDimension, anchor, offsets, structure\.id\)/);
  assert.match(executor, /safe ground directly above it/);
  assert.match(executor, /const \{ minFeet \} = travelHeightRange\(dimension\)/);
  assert.match(executor, /located \$\{structure\.id\} was not observable at authoritative coordinate/);
  assert.match(executor, /const restoreAll = async \(\) =>/);
  assert.match(executor, /capturedParty\.length !== capturedPartyIds\.length/);
  assert.match(executor, /instead of splitting the party/);
  assert.match(executor, /distanceSquared\(entity\.location, location\) <= 4/);
  assert.match(executor, /const sendAll = async \(\) =>/);
  assert.match(executor, /rollback=\$\{restored\}/);
  assert.match(executor, /this world reported none in range/);
  assert.match(executor, /compass is fuzzy right now/);
  assert.match(executor, /endImmediateAction\(report, structureFallback \? "partial" : "completed"/);
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

test("a disposable-world simulated child verifies surface and general structure travel", () => {
  const start = e2eScript.indexOf("async function runLocalTravelAcceptance");
  const end = e2eScript.indexOf("function runCustomPlanCheck", start);
  const acceptance = e2eScript.slice(start, end);
  assert.match(acceptance, /take us up on top of land/);
  assert.match(acceptance, /teleport me to the nearest village/);
  assert.match(acceptance, /take us to the nearest woodland mansion/);
  assert.match(acceptance, /take us to the nearest nether fortress/);
  assert.match(acceptance, /take us to the nearest ancient city/);
  assert.match(acceptance, /getTopmostBlock/);
  assert.match(e2eScript, /function generatedStructureNear/);
  assert.match(e2eScript, /getGeneratedStructures/);
  assert.match(acceptance, /wizardPlayer\?\.dimension\.id === "minecraft:overworld"/);
  assert.match(acceptance, /"PASS", check/);
  assert.match(acceptance, /nearest-mansion-travel/);
  assert.match(acceptance, /nearest-fortress-travel/);
  assert.match(acceptance, /nearest-ancient-city-travel/);
  assert.match(packageJson, /"test:e2e:local-travel": "MC_WIZARD_E2E_SCOPE=local-travel/);
  assert.match(e2eRunner, /BEDROCK_CONTAINER_NAME="\$NAME"/);
  assert.match(e2eRunner, /node --env-file-if-exists=.env src\/server\.mjs/);
  assert.match(e2eRunner, /INTERACTION_LOG_FILE="\$DATA\/interactions\.jsonl"/);
  assert.match(e2eRunner, /E2E_SCOPE" = "local-travel"/);
  assert.match(e2eRunner, /WORLD_TYPE=DEFAULT/);
  assert.match(e2eRunner, /WORLD_SEED=8675309/);
});
