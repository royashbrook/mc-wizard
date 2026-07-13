import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packScript = await readFile(new URL(
  "../bedrock/behavior_packs/mc_wizard/scripts/main.js",
  import.meta.url,
), "utf8");

test("Bedrock reports real action outcomes instead of treating a plan as executed", () => {
  assert.match(packScript, /\/v1\/action-result/);
  assert.match(packScript, /function registerActionRequest\(player, payload\)/);
  assert.match(packScript, /postActionResult\(report, "started", "in-world build started"\)/);
  assert.match(packScript, /endBuildAction\(token, "completed", `verified/);
  assert.match(packScript, /endBuildAction\(token, "failed", `verification left/);
  assert.match(packScript, /registerActionRequest\(player, payload\)/);
});

test("every build executor binds its request to the allocated build token", () => {
  const allocations = [...packScript.matchAll(/const token = \+\+nextBuildToken;/g)].length;
  const bindings = [...packScript.matchAll(/^\s+(?:if \(!)?bindBuildAction\(player, token/gm)].length;
  assert.equal(allocations, 6);
  assert.equal(bindings, allocations);
});

test("a structure becomes the modification target only after verified completion", () => {
  const buildStart = packScript.indexOf("async function buildStructure");
  const buildEnd = packScript.indexOf("function findBlueprintSite", buildStart);
  const executor = packScript.slice(buildStart, buildEnd);
  assert.match(executor, /bindBuildAction\(player, token, structureRecord\)/);
  assert.doesNotMatch(executor, /rememberLastStructure\(/);

  const outcomeStart = packScript.indexOf("function endBuildAction");
  const outcomeEnd = packScript.indexOf("function structurePlayerKey", outcomeStart);
  const outcome = packScript.slice(outcomeStart, outcomeEnd);
  assert.match(outcome, /status === "completed" && report\.structureRecord/);
  assert.match(outcome, /rememberLastStructure/);
});

test("immediate world actions also report their observed result", () => {
  assert.match(packScript, /function castPotionRain\(player, action, report = beginImmediateAction\(player\)\)/);
  assert.match(packScript, /spawned \? "completed" : "failed"/);
  assert.match(packScript, /function applyWorldControl\(player, action, report = beginImmediateAction\(player\)\)/);
  assert.match(packScript, /endImmediateAction\(report, "completed", `changed/);
  assert.match(packScript, /activeReport \|\|= beginImmediateAction\(player\)/);
  assert.match(packScript, /dropped > 0 \? "completed" : "failed"/);
});

test("superseded and abandoned actions cannot remain pending forever", () => {
  assert.match(packScript, /postActionResult\(responseReport, "failed", "superseded before execution"\)/);
  assert.match(packScript, /endImmediateAction\(report, "failed", "player left before queued build started"\)/);
  assert.match(packScript, /queuedBuilds\.delete\(player\.id\);\n\s+void postActionResult\(previous, "failed"/);
  assert.match(packScript, /for \(let attempt = 0; attempt < 3; attempt \+= 1\)/);
  assert.match(packScript, /postActionResult\(responseReport, "failed", "player left before execution"\)/);
  assert.match(packScript, /endBuildAction\(abandonedToken, "failed", "all players left before the build completed"\)/);
});

test("structure preparation reserves the one Wizard body before yielding", () => {
  const start = packScript.indexOf("async function buildStructure");
  const end = packScript.indexOf("function findBlueprintSite", start);
  const executor = packScript.slice(start, end);
  assert.ok(executor.indexOf("buildInProgress = true") < executor.indexOf("await prepareStructureArea"));
  assert.ok(executor.indexOf("bindBuildAction(player, token, structureRecord)") < executor.indexOf("await prepareStructureArea"));
  assert.match(executor, /endBuildAction\(token, "failed", "could not prepare a nearby build area"\)/);
});

test("every async workshop preparation holds the shared build reservation", () => {
  assert.equal([...packScript.matchAll(/await prepareBuildWorkshopReserved\(player\)/g)].length, 5);
  assert.equal([...packScript.matchAll(/await prepareBuildWorkshop\(player\)/g)].length, 1);
  assert.match(packScript, /if \(buildInProgress \|\| buildPreparing\)/);
});

test("a workshop await cannot consume a newer request's lifecycle report", () => {
  assert.equal([...packScript.matchAll(/actionClaim = captureBuildActionClaim\(player\)/g)].length, 5);
  assert.equal([...packScript.matchAll(/if \(!buildActionClaimIsCurrent\(player, actionClaim\)\) return;/g)].length, 5);
  assert.equal([...packScript.matchAll(/bindBuildAction\(player, token, undefined, actionClaim\)/g)].length, 5);
  assert.match(packScript, /if \(claim && !buildActionClaimIsCurrent\(player, claim\)\) return false/);
});

test("chat and item delivery cannot steal the Wizard body from an active build", () => {
  assert.equal(
    [...packScript.matchAll(/if \(!buildInProgress && !buildPreparing\) bringWizardTo\(player/g)].length,
    3,
  );
  const start = packScript.indexOf("async function giveItemsAsWizard");
  const end = packScript.indexOf("function applyResponse", start);
  const delivery = packScript.slice(start, end);
  assert.match(delivery, /if \(buildInProgress \|\| buildPreparing\)/);
  assert.match(delivery, /const reservation = beginBuildPreparation\(\)/);
  assert.match(delivery, /endImmediateAction\(activeReport, "failed", "item delivery was interrupted before completion"\)/);
  assert.match(delivery, /finally \{\n\s+endBuildPreparation\(reservation\)/);
});

test("the last player leaving clears lifecycle and body reservations even if Wizard is invalid", () => {
  const start = packScript.indexOf("world.afterEvents.playerLeave.subscribe");
  const end = packScript.indexOf("system.runInterval", start);
  const cleanup = packScript.slice(start, end);
  assert.doesNotMatch(cleanup, /humanPlayers\(\)\.length \|\| !wizardIsValid\(\)/);
  assert.match(cleanup, /if \(wizardIsValid\(\)\)/);
  assert.match(cleanup, /clearBuild\(abandonedToken, true\)/);
  assert.match(cleanup, /endBuildAction\(abandonedToken, "failed", "all players left before the build completed"\)/);
  assert.match(cleanup, /activeBuildPreparation = undefined/);
  assert.match(cleanup, /pendingActionReports\.clear\(\)/);
});
