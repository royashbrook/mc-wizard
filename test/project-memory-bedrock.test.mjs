import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packScript = await readFile(new URL(
  "../bedrock/behavior_packs/mc_wizard/scripts/main.js",
  import.meta.url,
), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = packScript.indexOf(startMarker);
  const end = packScript.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return packScript.slice(start, end);
}

test("interactive blueprints retain completed work and partial progress for refinement", () => {
  const build = sourceBetween("async function buildInteractiveBlueprint", "function buildMachinePlan");
  assert.match(build, /bindBuildProject\(player, token, \{/);
  assert.match(build, /projectBlueprintSummary\(blueprint\)/);
  assert.doesNotMatch(build, /rememberLastProject\(/);

  const outcome = sourceBetween("function endBuildAction", "function structurePlayerKey");
  assert.match(outcome, /\["completed", "partial"\]\.includes\(status\) && report\.projectRecord/);
  assert.match(outcome, /rememberLastProject/);
});

test("a modify machine plan reuses the active project's origin and orientation", () => {
  const build = sourceBetween("async function buildInteractiveBlueprint", "function buildMachinePlan");
  assert.match(build, /blueprint\.mode === "modify" \? projectFor\(player, blueprint\.kind\) : undefined/);
  assert.match(build, /previousProject\?\.dimensionId === dimension\.id/);
  assert.match(build, /reuseProject \? \{ \.\.\.reuseProject\.forward \} : cardinalDirection\(player\)/);
  assert.match(build, /reuseProject \? \{ \.\.\.reuseProject\.right \}/);
  assert.match(build, /reuseProject \? \{ \.\.\.reuseProject\.origin \} : findBlueprintSite/);
  assert.ok(build.indexOf("if (!origin && !waitingForBody)") > build.indexOf("reuseProject ? { ...reuseProject.origin }"));
});

test("the brain receives a bounded, sanitized project summary without an absolute origin", () => {
  assert.match(packScript, /const PROJECT_PLACEMENT_LIMIT = 128/);
  assert.match(packScript, /const PROJECT_INTERACTION_LIMIT = 24/);
  const summary = sourceBetween("function projectBlueprintSummary", "function lastProjectFor");
  assert.match(summary, /foldPlacementSteps\(blueprint\?\.placements\)/);
  assert.match(summary, /placements\.length >= PROJECT_PLACEMENT_LIMIT/);
  assert.match(summary, /interactions\.length >= PROJECT_INTERACTION_LIMIT/);
  assert.match(summary, /blueprint\?\.preInteractions/);
  assert.match(summary, /orientationTarget:/);

  const snapshot = sourceBetween("function liveWorldSnapshot", "function idleLookAround");
  assert.match(snapshot, /const lastProject = project\?\.dimensionId === player\.dimension\.id/);
  assert.match(snapshot, /relativeOrigin:/);
  assert.match(snapshot, /bounds: \{ min: \[\.\.\.project\.bounds\.min\], max: \[\.\.\.project\.bounds\.max\] \}/);
  assert.match(snapshot, /placements: project\.placements\.map/);
  assert.match(snapshot, /interactions: project\.interactions\.map/);
  assert.match(snapshot, /\.\.\.\(lastProject \? \{ lastProject \} : \{\}\)/);
  assert.doesNotMatch(snapshot, /lastProject = [\s\S]*?\n\s+origin:/);
});

test("modify reconciles obsolete Wizard-owned blocks and runs repeatable side effects by deficit", () => {
  const build = sourceBetween("async function buildInteractiveBlueprint", "function buildMachinePlan");
  assert.match(build, /obsoleteProjectPlacements\(reuseProject, projectSummary\)/);
  assert.match(build, /projectPlacementStillOwned/);
  assert.match(build, /const cleanupSteps = obsoletePlacements\.map/);
  assert.match(build, /expectedEntityCount/);

  const interaction = sourceBetween("function interactionIsSatisfied", "function expectedHopperFacing");
  assert.match(interaction, /count >= \(interaction\.expectedEntityCount \|\| 1\)/);
  const container = sourceBetween("function loadContainerSlotAsWizard", "function verifyBlueprint");
  assert.match(container, /containerHasSlots\(dimension, location, \[slot\]\)\) return true/);
});

test("a failed action's bounded replan is scheduled for the same live player", () => {
  const reporter = sourceBetween("async function postActionResult", "function registerActionRequest");
  assert.match(reporter, /JSON\.parse\(response\.body \|\| "\{\}"\)/);
  assert.match(reporter, /result\.replan\?\.action && result\.replan\?\.requestId/);
  assert.match(reporter, /report\.playerId \? playerById\(report\.playerId\)/);
  assert.match(reporter, /humanPlayers\(\)\.find/);
  assert.match(reporter, /if \(!player\) \{/);
  assert.match(reporter, /system\.run\(\(\) => \{/);
  assert.match(reporter, /status === "failed"[\s\S]*automatic retry after an in-world action failed[\s\S]*automatic continuation after checking the active goal/);
  assert.match(reporter, /applyResponse\(player\.id, replan, status === "failed"/);
  assert.match(reporter, /kept our project active[\s\S]*tell me what to change/);
});
