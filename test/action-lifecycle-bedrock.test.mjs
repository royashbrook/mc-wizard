import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  legacyPropertySuffix,
  stablePropertySuffix,
} from "../bedrock/behavior_packs/mc_wizard/scripts/project-memory-key.js";

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
  assert.match(packScript, /changedWorld \? "partial" : "failed"/);
  assert.match(packScript, /\["completed", "partial"\]\.includes\(status\) && report\.projectRecord/);
});

test("every build executor binds its request to the allocated build token", () => {
  const allocations = [...packScript.matchAll(/const token = \+\+nextBuildToken;/g)].length;
  const bindings = [...packScript.matchAll(/^\s+(?:if \(!)?bindBuildAction\(player, token/gm)].length;
  assert.ok(allocations > 0);
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

test("named structure refinements reuse the matching completed structure, not merely the latest kind", () => {
  assert.match(packScript, /const structuresByKind = new Map\(\)/);
  assert.match(packScript, /structureKindPropertyId\(player, saved\.plan\.kind\)/);
  assert.match(packScript, /function structureFor\(player, kind\)/);
  const finder = packScript.slice(
    packScript.indexOf("function findModificationSite"),
    packScript.indexOf("function runRawFill"),
  );
  assert.match(finder, /structureFor\(player, plan\.kind\)/);
  assert.doesNotMatch(finder, /const previous = lastStructureFor\(player\)/);
  assert.ok(
    packScript.indexOf("world.setDynamicProperty(structureKindPropertyId(player, saved.plan.kind)")
      < packScript.indexOf("world.setDynamicProperty(lastStructurePropertyId(player)"),
  );
});

test("project persistence keys resist known FNV collisions and migrate legacy records", () => {
  const first = "collisionkid\u0000green house annex sky village";
  const second = "collisionkid\u0000crystal monument park cedar statue";
  assert.equal(legacyPropertySuffix(first), legacyPropertySuffix(second));
  assert.notEqual(stablePropertySuffix(first), stablePropertySuffix(second));
  assert.match(packScript, /readMigratingDynamicProperty/);
  assert.match(packScript, /legacyStructureKindPropertyId/);
  assert.match(packScript, /legacyProjectKindPropertyId/);
  assert.match(packScript, /lastStructureIndexPropertyId/);
  assert.match(packScript, /lastProjectIndexPropertyId/);
  assert.match(packScript, /could not migrate .* saved (?:project|structure) index/);
});

test("named machine refinements reuse the matching completed project, not merely the latest project", () => {
  assert.match(packScript, /const projectsByKind = new Map\(\)/);
  assert.match(packScript, /function projectFor\(player, kind\)/);
  assert.match(packScript, /blueprint\.mode === "modify" \? projectFor\(player, blueprint\.kind\) : undefined/);
  assert.match(packScript, /world\.setDynamicProperty\(projectKindPropertyId\(player, saved\.kind\), JSON\.stringify\(saved\)\)/);
  assert.ok(
    packScript.indexOf("world.setDynamicProperty(projectKindPropertyId(player, saved.kind)")
      < packScript.indexOf("world.setDynamicProperty(lastProjectPropertyId(player)"),
  );
});

test("immediate world actions also report their observed result", () => {
  assert.match(packScript, /function castPotionRain\(player, action, report = beginImmediateAction\(player\)\)/);
  assert.match(packScript, /spawned \? "completed" : "failed"/);
  assert.match(packScript, /function applyWorldControl\(player, action, report = beginImmediateAction\(player\)\)/);
  assert.match(packScript, /endImmediateAction\(report, "completed", `changed/);
  assert.match(packScript, /activeReport \|\|= beginImmediateAction\(player\)/);
  assert.match(packScript, /const complete = dropped === requested/);
  assert.match(packScript, /complete \? "completed" : "failed"/);
});

test("partial item delivery stays failed and feedback speech waits for the brain decision", () => {
  assert.match(packScript, /delivered \$\{dropped\} of \$\{requested\} requested items/);
  assert.doesNotMatch(packScript, /saving that and using your note as the next instruction/);
  assert.match(packScript, /if \(message\) speak\(current, message\)/);
});

test("an explicit no-action continuation stays visible and retries through the guarded brain path", () => {
  const start = packScript.indexOf("function actionResultRetry");
  const end = packScript.indexOf("function registerActionRequest", start);
  const lifecycle = packScript.slice(start, end);
  assert.match(lifecycle, /question\.length > 500/);
  assert.match(lifecycle, /typeof value\.goalId === "string"/);
  assert.match(lifecycle, /\^\[a-zA-Z0-9_\-\]\{1,64\}\$/);
  assert.match(lifecycle, /\|\| !goalId/);
  assert.match(lifecycle, /return \{ question, reason: value\.reason, goalId \}/);
  assert.match(lifecycle, /value\.reason !== "failed-action" && value\.reason !== "staged-progress"/);
  assert.match(lifecycle, /pendingQuestions\.set\(questionKey, retryToken\)/);
  assert.match(lifecycle, /retry\.reason === "failed-action"/);
  assert.match(lifecycle, /That first pass is in place and our goal is still active/);
  assert.match(lifecycle, /our goal is still active/);
  assert.match(lifecycle, /askBackend\(player\.id, retry\.question, "wizard", 0, retryToken, retry\.goalId\)/);
  assert.match(packScript, /\.\.\.\(goalRetryId \? \{ goalId: goalRetryId \} : \{\}\)/);
  assert.match(packScript, /askBackend\(playerId, question, mode, planningAttempt \+ 1, token, goalRetryId\)/);
  assert.match(lifecycle, /system\.runTimeout/);
  assert.match(lifecycle, /const executableReplan = result\.replan\?\.action/);
  assert.ok(lifecycle.indexOf("if (executableReplan)") < lifecycle.indexOf("actionResultRetry(result.retry)"));
});

test("automatic continuations yield to newer child work and stop visibly at brain limits", () => {
  const start = packScript.indexOf("function hasNewerAction");
  const end = packScript.indexOf("function registerActionRequest", start);
  const lifecycle = packScript.slice(start, end);
  assert.match(lifecycle, /pendingQuestions\.has\(questionKey\) \|\| hasNewerAction/);
  assert.match(lifecycle, /pendingQuestions\.get\(questionKey\) !== retryToken/);
  const schedule = lifecycle.slice(
    lifecycle.indexOf("function scheduleActionResultRetry"),
    lifecycle.indexOf("async function postActionResult"),
  );
  assert.ok(schedule.indexOf("hasNewerAction(player.id, report.requestId)")
    < schedule.indexOf("askBackend(player.id, retry.question"));
  assert.match(lifecycle, /result\.superseded \|\| result\.replan\?\.superseded/);
  assert.match(lifecycle, /result\.updated === false/);
  assert.match(lifecycle, /result\.reviewLimitReached \|\| result\.retryLimitReached/);
  assert.match(lifecycle, /result\.review\?\.goal\?\.status === "complete"/);
  assert.match(lifecycle, /result\.review\.answer \|\| "That worked\. Goal complete\."/);
  assert.match(lifecycle, /reached my automatic retry limit/);
  assert.ok(lifecycle.indexOf("result.reviewLimitReached") < lifecycle.indexOf("actionResultRetry(result.retry)"));
  assert.match(lifecycle, /const abandoned = \/\\b\(\?:superseded\|player left\|all players left\|server stopp\)/);
});

test("intermediate planner retries stay conversational without speaking a false terminal answer", () => {
  const start = packScript.indexOf("async function askBackend");
  const end = packScript.indexOf("function cancelPendingQuestion", start);
  const backend = packScript.slice(start, end);
  const branch = backend.slice(backend.indexOf("if (retryPlanning)"), backend.indexOf("} catch (error)"));
  assert.match(branch, /That design didn’t fit your goal\. I’m trying another one now/);
  assert.match(branch, /\} else \{\n\s+applyResponse\(playerId, payload, question\)/);
  assert.ok(branch.indexOf("if (retryPlanning)") < branch.indexOf("applyResponse(playerId, payload, question)"));
});

test("undo cancels an already scheduled goal continuation before restoring the build", () => {
  const start = packScript.indexOf("function handleLocalCommand");
  const end = packScript.indexOf("function shouldAddressWizard", start);
  const commands = packScript.slice(start, end);
  const undo = commands.slice(
    commands.indexOf("if (/^(?:undo|undo"),
    commands.indexOf("const wantsMovement"),
  );
  assert.match(undo, /cancelPendingQuestion\(player\)/);
  assert.ok(undo.indexOf("cancelPendingQuestion(player)") < undo.indexOf("undoLastBuild(player)"));
});

test("failed immediate typed actions use the same no-action recovery boundary", () => {
  const start = packScript.indexOf("function beginImmediateAction");
  const end = packScript.indexOf("function bindBuildAction", start);
  const immediate = packScript.slice(start, end);
  assert.match(immediate, /function endImmediateAction\(report, status, detail\)/);
  assert.match(immediate, /postActionResult\(report, status, detail\)/);
  assert.match(packScript, /endImmediateAction\(report, "failed", `dimension travel failed/);
  assert.match(packScript, /endImmediateAction\(report, "failed", "player left before world control completed"\)/);
  assert.match(packScript, /endImmediateAction\(activeReport, "failed", "item delivery was interrupted before completion"\)/);
});

test("partial action results cross HTTP and remain terminal for replan and feedback", () => {
  const start = packScript.indexOf("async function postActionResult");
  const end = packScript.indexOf("function registerActionRequest", start);
  const lifecycle = packScript.slice(start, end);
  assert.match(lifecycle, /\["completed", "failed", "partial"\]\.includes\(status\)/);
  assert.match(lifecycle, /result\.updated === false && !result\.replayed/);
  assert.ok(lifecycle.indexOf("const terminal") < lifecycle.indexOf("const executableReplan"));
  assert.ok(lifecycle.indexOf("const terminal") < lifecycle.indexOf("queueFeedback(report)"));
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
  assert.ok(
    [...packScript.matchAll(/if \(!buildInProgress && !buildPreparing\) bringWizardTo\(player/g)].length >= 2,
    "response and active-request paths must not pull the Wizard out of a build",
  );
  const start = packScript.indexOf("async function giveItemsAsWizard");
  const end = packScript.indexOf("function capabilityProgramFrame", start);
  const delivery = packScript.slice(start, end);
  assert.match(delivery, /if \(buildInProgress \|\| buildPreparing\)/);
  assert.match(delivery, /const reservation = beginBuildPreparation\(\)/);
  assert.match(delivery, /const target = giftRecipient\(player, recipient\)[\s\S]*bringWizardTo\(target, true, true\)/);
  assert.doesNotMatch(delivery, /bringWizardTo\(player, true, true\)/);
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
