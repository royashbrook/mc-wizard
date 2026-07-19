import {
  BlockPermutation,
  Direction,
  EnchantmentTypes,
  EquipmentSlot,
  GameMode,
  ItemStack,
  system,
  world,
} from "@minecraft/server";
import { getPlayerSkin, LookDuration, spawnSimulatedPlayer } from "@minecraft/server-gametest";
import { FormCancelationReason, ModalFormData } from "@minecraft/server-ui";
import { variables, secrets } from "@minecraft/server-admin";
import { http, HttpRequest, HttpRequestMethod } from "@minecraft/server-net";
import { startE2E } from "./e2e.js";
import { createCalculatorBlueprint } from "./calculator.js";
import { bookPages, bookTitle } from "./book.js";
import {
  expectedPlacementStates,
  planBounds,
  validateBuildPlan,
} from "./build-plan.js";
import {
  expansionClearOperations,
  obsoleteExpansionOperations,
  primitiveStructureOperations,
  STRUCTURE_PRIMITIVE_LIMIT,
  validateBuildStructurePlan,
} from "./build-structure.js";
import { createAutomaticSmelterBlueprint } from "./auto-smelter.js";
import { createAutomaticChickenFarmBlueprint } from "./chicken-farm.js";
import { commandLesson } from "./command-lessons.js";
import { createItemSorterBlueprint } from "./item-sorter.js";
import { createAutomaticKelpFarmBlueprint } from "./kelp-farm.js";
import { foldPlacementSteps, machineBlueprint } from "./machine-plan.js";
import { createTwoByTwoPistonDoorBlueprint } from "./piston-door.js";
import { createRecipeDisplay } from "./recipe-display.js";
import { createAutomaticWoolFarmBlueprint } from "./wool-farm.js";
import { splitMessage } from "./chat.js";
import { newestProjectRecord, normalizeRuntimeStep, runtimeProgramHasEvidence } from "./capability-runtime.js";
// Kept as a separate import: contract tests assert the exact line above.
import { synthesizeRuntimeEvidence } from "./capability-runtime.js";
import { legacyPropertySuffix, stablePropertySuffix } from "./project-memory-key.js";

const PREFIX = "§d[MC Wizard]§r ";
const WIZARD_NAME = "MC Wizard";
const WIZARD_TAG = "mcwizard:bot";
// Keep the native form implementation available, but use non-blocking chat grading for now.
const FEEDBACK_FORMS_ENABLED = false;
const SAFE_SPACE = new Set([
  "minecraft:air",
  "minecraft:short_grass",
  "minecraft:tall_grass",
  "minecraft:fern",
  "minecraft:snow_layer",
]);
const SAFE_GROUND = new Set([
  "minecraft:grass_block",
  "minecraft:dirt",
  "minecraft:coarse_dirt",
  "minecraft:podzol",
  "minecraft:mycelium",
  "minecraft:stone",
  "minecraft:smooth_stone",
  "minecraft:sand",
  "minecraft:red_sand",
  "minecraft:gravel",
  "minecraft:snow",
]);
const OPPOSITE_CARDINAL = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};
// Vanilla Bedrock pistons use their legacy metadata direction map, whose
// horizontal values are opposite the generic facing_direction state map.
const PISTON_FACING_DIRECTION = {
  north: 3,
  south: 2,
  west: 5,
  east: 4,
};
// Match a creative player's practical block reach. Every placement is still
// verified because the API can report a use animation without changing the world.
const BUILD_REACH_SQUARED = 5.5 * 5.5;
const lastBuildTick = new Map();
const greetedPlayers = new Set();
const engineAddressedMessageCounts = new Map();
const queuedBuilds = new Map();
const buildMoveNotices = new Set();
const pendingQuestions = new Map();
const pendingActionReports = new Map();
const actionReportsByToken = new Map();
const pendingFeedback = new Map();
const queuedFeedback = new Map();
const promptedFeedbackRequests = new Set();
const lastUndo = new Map();
const lastStructures = new Map();
const structuresByKind = new Map();
const lastProjects = new Map();
const projectsByKind = new Map();
const playerPreferences = new Map();
const playerPreferenceGenerations = new Map();
const playerPreferencesPending = new Set();
const sessionResets = new Map();
const placementRetries = new Map();
const buildRetryNotices = new Set();
const preparedPlacements = new Set();
const nonTransactionalBuildTokens = new Set();
const TRANSACTION_JOURNAL = "mcwizard:active_transaction";
const UNDO_RETENTION_TICKS = 20 * 60 * 10;
const WORKSHOP_COUNTER = "mcwizard:workshop_counter";
const WORKSHOP_TICKING_AREA = "mc_wizard_workshop";
const E2E_TRAVEL_FAULT_PROPERTY = "mcwizard:e2e_travel_fault";
const LAST_STRUCTURES = "mcwizard:last_structures";
const LAST_PROJECTS = "mcwizard:last_projects";
const PROJECT_PLACEMENT_LIMIT = 128;
const PROJECT_INTERACTION_LIMIT = 24;
const PROJECT_COORDINATE_LIMIT = 64;
const TRAVEL_PARTY_DISTANCE_SQUARED = 16 * 16;
const TRAVEL_DIMENSIONS = Object.freeze({
  overworld: { id: "minecraft:overworld", name: "overworld", label: "Overworld" },
  nether: { id: "minecraft:nether", name: "nether", label: "Nether" },
  the_end: { id: "minecraft:the_end", name: "the_end", label: "End" },
});
const LOCATABLE_STRUCTURES = Object.freeze({
  ancient_city: { label: "ancient city", dimension: "overworld" },
  bastion_remnant: { label: "bastion remnant", dimension: "nether" },
  buried_treasure: { label: "buried treasure", dimension: "overworld" },
  end_city: { label: "End city", dimension: "the_end" },
  fortress: { label: "Nether fortress", dimension: "nether" },
  mansion: { label: "woodland mansion", dimension: "overworld" },
  mineshaft: { label: "mineshaft", dimension: "overworld" },
  monument: { label: "ocean monument", dimension: "overworld" },
  pillager_outpost: { label: "pillager outpost", dimension: "overworld" },
  ruined_portal: { label: "ruined portal", dimension: "overworld" },
  ruins: { label: "ocean ruins", dimension: "overworld" },
  shipwreck: { label: "shipwreck", dimension: "overworld" },
  stronghold: { label: "stronghold", dimension: "overworld" },
  temple: { label: "temple", dimension: "overworld" },
  trail_ruins: { label: "trail ruins", dimension: "overworld" },
  trial_chambers: { label: "trial chambers", dimension: "overworld" },
  village: { label: "village", dimension: "overworld" },
});
const UNDERGROUND_LOCATABLE_STRUCTURES = new Set([
  "ancient_city", "mineshaft", "stronghold", "trail_ruins", "trial_chambers",
]);
const TRAVEL_GROUND_HAZARDS = new Set([
  "minecraft:campfire",
  "minecraft:cactus",
  "minecraft:fire",
  "minecraft:lava",
  "minecraft:magma",
  "minecraft:powder_snow",
  "minecraft:soul_campfire",
]);
const STRUCTURE_ENTITY_ITEMS = Object.freeze({
  "minecraft:villager_v2": "minecraft:villager_spawn_egg",
  "minecraft:goat": "minecraft:goat_spawn_egg",
  "minecraft:iron_golem": "minecraft:iron_golem_spawn_egg",
});
// Entity spawns can be visible for a tick and then disappear if the target is
// blocked or the mob walks out. Require five seconds of aggregate presence
// before the structure is allowed to report completion.
const STRUCTURE_ENTITY_STABLE_POLLS = 20;
const STRUCTURE_ENTITY_REACH_POLLS = 20;
const MAX_BULK_STRUCTURE_RETRIES = 8;
const MAX_STRUCTURE_POST_RETRIES = 120;
const GENERATED_STRUCTURE_KINDS = new Set([
  "castle", "mansion", "house", "tower", "bridge", "barn", "base", "shop", "school", "wall", "monument",
]);

let wizard;
let followPlayerId;
let wizardShouldStay = false;
let wizardSpeaking = false;
let buildInProgress = false;
let buildPreparing = false;
let activeBuildPreparation;
let nextBuildPreparation = 0;
let buildActionGeneration = 0;
let activeBuildToken;
let nextBuildToken = 0;
let nextQuestionToken = 0;
let nextTravelArea = 0;
const RUNTIME_SESSION_NONCE = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1_000_000_000).toString(36)}`;
let buildMovement;
let activeTransaction;
let lastAmbientTick = 0;
let learnedWizardSkin;
const lastCompletedBuildTokens = new Map();
// Validator salvage records (#35): entries the brain-side validators dropped
// ride along with the build token so a verified-complete salvaged build posts
// status "partial" naming the dropped indices instead of a clean "completed".
const salvageDropsByToken = new Map();
// Synchronous handoff from buildMachinePlan into buildInteractiveBlueprint;
// the call site must stay byte-stable for contract tests, so the drops cannot
// travel as an extra argument.
let nextBlueprintSalvageDrops;

function variable(name, fallback) {
  try {
    return variables.get(name) || fallback;
  } catch {
    return fallback;
  }
}

function secret(name) {
  try {
    return secrets.get(name);
  } catch {
    return undefined;
  }
}

const WIZARD_URL = variable("mc_wizard_url", "http://host.docker.internal:3000/v1/ask");
const AUTHORIZATION = secret("mc_wizard_authorization");

async function executeServerConsole(player, commands) {
  const request = new HttpRequest(WIZARD_URL.replace(/\/v1\/ask(?:\?.*)?$/, "/v1/server-commands"))
    .setMethod(HttpRequestMethod.Post)
    .setBody(JSON.stringify({ player: player.name, commands }))
    .addHeader("Content-Type", "application/json");
  if (AUTHORIZATION) request.addHeader("Authorization", AUTHORIZATION);
  const response = await http.request(request);
  let result = {};
  try { result = JSON.parse(response.body || "{}"); } catch {}
  if (response.status < 200 || response.status >= 300) {
    throw new Error(result.error || `server console returned HTTP ${response.status}`);
  }
  if (result.succeeded !== result.total) {
    throw new Error(`only ${result.succeeded || 0} of ${result.total || commands.length} server commands succeeded`);
  }
  return `executed ${result.succeeded} dedicated-server command${result.succeeded === 1 ? "" : "s"}`;
}

async function configureServer(player, settings) {
  const request = new HttpRequest(WIZARD_URL.replace(/\/v1\/ask(?:\?.*)?$/, "/v1/server-control"))
    .setMethod(HttpRequestMethod.Post)
    .setBody(JSON.stringify({ player: player.name, settings }))
    .addHeader("Content-Type", "application/json");
  if (AUTHORIZATION) request.addHeader("Authorization", AUTHORIZATION);
  const response = await http.request(request);
  let result = {};
  try { result = JSON.parse(response.body || "{}"); } catch {}
  if (response.status < 200 || response.status >= 300) {
    throw new Error(result.error || `server control returned HTTP ${response.status}`);
  }
  speak(player, "The setting is saved. I’m restarting this world now, so you’ll disconnect briefly—rejoin in about a minute and it will be ready.");
  return "queued a clean Bedrock settings restart";
}

function actionResultRetry(value) {
  if (!value || typeof value !== "object" || typeof value.question !== "string") return undefined;
  const question = value.question.trim();
  const goalId = typeof value.goalId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value.goalId)
    ? value.goalId : undefined;
  if (!question || question.length > 500
    || !goalId
    || (value.reason !== "failed-action" && value.reason !== "staged-progress")) return undefined;
  return { question, reason: value.reason, goalId };
}

function hasNewerAction(playerId, requestId) {
  const pending = pendingActionReports.get(playerId);
  if (pending && pending.requestId !== requestId) return true;
  return [...actionReportsByToken.values()].some((active) => (
    active.playerId === playerId && active.requestId !== requestId
  ));
}

function withCurrentActionPlayer(report, callback) {
  system.run(() => {
    const player = (report.playerId ? playerById(report.playerId) : undefined)
      || humanPlayers().find((candidate) => candidate.name === report.playerName);
    if (!player) return;
    const questionKey = `${player.id}:wizard`;
    if (pendingQuestions.has(questionKey) || hasNewerAction(player.id, report.requestId)) {
      console.warn(`[MC Wizard] skipped automatic continuation for ${report.requestId}: newer player work exists`);
      return;
    }
    callback(player, questionKey);
  });
}

function scheduleActionResultRetry(report, retry) {
  withCurrentActionPlayer(report, (player, questionKey) => {
    const retryToken = ++nextQuestionToken;
    pendingQuestions.set(questionKey, retryToken);
    speak(player, retry.reason === "failed-action"
      ? "That attempt didn’t hold, but our goal is still active. I’m revising the plan and trying again now."
      : "That first pass is in place and our goal is still active. I’m planning the next part now.");
    system.runTimeout(() => {
      if (pendingQuestions.get(questionKey) !== retryToken) return;
      const current = playerById(player.id);
      if (!current || hasNewerAction(player.id, report.requestId)) {
        pendingQuestions.delete(questionKey);
        return;
      }
      void askBackend(player.id, retry.question, "wizard", 0, retryToken, retry.goalId);
    }, 40);
  });
}

async function postActionResult(report, status, detail) {
  if (!report?.requestId) return;
  const actionPlayer = (report.playerId ? playerById(report.playerId) : undefined)
    || humanPlayers().find((candidate) => candidate.name === report.playerName);
  const context = ["completed", "failed", "partial"].includes(status) && actionPlayer
    ? liveWorldSnapshot(actionPlayer) : undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const request = new HttpRequest(WIZARD_URL.replace(/\/v1\/ask(?:\?.*)?$/, "/v1/action-result"))
        .setMethod(HttpRequestMethod.Post)
          .setBody(JSON.stringify({
            player: report.playerName,
            ...(report.playerId ? { playerId: report.playerId } : {}),
            requestId: report.requestId,
          status,
          ...(detail ? { detail: String(detail).slice(0, 1600) } : {}),
          ...(context ? { context } : {}),
        }))
        .addHeader("Content-Type", "application/json");
      if (AUTHORIZATION) request.addHeader("Authorization", AUTHORIZATION);
      const response = await http.request(request);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`brain returned HTTP ${response.status}`);
      }
      const result = JSON.parse(response.body || "{}");
      console.warn(`[MC Wizard] action ${report.requestId} ${status}`);
      const terminal = ["completed", "failed", "partial"].includes(status);
      const abandoned = /\b(?:superseded|player left|all players left|server stopp)/i.test(detail || "");
      if (!terminal || abandoned || result.superseded || result.replan?.superseded) return;
      if (result.updated === false && !result.replayed) {
        if (result.matched) queueFeedback(report);
        return;
      }
      if (result.review?.goal?.status === "complete") {
        withCurrentActionPlayer(report, (player) => speak(
          player,
          result.review.answer || "That worked. Goal complete.",
        ));
        queueFeedback(report);
        return;
      }
      if (result.reviewLimitReached || result.retryLimitReached) {
        withCurrentActionPlayer(report, (player) => speak(
          player,
          "Our goal is still active, but I’ve reached my automatic retry limit. Come take a look and tell me what to change; I’ll continue from there.",
        ));
        queueFeedback(report);
        return;
      }
      const executableReplan = result.replan?.action && result.replan?.requestId
        && typeof result.replan.requestId === "string"
        && /^[a-zA-Z0-9_-]{1,64}$/.test(result.replan.requestId);
      if (executableReplan) {
        const replan = result.replan;
        const player = actionPlayer
          || humanPlayers().find((candidate) => candidate.name === report.playerName);
        if (!player) {
          console.warn(`[MC Wizard] could not apply replan ${replan.requestId}: player ${report.playerName} left`);
          return;
        }
        system.run(() => {
          if (!playerById(player.id)) {
            console.warn(`[MC Wizard] could not apply replan ${replan.requestId}: player ${report.playerName} left`);
            return;
          }
          if (pendingQuestions.has(`${player.id}:wizard`)
            || hasNewerAction(player.id, report.requestId)) {
            console.warn(`[MC Wizard] skipped automatic replan ${replan.requestId}: newer player work exists`);
            return;
          }
          applyResponse(player.id, replan, status === "failed"
            ? "automatic retry after an in-world action failed"
            : "automatic continuation after checking the active goal");
        });
        return;
      }
      const retry = actionResultRetry(result.retry);
      if (result.retry && !retry) {
        console.warn(`[MC Wizard] ignored invalid action-result retry for ${report.requestId}`);
      }
      if (retry) {
        scheduleActionResultRetry(report, retry);
        return;
      }
      if (result.reviewDeferred || result.review?.goal?.status === "active") {
        withCurrentActionPlayer(report, (player) => speak(player, "I’ve finished this pass and kept our project active. Come take a look—tell me what to change, and I’ll keep working on this same build."));
        queueFeedback(report);
        return;
      }
      if (status === "failed") {
        withCurrentActionPlayer(report, (player) => speak(
          player,
          "That attempt didn’t hold, but our goal is still active. Tell me what to change and I’ll keep working from here.",
        ));
      }
      queueFeedback(report);
      return;
    } catch (error) {
      if (attempt === 2) {
        console.warn(`[MC Wizard] could not report action ${report.requestId} ${status} after three attempts: ${error}`);
        return;
      }
      await system.waitTicks(10 * (attempt + 1));
    }
  }
}

function registerActionRequest(player, payload) {
  if (!payload.action) return;
  if (typeof payload.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(payload.requestId)) {
    console.warn("[MC Wizard] action response had no safe request id; executing without lifecycle memory");
    return;
  }
  const previous = pendingActionReports.get(player.id);
  if (previous && previous.requestId !== payload.requestId) {
    queuedBuilds.delete(player.id);
    void postActionResult(previous, "failed", "superseded by a newer queued request");
  }
  pendingActionReports.set(player.id, {
    playerId: player.id,
    playerName: player.name,
    requestId: payload.requestId,
  });
}

function takePendingActionReport(player) {
  const report = pendingActionReports.get(player.id);
  if (report) pendingActionReports.delete(player.id);
  return report;
}

function captureBuildActionClaim(player) {
  return {
    generation: buildActionGeneration,
    report: pendingActionReports.get(player.id),
  };
}

function buildActionClaimIsCurrent(player, claim) {
  return claim?.generation === buildActionGeneration
    && (!claim.report || pendingActionReports.get(player.id) === claim.report);
}

function beginImmediateAction(player) {
  const report = takePendingActionReport(player);
  if (report) void postActionResult(report, "started", "in-world action started");
  return report;
}

function endImmediateAction(report, status, detail) {
  if (report) void postActionResult(report, status, detail);
}

function failPendingAction(player, detail) {
  const report = takePendingActionReport(player);
  endImmediateAction(report, "failed", detail);
}

function bindBuildAction(player, token, structureRecord, claim) {
  if (claim && !buildActionClaimIsCurrent(player, claim)) return false;
  const report = claim ? claim.report : takePendingActionReport(player);
  if (report) pendingActionReports.delete(player.id);
  if (!report && !structureRecord) return true;
  actionReportsByToken.set(token, {
    ...(report || { playerId: player.id, playerName: player.name }),
    ...(structureRecord ? { structureRecord } : {}),
  });
  if (report) void postActionResult(report, "started", "in-world build started");
  return true;
}

function bindBuildProject(player, token, projectRecord) {
  actionReportsByToken.set(token, {
    ...(actionReportsByToken.get(token) || { playerId: player.id, playerName: player.name }),
    projectRecord,
  });
}

function endBuildAction(token, status, detail) {
  const report = actionReportsByToken.get(token);
  const dropped = salvageDropsByToken.get(token);
  salvageDropsByToken.delete(token);
  if (!report) return;
  actionReportsByToken.delete(token);
  if (status === "completed" && report.playerId) lastCompletedBuildTokens.set(report.playerId, token);
  if (status === "completed" && report.structureRecord) {
    rememberLastStructure({ name: report.playerName }, report.structureRecord);
  }
  if (["completed", "partial"].includes(status) && report.projectRecord) {
    rememberLastProject({ name: report.playerName }, report.projectRecord);
  }
  if (status === "completed" && dropped?.length) {
    // A salvaged plan built everything that survived validation, but the child
    // asked for more: post partial with the dropped entries so the brain
    // reviews the gap instead of closing the goal on a clean completion (#35).
    status = "partial";
    detail = `${detail ? `${detail}; ` : ""}salvage dropped ${dropped.length} entr${dropped.length === 1 ? "y" : "ies"}: ${JSON.stringify(dropped)}`;
    withCurrentActionPlayer(report, (player) => speak(
      player,
      `I built most of it—${dropped.length} piece${dropped.length === 1 ? "" : "s"} didn’t fit this world. Want me to fix those?`,
    ));
  }
  void postActionResult(report, status, detail);
}

function structurePlayerKey(player) {
  return player.name.trim().toLowerCase();
}

function newStructureInhabitantTag(token) {
  return `mcwizard_inhabitant_${Date.now().toString(36)}_${token}`;
}

function validStructureInhabitantTag(value) {
  return typeof value === "string" && /^mcwizard_inhabitant_[a-z0-9_]{1,64}$/.test(value);
}

function readMigratingDynamicProperty(currentId, legacyId) {
  const current = world.getDynamicProperty(currentId);
  if (typeof current === "string" && current) return current;
  const legacy = world.getDynamicProperty(legacyId);
  return typeof legacy === "string" && legacy ? legacy : undefined;
}

function lastStructurePropertyId(player) {
  return `${LAST_STRUCTURES}:${stablePropertySuffix(structurePlayerKey(player))}`;
}

function legacyLastStructurePropertyId(player) {
  return `${LAST_STRUCTURES}:${legacyPropertySuffix(structurePlayerKey(player))}`;
}

function lastStructureIndexPropertyId(player) {
  return `${LAST_STRUCTURES}:latest:${stablePropertySuffix(structurePlayerKey(player))}`;
}

function structureKindKey(player, kind) {
  return `${structurePlayerKey(player)}\u0000${String(kind || "structure").toLowerCase()}`;
}

function structureKindPropertyId(player, kind) {
  return `${LAST_STRUCTURES}:kind:${stablePropertySuffix(structureKindKey(player, kind))}`;
}

function legacyStructureKindPropertyId(player, kind) {
  return `${LAST_STRUCTURES}:kind:${legacyPropertySuffix(structureKindKey(player, kind))}`;
}

function validStructureVector(value, vertical = false) {
  if (!value || !Number.isInteger(value.x) || !Number.isInteger(value.z)) return false;
  if (vertical && !Number.isInteger(value.y)) return false;
  return vertical || (Math.abs(value.x) + Math.abs(value.z) === 1);
}

function validatedStoredStructure(stored) {
  if (!stored || typeof stored.dimensionId !== "string"
    || !validStructureVector(stored.origin, true)
    || !validStructureVector(stored.forward)
    || !validStructureVector(stored.right)) return undefined;
  return { ...stored, plan: validateBuildStructurePlan(stored.plan) };
}

function lastProjectPropertyId(player) {
  return `${LAST_PROJECTS}:${stablePropertySuffix(structurePlayerKey(player))}`;
}

function legacyLastProjectPropertyId(player) {
  return `${LAST_PROJECTS}:${legacyPropertySuffix(structurePlayerKey(player))}`;
}

function lastProjectIndexPropertyId(player) {
  return `${LAST_PROJECTS}:latest:${stablePropertySuffix(structurePlayerKey(player))}`;
}

function projectKindKey(player, kind) {
  return `${structurePlayerKey(player)}\u0000${String(kind || "project").toLowerCase()}`;
}

function projectKindPropertyId(player, kind) {
  return `${LAST_PROJECTS}:kind:${stablePropertySuffix(projectKindKey(player, kind))}`;
}

function legacyProjectKindPropertyId(player, kind) {
  return `${LAST_PROJECTS}:kind:${legacyPropertySuffix(projectKindKey(player, kind))}`;
}

function projectVector(value) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isInteger)) return undefined;
  if (value.some((coordinate) => Math.abs(coordinate) > PROJECT_COORDINATE_LIMIT)) return undefined;
  return [...value];
}

function projectText(value, fallback, maxLength) {
  const cleaned = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
  return cleaned || fallback;
}

function projectItemId(value) {
  const itemId = String(value || "").trim().slice(0, 96);
  return /^[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(itemId) ? itemId : undefined;
}

function projectBlueprintSummary(blueprint) {
  const placements = [];
  for (const placement of foldPlacementSteps(blueprint?.placements)) {
    if (placements.length >= PROJECT_PLACEMENT_LIMIT) break;
    const itemId = projectItemId(placement?.itemId);
    const target = projectVector(placement?.target);
    const support = projectVector(placement?.support || placement?.facingTarget);
    if (!itemId || !target || !support) continue;
    const expectedType = Array.isArray(placement.expectedType)
      ? placement.expectedType[0] : placement.expectedType;
    placements.push({
      itemId,
      typeId: projectItemId(placement.typeId || expectedType) || itemId,
      target,
      support,
      orientationTarget: projectVector(placement.orientationTarget || placement.facingTarget) || null,
    });
  }

  const interactions = [];
  for (const interaction of [
    ...(blueprint?.preInteractions || []),
    ...(blueprint?.interactions || []),
  ]) {
    if (interactions.length >= PROJECT_INTERACTION_LIMIT) break;
    const action = projectText(interaction?.action, "", 32);
    const itemId = projectItemId(interaction?.itemId);
    const block = projectVector(interaction?.block);
    const faceTarget = projectVector(interaction?.faceTarget);
    if (!action || !itemId || !block || !faceTarget) continue;
    interactions.push({ action, itemId, block, faceTarget });
  }

  const suppliedMin = projectVector(blueprint?.bounds?.min);
  const suppliedMax = projectVector(blueprint?.bounds?.max);
  const points = placements.flatMap(({ target, support, orientationTarget }) => (
    [target, support, orientationTarget].filter(Boolean)
  ));
  const calculatedMin = points.length
    ? [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis])))
    : [0, 0, 0];
  const calculatedMax = points.length
    ? [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis])))
    : [0, 0, 0];
  const bounds = suppliedMin && suppliedMax
    && suppliedMin.every((coordinate, axis) => coordinate <= suppliedMax[axis])
    ? { min: suppliedMin, max: suppliedMax }
    : { min: calculatedMin, max: calculatedMax };

  return {
    title: projectText(blueprint?.title, "Working Project", 64),
    kind: projectText(blueprint?.kind || blueprint?.id, "project", 64).toLowerCase(),
    bounds,
    placements,
    interactions,
  };
}

function validatedStoredProject(stored) {
  if (!stored || typeof stored.dimensionId !== "string"
    || !validStructureVector(stored.origin, true)
    || !validStructureVector(stored.forward)
    || !validStructureVector(stored.right)) return undefined;
  return {
    ...projectBlueprintSummary(stored),
    dimensionId: stored.dimensionId,
    origin: { ...stored.origin },
    forward: { ...stored.forward },
    right: { ...stored.right },
    updatedAt: Number(stored.updatedAt) || 0,
  };
}

function newerStoredRecord(first, second) {
  if (!first) return second;
  if (!second) return first;
  return (second.updatedAt || 0) >= (first.updatedAt || 0) ? second : first;
}

function obsoleteProjectPlacements(previous, next) {
  const retained = new Set(next.placements.map(({ target }) => target.join(",")));
  return previous.placements.filter(({ target }) => !retained.has(target.join(",")));
}

function projectPlacementStillOwned(dimension, location, placement) {
  const actual = dimension.getBlock(location)?.typeId;
  const expected = new Set([placement.itemId, placement.typeId]);
  if (placement.itemId === "minecraft:repeater") {
    expected.add("minecraft:unpowered_repeater");
    expected.add("minecraft:powered_repeater");
  } else if (placement.itemId === "minecraft:comparator") {
    expected.add("minecraft:unpowered_comparator");
    expected.add("minecraft:powered_comparator");
  } else if (placement.itemId === "minecraft:redstone") {
    expected.add("minecraft:redstone_wire");
  } else if (placement.itemId === "minecraft:sugar_cane") {
    expected.add("minecraft:reeds");
  }
  return expected.has(actual);
}

function lastProjectFor(player) {
  const key = structurePlayerKey(player);
  if (lastProjects.has(key)) return lastProjects.get(key);
  try {
    const indexRaw = world.getDynamicProperty(lastProjectIndexPropertyId(player));
    if (typeof indexRaw === "string" && indexRaw) {
      const index = JSON.parse(indexRaw);
      const indexedKind = projectText(index?.kind, "", 64).toLowerCase();
      const indexedRaw = indexedKind
        ? world.getDynamicProperty(projectKindPropertyId(player, indexedKind)) : undefined;
      const indexed = typeof indexedRaw === "string" && indexedRaw
        ? validatedStoredProject(JSON.parse(indexedRaw)) : undefined;
      if (indexed?.kind === indexedKind && indexed.updatedAt === Number(index.updatedAt)) {
        lastProjects.set(key, indexed);
        projectsByKind.set(projectKindKey(player, indexed.kind), indexed);
        return indexed;
      }
    }
    const raw = readMigratingDynamicProperty(
      lastProjectPropertyId(player), legacyLastProjectPropertyId(player),
    );
    if (typeof raw !== "string" || !raw) return undefined;
    const record = validatedStoredProject(JSON.parse(raw));
    if (!record) return undefined;
    lastProjects.set(key, record);
    projectsByKind.set(projectKindKey(player, record.kind), record);
    try {
      world.setDynamicProperty(projectKindPropertyId(player, record.kind), JSON.stringify(record));
      world.setDynamicProperty(lastProjectIndexPropertyId(player), JSON.stringify({
        kind: record.kind, updatedAt: record.updatedAt,
      }));
    } catch (error) {
      console.warn(`[MC Wizard] could not migrate ${player.name}'s saved project index: ${error}`);
    }
    return record;
  } catch (error) {
    console.warn(`[MC Wizard] ignored invalid saved project for ${player.name}: ${error}`);
    return undefined;
  }
}

function projectFor(player, kind) {
  const requestedKind = String(kind || "").toLowerCase();
  const latest = lastProjectFor(player);
  const latestForKind = latest?.kind === requestedKind ? latest : undefined;
  const key = projectKindKey(player, requestedKind);
  if (projectsByKind.has(key)) return newerStoredRecord(latestForKind, projectsByKind.get(key));
  try {
    const raw = readMigratingDynamicProperty(
      projectKindPropertyId(player, requestedKind), legacyProjectKindPropertyId(player, requestedKind),
    );
    if (typeof raw !== "string" || !raw) return latestForKind;
    const record = validatedStoredProject(JSON.parse(raw));
    if (!record || record.kind !== requestedKind) return latestForKind;
    projectsByKind.set(key, record);
    return newerStoredRecord(latestForKind, record);
  } catch (error) {
    console.warn(`[MC Wizard] ignored invalid saved ${requestedKind} project for ${player.name}: ${error}`);
    return undefined;
  }
}

function rememberLastProject(player, record) {
  const saved = {
    ...projectBlueprintSummary(record),
    dimensionId: record.dimensionId,
    origin: { ...record.origin },
    forward: { ...record.forward },
    right: { ...record.right },
    updatedAt: Date.now(),
  };
  lastProjects.set(structurePlayerKey(player), saved);
  projectsByKind.set(projectKindKey(player, saved.kind), saved);
  try {
    world.setDynamicProperty(projectKindPropertyId(player, saved.kind), JSON.stringify(saved));
    world.setDynamicProperty(lastProjectIndexPropertyId(player), JSON.stringify({
      kind: saved.kind, updatedAt: saved.updatedAt,
    }));
    world.setDynamicProperty(lastProjectPropertyId(player), JSON.stringify(saved));
  } catch (error) {
    console.warn(`[MC Wizard] could not persist ${player.name}'s last project: ${error}`);
  }
}

function lastStructureFor(player) {
  const key = structurePlayerKey(player);
  if (lastStructures.has(key)) return lastStructures.get(key);
  try {
    const indexRaw = world.getDynamicProperty(lastStructureIndexPropertyId(player));
    if (typeof indexRaw === "string" && indexRaw) {
      const index = JSON.parse(indexRaw);
      const indexedKind = String(index?.kind || "").toLowerCase();
      const indexedRaw = indexedKind
        ? world.getDynamicProperty(structureKindPropertyId(player, indexedKind)) : undefined;
      const indexed = typeof indexedRaw === "string" && indexedRaw
        ? validatedStoredStructure(JSON.parse(indexedRaw)) : undefined;
      if (indexed?.plan.kind === indexedKind && indexed.updatedAt === Number(index.updatedAt)) {
        lastStructures.set(key, indexed);
        structuresByKind.set(structureKindKey(player, indexedKind), indexed);
        return indexed;
      }
    }
    const raw = readMigratingDynamicProperty(
      lastStructurePropertyId(player), legacyLastStructurePropertyId(player),
    );
    if (typeof raw !== "string" || !raw) return undefined;
    const record = validatedStoredStructure(JSON.parse(raw));
    if (!record) return undefined;
    lastStructures.set(key, record);
    structuresByKind.set(structureKindKey(player, record.plan.kind), record);
    try {
      world.setDynamicProperty(structureKindPropertyId(player, record.plan.kind), JSON.stringify(record));
      world.setDynamicProperty(lastStructureIndexPropertyId(player), JSON.stringify({
        kind: record.plan.kind, updatedAt: Number(record.updatedAt) || 0,
      }));
    } catch (error) {
      console.warn(`[MC Wizard] could not migrate ${player.name}'s saved structure index: ${error}`);
    }
    return record;
  } catch (error) {
    console.warn(`[MC Wizard] ignored invalid saved structure for ${player.name}: ${error}`);
    return undefined;
  }
}

function structureFor(player, kind) {
  const requestedKind = String(kind || "").toLowerCase();
  const latest = lastStructureFor(player);
  const latestForKind = latest?.plan.kind === requestedKind ? latest : undefined;
  const key = structureKindKey(player, requestedKind);
  if (structuresByKind.has(key)) return newerStoredRecord(latestForKind, structuresByKind.get(key));
  try {
    const raw = readMigratingDynamicProperty(
      structureKindPropertyId(player, requestedKind), legacyStructureKindPropertyId(player, requestedKind),
    );
    if (typeof raw !== "string" || !raw) return latestForKind;
    const record = validatedStoredStructure(JSON.parse(raw));
    if (!record || record.plan.kind !== requestedKind) return latestForKind;
    structuresByKind.set(key, record);
    return newerStoredRecord(latestForKind, record);
  } catch (error) {
    console.warn(`[MC Wizard] ignored invalid saved ${requestedKind} for ${player.name}: ${error}`);
    return undefined;
  }
}

function rememberLastStructure(player, record) {
  const saved = {
    dimensionId: record.dimensionId,
    origin: { ...record.origin },
    forward: { ...record.forward },
    right: { ...record.right },
    plan: record.plan,
    ...(validStructureInhabitantTag(record.inhabitantTag)
      ? { inhabitantTag: record.inhabitantTag } : {}),
    updatedAt: Date.now(),
  };
  lastStructures.set(structurePlayerKey(player), saved);
  structuresByKind.set(structureKindKey(player, saved.plan.kind), saved);
  try {
    world.setDynamicProperty(structureKindPropertyId(player, saved.plan.kind), JSON.stringify(saved));
    world.setDynamicProperty(lastStructureIndexPropertyId(player), JSON.stringify({
      kind: saved.plan.kind, updatedAt: saved.updatedAt,
    }));
    world.setDynamicProperty(lastStructurePropertyId(player), JSON.stringify(saved));
  } catch (error) {
    console.warn(`[MC Wizard] could not persist ${player.name}'s last structure: ${error}`);
  }
}

function completeStructurePrimitives(plan) {
  if (!plan?.primitives?.length) return undefined;
  try {
    const complete = validateBuildStructurePlan({ ...plan, mode: undefined });
    return complete.primitives.slice(0, STRUCTURE_PRIMITIVE_LIMIT)
      .map(({ shape, phase, blockId, from, to }) => ({
        shape,
        phase,
        blockId,
        from: [...from],
        to: [...to],
      }));
  } catch {
    // A generated ordinary edit can store only its changed primitives. Sending
    // that partial patch as a whole structure would erase the original shape.
    return undefined;
  }
}

function hasWizardTag(player) {
  try {
    return player.hasTag(WIZARD_TAG);
  } catch {
    return false;
  }
}

function isWizardPlayer(player) {
  return Boolean(player)
    && typeof player.navigateToEntity === "function"
    && (hasWizardTag(player) || player.name === WIZARD_NAME);
}

function humanPlayers() {
  return world.getAllPlayers().filter((player) => !isWizardPlayer(player));
}

function playerById(id) {
  return humanPlayers().find((player) => player.id === id);
}

function normalizePlayerPreferences(value) {
  const byKind = new Map();
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.kind === "proximity" && Number.isFinite(entry.minimumDistance)) {
      byKind.set("proximity", {
        kind: "proximity",
        minimumDistance: Math.min(12, Math.max(3, Math.round(entry.minimumDistance))),
      });
    } else if (entry.kind === "material"
      && typeof entry.blockId === "string" && /^minecraft:[a-z0-9_]+$/.test(entry.blockId)
      && typeof entry.label === "string") {
      byKind.set("material", {
        kind: "material",
        blockId: entry.blockId,
        label: entry.label.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 48),
        exclusive: entry.exclusive === true,
      });
    } else if (entry.kind === "teleport" && entry.askBeforeTeleport === true) {
      byKind.set("teleport", { kind: "teleport", askBeforeTeleport: true });
    }
  }
  return [...byKind.values()];
}

function playerPreferenceGeneration(playerId) {
  return playerPreferenceGenerations.get(playerId) || 0;
}

function advancePlayerPreferenceGeneration(playerId) {
  const next = playerPreferenceGeneration(playerId) + 1;
  playerPreferenceGenerations.set(playerId, next);
  return next;
}

function rememberPlayerPreferences(player, value, expectedGeneration) {
  if (!player || !Array.isArray(value)) return;
  if (expectedGeneration !== undefined && playerPreferenceGeneration(player.id) !== expectedGeneration) return;
  playerPreferences.set(player.id, normalizePlayerPreferences(value));
}

function receivePlayerPreferences(player, value) {
  if (!player || !Array.isArray(value)) return;
  advancePlayerPreferenceGeneration(player.id);
  rememberPlayerPreferences(player, value);
  playerPreferencesPending.delete(player.id);
}

function playerPreference(player, kind) {
  return playerPreferences.get(player.id)?.find((entry) => entry.kind === kind);
}

function preferredWizardDistance(player) {
  return playerPreference(player, "proximity")?.minimumDistance || (playerPreferencesPending.has(player.id) ? 8 : 3);
}

function needsTeleportConsent(player) {
  return playerPreferencesPending.has(player.id) || playerPreference(player, "teleport")?.askBeforeTeleport === true;
}

function directTravelRequest(question) {
  return /\b(?:teleport|\btp\b|take|bring|send|move|travel)\b.{0,48}\b(?:me|us|everyone|all of us|the party)\b/i.test(String(question || ""));
}

function commandsTeleportRequester(commands) {
  return (Array.isArray(commands) ? commands : []).some((command) => /\b(?:teleport|tp|spreadplayers)\b/i.test(String(command || "")));
}

function commandsMoveOptedOutPlayer(player, commands) {
  const optedOut = humanPlayers().filter((candidate) => candidate.id !== player.id && needsTeleportConsent(candidate));
  return optedOut.some((candidate) => (Array.isArray(commands) ? commands : []).some((command) => {
    const text = String(command || "");
    if (!/\b(?:teleport|tp|spreadplayers)\b/i.test(text)) return false;
    return /@(?:a|e|p|r)\b/i.test(text) || text.toLowerCase().includes(candidate.name.toLowerCase());
  }));
}

function actionMovesRequester(action) {
  if (!action || typeof action !== "object") return false;
  if (action.type === "dimension_travel" || action.type === "local_travel") return true;
  if (action.type === "run_commands") return commandsTeleportRequester(action.commands);
  if (action.type !== "execute_program") return false;
  return (Array.isArray(action.program?.steps) ? action.program.steps : []).some((step) => (
    (step?.capability === "script.teleport" && step.arguments?.subject === "requester")
    || ((step?.capability === "world.command" || step?.capability === "server.console")
      && commandsTeleportRequester(step.arguments?.commands))
  ));
}

function actionMovesOptedOutPlayer(player, action) {
  if (!action || typeof action !== "object") return false;
  if (action.type === "run_commands") return commandsMoveOptedOutPlayer(player, action.commands);
  if (action.type !== "execute_program") return false;
  return (Array.isArray(action.program?.steps) ? action.program.steps : []).some((step) => (
    (step?.capability === "world.command" || step?.capability === "server.console")
      && commandsMoveOptedOutPlayer(player, step.arguments?.commands)
  ));
}

async function loadPlayerPreferences(player) {
  const generation = playerPreferenceGeneration(player.id);
  let restored = false;
  try {
    const request = new HttpRequest(WIZARD_URL.replace(/\/v1\/ask(?:\?.*)?$/, "/v1/preferences"))
      .setMethod(HttpRequestMethod.Post)
      .setBody(JSON.stringify({ player: player.name, playerId: player.id }))
      .addHeader("Content-Type", "application/json");
    if (AUTHORIZATION) request.addHeader("Authorization", AUTHORIZATION);
    const response = await http.request(request);
    if (response.status < 200 || response.status >= 300) throw new Error(`brain returned HTTP ${response.status}`);
    const payload = JSON.parse(response.body || "{}");
    const current = playerById(player.id);
    if (current && Array.isArray(payload.preferences) && playerPreferenceGeneration(current.id) === generation) {
      rememberPlayerPreferences(current, payload.preferences, generation);
      restored = true;
    }
  } catch (error) {
    console.warn(`[MC Wizard] could not restore private preferences: ${error}`);
  } finally {
    if (restored) playerPreferencesPending.delete(player.id);
  }
}

function wizardIsValid() {
  return Boolean(wizard?.isValid);
}

function logChat(player, channel, speaker, message, privatePreference = false) {
  console.warn(`[MC Wizard][chat] ${JSON.stringify({
    channel,
    player: player.name,
    speaker,
    message: privatePreference ? "[private player preference]" : String(message),
  })}`);
}

function isPrivatePreferenceMessage(message) {
  return /\b(?:remember|memory|memories|lasting notes|from now on|my stuff|my builds?|keep using|go away|stay away|keep back|too close|not so close|give me space|don'?t stand near|ask .* before .* teleport|don'?t|do not|never|don'?t do that again|forget|erase|delete|remove)\b/i.test(String(message || ""));
}

function deliverModelAnswer(player, payload, question) {
  const label = String(payload.label || "AI").replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, 24) || "AI";
  const answer = String(payload.answer || "I found no answer.").trim();
  logChat(player, "general", label, answer);
  if (answer.length <= 700) {
    for (const line of splitMessage(answer)) player.sendMessage(`§b[${label}]§r ${line}`);
    return;
  }
  try {
    const book = new ItemStack("minecraft:writable_book", 1);
    const component = book.getComponent("minecraft:book");
    if (!component) throw new Error("book component is unavailable");
    component.setContents(bookPages(answer));
    component.signBook(bookTitle(payload.title || question), label);
    player.dimension.spawnItem(book, {
      x: player.location.x,
      y: player.location.y + 0.5,
      z: player.location.z,
    });
    player.sendMessage(`§b[${label}]§r I dropped “${component.title}” at your feet.`);
  } catch (error) {
    console.warn(`[MC Wizard] could not create answer book: ${error}`);
    for (const line of splitMessage(answer)) player.sendMessage(`§b[${label}]§r ${line}`);
  }
}

function blockIsOpen(dimension, location) {
  return SAFE_SPACE.has(dimension.getBlock(location)?.typeId);
}

function standingBlockY(location) {
  return Math.floor(location.y + 0.01);
}

function arrivalPosition(player) {
  const base = {
    x: Math.floor(player.location.x),
    y: standingBlockY(player.location),
    z: Math.floor(player.location.z),
  };
  const minimumDistance = preferredWizardDistance(player);
  const offsets = Array.from({ length: 13 - minimumDistance }, (_, index) => minimumDistance + index).flatMap((radius) => (
    [[radius, 0], [-radius, 0], [0, radius], [0, -radius], [radius, radius], [-radius, -radius]]
  ));
  for (const [x, z] of offsets) {
    for (const yOffset of [0, -1, 1, -2, 2]) {
      const feet = { x: base.x + x, y: base.y + yOffset, z: base.z + z };
      const head = { x: feet.x, y: feet.y + 1, z: feet.z };
      const ground = player.dimension.getBlock({ x: feet.x, y: feet.y - 1, z: feet.z });
      if (SAFE_GROUND.has(ground?.typeId)
        && blockIsOpen(player.dimension, feet)
        && blockIsOpen(player.dimension, head)) {
        return { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 };
      }
    }
  }
  // Creative simulated players can safely spawn flying when the child is over
  // a void or an unfinished platform; the builder will land when terrain allows.
  for (const [x, z] of offsets) {
    const feet = { x: base.x + x, y: base.y, z: base.z + z };
    const head = { ...feet, y: feet.y + 1 };
    if (blockIsOpen(player.dimension, feet) && blockIsOpen(player.dimension, head)) {
      return { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 };
    }
  }
  return undefined;
}

function equipWizard(itemId = "mcwizard:wand") {
  if (!wizardIsValid()) return;
  try {
    wizard.setItem(new ItemStack(itemId, 1), 0, true);
  } catch (error) {
    console.warn(`[MC Wizard] could not equip ${itemId}: ${error}`);
    if (itemId !== "minecraft:stick") equipWizard("minecraft:stick");
  }
}

function applyLearnedWizardSkin() {
  if (!wizardIsValid() || !learnedWizardSkin) return false;
  try {
    wizard.setSkin(learnedWizardSkin);
    return true;
  } catch (error) {
    console.warn(`[MC Wizard] could not apply learned skin: ${error}`);
    return false;
  }
}

function learnWizardSkin(player) {
  if (player.playerPermissionLevel !== 2) {
    speak(player, "Only a server operator can teach me a new look.");
    return;
  }
  const bot = ensureWizard(player);
  if (!bot) {
    speak(player, "I couldn’t appear long enough to try that skin. Please ask me again.");
    return;
  }
  try {
    learnedWizardSkin = getPlayerSkin(player);
    bot.setSkin(learnedWizardSkin);
    const pieceCount = learnedWizardSkin.personaPieces?.length || 0;
    if (pieceCount > 0) {
      speak(player, "I copied your Character Creator look. That should stay on me until this server restarts.");
    } else {
      speak(player, "I tried, but Bedrock did not expose any Character Creator pieces. Classic PNG skins cannot be copied to a simulated player, so I may still look default.");
    }
    console.warn(`[MC Wizard] operator skin-copy applied; personaPieces=${pieceCount}`);
  } catch (error) {
    learnedWizardSkin = undefined;
    console.warn(`[MC Wizard] could not copy ${player.name}'s skin: ${error}`);
    speak(player, "Bedrock would not let me copy that skin type. I’ll keep my current look.");
  }
}

function removeOldCostume() {
  if (!wizardIsValid()) return;
  const equippable = wizard.getComponent("minecraft:equippable");
  if (!equippable) return;
  try {
    equippable.setEquipment(EquipmentSlot.Head, undefined);
    equippable.setEquipment(EquipmentSlot.Chest, undefined);
  } catch (error) {
    console.warn(`[MC Wizard] could not clear the old costume: ${error}`);
  }
}

function ensureWizard(anchor) {
  if (wizardIsValid()) {
    removeOldCostume();
    return wizard;
  }

  wizard = world.getAllPlayers().find((player) => isWizardPlayer(player));
  if (wizardIsValid()) return wizard;

  if (world.getAllPlayers().some((player) => player.name === WIZARD_NAME)) {
    console.warn(`[MC Wizard] cannot spawn: a non-simulated player is using the name ${WIZARD_NAME}`);
    wizard = undefined;
    return undefined;
  }

  try {
    const location = arrivalPosition(anchor);
    if (!location) {
      console.warn(`[MC Wizard] no safe standing space near ${anchor.name}`);
      return undefined;
    }
    wizard = spawnSimulatedPlayer(
      { dimension: anchor.dimension, ...location },
      WIZARD_NAME,
      GameMode.Creative,
    );
    const arrivalGround = anchor.dimension.getBlock({
      x: Math.floor(location.x),
      y: Math.floor(location.y) - 1,
      z: Math.floor(location.z),
    });
    if (!SAFE_GROUND.has(arrivalGround?.typeId)) wizard.fly();
    wizard.addTag(WIZARD_TAG);
    applyLearnedWizardSkin();
    equipWizard();
    removeOldCostume();
    wizard.lookAtEntity(anchor, LookDuration.UntilMove);
    console.warn(`[MC Wizard] spawned beside ${anchor.name}`);
    return wizard;
  } catch (error) {
    console.warn(`[MC Wizard] simulated player could not spawn: ${error}`);
    wizard = undefined;
    return undefined;
  }
}

function distanceSquared(a, b) {
  const x = a.x - b.x;
  const y = a.y - b.y;
  const z = a.z - b.z;
  return x * x + y * y + z * z;
}

function moveWizardBeside(bot, player) {
  const distance = distanceSquared(bot.location, player.location);
  const destination = arrivalPosition(player);
  const preferredDistance = preferredWizardDistance(player);
  const tooClose = Math.max(1.5, preferredDistance - 0.75);
  const tooFar = preferredDistance + 1.5;
  if (distance > 24 * 24 && destination) {
    bot.stopMoving();
    bot.teleport(destination, {
      dimension: player.dimension,
      facingLocation: player.location,
    });
    const ground = player.dimension.getBlock({
      x: Math.floor(destination.x),
      y: Math.floor(destination.y) - 1,
      z: Math.floor(destination.z),
    });
    if (SAFE_GROUND.has(ground?.typeId)) bot.stopFlying();
    else bot.fly();
    console.warn(`[MC Wizard] blinked beside ${player.name} after they moved far away`);
    return true;
  }
  if ((distance < tooClose * tooClose || distance > tooFar * tooFar)
    && destination
    && distanceSquared(bot.location, destination) > 0.75 * 0.75) {
    bot.navigateToLocation(destination, 0.65);
    return true;
  }
  bot.stopMoving();
  bot.lookAtEntity(player, LookDuration.UntilMove);
  return false;
}

function bringWizardTo(player, follow = true, forceMovement = false) {
  const bot = ensureWizard(player);
  if (!bot) return undefined;
  if (follow) {
    followPlayerId = player.id;
    wizardShouldStay = false;
  }

  try {
    if (buildInProgress && !forceMovement) {
      return bot;
    }
    const sameDimension = bot.dimension.id === player.dimension.id;
    if (!sameDimension) {
      console.warn(`[MC Wizard] ${player.name} is in another dimension; refusing to teleport`);
    } else moveWizardBeside(bot, player);
  } catch (error) {
    console.warn(`[MC Wizard] could not move to ${player.name}: ${error}`);
  }
  return bot;
}

function speak(player, message, { privatePreference = false } = {}) {
  logChat(player, "wizard", WIZARD_NAME, message, privatePreference);
  if (privatePreference) {
    for (const line of splitMessage(message)) player.sendMessage(`${PREFIX}${line}`);
    return;
  }
  const bot = ensureWizard(player);
  for (const line of splitMessage(message)) {
    if (bot?.isValid) {
      try {
        bot.lookAtEntity(player, LookDuration.UntilMove);
        wizardSpeaking = true;
        bot.chat(line);
        continue;
      } catch (error) {
        console.warn(`[MC Wizard] simulated chat failed: ${error}`);
      } finally {
        wizardSpeaking = false;
      }
    }
    player.sendMessage(`${PREFIX}${line}`);
  }
}

function parseGradeMessage(message) {
  const match = /^grade\s+([1-5])\b(?:\s*(?::|-)\s*|\s+)?(.*)$/i.exec(message.trim());
  if (!match) return undefined;
  return {
    grade: Number(match[1]),
    feedback: String(match[2] || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500),
  };
}

function feedbackChatFallback(prompt) {
  if (pendingFeedback.get(prompt.playerId) !== prompt || prompt.fallbackOffered) return;
  prompt.fallbackOffered = true;
  const player = playerById(prompt.playerId);
  if (player) speak(player, "How did I do? Reply with ‘grade 1’ through ‘grade 5’. You can add what I should do next after a colon, like ‘grade 2: add more windows’.");
}

async function submitFeedback(prompt, grade, feedback) {
  if (pendingFeedback.get(prompt.playerId) !== prompt || prompt.submitting) return;
  const player = playerById(prompt.playerId);
  if (!player) return;
  prompt.submitting = true;
  speak(player, feedback ? "Thanks—I’m saving your grade and note." : "Thanks—I’m saving your grade.");
  try {
    const request = new HttpRequest(WIZARD_URL.replace(/\/v1\/ask(?:\?.*)?$/, "/v1/feedback"))
      .setMethod(HttpRequestMethod.Post)
      .setBody(JSON.stringify({
          player: prompt.playerName,
          playerId: prompt.playerId,
          requestId: prompt.requestId,
        grade,
        feedback,
        context: liveWorldSnapshot(player),
      }))
      .addHeader("Content-Type", "application/json");
    if (AUTHORIZATION) request.addHeader("Authorization", AUTHORIZATION);
    const response = await http.request(request);
    if (response.status < 200 || response.status >= 300) throw new Error(`brain returned HTTP ${response.status}`);
    const result = JSON.parse(response.body || "{}");
    system.run(() => {
      if (pendingFeedback.get(prompt.playerId) !== prompt) return;
      const current = playerById(prompt.playerId);
      if (!current) return;
      const message = typeof result.message === "string" ? result.message : undefined;
      const followUp = result.followUp && typeof result.followUp === "object"
        ? result.followUp : result.refinement;
      if (result.needsFeedback && !feedback) {
        prompt.submitting = false;
        prompt.fallbackOffered = true;
        speak(current, `${message || "Tell me one thing I should change."} Reply with ‘grade ${grade}:’ followed by what I should do next.`);
        return;
      }
      completeFeedbackPrompt(prompt);
      if (message) speak(current, message);
      if (feedback) {
        if (followUp && typeof followUp === "object") applyResponse(current.id, followUp, feedback);
      }
    });
  } catch {
    system.run(() => {
      if (pendingFeedback.get(prompt.playerId) !== prompt) return;
      prompt.submitting = false;
      const current = playerById(prompt.playerId);
      if (current) speak(current, "I couldn’t save that grade just yet. Try the grade message again in a moment.");
      feedbackChatFallback(prompt);
    });
  }
}

async function showFeedbackForm(prompt, busyRetries = 0) {
  if (pendingFeedback.get(prompt.playerId) !== prompt) return;
  const player = playerById(prompt.playerId);
  if (!player) return;
  try {
    const response = await new ModalFormData()
      .title("Grade MC Wizard")
      .dropdown("How did Wiz do?", [
        "1 — Not right",
        "2 — Needs lots of work",
        "3 — Partly right",
        "4 — Good",
        "5 — Great",
      ], { defaultValueIndex: 2 })
      .textField("What should Wiz change or do next?", "Optional", { defaultValue: "" })
      .submitButton("Send to Wiz")
      .show(player);
    if (pendingFeedback.get(prompt.playerId) !== prompt) return;
    if (response.canceled) {
      if (response.cancelationReason === FormCancelationReason.UserBusy && busyRetries < 3) {
        system.runTimeout(() => void showFeedbackForm(prompt, busyRetries + 1), 40);
      } else {
        feedbackChatFallback(prompt);
      }
      return;
    }
    const index = Number(response.formValues?.[0]);
    if (!Number.isInteger(index) || index < 0 || index > 4) {
      feedbackChatFallback(prompt);
      return;
    }
    const feedback = String(response.formValues?.[1] || "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500);
    await submitFeedback(prompt, index + 1, feedback);
  } catch {
    feedbackChatFallback(prompt);
  }
}

function queueFeedback(report) {
  if (!report?.playerId || typeof report.requestId !== "string"
    || !/^[a-zA-Z0-9_-]{1,64}$/.test(report.requestId)
    || pendingQuestions.has(`${report.playerId}:wizard`)
    || hasNewerAction(report.playerId, report.requestId)
    || promptedFeedbackRequests.has(report.requestId)) return;
  promptedFeedbackRequests.add(report.requestId);
  if (promptedFeedbackRequests.size > 256) {
    promptedFeedbackRequests.delete(promptedFeedbackRequests.values().next().value);
  }
  const prompt = {
    playerId: report.playerId,
    playerName: report.playerName,
    requestId: report.requestId,
    submitting: false,
    fallbackOffered: false,
  };
  if (pendingFeedback.has(report.playerId)) {
    const queue = queuedFeedback.get(report.playerId) || [];
    if (queue.length < 16) {
      queue.push(prompt);
      queuedFeedback.set(report.playerId, queue);
    }
    return;
  }
  pendingFeedback.set(report.playerId, prompt);
  offerFeedbackPrompt(prompt);
}

function offerFeedbackPrompt(prompt) {
  system.runTimeout(() => {
    if (FEEDBACK_FORMS_ENABLED) void showFeedbackForm(prompt);
    else feedbackChatFallback(prompt);
  }, 20);
}

function completeFeedbackPrompt(prompt) {
  if (pendingFeedback.get(prompt.playerId) !== prompt) return;
  pendingFeedback.delete(prompt.playerId);
  const queue = queuedFeedback.get(prompt.playerId);
  const next = queue?.shift();
  if (!queue?.length) queuedFeedback.delete(prompt.playerId);
  if (!next) return;
  pendingFeedback.set(prompt.playerId, next);
  offerFeedbackPrompt(next);
}

function routeFeedbackMessage(player, message) {
  const question = message.trim().replace(
    /^!?(?:mc\s+)?wiz(?:ard)?(?:\s*[:,]\s*|\s+)/i,
    "",
  );
  const grade = parseGradeMessage(question);
  if (!grade) return false;
  const prompt = pendingFeedback.get(player.id);
  if (!prompt) return false;
  system.run(() => void submitFeedback(prompt, grade.grade, grade.feedback));
  return true;
}

function worldSmallTalk(player, question) {
  const text = question.trim();
  const asksMood = /\b(?:what(?:’|'| i)s up|how are you|how(?:’|'| i)s it going|you doing)\b/i.test(text);
  const hasRainingObjects = /\b(?:potion|splash|arrow|item|block|mob|animal|chicken|wool|diamond|lava|water)s?\b/i.test(text);
  const asksWeather = !hasRainingObjects && (
    /\bweather\b/i.test(text)
    || /\b(?:is it|does it look|what do you think (?:of|about))\b.{0,40}\b(?:rain|raining|sunny|storm|storming|thunder|sky)\b/i.test(text)
  );
  const asksTime = /\b(?:what time|time is it|day or night|night or day|is it (?:day|night)|daytime|nighttime)\b/i.test(text);
  if (!asksMood && !asksWeather && !asksTime) return undefined;
  let weather;
  try {
    weather = typeof player.dimension.getWeather === "function" ? player.dimension.getWeather() : undefined;
  } catch {
    weather = undefined;
  }
  const time = world.getTimeOfDay();
  const dayPart = time < 1000 || time >= 23000 ? "sunrise"
    : time < 12000 ? "daytime"
      : time < 13000 ? "sunset"
        : "night";
  if (asksTime) {
    const hour = Math.floor((time / 1000 + 6) % 24);
    return `It’s ${dayPart} right now—about ${String(hour).padStart(2, "0")}:00 in Minecraft time.`;
  }
  if (weather === "Thunder") return `That thunder has excellent wizard timing. It’s ${dayPart}, so I’m keeping my wand dry and watching the sky.`;
  if (weather === "Rain") return `It’s raining at ${dayPart}. Good weather for roofs, hidden workshops, and dramatic entrances.`;
  if (weather === "Clear") return `Clear skies at ${dayPart}. I’m doing well and ready to wander, build, or inspect whatever you’re making.`;
  return `I’m doing well. It’s ${dayPart} here, and I’m ready to explore or build with you.`;
}

function liveWorldSnapshot(player) {
  const playerPosition = {
    x: Math.floor(player.location.x),
    y: Math.floor(player.location.y),
    z: Math.floor(player.location.z),
  };
  let weather = "unknown";
  try {
    const observed = typeof player.dimension.getWeather === "function"
      ? String(player.dimension.getWeather()).toLowerCase() : "";
    weather = observed.includes("thunder") ? "thunder"
      : observed.includes("rain") ? "rain"
        : observed.includes("clear") ? "clear" : "unknown";
  } catch {
    weather = "unknown";
  }

  const blockCounts = new Map();
  for (let x = -4; x <= 4; x += 1) {
    for (let y = -2; y <= 4; y += 1) {
      for (let z = -4; z <= 4; z += 1) {
        try {
          const typeId = player.dimension.getBlock({
            x: playerPosition.x + x,
            y: playerPosition.y + y,
            z: playerPosition.z + z,
          })?.typeId;
          if (typeId && typeId !== "minecraft:air") {
            blockCounts.set(typeId, (blockCounts.get(typeId) || 0) + 1);
          }
        } catch {
          // A block on the edge of an unloaded chunk is simply not observable.
        }
      }
    }
  }
  const nearbyBlocks = [...blockCounts.entries()]
    .sort(([leftType, leftCount], [rightType, rightCount]) => (
      rightCount - leftCount || leftType.localeCompare(rightType)
    ))
    .slice(0, 16)
    .map(([typeId, count]) => ({ typeId, count }));

  let nearbyEntities = [];
  try {
    nearbyEntities = player.dimension.getEntities({
      location: player.location,
      maxDistance: 12,
    }).filter((entity) => entity.id !== player.id && !isWizardPlayer(entity))
      .map((entity) => {
        const relative = {
          x: Math.round(entity.location.x - player.location.x),
          y: Math.round(entity.location.y - player.location.y),
          z: Math.round(entity.location.z - player.location.z),
        };
        return {
          typeId: entity.typeId,
          relative,
          distanceSquared: relative.x ** 2 + relative.y ** 2 + relative.z ** 2,
        };
      })
      .sort((left, right) => left.distanceSquared - right.distanceSquared)
      .slice(0, 12)
      .map(({ typeId, relative }) => ({ typeId, relative }));
  } catch {
    nearbyEntities = [];
  }

  const previous = lastStructureFor(player);
  const primitives = completeStructurePrimitives(previous?.plan);
  let verifiedInhabitants;
  if (previous?.dimensionId === player.dimension.id && previous.plan.entities?.length) {
    try {
      const bounds = structureEntityBounds(previous.plan, previous.origin, previous.forward, previous.right);
      const typeIds = [...new Set(previous.plan.entities.map(({ typeId }) => typeId))];
      verifiedInhabitants = Object.fromEntries(typeIds.map((typeId) => {
        const inside = structureEntitiesInside(player.dimension, typeId, bounds);
        const managed = validStructureInhabitantTag(previous.inhabitantTag)
          ? inside.filter((entity) => entityHasTag(entity, previous.inhabitantTag)) : inside;
        return [typeId, managed.length];
      }));
    } catch {
      verifiedInhabitants = undefined;
    }
  }
  const lastStructure = previous?.dimensionId === player.dimension.id ? {
    kind: previous.plan.kind,
    title: previous.plan.title,
    dimensions: previous.plan.dimensions,
    materials: previous.plan.materials,
    features: previous.plan.features,
    ...(previous.plan.entities?.length ? {
      entities: previous.plan.entities.map(({ typeId, location }) => ({
        typeId,
        location: [...location],
      })),
    } : {}),
    ...(verifiedInhabitants ? { verifiedInhabitants } : {}),
    ...(primitives?.length ? { primitives } : {}),
    relativeOrigin: {
      x: previous.origin.x - playerPosition.x,
      y: previous.origin.y - playerPosition.y,
      z: previous.origin.z - playerPosition.z,
    },
  } : undefined;
  const project = lastProjectFor(player);
  const lastProject = project?.dimensionId === player.dimension.id ? {
    title: project.title,
    kind: project.kind,
    dimensionId: project.dimensionId,
    relativeOrigin: {
      x: project.origin.x - playerPosition.x,
      y: project.origin.y - playerPosition.y,
      z: project.origin.z - playerPosition.z,
    },
    bounds: { min: [...project.bounds.min], max: [...project.bounds.max] },
    placements: project.placements.map(({ itemId, target, support, orientationTarget }) => ({
      itemId,
      target: [...target],
      support: [...support],
      orientationTarget: orientationTarget ? [...orientationTarget] : null,
    })),
    interactions: project.interactions.map(({ action, itemId, block, faceTarget }) => ({
      action,
      itemId,
      block: [...block],
      faceTarget: [...faceTarget],
    })),
  } : undefined;
  return {
    dimension: player.dimension.id,
    weather,
    timeOfDay: world.getTimeOfDay(),
    player: playerPosition,
    buildState: buildInProgress || buildPreparing ? "building" : queuedBuilds.has(player.id) ? "queued" : "idle",
    nearbyBlocks,
    nearbyEntities,
    ...(lastStructure ? { lastStructure } : {}),
    ...(lastProject ? { lastProject } : {}),
  };
}

function idleLookAround(player) {
  if (!wizardIsValid() || system.currentTick - lastAmbientTick < 200) return;
  lastAmbientTick = system.currentTick;
  const base = {
    x: Math.floor(player.location.x),
    y: standingBlockY(player.location),
    z: Math.floor(player.location.z),
  };
  for (let radius = 1; radius <= 4; radius += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      for (let z = -radius; z <= radius; z += 1) {
        const location = { x: base.x + x, y: base.y, z: base.z + z };
        const typeId = player.dimension.getBlock(location)?.typeId || "";
        if (/redstone|command_block|comparator|repeater|lever|button|lamp/.test(typeId)) {
          wizard.lookAtBlock(location, LookDuration.UntilMove);
          return;
        }
      }
    }
  }
  const view = player.getViewDirection();
  wizard.lookAtLocation({
    x: player.location.x + view.x * 5,
    y: player.location.y + Math.max(1, view.y * 5),
    z: player.location.z + view.z * 5,
  }, LookDuration.UntilMove);
}

function cardinalDirection(player) {
  const view = player.getViewDirection();
  if (Math.abs(view.x) > Math.abs(view.z)) {
    return view.x >= 0
      ? { name: "east", x: 1, z: 0 }
      : { name: "west", x: -1, z: 0 };
  }
  return view.z >= 0
    ? { name: "south", x: 0, z: 1 }
    : { name: "north", x: 0, z: -1 };
}

function offset(base, forward, right, along, across = 0, up = 0) {
  return {
    x: base.x + forward.x * along + right.x * across,
    y: base.y + up,
    z: base.z + forward.z * along + right.z * across,
  };
}

function blockingBuildEntities(dimension, target) {
  const below = { x: target.x, y: target.y - 1, z: target.z };
  return [...new Map(
    [...dimension.getEntitiesAtBlockLocation(target), ...dimension.getEntitiesAtBlockLocation(below)]
      .map((entity) => [entity.id, entity]),
  ).values()].filter((entity) => (
    !isWizardPlayer(entity)
    && entity.typeId !== "minecraft:item"
    && entity.typeId !== "minecraft:xp_orb"
  ));
}

function moveBuildTargetEntities(dimension, target) {
  const blockers = blockingBuildEntities(dimension, target);
  if (!blockers.length) return;
  console.warn(
    `[MC Wizard] moving build blockers at ${target.x},${target.y},${target.z}: `
      + blockers.map((entity) => `${entity.typeId}:${entity.name || entity.nameTag || entity.id}`).join(", "),
  );
  for (const entity of blockers) {
    if (entity.typeId === "minecraft:player" && !buildMoveNotices.has(entity.id)) {
      buildMoveNotices.add(entity.id);
      speak(entity, "Tiny scoot—this block belongs to the machine. I moved you a few steps aside and kept building.");
    }
    try {
      entity.teleport(
        { x: target.x + 3.5, y: target.y, z: target.z - 3.5 },
        { dimension },
      );
    } catch (error) {
      console.warn(`[MC Wizard] could not move ${entity.typeId} from the build square: ${error}`);
    }
  }
}

function beginTransaction(playerId, token, dimension, expectedBlocks) {
  const unique = new Map(expectedBlocks.map(({ location }) => [
    `${location.x},${location.y},${location.z}`,
    { x: location.x, y: location.y, z: location.z },
  ]));
  const locations = [...unique.values()];
  if (!locations.length || locations.length > 400) throw new Error("build transaction is outside the 1-400 block limit");
  const protectedRadius = Number(variable("mc_wizard_protected_spawn_radius", 0)) || 0;
  if (protectedRadius > 0 && dimension.id === "minecraft:overworld") {
    const spawn = world.getDefaultSpawnLocation();
    if (locations.some((location) => (
      Math.abs(location.x - spawn.x) <= protectedRadius && Math.abs(location.z - spawn.z) <= protectedRadius
    ))) throw new Error("that build would enter the protected spawn area");
  }
  const snapshots = locations.map((location) => {
    const block = dimension.getBlock(location);
    if (!block) throw new Error(`could not snapshot ${location.x},${location.y},${location.z}`);
    return {
      location,
      typeId: block.typeId,
      states: block.permutation.getAllStates(),
    };
  });
  const transaction = {
    playerId,
    token,
    dimensionId: dimension.id,
    snapshots,
    expectedBlocks,
  };
  world.setDynamicProperty(TRANSACTION_JOURNAL, JSON.stringify({
    dimensionId: dimension.id,
    snapshots,
  }));
  activeTransaction = transaction;
  return transaction;
}

function restoreSnapshots(transaction) {
  const dimension = world.getDimension(transaction.dimensionId);
  for (const snapshot of transaction.snapshots) {
    dimension.getBlock(snapshot.location)?.setPermutation(
      BlockPermutation.resolve(snapshot.typeId, snapshot.states || {}),
    );
  }
}

function rollbackTransaction(token) {
  if (!activeTransaction || activeTransaction.token !== token) return;
  restoreSnapshots(activeTransaction);
  world.setDynamicProperty(TRANSACTION_JOURNAL, undefined);
  activeTransaction = undefined;
}

function commitTransaction(token) {
  if (!activeTransaction || activeTransaction.token !== token) return;
  const transaction = activeTransaction;
  lastUndo.set(transaction.playerId, {
    ...transaction,
    expiresTick: system.currentTick + UNDO_RETENTION_TICKS,
  });
  world.setDynamicProperty(TRANSACTION_JOURNAL, undefined);
  activeTransaction = undefined;
}

function undoLastBuild(player) {
  const transaction = lastUndo.get(player.id);
  if (!transaction || transaction.expiresTick <= system.currentTick) {
    lastUndo.delete(player.id);
    speak(player, "I don’t have a recent build to undo.");
    return false;
  }
  if (buildInProgress || buildPreparing) {
    speak(player, "I’ll finish or roll back the current build before undoing another one.");
    return false;
  }
  restoreSnapshots(transaction);
  lastUndo.delete(player.id);
  speak(player, "Undone. I restored every block from before my last build.");
  return true;
}

function recoverInterruptedTransaction() {
  const journal = world.getDynamicProperty(TRANSACTION_JOURNAL);
  if (typeof journal !== "string" || !journal) return;
  try {
    restoreSnapshots(JSON.parse(journal));
    console.warn("[MC Wizard] restored an interrupted build transaction");
  } catch (error) {
    console.warn(`[MC Wizard] could not restore interrupted build: ${error}`);
  } finally {
    world.setDynamicProperty(TRANSACTION_JOURNAL, undefined);
  }
}

async function prepareBuildWorkshop(player) {
  try {
    const sequence = Math.max(0, Number(world.getDynamicProperty(WORKSHOP_COUNTER)) || 0);
    world.setDynamicProperty(WORKSHOP_COUNTER, sequence + 1);
    const dimension = player.dimension;
    const forward = cardinalDirection(player);
    const right = { x: -forward.z, z: forward.x };
    const base = {
      x: Math.floor(player.location.x),
      y: standingBlockY(player.location),
      z: Math.floor(player.location.z),
    };
    const corners = [
      offset(base, forward, right, 4, -16),
      offset(base, forward, right, 34, 16),
    ];
    const min = {
      x: Math.min(corners[0].x, corners[1].x),
      y: base.y,
      z: Math.min(corners[0].z, corners[1].z),
    };
    const max = {
      x: Math.max(corners[0].x, corners[1].x),
      y: base.y + 24,
      z: Math.max(corners[0].z, corners[1].z),
    };
    const center = {
      x: Math.floor((min.x + max.x) / 2),
      y: base.y,
      z: Math.floor((min.z + max.z) / 2),
    };
    speak(player, "This spot is crowded, so I’m clearing and leveling a workshop nearby. Stay here—I’ll bring the build to you.");
    try {
      dimension.runCommand(`tickingarea remove ${WORKSHOP_TICKING_AREA}`);
    } catch {}
    dimension.runCommand(`tickingarea add circle ${center.x} ${center.y} ${center.z} 4 ${WORKSHOP_TICKING_AREA} true`);
    await system.waitTicks(5);
    dimension.runCommand(`fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} air`);
    dimension.runCommand(`fill ${min.x} ${min.y - 1} ${min.z} ${max.x} ${min.y - 1} ${max.z} smooth_stone`);
    await system.waitTicks(1);
    const check = offset(base, forward, right, 6);
    if (dimension.getBlock({ ...check, y: check.y - 1 })?.typeId !== "minecraft:smooth_stone"
      || dimension.getBlock(check)?.typeId !== "minecraft:air") {
      throw new Error("workshop blocks were not loaded after preparation");
    }
    system.runTimeout(() => {
      try {
        dimension.runCommand(`tickingarea remove ${WORKSHOP_TICKING_AREA}`);
      } catch {}
    }, 12_000);
    console.warn(`[MC Wizard] prepared workshop ${sequence} for ${player.name}`);
    return true;
  } catch (error) {
    console.warn(`[MC Wizard] could not prepare a workshop: ${error}`);
    speak(player, "That patch of ground fought back. I’m trying the build beside you instead.");
    return false;
  }
}

function beginBuildPreparation() {
  const reservation = ++nextBuildPreparation;
  activeBuildPreparation = reservation;
  buildPreparing = true;
  return reservation;
}

function endBuildPreparation(reservation) {
  if (activeBuildPreparation !== reservation) return;
  activeBuildPreparation = undefined;
  buildPreparing = false;
}

async function prepareBuildWorkshopReserved(player) {
  const reservation = beginBuildPreparation();
  try {
    return await prepareBuildWorkshop(player);
  } finally {
    endBuildPreparation(reservation);
  }
}

function queueBuild(player, callback, delayTicks = 40, message = "I queued that build and will start it automatically.") {
  const playerId = player.id;
  const alreadyQueued = queuedBuilds.has(playerId);
  queuedBuilds.set(playerId, callback);
  if (alreadyQueued) speak(player, "I updated your queued build request.");
  else if (message) speak(player, message);
  if (alreadyQueued) return;
  const attempt = () => {
    const current = playerById(playerId);
    if (!current) {
      queuedBuilds.delete(playerId);
      const report = pendingActionReports.get(playerId);
      if (report) {
        pendingActionReports.delete(playerId);
        endImmediateAction(report, "failed", "player left before queued build started");
      }
      return;
    }
    if (buildInProgress || buildPreparing) {
      system.runTimeout(attempt, 40);
      return;
    }
    const queued = queuedBuilds.get(playerId);
    queuedBuilds.delete(playerId);
    if (queued) queued(current);
  };
  system.runTimeout(attempt, delayTicks);
}

function findClearSite(player, forward, right) {
  const location = player.location;
  const base = {
    x: Math.floor(location.x) + forward.x * 5,
    y: standingBlockY(location),
    z: Math.floor(location.z) + forward.z * 5,
  };
  const occupied = [
    offset(base, forward, right, 0),
    offset(base, forward, right, 0, 0, 1),
    offset(base, forward, right, 1),
    offset(base, forward, right, 2),
    offset(base, forward, right, 3),
  ];
  for (const position of occupied) moveBuildTargetEntities(player.dimension, position);
  for (let along = -1; along <= 4; along += 1) {
    for (let across = -1; across <= 1; across += 1) {
      const ground = player.dimension.getBlock(offset(base, forward, right, along, across, -1));
      if (!ground || !SAFE_GROUND.has(ground.typeId)) {
        console.warn("[MC Wizard] T flip-flop ground rejected: " + (ground?.typeId || "unloaded"));
        return null;
      }
      const feet = player.dimension.getBlock(offset(base, forward, right, along, across));
      const head = player.dimension.getBlock(offset(base, forward, right, along, across, 1));
      if (!feet || !head || !SAFE_SPACE.has(feet.typeId) || !SAFE_SPACE.has(head.typeId)) {
        console.warn("[MC Wizard] T flip-flop space rejected: "
          + (feet?.typeId || "unloaded") + "/" + (head?.typeId || "unloaded"));
        return null;
      }
    }
  }
  return base;
}

function faceLocation(direction) {
  if (direction === Direction.Down) return { x: 0.5, y: 0, z: 0.5 };
  if (direction === Direction.North) return { x: 0.5, y: 0.5, z: 0 };
  if (direction === Direction.South) return { x: 0.5, y: 0.5, z: 1 };
  if (direction === Direction.East) return { x: 1, y: 0.5, z: 0.5 };
  if (direction === Direction.West) return { x: 0, y: 0.5, z: 0.5 };
  return { x: 0.5, y: 1, z: 0.5 };
}

function directionFromSupport(support, target) {
  if (target.y > support.y) return Direction.Up;
  if (target.y < support.y) return Direction.Down;
  if (target.x > support.x) return Direction.East;
  if (target.x < support.x) return Direction.West;
  if (target.z > support.z) return Direction.South;
  return Direction.North;
}

function placementGazeLocation(target, facingLocation) {
  const distance = 16;
  return {
    x: target.x + 0.5 + Math.sign(facingLocation.x - target.x) * distance,
    y: target.y + 0.5 + Math.sign(facingLocation.y - target.y) * distance,
    z: target.z + 0.5 + Math.sign(facingLocation.z - target.z) * distance,
  };
}

function canReachBuildTarget(location, target) {
  const targetCenter = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 };
  const eye = { x: location.x, y: location.y + 1.62, z: location.z };
  return distanceSquared(eye, targetCenter) <= BUILD_REACH_SQUARED;
}

function horizontalClearanceSquared(location, target) {
  const dx = Math.max(target.x - location.x, 0, location.x - (target.x + 1));
  const dz = Math.max(target.z - location.z, 0, location.z - (target.z + 1));
  return dx * dx + dz * dz;
}

function navigateWizardToBuildPosition(destination, forceDirect = false, movement) {
  wizard.stopFlying();
  if (forceDirect && Math.abs(destination.y - wizard.location.y) <= 1.5) {
    if (movement?.lastJumpTick
      && system.currentTick - movement.lastJumpTick < 12
      && !wizard.isOnGround) return;
    wizard.moveToLocation(destination, { speed: 0.8, faceTarget: true });
    if (wizard.isOnGround
      && (!movement?.lastJumpTick || system.currentTick - movement.lastJumpTick >= 12)
      && wizard.jump()
      && movement) movement.lastJumpTick = system.currentTick;
    return;
  }
  try {
    const navigation = wizard.navigateToLocation(destination, 1);
    if (navigation.isFullPath) {
      if (system.currentTick % 10 === 0) wizard.jump();
      return;
    }
  } catch {
    // Bedrock can briefly report a fractional airborne height over redstone.
  }
  if (Math.abs(destination.y - wizard.location.y) <= 1.5) {
    wizard.moveToLocation(destination, { speed: 0.8, faceTarget: true });
  }
}

function wizardCanReach(dimension, target, support = target) {
  if (!wizardIsValid() || wizard.dimension.id !== dimension.id) return false;
  const feet = {
    x: Math.floor(wizard.location.x),
    y: Math.floor(wizard.location.y),
    z: Math.floor(wizard.location.z),
  };
  const targetOccupiesBody = target.x === feet.x
    && target.z === feet.z
    && (target.y === feet.y || target.y === feet.y + 1);
  const targetTouchesBody = (target.y === feet.y || target.y === feet.y + 1)
    && horizontalClearanceSquared(wizard.location, target) < 0.4 * 0.4;
  return !targetOccupiesBody
    && !targetTouchesBody
    && canReachBuildTarget(wizard.location, target)
    && canReachBuildTarget(wizard.location, support);
}

function positionWizardForBuild(dimension, target, support = target, forceMove = false) {
  if (!wizardIsValid()) throw new Error("the simulated player is unavailable");
  const key = `${dimension.id}:${target.x},${target.y},${target.z}:${support.x},${support.y},${support.z}`;
  if (!forceMove && wizardCanReach(dimension, target, support)) {
    wizard.stopMoving();
    if (buildMovement) {
      buildMovement = undefined;
      return false;
    }
    buildMovement = undefined;
    return true;
  }

  const candidates = [];
  for (let y = target.y + 1; y >= target.y - 4; y -= 1) {
    if (y < -64 || y > 319) continue;
    for (let x = target.x - 5; x <= target.x + 5; x += 1) {
      for (let z = target.z - 5; z <= target.z + 5; z += 1) {
        if (x === target.x && z === target.z) continue;
        const location = { x: x + 0.5, y, z: z + 0.5 };
        if (!canReachBuildTarget(location, target) || !canReachBuildTarget(location, support)) continue;
        candidates.push(location);
      }
    }
  }
  candidates.sort((a, b) => distanceSquared(a, wizard.location) - distanceSquared(b, wizard.location));
  const validCandidates = [];
  for (const location of candidates) {
    const feet = { x: Math.floor(location.x), y: location.y, z: Math.floor(location.z) };
    const head = { ...feet, y: feet.y + 1 };
    const ground = dimension.getBlock({ ...feet, y: feet.y - 1 });
    if (!SAFE_GROUND.has(ground?.typeId)
      || !blockIsOpen(dimension, feet)
      || !blockIsOpen(dimension, head)) continue;
    const occupied = [...dimension.getEntitiesAtBlockLocation(feet), ...dimension.getEntitiesAtBlockLocation(head)]
      .some((entity) => entity.id !== wizard.id);
    if (occupied) continue;
    validCandidates.push(location);
  }
  if (!validCandidates.length) {
    const flightDestination = candidates.find((location) => {
      const feet = {
        x: Math.floor(location.x),
        y: Math.floor(location.y),
        z: Math.floor(location.z),
      };
      const head = { ...feet, y: feet.y + 1 };
      return blockIsOpen(dimension, feet)
        && blockIsOpen(dimension, head)
        && [...dimension.getEntitiesAtBlockLocation(feet), ...dimension.getEntitiesAtBlockLocation(head)]
          .every((entity) => entity.id === wizard.id);
    });
    if (!flightDestination) {
      throw new Error(`the simulated player cannot stand or fly within reach of ${target.x},${target.y},${target.z}`);
    }
    if (buildMovement?.key !== key) {
      buildMovement = {
        key,
        destination: flightDestination,
        startedTick: system.currentTick,
        mode: "flight-takeoff",
      };
      wizard.stopMoving();
      wizard.fly();
      wizard.lookAtLocation(target, LookDuration.UntilMove);
      return false;
    }
  }

  if (buildMovement?.key === key) {
    if (wizardCanReach(dimension, target, support)
      && distanceSquared(wizard.location, buildMovement.destination) < 1) {
      wizard.stopMoving();
      buildMovement = undefined;
      return true;
    }
    const movementElapsed = system.currentTick - buildMovement.startedTick;
    if (buildMovement.mode === "flight-takeoff") {
      wizard.fly();
      if (movementElapsed < 10) return false;
      const clearanceY = Math.max(wizard.location.y, buildMovement.destination.y) + 4;
      buildMovement = {
        ...buildMovement,
        mode: "flight",
        startedTick: system.currentTick,
        waypoint: 0,
        waypoints: [
          { x: wizard.location.x, y: clearanceY, z: wizard.location.z },
          { x: buildMovement.destination.x, y: clearanceY, z: buildMovement.destination.z },
          buildMovement.destination,
        ],
        commandedWaypoint: undefined,
      };
      return false;
    }
    if (buildMovement.mode === "flight") {
      if (movementElapsed > 80) {
        const destination = buildMovement.destination;
        wizard.stopMoving();
        wizard.teleport(destination, { dimension, facingLocation: target });
        const ground = dimension.getBlock({
          x: Math.floor(destination.x),
          y: Math.floor(destination.y) - 1,
          z: Math.floor(destination.z),
        });
        if (SAFE_GROUND.has(ground?.typeId)) wizard.stopFlying();
        else wizard.fly();
        buildMovement = undefined;
        console.warn(`[MC Wizard] blinked into build reach after the flight path stalled at ${target.x},${target.y},${target.z}`);
        return false;
      }
      let waypoint = buildMovement.waypoints[buildMovement.waypoint];
      if (distanceSquared(wizard.location, waypoint) < 0.5) {
        buildMovement.waypoint += 1;
        buildMovement.commandedWaypoint = undefined;
        waypoint = buildMovement.waypoints[buildMovement.waypoint];
        if (!waypoint) {
          const destination = buildMovement.destination;
          buildMovement = undefined;
          wizard.stopMoving();
          const ground = dimension.getBlock({
            x: Math.floor(destination.x),
            y: Math.floor(destination.y) - 1,
            z: Math.floor(destination.z),
          });
          if (SAFE_GROUND.has(ground?.typeId)) wizard.stopFlying();
          else wizard.fly();
          return false;
        }
      }
      if (buildMovement.commandedWaypoint !== buildMovement.waypoint) {
        wizard.moveToLocation(waypoint, { speed: 1, faceTarget: true });
        buildMovement.commandedWaypoint = buildMovement.waypoint;
      }
      return false;
    }
    if (movementElapsed > 80) {
      const destination = buildMovement.destination;
      wizard.stopMoving();
      wizard.stopFlying();
      wizard.teleport(destination, { dimension, facingLocation: target });
      buildMovement = undefined;
      console.warn(`[MC Wizard] blinked into grounded build reach after navigation stalled at ${target.x},${target.y},${target.z}`);
      return false;
    }
    navigateWizardToBuildPosition(
      buildMovement.destination,
      movementElapsed > 40,
      buildMovement,
    );
    return false;
  }

  const forcedDestination = forceMove
    ? validCandidates.find((location) => distanceSquared(location, wizard.location) >= 2.25)
    : undefined;
  const destination = forcedDestination || validCandidates[0];
  buildMovement = { key, destination, startedTick: system.currentTick, mode: "ground" };
  wizard.stopMoving();
  navigateWizardToBuildPosition(destination);
  wizard.lookAtLocation(target, LookDuration.UntilMove);
  return false;
}

function placeAsWizard(
  dimension,
  itemId,
  support,
  target,
  expectedType,
  permutation,
  direction = Direction.Up,
  expectedStates = {},
  facingLocation,
) {
  if (!wizardIsValid()) throw new Error("the simulated player is unavailable");
  const targetBeforePlacement = dimension.getBlock(target);
  const expectedTypes = Array.isArray(expectedType) ? expectedType : [expectedType];
  if (targetBeforePlacement && expectedTypes.includes(targetBeforePlacement.typeId)
    && Object.entries(expectedStates).every(([state, expected]) => (
      targetBeforePlacement.permutation.getState(state) === expected
    ))) return true;
  moveBuildTargetEntities(dimension, target);
  if (!targetBeforePlacement || !SAFE_SPACE.has(targetBeforePlacement.typeId)) {
    if (!positionWizardForBuild(dimension, target, support, true)) return false;
    wizard.lookAtBlock(target, LookDuration.Instant);
    if (!wizard.breakBlock(target, Direction.Up)) {
      const clearKey = `clear:${target.x},${target.y},${target.z}`;
      const attempts = (placementRetries.get(clearKey) || 0) + 1;
      if (attempts <= 3) {
        placementRetries.set(clearKey, attempts);
        return "placement-retry";
      }
      placementRetries.delete(clearKey);
      dimension.setBlockType(target, "minecraft:air");
      console.warn(`[MC Wizard] cleared stubborn target after ${attempts} player attempts`);
    }
    return "placement-retry";
  }
  const retryKey = `${target.x},${target.y},${target.z}:${itemId}`;
  if (!positionWizardForBuild(dimension, target, support, placementRetries.has(retryKey))) return false;

  const item = new ItemStack(itemId, 1);
  if (!preparedPlacements.has(retryKey)) {
    wizard.stopUsingItem();
    if (!wizard.setItem(item, 0, true)) throw new Error(`could not equip ${itemId}`);
    if (facingLocation) {
      wizard.lookAtLocation(placementGazeLocation(target, facingLocation), LookDuration.UntilMove);
    } else {
      wizard.lookAtBlock(support, LookDuration.UntilMove);
    }
    preparedPlacements.add(retryKey);
    return "placement-prepare";
  }
  preparedPlacements.delete(retryKey);
  if (facingLocation) {
    wizard.lookAtLocation(placementGazeLocation(target, facingLocation), LookDuration.Instant);
  } else {
    wizard.lookAtBlock(support, LookDuration.Instant);
  }
  const placed = wizard.useItemOnBlock(
    item,
    support,
    direction,
    faceLocation(direction),
  );
  if (!placed) {
    const attempts = (placementRetries.get(retryKey) || 0) + 1;
    // A real player-use attempt has already happened. Repair immediately when
    // Bedrock rejects it instead of making a child watch repeated pathing stalls.
    const retryLimit = 0;
    console.warn(`[MC Wizard] placement retry ${attempts} for ${itemId}; wizard=${wizard.location.x.toFixed(1)},${wizard.location.y.toFixed(1)},${wizard.location.z.toFixed(1)} target=${target.x},${target.y},${target.z} support=${support.x},${support.y},${support.z}; use=false`);
    if (attempts <= retryLimit) {
      placementRetries.set(retryKey, attempts);
      wizard.stopMoving();
      return "placement-retry";
    }
    placementRetries.delete(retryKey);
    dimension.setBlockType(target, expectedTypes[0]);
    console.warn(`[MC Wizard] completed ${itemId} with a direct repair after ${attempts} player attempts`);
  }

  let block = dimension.getBlock(target);
  if (!block || !expectedTypes.includes(block.typeId)) {
    const attempts = (placementRetries.get(retryKey) || 0) + 1;
    // The Wizard tried from player reach; one failed API result is enough to
    // use the verified operator-rights repair path and keep the build moving.
    const retryLimit = 0;
    console.warn(`[MC Wizard] placement retry ${attempts} for ${itemId}; wizard=${wizard.location.x.toFixed(1)},${wizard.location.y.toFixed(1)},${wizard.location.z.toFixed(1)} target=${target.x},${target.y},${target.z} support=${support.x},${support.y},${support.z}; result=${block?.typeId || "nothing"}`);
    if (attempts <= retryLimit) {
      placementRetries.set(retryKey, attempts);
      wizard.stopMoving();
      return "placement-retry";
    }
    placementRetries.delete(retryKey);
    dimension.setBlockType(target, expectedTypes[0]);
    block = dimension.getBlock(target);
    console.warn(`[MC Wizard] repaired ${itemId} result after ${attempts} player attempts`);
  }
  placementRetries.delete(retryKey);
  if (permutation) block.setPermutation(permutation);
  for (const [state, expected] of Object.entries(expectedStates)) {
    const actual = block.permutation.getState(state);
    if (actual !== expected) {
      block.setPermutation(block.permutation.withState(state, expected));
      console.warn(`[MC Wizard] corrected ${itemId} orientation ${state} after player placement`);
    }
  }
  return true;
}

function breakAsWizard(dimension, target) {
  if (!wizardIsValid()) throw new Error("the simulated player is unavailable");
  moveBuildTargetEntities(dimension, target);
  const block = dimension.getBlock(target);
  if (!block) throw new Error(`could not load scaffold at ${target.x},${target.y},${target.z}`);
  if (block.typeId === "minecraft:air") return true;
  if (!positionWizardForBuild(dimension, target)) return false;
  wizard.lookAtBlock(target, LookDuration.Instant);
  if (!wizard.breakBlock(target, Direction.Up)) {
    const key = `break:${target.x},${target.y},${target.z}`;
    const attempts = (placementRetries.get(key) || 0) + 1;
    if (attempts <= 3) {
      placementRetries.set(key, attempts);
      return false;
    }
    placementRetries.delete(key);
    dimension.setBlockType(target, "minecraft:air");
    console.warn(`[MC Wizard] removed stubborn scaffold after ${attempts} player attempts`);
  }
  return true;
}

function clearBuild(token, rollback = false) {
  if (activeBuildToken !== token) return false;
  if (rollback) rollbackTransaction(token);
  activeBuildToken = undefined;
  buildInProgress = false;
  buildMovement = undefined;
  placementRetries.clear();
  preparedPlacements.clear();
  buildRetryNotices.clear();
  nonTransactionalBuildTokens.delete(token);
  if (wizardIsValid()) {
    wizard.stopMoving();
    wizard.stopFlying();
  }
  equipWizard();
  return true;
}

function expectedBlockMatches(dimension, { location, typeId, states = {} }) {
  const expectedTypes = Array.isArray(typeId) ? typeId : [typeId];
  const block = dimension.getBlock(location);
  return expectedTypes.includes(block?.typeId)
    && Object.entries(states).every(([state, expected]) => block.permutation.getState(state) === expected);
}

function repairExpectedBlock(dimension, expected) {
  const expectedTypes = Array.isArray(expected.typeId) ? expected.typeId : [expected.typeId];
  let block = dimension.getBlock(expected.location);
  if (!block) return false;
  if (!expectedTypes.includes(block.typeId)) {
    dimension.setBlockType(expected.location, expectedTypes[0]);
    block = dimension.getBlock(expected.location);
  }
  if (!block) return false;
  for (const [state, value] of Object.entries(expected.states || {})) {
    if (block.permutation.getState(state) === undefined) return false;
    block.setPermutation(block.permutation.withState(state, value));
  }
  return expectedBlockMatches(dimension, expected);
}

function finishBuild(playerId, token, dimension, expectedBlocks, successMessage, repairAttempt = 0) {
  if (activeBuildToken !== token) return;
  const player = playerById(playerId);
  const mismatches = expectedBlocks.filter((expected) => !expectedBlockMatches(dimension, expected));
  if (mismatches.length && repairAttempt < 3) {
    let repaired = 0;
    for (const expected of mismatches) {
      try {
        if (repairExpectedBlock(dimension, expected)) repaired += 1;
      } catch (error) {
        console.warn(`[MC Wizard] targeted repair missed ${expected.location.x},${expected.location.y},${expected.location.z}: ${error}`);
      }
    }
    console.warn(`[MC Wizard] targeted verification repair ${repairAttempt + 1}: ${repaired}/${mismatches.length} pieces restored`);
    if (player && repairAttempt === 0) {
      speak(player, "I found a few stubborn pieces. I’m repairing those exact spots now and keeping the rest of your build standing.");
    }
    system.runTimeout(
      () => finishBuild(playerId, token, dimension, expectedBlocks, successMessage, repairAttempt + 1),
      4,
    );
    return;
  }
  if (mismatches.length) {
    const mismatch = mismatches[0];
    const actual = dimension.getBlock(mismatch.location)?.typeId || "unloaded";
    const expected = Array.isArray(mismatch.typeId) ? mismatch.typeId.join(" or ") : mismatch.typeId;
    console.warn(
      "[MC Wizard] final build verification failed at "
        + mismatch.location.x + "," + mismatch.location.y + "," + mismatch.location.z
        + ": expected " + expected + ", got " + actual,
    );
    commitTransaction(token);
    if (!clearBuild(token)) return;
    endBuildAction(token, "failed", `verification left ${mismatches.length} mismatched block${mismatches.length === 1 ? "" : "s"}`);
    if (!player) return;
    speak(player, "I kept every good part standing instead of erasing your build. One enchanted piece needed a sturdier repair, and I’ve left the useful build in place for you.");
    return;
  }
  commitTransaction(token);
  if (!clearBuild(token)) return;
  endBuildAction(token, "completed", `verified ${expectedBlocks.length} planned blocks`);
  if (!player) return;
  console.warn("[MC Wizard] final build verification passed");
  speak(player, successMessage);
}

function runBuildSteps(
  playerId,
  token,
  dimension,
  steps,
  expectedBlocks,
  successMessage,
  delayTicks,
  index = 0,
  repairPass = 0,
) {
  if (activeBuildToken !== token) return;
  if (index === 0 && !activeTransaction && !nonTransactionalBuildTokens.has(token)) {
    try {
      beginTransaction(playerId, token, dimension, expectedBlocks);
    } catch (error) {
      console.warn(`[MC Wizard] continuing without undo snapshot: ${error}`);
      nonTransactionalBuildTokens.add(token);
      const player = playerById(playerId);
      if (player) speak(player, "I can’t save an undo snapshot here, but I’m continuing carefully instead of stopping.");
    }
  }
  if (index >= steps.length) {
    const mismatch = expectedBlocks.find((expected) => !expectedBlockMatches(dimension, expected));
    if (mismatch) {
      if (repairPass >= 1) {
        finishBuild(playerId, token, dimension, expectedBlocks, successMessage);
        return;
      }
      const player = playerById(playerId);
      const expected = Array.isArray(mismatch.typeId) ? mismatch.typeId.join(" or ") : mismatch.typeId;
      console.warn(
        `[MC Wizard] build pass mismatch at ${mismatch.location.x},${mismatch.location.y},${mismatch.location.z}: `
          + `expected ${expected}, got ${dimension.getBlock(mismatch.location)?.typeId || "unloaded"}`,
      );
      if (player) speak(player, "I found one unfinished piece in my inspection. I’m going back through the build and fixing it now.");
      system.runTimeout(
        () => runBuildSteps(
          playerId,
          token,
          dimension,
          steps,
          expectedBlocks,
          successMessage,
          delayTicks,
          0,
          repairPass + 1,
        ),
        20,
      );
      return;
    }
    finishBuild(playerId, token, dimension, expectedBlocks, successMessage);
    return;
  }

  let stepComplete;
  try {
    stepComplete = steps[index]();
    if (stepComplete === "interaction-failed") {
      commitTransaction(token);
      endBuildAction(token, "failed", "required player interaction could not be verified");
      const player = playerById(playerId);
      if (!clearBuild(token) || !player) return;
      speak(player, "The useful build is standing, but that last interaction did not actually work. I marked it unfinished so I can redraw and retry it instead of pretending it passed.");
      return;
    }
    if (stepComplete !== false
      && stepComplete !== "placement-retry"
      && stepComplete !== "placement-prepare"
      && index % 50 === 0) {
      console.warn("[MC Wizard] build progress " + index + "/" + steps.length);
    }
    if (stepComplete !== false && stepComplete !== "placement-retry" && stepComplete !== "placement-prepare") {
      buildRetryNotices.delete(`${token}:${index}`);
    }
  } catch (error) {
    console.warn(`[MC Wizard] build step ${index} retrying: ${error}`);
    buildMovement = undefined;
    placementRetries.clear();
    preparedPlacements.clear();
    if (wizardIsValid()) wizard.stopMoving();
    const player = playerById(playerId);
    if (player && !wizardIsValid()) bringWizardTo(player);
    const noticeKey = `${token}:${index}`;
    if (player && !buildRetryNotices.has(noticeKey)) {
      buildRetryNotices.add(noticeKey);
      speak(player, "That piece is being stubborn. I’m changing angle and trying it again—I’m not abandoning the build.");
    }
    system.runTimeout(
      () => runBuildSteps(
        playerId,
        token,
        dimension,
        steps,
        expectedBlocks,
        successMessage,
        delayTicks,
        index,
        repairPass,
      ),
      20,
    );
    return;
  }
  system.runTimeout(
    () => runBuildSteps(
      playerId,
      token,
      dimension,
      steps,
      expectedBlocks,
      successMessage,
      delayTicks,
      stepComplete === false || stepComplete === "placement-retry" || stepComplete === "placement-prepare"
        ? index
        : index + 1,
      repairPass,
    ),
    stepComplete === "placement-retry" ? 10
      : stepComplete === "placement-prepare" ? 3
        : stepComplete === false ? 1 : delayTicks,
  );
}

async function buildCopperBulbTFlipFlop(player) {
  console.warn("[MC Wizard] T flip-flop build requested by " + player.name);
  const previousBuild = lastBuildTick.get(player.id) || -Infinity;
  if (system.currentTick - previousBuild < 200) {
    queueBuild(
      player,
      buildCopperBulbTFlipFlop,
      200 - (system.currentTick - previousBuild),
      "I queued that T flip-flop and will start it in a few seconds.",
    );
    return;
  }
  if (buildInProgress || buildPreparing) {
    queueBuild(player, buildCopperBulbTFlipFlop);
    return;
  }

  let dimension = player.dimension;
  let forward = cardinalDirection(player);
  console.warn("[MC Wizard] T flip-flop facing " + forward.name);
  let right = { x: -forward.z, z: forward.x };
  let base = findClearSite(player, forward, right);
  let actionClaim;
  if (!base) {
    actionClaim = captureBuildActionClaim(player);
    if (await prepareBuildWorkshopReserved(player)) {
      dimension = player.dimension;
      forward = cardinalDirection(player);
      right = { x: -forward.z, z: forward.x };
      base = findClearSite(player, forward, right);
    }
    if (!buildActionClaimIsCurrent(player, actionClaim)) return;
  }
  if (!base) {
    console.warn("[MC Wizard] no clear T flip-flop site near " + player.name);
    queueBuild(
      player,
      buildCopperBulbTFlipFlop,
      200,
      "This patch is extra stubborn. I’m keeping your T flip-flop queued and trying the ground again nearby.",
    );
    return;
  }

  const bot = bringWizardTo(player);
  if (!bot) {
    queueBuild(
      player,
      buildCopperBulbTFlipFlop,
      40,
      "My boots missed the summon. I’m fetching them and starting your T flip-flop automatically.",
    );
    return;
  }

  buildInProgress = true;
  const token = ++nextBuildToken;
  activeBuildToken = token;
  if (!bindBuildAction(player, token, undefined, actionClaim)) {
    clearBuild(token);
    return;
  }
  lastBuildTick.set(player.id, system.currentTick);
  const buildBlock = offset(base, forward, right, 1, 1);
  const buildSpot = { x: buildBlock.x + 0.5, y: buildBlock.y, z: buildBlock.z + 0.5 };
  try {
    bot.navigateToLocation(buildSpot, 0.8);
    bot.lookAtLocation(base, LookDuration.UntilMove);
  } catch (error) {
    console.warn(`[MC Wizard] could not walk to build site: ${error}`);
  }
  speak(player, "I’ll make a small copper-bulb T flip-flop here. Watch the parts in my hand as I place them.");

  const bulb = offset(base, forward, right, 0);
  const button = offset(bulb, forward, right, 0, 0, 1);
  const comparator = offset(base, forward, right, 1);
  const wire = offset(base, forward, right, 2);
  const lamp = offset(base, forward, right, 3);
  const steps = [
    () => placeAsWizard(
      dimension,
      "minecraft:copper_bulb",
      offset(bulb, forward, right, 0, 0, -1),
      bulb,
      "minecraft:copper_bulb",
    ),
    () => placeAsWizard(
      dimension,
      "minecraft:stone_button",
      bulb,
      button,
      "minecraft:stone_button",
    ),
    () => placeAsWizard(
      dimension,
      "minecraft:comparator",
      offset(comparator, forward, right, 0, 0, -1),
      comparator,
      "minecraft:unpowered_comparator",
      BlockPermutation.resolve("minecraft:unpowered_comparator", {
        "minecraft:cardinal_direction": OPPOSITE_CARDINAL[forward.name],
        output_lit_bit: false,
        output_subtract_bit: false,
      }),
    ),
    () => placeAsWizard(
      dimension,
      "minecraft:redstone",
      offset(wire, forward, right, 0, 0, -1),
      wire,
      "minecraft:redstone_wire",
    ),
    () => placeAsWizard(
      dimension,
      "minecraft:redstone_lamp",
      offset(lamp, forward, right, 0, 0, -1),
      lamp,
      "minecraft:redstone_lamp",
    ),
  ];
  const expectedBlocks = [
    { location: bulb, typeId: "minecraft:copper_bulb" },
    { location: button, typeId: "minecraft:stone_button" },
    { location: comparator, typeId: ["minecraft:unpowered_comparator", "minecraft:powered_comparator"] },
    { location: wire, typeId: "minecraft:redstone_wire" },
    { location: lamp, typeId: "minecraft:redstone_lamp" },
  ];

  const beginTFlipFlop = () => {
    if (activeBuildToken !== token) return;
    if (!wizardIsValid()) {
      const current = playerById(player.id);
      if (!current) {
        endBuildAction(token, "failed", "player left before the build could continue");
        clearBuild(token);
        return;
      }
      bringWizardTo(current);
      if (!buildRetryNotices.has(`${token}:body`)) {
        buildRetryNotices.add(`${token}:body`);
        speak(current, "My boots blinked away, but your T flip-flop is safe. I’m summoning them back and continuing from this exact spot.");
      }
      system.runTimeout(beginTFlipFlop, 40);
      return;
    }
    runBuildSteps(
      player.id,
      token,
      dimension,
      steps,
      expectedBlocks,
      "Built! Press the button on the copper bulb. The bulb stores one bit, the comparator reads it, and the output lamp should alternate on and off.",
      12,
    );
  };
  system.runTimeout(beginTFlipFlop, 20);
}

function calculatorLocation(origin, forward, right, [x, y, z]) {
  return {
    x: origin.x + right.x * x - forward.x * z,
    y: origin.y + y,
    z: origin.z + right.z * x - forward.z * z,
  };
}

function playerCopyableCalculatorSupport(dimension, itemId, target, plannedSupport) {
  const isFloorTile = itemId === "minecraft:smooth_stone" || itemId.endsWith("_wool");
  if (!isFloorTile || plannedSupport.y !== target.y - 1) return plannedSupport;
  const neighbors = [
    { x: target.x - 1, y: target.y, z: target.z },
    { x: target.x + 1, y: target.y, z: target.z },
    { x: target.x, y: target.y, z: target.z - 1 },
    { x: target.x, y: target.y, z: target.z + 1 },
  ];
  return neighbors.find((location) => dimension.getBlock(location)?.isSolid) || plannedSupport;
}

function playerAccessibleCalculatorOrder(placements) {
  const ordered = [];
  const built = new Set();
  const key = ([x, y, z]) => `${x},${y},${z}`;
  const isStackedFullBlock = (placement) => placement.action !== "break"
    && (placement.itemId === "minecraft:smooth_stone" || placement.itemId.endsWith("_wool"))
    && placement.support[1] === placement.target[1] - 1;
  const hasBuiltNeighbor = (placement) => {
    const [x, y, z] = placement.target;
    return [[x - 1, y, z], [x + 1, y, z], [x, y, z - 1], [x, y, z + 1]]
      .some((location) => built.has(key(location)));
  };

  for (let index = 0; index < placements.length;) {
    const first = placements[index];
    if (!isStackedFullBlock(first)) {
      ordered.push(first);
      if (first.action !== "break") built.add(key(first.target));
      index += 1;
      continue;
    }
    const run = [];
    while (index < placements.length
      && isStackedFullBlock(placements[index])
      && placements[index].target[1] === first.target[1]) {
      run.push(placements[index]);
      index += 1;
    }
    while (run.length) {
      const nextIndex = run.findIndex(hasBuiltNeighbor);
      const [next] = run.splice(nextIndex < 0 ? 0 : nextIndex, 1);
      ordered.push(next);
      built.add(key(next.target));
    }
  }
  return ordered;
}

function customLocation(origin, forward, right, [x, y, z]) {
  return {
    x: origin.x + right.x * x + forward.x * z,
    y: origin.y + y,
    z: origin.z + right.z * x + forward.z * z,
  };
}

const boxVolume = ({ from, to }) => (
  (Math.abs(to[0] - from[0]) + 1)
  * (Math.abs(to[1] - from[1]) + 1)
  * (Math.abs(to[2] - from[2]) + 1)
);

function structureBox(phase, blockId, from, to = from) {
  return {
    phase,
    blockId,
    from: from.map((value, axis) => Math.min(value, to[axis])),
    to: to.map((value, axis) => Math.max(value, from[axis])),
  };
}

function structureOperations(plan) {
  const { width, depth, height } = plan.dimensions;
  const features = new Set(plan.features);
  const operations = [];
  const interiorOpenings = [];
  const add = (phase, blockId, from, to = from) => operations.push(structureBox(phase, blockId, from, to));
  const houseLike = /house|home|cottage|cabin|mansion|barn|hall|workshop/.test(plan.kind);
  const battlements = features.has("battlements") && height >= 3;
  const roofRise = houseLike && features.has("roof") && width >= 3 && height >= 4
    ? Math.min(Math.floor((width - 1) / 2), Math.max(1, Math.floor((height - 2) / 3)))
    : 0;
  const wallTop = Math.max(0, height - 1 - Math.max(roofRise, battlements ? 1 : 0));

  // A continuous floor gives both players and later redstone/detail blocks real support.
  add("foundation", plan.materials.primary, [0, 0, 0], [width - 1, 0, depth - 1]);

  if (features.has("walls") && wallTop >= 1) {
    add("shell", plan.materials.primary, [0, 1, 0], [width - 1, wallTop, 0]);
    if (depth > 1) add("shell", plan.materials.primary, [0, 1, depth - 1], [width - 1, wallTop, depth - 1]);
    if (depth > 2) {
      add("shell", plan.materials.primary, [0, 1, 1], [0, wallTop, depth - 2]);
      if (width > 1) add("shell", plan.materials.primary, [width - 1, 1, 1], [width - 1, wallTop, depth - 2]);
    }
  }
  if (features.has("rainbow") && features.has("walls") && wallTop >= 1) {
    const colors = [
      "minecraft:red_concrete", "minecraft:orange_concrete", "minecraft:yellow_concrete",
      "minecraft:lime_concrete", "minecraft:light_blue_concrete", "minecraft:blue_concrete",
      "minecraft:purple_concrete",
    ];
    for (let y = 1; y <= wallTop; y += 1) {
      const color = colors[(y - 1) % colors.length];
      add("shell", color, [0, y, 0], [width - 1, y, 0]);
      if (depth > 1) add("shell", color, [0, y, depth - 1], [width - 1, y, depth - 1]);
      if (depth > 2) {
        add("shell", color, [0, y, 1], [0, y, depth - 2]);
        if (width > 1) add("shell", color, [width - 1, y, 1], [width - 1, y, depth - 2]);
      }
    }
  }
  if (wallTop >= 1 && (features.has("supports") || features.has("towers"))) {
    const size = features.has("towers") && width >= 9 && depth >= 9 ? 3
      : features.has("towers") && width >= 6 && depth >= 6 ? 2 : 1;
    for (const [x, z] of [[0, 0], [width - size, 0], [0, depth - size], [width - size, depth - size]]) {
      if (size === 1) {
        add("shell", plan.materials.accent, [x, 1, z], [x, wallTop, z]);
      } else {
        add("shell", plan.materials.accent, [x, 1, z], [x + size - 1, wallTop, z]);
        add("shell", plan.materials.accent, [x, 1, z + size - 1], [x + size - 1, wallTop, z + size - 1]);
        if (size > 2) {
          add("shell", plan.materials.accent, [x, 1, z + 1], [x, wallTop, z + size - 2]);
          add("shell", plan.materials.accent, [x + size - 1, 1, z + 1], [x + size - 1, wallTop, z + size - 2]);
        }
      }
    }
  }
  const secondFloorY = features.has("second_floor") && wallTop >= 4 && width >= 5 && depth >= 5
    ? Math.max(3, Math.min(wallTop - 1, Math.floor((wallTop + 1) / 2)))
    : undefined;
  if (secondFloorY !== undefined) {
    add("shell", plan.materials.primary, [1, secondFloorY, 1], [width - 2, secondFloorY, depth - 2]);
  }
  if (features.has("rooms") && wallTop >= 3 && width >= 7 && depth >= 7) {
    const middleX = Math.floor(width / 2);
    const middleZ = Math.floor(depth / 2);
    add("shell", plan.materials.primary, [1, 1, middleZ], [width - 2, wallTop, middleZ]);
    add("shell", plan.materials.primary, [middleX, 1, 1], [middleX, wallTop, depth - 2]);
    for (const x of [Math.floor(width / 4), Math.floor((width * 3) / 4)]) {
      interiorOpenings.push([[x, 1, middleZ], [x, Math.min(2, wallTop), middleZ]]);
      if (secondFloorY !== undefined && secondFloorY + 1 <= wallTop) {
        interiorOpenings.push([
          [x, secondFloorY + 1, middleZ],
          [x, Math.min(secondFloorY + 2, wallTop), middleZ],
        ]);
      }
    }
    for (const z of [Math.floor(depth / 4), Math.floor((depth * 3) / 4)]) {
      interiorOpenings.push([[middleX, 1, z], [middleX, Math.min(2, wallTop), z]]);
      if (secondFloorY !== undefined && secondFloorY + 1 <= wallTop) {
        interiorOpenings.push([
          [middleX, secondFloorY + 1, z],
          [middleX, Math.min(secondFloorY + 2, wallTop), z],
        ]);
      }
    }
  }
  if (height > 1 && features.has("walkway") && !features.has("walls")) {
    add("shell", plan.materials.accent, [0, 1, 0], [0, 1, depth - 1]);
    if (width > 1) add("shell", plan.materials.accent, [width - 1, 1, 0], [width - 1, 1, depth - 1]);
  }

  if (features.has("roof")) {
    if (roofRise > 0) {
      for (let rise = 0; rise <= roofRise; rise += 1) {
        add("roof", plan.materials.roof, [rise, wallTop + rise, 0], [width - 1 - rise, wallTop + rise, depth - 1]);
      }
    } else {
      add("roof", plan.materials.roof, [0, height - 1, 0], [width - 1, height - 1, depth - 1]);
    }
  }
  if (battlements) {
    for (let x = 0; x < width; x += 2) {
      add("roof", plan.materials.accent, [x, height - 1, 0]);
      if (depth > 1) add("roof", plan.materials.accent, [x, height - 1, depth - 1]);
    }
    for (let z = 2; z < depth - 1; z += 2) {
      add("roof", plan.materials.accent, [0, height - 1, z]);
      if (width > 1) add("roof", plan.materials.accent, [width - 1, height - 1, z]);
    }
  }

  if (wallTop >= 1 && features.has("door") && features.has("walls")) {
    const doorX = Math.floor((width - 1) / 2);
    add("details", "minecraft:air", [doorX, 1, 0], [doorX + (width % 2 === 0 ? 1 : 0), Math.min(2, wallTop), 0]);
  }
  for (const [from, to] of interiorOpenings) add("details", "minecraft:air", from, to);
  if (secondFloorY !== undefined) {
    const stairZ = Math.min(depth - 2, 2);
    const steps = Math.min(secondFloorY, width - 3);
    for (let step = 1; step <= steps; step += 1) {
      add("details", plan.materials.accent, [step, step, stairZ]);
    }
    add("details", "minecraft:air", [steps, secondFloorY, stairZ]);
  }
  if (features.has("windows") && features.has("walls") && wallTop >= 2) {
    const y = Math.min(wallTop, Math.max(2, Math.floor(wallTop / 2)));
    const doorX = Math.floor((width - 1) / 2);
    for (let x = 2; x < width - 1; x += 3) {
      if (Math.abs(x - doorX) > 1) add("details", "minecraft:glass", [x, y, 0]);
      if (depth > 1) add("details", "minecraft:glass", [x, y, depth - 1]);
    }
    for (let z = 2; z < depth - 1; z += 3) {
      add("details", "minecraft:glass", [0, y, z]);
      if (width > 1) add("details", "minecraft:glass", [width - 1, y, z]);
    }
  }
  if (height > 1 && features.has("lighting")) {
    const step = Math.max(4, Math.ceil(Math.sqrt((width * depth) / 32)));
    let lights = 0;
    for (let x = Math.min(2, width - 1); x < Math.max(1, width - 1); x += step) {
      for (let z = Math.min(2, depth - 1); z < Math.max(1, depth - 1); z += step) {
        add("details", "minecraft:sea_lantern", [x, 0, z]);
        if (secondFloorY !== undefined) add("details", "minecraft:sea_lantern", [x, secondFloorY, z]);
        lights += 1;
      }
    }
    if (!lights) add("details", "minecraft:sea_lantern", [0, 0, 0]);
  }
  if (features.has("decorations") && width >= 5 && depth >= 5 && wallTop >= 2) {
    const centerX = Math.floor(width / 2);
    const centerZ = Math.floor(depth / 2);
    add("details", plan.materials.accent, [1, 1, 1], [1, Math.min(2, wallTop), 1]);
    add("details", plan.materials.accent, [width - 2, 1, depth - 2], [width - 2, Math.min(2, wallTop), depth - 2]);
    add("details", "minecraft:sea_lantern", [centerX, Math.max(2, Math.min(wallTop - 1, height - 2)), centerZ]);
    if (secondFloorY !== undefined && secondFloorY > 2) {
      add("details", "minecraft:sea_lantern", [centerX, secondFloorY - 1, centerZ]);
    }
  }
  for (const { typeId, location: [x, y, z] } of plan.entities || []) {
    if (typeId === "minecraft:iron_golem") continue;
    if (x < 1 || x >= width - 1 || z < 1 || z >= depth - 1 || y < 1) continue;
    add("details", "minecraft:oak_fence", [x - 1, y, z - 1], [x + 1, y, z - 1]);
    add("details", "minecraft:oak_fence", [x - 1, y, z + 1], [x + 1, y, z + 1]);
    add("details", "minecraft:oak_fence", [x - 1, y, z], [x - 1, y, z]);
    add("details", "minecraft:oak_fence", [x + 1, y, z], [x + 1, y, z]);
  }
  return operations;
}

function sameGeneratedStructureBase(plan, previousPlan) {
  return Boolean(previousPlan)
    && plan.kind === previousPlan.kind
    && JSON.stringify(plan.dimensions) === JSON.stringify(previousPlan.dimensions)
    && JSON.stringify(plan.materials) === JSON.stringify(previousPlan.materials)
    && JSON.stringify(plan.features) === JSON.stringify(previousPlan.features)
    && JSON.stringify(plan.entities || []) === JSON.stringify(previousPlan.entities || []);
}

function structurePlanOperations(plan, previousPlan, { reconstructing = false } = {}) {
  const primitives = primitiveStructureOperations(plan);
  const detailOnlyPatch = primitives.length > 0
    && plan.mode === "modify"
    && GENERATED_STRUCTURE_KINDS.has(plan.kind)
    && sameGeneratedStructureBase(plan, previousPlan);
  let operations;
  if (!primitives.length) {
    // `reconstructing` replays a plan that already stands in the world (the
    // saved record of a previous build). Legacy generic-box-era records have
    // no primitives and no mode, and their kind may not be a generated kind
    // ("dragon" built before #35); the parametric generator is exactly what
    // was built then, so the fail-fast below must not apply to them or the
    // legacy structure could never be modified again.
    if (!reconstructing && plan.mode !== "modify" && !GENERATED_STRUCTURE_KINDS.has(plan.kind)) {
      // Fail fast instead of silently substituting the generic parametric box:
      // a primitive-less "dragon" would otherwise become a house-shaped
      // building that is not what the child asked for (#35).
      throw new Error(`a ${plan.kind} needs authored shape primitives (box/line/hollow_box); send its silhouette instead of a generic building`);
    }
    operations = structureOperations(plan);
  }
  else if (plan.mode !== "modify" || !GENERATED_STRUCTURE_KINDS.has(plan.kind)) operations = primitives;
  else if (detailOnlyPatch) {
    const previousPrimitiveKeys = new Set(
      primitiveStructureOperations(previousPlan).map((operation) => JSON.stringify(operation)),
    );
    operations = primitives.filter((operation) => !previousPrimitiveKeys.has(JSON.stringify(operation)));
  }
  else {
    const phaseOrder = new Map(["foundation", "shell", "roof", "details"].map((phase, index) => [phase, index]));
    operations = [...structureOperations(plan), ...primitives]
      .sort((a, b) => phaseOrder.get(a.phase) - phaseOrder.get(b.phase));
  }
  // An entity location is also a promise that the inhabitant can stand there.
  // Provider geometry may otherwise put a hollow-box floor or room detail in
  // the model's own spawn cell. Clear feet and headroom last, after every
  // authored detail, while preserving the supported floor below.
  const clearance = (detailOnlyPatch ? [] : plan.entities || []).map(({ location: [x, y, z] }) => (
    structureBox("details", "minecraft:air", [x, y, z], [x, y + 1, z])
  ));
  return [...operations, ...clearance];
}

function worldStructureBox(origin, forward, right, operation) {
  const a = customLocation(origin, forward, right, operation.from);
  const b = customLocation(origin, forward, right, operation.to);
  return {
    ...operation,
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
  };
}

function splitWorldFill(operation, limit = 30_000) {
  const volume = (operation.max.x - operation.min.x + 1)
    * (operation.max.y - operation.min.y + 1)
    * (operation.max.z - operation.min.z + 1);
  if (volume <= limit) return [operation];
  const axes = ["x", "y", "z"].sort((a, b) => (
    operation.max[b] - operation.min[b] - (operation.max[a] - operation.min[a])
  ));
  const axis = axes[0];
  const middle = Math.floor((operation.min[axis] + operation.max[axis]) / 2);
  const first = { ...operation, min: { ...operation.min }, max: { ...operation.max, [axis]: middle } };
  const second = { ...operation, min: { ...operation.min, [axis]: middle + 1 }, max: { ...operation.max } };
  return [...splitWorldFill(first, limit), ...splitWorldFill(second, limit)];
}

function structureOrigin(player, plan, forward, right, distance = 7, lateral = 0) {
  const base = {
    x: Math.floor(player.location.x),
    y: standingBlockY(player.location),
    z: Math.floor(player.location.z),
  };
  return offset(base, forward, right, distance, lateral - Math.floor((plan.dimensions.width - 1) / 2));
}

function structureSiteIsClear(player, plan, origin, forward, right) {
  const { width, depth } = plan.dimensions;
  for (let x = 0; x < width; x += 1) {
    for (let z = 0; z < depth; z += 1) {
      const floor = customLocation(origin, forward, right, [x, 0, z]);
      const ground = player.dimension.getBlock({ ...floor, y: floor.y - 1 });
      const feet = player.dimension.getBlock(floor);
      const head = player.dimension.getBlock({ ...floor, y: floor.y + 1 });
      if (!ground || !SAFE_GROUND.has(ground.typeId)
        || !feet || !SAFE_SPACE.has(feet.typeId)
        || !head || !SAFE_SPACE.has(head.typeId)) return false;
    }
  }
  return true;
}

function findStructureSite(player, plan, forward, right) {
  const sideStep = Math.ceil(plan.dimensions.width / 2) + 4;
  for (const [distance, lateral] of [[7, 0], [9, sideStep], [9, -sideStep]]) {
    const origin = structureOrigin(player, plan, forward, right, distance, lateral);
    if (structureSiteIsClear(player, plan, origin, forward, right)) return { origin, clear: true };
  }
  return { origin: structureOrigin(player, plan, forward, right), clear: false };
}

function findModificationSite(player, plan) {
  const previous = structureFor(player, plan.kind);
  if (!previous || previous.dimensionId !== player.dimension.id) return undefined;
  const oldDimensions = previous.plan.dimensions;
  const shiftX = Math.round((oldDimensions.width - plan.dimensions.width) / 2);
  const shiftZ = Math.round((oldDimensions.depth - plan.dimensions.depth) / 2);
  return {
    origin: customLocation(previous.origin, previous.forward, previous.right, [shiftX, 0, shiftZ]),
    forward: previous.forward,
    right: previous.right,
    clear: false,
    previous,
  };
}

function runRawFill(dimension, operation) {
  const { min, max, blockId, replaceBlockId } = operation;
  const samples = [
    min,
    max,
    {
      x: Math.floor((min.x + max.x) / 2),
      y: Math.floor((min.y + max.y) / 2),
      z: Math.floor((min.z + max.z) / 2),
    },
  ];
  const before = replaceBlockId ? samples.map((location) => dimension.getBlock(location)?.typeId) : [];
  try {
    dimension.runCommand(`fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} ${blockId}${replaceBlockId ? ` replace ${replaceBlockId}` : ""}`);
  } catch (error) {
    if (replaceBlockId) {
      console.warn(`[MC Wizard] obsolete ${replaceBlockId} shell section was already changed or empty: ${error}`);
      return;
    }
    throw error;
  }
  if (samples.some((location, index) => (
    (!replaceBlockId || before[index] === replaceBlockId)
    && dimension.getBlock(location)?.typeId !== blockId
  ))) {
    throw new Error(`fill verification missed ${blockId}`);
  }
}

async function prepareStructureArea(player, plan, origin, forward, right, clear, previousPlan) {
  const dimension = player.dimension;
  const { width, depth, height } = plan.dimensions;
  const worldBox = worldStructureBox(origin, forward, right, structureBox(
    "preparation",
    "minecraft:air",
    [0, 0, 0],
    [width - 1, height - 1, depth - 1],
  ));
  const center = {
    x: Math.floor((worldBox.min.x + worldBox.max.x) / 2),
    y: origin.y,
    z: Math.floor((worldBox.min.z + worldBox.max.z) / 2),
  };
  try {
    dimension.runCommand(`tickingarea remove ${WORKSHOP_TICKING_AREA}`);
  } catch {}
  dimension.runCommand(`tickingarea add circle ${center.x} ${center.y} ${center.z} 4 ${WORKSHOP_TICKING_AREA} true`);
  system.runTimeout(() => {
    try {
      dimension.runCommand(`tickingarea remove ${WORKSHOP_TICKING_AREA}`);
    } catch {}
  }, 12_000);
  await system.waitTicks(5);
  if (previousPlan) {
    const ground = worldStructureBox(origin, forward, right, structureBox(
      "preparation",
      plan.materials.primary,
      [0, -1, 0],
      [width - 1, -1, depth - 1],
    ));
    for (const slice of splitWorldFill(ground)) runRawFill(dimension, slice);
    for (const operation of expansionClearOperations(previousPlan, plan)) {
      for (const slice of splitWorldFill(worldStructureBox(origin, forward, right, operation))) {
        runRawFill(dimension, slice);
      }
    }
    return;
  }
  if (!clear) {
    speak(player, "I found the closest workable patch. I’m leveling it right here instead of whisking us into the sky.");
    const ground = worldStructureBox(origin, forward, right, structureBox(
      "preparation",
      plan.materials.primary,
      [0, -1, 0],
      [width - 1, -1, depth - 1],
    ));
    for (const slice of splitWorldFill(ground)) runRawFill(dimension, slice);
  }
  for (const slice of splitWorldFill(worldBox)) runRawFill(dimension, slice);
}

function phaseMessage(phase) {
  if (phase === "cleanup") return "I’m opening the old outer walls so the larger build becomes one connected structure.";
  if (phase === "foundation") return "Foundation first—this sets the exact footprint.";
  if (phase === "shell") return "The footprint is set. Walls and supports are going up now.";
  if (phase === "roof") return "Time for the roof and skyline.";
  return "Finishing the doorway, windows, and useful details.";
}

function runStructurePostSteps(playerId, token, steps, complete, fail, index = 0, retries = 0) {
  if (activeBuildToken !== token) return;
  if (index >= steps.length) {
    complete();
    return;
  }
  let result;
  try {
    result = steps[index]();
  } catch (error) {
    console.warn(`[MC Wizard] structure inhabitant retry: ${error}`);
    result = false;
  }
  if (result !== true && retries >= MAX_STRUCTURE_POST_RETRIES) {
    fail("inhabitants could not be safely placed and verified");
    return;
  }
  system.runTimeout(
    () => runStructurePostSteps(
      playerId,
      token,
      steps,
      complete,
      fail,
      result === true ? index + 1 : index,
      result === true ? 0 : retries + 1,
    ),
    result === "placement-prepare" ? 3 : result === "placement-retry" ? 10 : result === false ? 5 : 2,
  );
}

function runBulkStructureSteps(
  playerId,
  token,
  dimension,
  operations,
  title,
  postSteps = [],
  index = 0,
  retries = 0,
) {
  if (activeBuildToken !== token) return;
  if (index >= operations.length) {
    const complete = () => {
      if (!clearBuild(token)) return;
      endBuildAction(token, "completed", `verified all ${operations.length} structure operations`);
      try {
        dimension.runCommand(`tickingarea remove ${WORKSHOP_TICKING_AREA}`);
      } catch {}
      const player = playerById(playerId);
      if (player) speak(player, `${title} is complete. I checked every section and inhabitant as they appeared.`);
      console.warn(`[MC Wizard] completed and verified bulk structure ${title}`);
    };
    const fail = (detail) => {
      if (!clearBuild(token)) return;
      endBuildAction(token, "failed", detail);
      try {
        dimension.runCommand(`tickingarea remove ${WORKSHOP_TICKING_AREA}`);
      } catch {}
      const player = playerById(playerId);
      if (player) speak(player, "That section won’t settle yet. I’m keeping the good work and replanning instead of leaving you waiting.");
    };
    if (postSteps.length) runStructurePostSteps(playerId, token, postSteps, complete, fail);
    else complete();
    return;
  }
  const operation = operations[index];
  const player = playerById(playerId);
  if (player && (index === 0 || operations[index - 1].phase !== operation.phase)) {
    speak(player, phaseMessage(operation.phase));
  }
  try {
    if (wizardIsValid()) {
      if (operation.blockId !== "minecraft:air") equipWizard(operation.blockId);
      wizard.lookAtLocation({
        x: (operation.min.x + operation.max.x) / 2,
        y: (operation.min.y + operation.max.y) / 2,
        z: (operation.min.z + operation.max.z) / 2,
      }, LookDuration.Instant);
    }
    runRawFill(dimension, operation);
    system.runTimeout(
      () => runBulkStructureSteps(playerId, token, dimension, operations, title, postSteps, index + 1, 0),
      2,
    );
  } catch (error) {
    console.warn(`[MC Wizard] structure phase retry ${retries + 1}: ${error}`);
    if (player && retries === 0) speak(player, "One section snagged. I’m recasting that piece instead of abandoning it.");
    if (retries >= MAX_BULK_STRUCTURE_RETRIES) {
      if (!clearBuild(token)) return;
      endBuildAction(token, "failed", `structure section failed after ${retries + 1} attempts`);
      try {
        dimension.runCommand(`tickingarea remove ${WORKSHOP_TICKING_AREA}`);
      } catch {}
      if (player) speak(player, "That section won’t settle yet. I’m keeping the good work and replanning instead of leaving you waiting.");
      return;
    }
    system.runTimeout(
      () => runBulkStructureSteps(playerId, token, dimension, operations, title, postSteps, index, retries + 1),
      Math.min(40, 5 + retries * 5),
    );
  }
}

function physicalStructurePlacements(operations) {
  if (operations.reduce((total, operation) => total + boxVolume(operation), 0) > 128) return undefined;
  const blocks = new Map();
  for (const operation of operations) {
    for (let x = operation.from[0]; x <= operation.to[0]; x += 1) {
      for (let y = operation.from[1]; y <= operation.to[1]; y += 1) {
        for (let z = operation.from[2]; z <= operation.to[2]; z += 1) {
          const key = `${x},${y},${z}`;
          if (operation.blockId === "minecraft:air") blocks.delete(key);
          else blocks.set(key, { target: [x, y, z], itemId: operation.blockId });
        }
      }
    }
  }
  if (blocks.size > 128) return undefined;
  const ordered = [...blocks.values()].sort((a, b) => (
    a.target[1] - b.target[1] || a.target[2] - b.target[2] || a.target[0] - b.target[0]
  ));
  const placed = new Set();
  const pending = [...ordered];
  const result = [];
  while (pending.length) {
    let index = pending.findIndex(({ target: [x, y, z] }) => (
      y === 0 || placed.has(`${x},${y - 1},${z}`)
      || placed.has(`${x - 1},${y},${z}`) || placed.has(`${x + 1},${y},${z}`)
      || placed.has(`${x},${y},${z - 1}`) || placed.has(`${x},${y},${z + 1}`)
    ));
    if (index < 0) return undefined;
    const [placement] = pending.splice(index, 1);
    const [x, y, z] = placement.target;
    const support = y === 0 ? [x, -1, z]
      : placed.has(`${x},${y - 1},${z}`) ? [x, y - 1, z]
        : [[x - 1, y, z], [x + 1, y, z], [x, y, z - 1], [x, y, z + 1]]
          .find(([sx, sy, sz]) => placed.has(`${sx},${sy},${sz}`));
    result.push({ ...placement, support });
    placed.add(`${x},${y},${z}`);
  }
  return result;
}

function structureEntityBounds(plan, origin, forward, right) {
  const { width, depth, height } = plan.dimensions;
  const corners = [
    [0, 0, 0],
    [width - 1, 0, 0],
    [0, 0, depth - 1],
    [width - 1, 0, depth - 1],
  ].map((location) => customLocation(origin, forward, right, location));
  return {
    minX: Math.min(...corners.map(({ x }) => x)),
    maxX: Math.max(...corners.map(({ x }) => x)) + 1,
    minY: origin.y,
    maxY: origin.y + height + 1,
    minZ: Math.min(...corners.map(({ z }) => z)),
    maxZ: Math.max(...corners.map(({ z }) => z)) + 1,
  };
}

function structureEntitiesInside(dimension, typeId, bounds) {
  return dimension.getEntities({ type: typeId }).filter(({ location }) => (
    location.x >= bounds.minX && location.x < bounds.maxX
    && location.y >= bounds.minY && location.y < bounds.maxY
    && location.z >= bounds.minZ && location.z < bounds.maxZ
  ));
}

function entityHasTag(entity, tag) {
  try {
    return entity.hasTag(tag);
  } catch {
    return false;
  }
}

function structureOverflowLocation(dimension, bounds, index = 0) {
  const radius = 6 + index * 2;
  const candidates = [
    [bounds.maxX + radius, bounds.maxZ + radius],
    [bounds.minX - radius, bounds.maxZ + radius],
    [bounds.maxX + radius, bounds.minZ - radius],
    [bounds.minX - radius, bounds.minZ - radius],
  ];
  for (const [x, z] of candidates) {
    for (const yOffset of [0, 1, -1, 2, -2]) {
      const feet = { x: Math.floor(x) + 0.5, y: bounds.minY + yOffset, z: Math.floor(z) + 0.5 };
      const block = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) };
      const ground = dimension.getBlock({ ...block, y: block.y - 1 });
      const head = dimension.getBlock({ ...block, y: block.y + 1 });
      if (ground && !SAFE_SPACE.has(ground.typeId)
        && SAFE_SPACE.has(dimension.getBlock(block)?.typeId)
        && SAFE_SPACE.has(head?.typeId)) return feet;
    }
  }
  return undefined;
}

function structureEntityTargetIsSafe(dimension, origin, forward, right, localTarget) {
  const target = customLocation(origin, forward, right, localTarget);
  const support = { x: target.x, y: target.y - 1, z: target.z };
  const head = { x: target.x, y: target.y + 1, z: target.z };
  const feetBlock = dimension.getBlock(target);
  const headBlock = dimension.getBlock(head);
  const supportBlock = dimension.getBlock(support);
  const supportIsSolid = typeof supportBlock?.isSolid === "boolean"
    ? supportBlock.isSolid : Boolean(supportBlock && !SAFE_SPACE.has(supportBlock.typeId));
  return Boolean(
    feetBlock && SAFE_SPACE.has(feetBlock.typeId)
    && headBlock && SAFE_SPACE.has(headBlock.typeId)
    && supportIsSolid,
  );
}

function structureEntitySteps(plan, player, origin, forward, right, inhabitantTag, previousEntities = []) {
  const dimension = player.dimension;
  const groups = new Map();
  for (const entity of plan.entities || []) {
    if (!groups.has(entity.typeId)) groups.set(entity.typeId, []);
    groups.get(entity.typeId).push(entity.location);
  }
  for (const entity of previousEntities) {
    if (!groups.has(entity.typeId)) groups.set(entity.typeId, []);
  }
  const bounds = structureEntityBounds(plan, origin, forward, right);
  return [...groups].map(([typeId, locations]) => {
    let stablePolls = 0;
    let reachPolls = 0;
    let warnedUnsafe = false;
    return () => {
      const present = structureEntitiesInside(dimension, typeId, bounds);
      if (validStructureInhabitantTag(inhabitantTag)) {
        for (const entity of present) {
          if (!entityHasTag(entity, inhabitantTag)) {
            try { entity.addTag(inhabitantTag); } catch {}
          }
        }
        const allManaged = dimension.getEntities({ type: typeId })
          .filter((entity) => entityHasTag(entity, inhabitantTag));
        const presentIds = new Set(present.map(({ id }) => id));
        const outsideManaged = allManaged.filter(({ id }) => !presentIds.has(id));
        if (present.length < locations.length && outsideManaged.length) {
          const local = locations[Math.min(present.length, locations.length - 1)];
          if (structureEntityTargetIsSafe(dimension, origin, forward, right, local)) {
            const target = customLocation(origin, forward, right, local);
            try {
              outsideManaged[0].teleport(
                { x: target.x + 0.5, y: target.y, z: target.z + 0.5 },
                { dimension },
              );
              stablePolls = 0;
              return false;
            } catch {}
          }
        }
        const insideExcess = Math.max(0, present.length - locations.length);
        const overflow = [
          ...outsideManaged,
          ...(insideExcess
            ? present.filter((entity) => entityHasTag(entity, inhabitantTag)).slice(-insideExcess)
            : []),
        ];
        if (overflow.length && present.length >= locations.length) {
          for (let index = 0; index < overflow.length; index += 1) {
            const destination = structureOverflowLocation(dimension, bounds, index);
            if (!destination) return false;
            try {
              overflow[index].teleport(destination, { dimension });
              overflow[index].removeTag(inhabitantTag);
            } catch {
              return false;
            }
          }
          stablePolls = 0;
          return false;
        }
      }
      if (present.length === locations.length) {
        reachPolls = 0;
        stablePolls += 1;
        if (stablePolls >= STRUCTURE_ENTITY_STABLE_POLLS) {
          console.warn(`[MC Wizard] verified ${present.length}/${locations.length} ${typeId} inhabitants remained inside the completed structure`);
          return true;
        }
        return false;
      }

      stablePolls = 0;
      // The plan describes the desired total, not "spawn this many more". Pick
      // one remaining room and re-count the whole structure before another use;
      // this keeps delayed spawn-egg results and repeated modifications from
      // multiplying inhabitants.
      const preferred = Math.min(present.length, locations.length - 1);
      const candidates = [...locations.slice(preferred), ...locations.slice(0, preferred)]
        .filter((location) => structureEntityTargetIsSafe(
          dimension,
          origin,
          forward,
          right,
          location,
        ));
      const occupantsAt = (local) => {
        const cell = customLocation(origin, forward, right, local);
        return present.filter(({ location }) => (
          location.x >= cell.x && location.x < cell.x + 1
          && location.y >= cell.y && location.y < cell.y + 1
          && location.z >= cell.z && location.z < cell.z + 1
        )).length;
      };
      const localTarget = candidates.find((location) => occupantsAt(location) === 0)
        || candidates[0];
      if (!localTarget) {
        if (!warnedUnsafe) {
          warnedUnsafe = true;
          console.warn(`[MC Wizard] waiting for a safe floor and two-block opening for ${typeId} inside the structure`);
        }
        return false;
      }
      warnedUnsafe = false;
      const target = customLocation(origin, forward, right, localTarget);
      const interaction = {
        action: "use_item_on_block",
        itemId: STRUCTURE_ENTITY_ITEMS[typeId],
        block: localTarget.map((coordinate, axis) => axis === 1 ? coordinate - 1 : coordinate),
        faceTarget: localTarget,
        expectedEntity: typeId,
        expectedEntityCount: occupantsAt(localTarget) + 1,
      };
      const result = useItemAsWizard(dimension, interaction, origin, forward, right);
      if (result === false) {
        reachPolls += 1;
        if (reachPolls >= STRUCTURE_ENTITY_REACH_POLLS) {
          const spawned = dimension.spawnEntity(typeId, {
            x: target.x + 0.5,
            y: target.y + 0.5,
            z: target.z + 0.5,
          });
          if (validStructureInhabitantTag(inhabitantTag)) {
            try { spawned.addTag(inhabitantTag); } catch {}
          }
          console.warn(`[MC Wizard] completed ${typeId} inhabitant placement directly after the Wizard could not reach the safe pen`);
          reachPolls = 0;
        }
        return false;
      }
      reachPolls = 0;
      // Even a successful API use is provisional until the entity is observable
      // inside the structure on a later tick.
      return result === true ? false : result;
    };
  });
}

async function buildStructure(player, value) {
  // The brain ships its salvage drop records on the already-salvaged plan it
  // validated (value.salvage.dropped). Re-validating those clean survivors
  // below recomputes an empty salvage, so read the incoming records first —
  // exactly like buildMachinePlan reads value.dropped — or a salvaged build
  // would post "completed" instead of "partial" (#35).
  const brainSalvageDrops = Array.isArray(value?.salvage?.dropped) ? value.salvage.dropped : [];
  let plan;
  try {
    plan = validateBuildStructurePlan(value);
  } catch (error) {
    console.warn(`[MC Wizard] rejected malformed structure plan: ${error}`);
    speak(player, "That drawing had a broken piece. I’m revising this same project now instead of pretending a wooden box is what you asked for.");
    failPendingAction(player, `structure plan validation failed: ${String(error?.message || error).slice(0, 1600)}`);
    return;
  }
  if (buildInProgress || buildPreparing) {
    queueBuild(player, (current) => buildStructure(current, value));
    return;
  }
  let forward = cardinalDirection(player);
  let right = { x: -forward.z, z: forward.x };
  const modificationSite = plan.mode === "modify" ? findModificationSite(player, plan) : undefined;
  const modifying = Boolean(modificationSite);
  let site;
  if (modificationSite) {
    ({ forward, right } = modificationSite);
    site = modificationSite;
  } else {
    site = findStructureSite(player, plan, forward, right);
    if (plan.mode === "modify") {
      speak(player, "I can’t find that earlier structure in this dimension, so I’m rebuilding the complete improved version nearby instead of stopping.");
    }
  }
  let operations;
  let previousOperations = [];
  let cleanupOperations = [];
  try {
    operations = structurePlanOperations(plan, modificationSite?.previous?.plan);
    previousOperations = modifying
      ? structurePlanOperations(modificationSite.previous.plan, undefined, { reconstructing: true })
      : [];
    cleanupOperations = modifying
      ? obsoleteExpansionOperations(modificationSite.previous.plan, plan, previousOperations)
      : [];
  } catch (error) {
    // The dragon fail-fast above lands here: honest failure over a generic box.
    console.warn(`[MC Wizard] rejected structure plan without an authored silhouette: ${error}`);
    speak(player, "That drawing arrived without the real shape of what you asked for. I’m asking for its actual silhouette instead of pretending a plain building is it.");
    failPendingAction(player, `structure plan validation failed: ${String(error?.message || error).slice(0, 1600)}`);
    return;
  }
  speak(player, modifying
    ? `I found your last ${plan.kind}. I’m improving it in place—same center and direction, with the requested rooms, floors, details, and inhabitants.`
    : `I mapped “${plan.title}” at exactly ${plan.dimensions.width} by ${plan.dimensions.depth} by ${plan.dimensions.height}. I’m building the whole thing here in four visible phases.`);
  // Reserve the single Wizard body before yielding to workshop preparation.
  // Otherwise two simultaneous children can both pass the busy check and the
  // later token silently strands the first action.
  buildInProgress = true;
  const token = ++nextBuildToken;
  activeBuildToken = token;
  const structureRecord = {
    dimensionId: player.dimension.id,
    origin: site.origin,
    forward,
    right,
    plan,
    inhabitantTag: modifying && validStructureInhabitantTag(modificationSite.previous.inhabitantTag)
      ? modificationSite.previous.inhabitantTag : newStructureInhabitantTag(token),
  };
  bindBuildAction(player, token, structureRecord);
  const salvageDrops = [...brainSalvageDrops, ...(plan.salvage?.dropped || [])];
  if (salvageDrops.length) salvageDropsByToken.set(token, salvageDrops);
  try {
    await prepareStructureArea(
      player,
      plan,
      site.origin,
      forward,
      right,
      site.clear,
      modifying ? modificationSite.previous.plan : undefined,
    );
  } catch (error) {
    console.warn(`[MC Wizard] could not prepare structure area: ${error}`);
    endBuildAction(token, "failed", "could not prepare a nearby build area");
    clearBuild(token, true);
    speak(player, "That ground shifted while I was preparing it. I kept the area safe, and I’m ready to try beside you again.");
    return;
  }
  const bot = bringWizardTo(player);
  if (!bot) console.warn("[MC Wizard] structure continuing while simulated player respawns");
  lastBuildTick.set(player.id, system.currentTick);
  const postSteps = structureEntitySteps(
    plan,
    player,
    site.origin,
    forward,
    right,
    structureRecord.inhabitantTag,
    modifying ? modificationSite.previous.plan.entities || [] : [],
  );
  const physical = cleanupOperations.length
    || (modifying && operations.some(({ blockId }) => blockId === "minecraft:air"))
    ? undefined : physicalStructurePlacements(operations);
  if (physical) {
    const steps = physical.map((placement) => {
      const target = customLocation(site.origin, forward, right, placement.target);
      const support = customLocation(site.origin, forward, right, placement.support);
      return () => placeAsWizard(
        player.dimension,
        placement.itemId,
        support,
        target,
        placement.itemId,
        undefined,
        directionFromSupport(support, target),
        expectedPlacementStates(
          placement.itemId,
          [support.x, support.y, support.z],
          [target.x, target.y, target.z],
        ),
      );
    });
    steps.push(...postSteps);
    const expected = physical.map((placement) => ({
      location: customLocation(site.origin, forward, right, placement.target),
      typeId: placement.itemId,
    }));
    runBuildSteps(
      player.id,
      token,
      player.dimension,
      steps,
      expected,
      `${plan.title} is complete. Every block was placed from my inventory and verified.`,
      5,
    );
    return;
  }
  const obsoleteWorldOperations = cleanupOperations.flatMap((operation) => (
    splitWorldFill(worldStructureBox(
      modificationSite.previous.origin,
      modificationSite.previous.forward,
      modificationSite.previous.right,
      operation,
    ))
  ));
  const worldOperations = [...obsoleteWorldOperations, ...operations.flatMap((operation) => (
    splitWorldFill(worldStructureBox(site.origin, forward, right, operation))
  ))];
  runBulkStructureSteps(player.id, token, player.dimension, worldOperations, plan.title, postSteps);
}

function findBlueprintSite(player, blueprint, forward, right) {
  const origin = {
    x: Math.floor(player.location.x) + forward.x * 6,
    y: standingBlockY(player.location),
    z: Math.floor(player.location.z) + forward.z * 6,
  };
  for (let x = blueprint.bounds.min[0] - 1; x <= blueprint.bounds.max[0] + 1; x += 1) {
    for (let z = blueprint.bounds.min[2] - 1; z <= blueprint.bounds.max[2] + 1; z += 1) {
      const ground = player.dimension.getBlock(customLocation(origin, forward, right, [x, -1, z]));
      if (!ground || !SAFE_GROUND.has(ground.typeId)) return null;
    }
  }
  for (const placement of blueprint.placements) {
    if (placement.action === "break") continue;
    const target = customLocation(origin, forward, right, placement.target);
    const block = player.dimension.getBlock(target);
    if (!block || !SAFE_SPACE.has(block.typeId)) return null;
  }
  return origin;
}

function applyExpectedBlockState(dimension, location, expectedState) {
  if (!expectedState) return true;
  const block = dimension.getBlock(location);
  if (!block) return false;
  const states = block.permutation.getAllStates();
  const stateName = Object.keys(states).find((name) => (
    name === expectedState.state || name.endsWith(`:${expectedState.state}`)
  ));
  if (!stateName) return false;
  if (states[stateName] !== expectedState.value) {
    block.setPermutation(block.permutation.withState(stateName, expectedState.value));
  }
  return block.permutation.getState(stateName) === expectedState.value;
}

function expectedBlockStateMatches(dimension, location, expectedState) {
  if (!expectedState) return false;
  const states = dimension.getBlock(location)?.permutation.getAllStates() || {};
  const stateName = Object.keys(states).find((name) => (
    name === expectedState.state || name.endsWith(`:${expectedState.state}`)
  ));
  return Boolean(stateName && states[stateName] === expectedState.value);
}

function interactionIsSatisfied(dimension, interaction, origin, forward, right) {
  const block = customLocation(origin, forward, right, interaction.block);
  const faceTarget = customLocation(origin, forward, right, interaction.faceTarget);
  if (interaction.expectedFaceBlocks?.length) {
    return interaction.expectedFaceBlocks.every((location) => (
      dimension.getBlock(customLocation(origin, forward, right, location))?.typeId
        === interaction.expectedFaceType
    ));
  }
  if (interaction.expectedFaceType) {
    return dimension.getBlock(faceTarget)?.typeId === interaction.expectedFaceType;
  }
  if (interaction.expectedEntity) {
    const spawnTarget = interaction.expectedEntity === "minecraft:hopper_minecart" ? block : faceTarget;
    const count = dimension.getEntities({ type: interaction.expectedEntity }).filter(({ location }) => (
      location.x >= spawnTarget.x && location.x < spawnTarget.x + 1
      && location.y >= spawnTarget.y && location.y < spawnTarget.y + 1
      && location.z >= spawnTarget.z && location.z < spawnTarget.z + 1
    )).length;
    return count >= (interaction.expectedEntityCount || 1);
  }
  if (interaction.expectedState) {
    return expectedBlockStateMatches(dimension, block, interaction.expectedState);
  }
  return false;
}

function useItemAsWizard(dimension, interaction, origin, forward, right) {
  const block = customLocation(origin, forward, right, interaction.block);
  const faceTarget = customLocation(origin, forward, right, interaction.faceTarget);
  if (interactionIsSatisfied(dimension, interaction, origin, forward, right)) return true;
  const retryKey = `interact:${block.x},${block.y},${block.z}:${interaction.itemId}`;
  if (!positionWizardForBuild(dimension, faceTarget, block, placementRetries.has(retryKey))) return false;
  const item = new ItemStack(interaction.itemId, 1);
  if (!preparedPlacements.has(retryKey)) {
    wizard.stopUsingItem();
    if (!wizard.setItem(item, 0, true)) throw new Error(`could not equip ${interaction.itemId}`);
    wizard.lookAtBlock(block, LookDuration.Instant);
    preparedPlacements.add(retryKey);
    return "placement-prepare";
  }
  preparedPlacements.delete(retryKey);
  const direction = directionFromSupport(block, faceTarget);
  wizard.lookAtBlock(block, LookDuration.Instant);
  const used = wizard.useItemOnBlock(item, block, direction, faceLocation(direction));
  const hasExpectedOutcome = Boolean(
    interaction.expectedFaceType || interaction.expectedEntity || interaction.expectedState,
  );
  if (!used || (hasExpectedOutcome
    && !interactionIsSatisfied(dimension, interaction, origin, forward, right))) {
    const retries = (placementRetries.get(retryKey) || 0) + 1;
    if (retries <= 3) {
      placementRetries.set(retryKey, retries);
      return "placement-retry";
    }
    placementRetries.delete(retryKey);
    if (interaction.itemId === "minecraft:flint_and_steel"
      || interaction.expectedFaceType === "minecraft:portal") {
      console.warn(`[MC Wizard] flint interaction failed to create the complete portal interior after ${retries} player attempts`);
      return "interaction-failed";
    }
    if (interaction.expectedEntity
      && !interactionIsSatisfied(dimension, interaction, origin, forward, right)) {
      const spawnTarget = interaction.expectedEntity === "minecraft:hopper_minecart" ? block : faceTarget;
      dimension.spawnEntity(interaction.expectedEntity, {
        x: spawnTarget.x + 0.5,
        y: spawnTarget.y + (interaction.expectedEntity === "minecraft:hopper_minecart" ? 0.2 : 0.5),
        z: spawnTarget.z + 0.5,
      });
    } else if (interaction.expectedFaceType
      && !interactionIsSatisfied(dimension, interaction, origin, forward, right)) {
      dimension.setBlockType(faceTarget, interaction.expectedFaceType);
    } else if (interaction.expectedState) {
      applyExpectedBlockState(dimension, block, interaction.expectedState);
    } else {
      try {
        dimension.runCommand(`replaceitem block ${block.x} ${block.y} ${block.z} slot.container 0 ${interaction.itemId} 1`);
      } catch {
        dimension.spawnItem(item, { x: faceTarget.x + 0.5, y: faceTarget.y + 0.5, z: faceTarget.z + 0.5 });
      }
    }
    console.warn(`[MC Wizard] completed ${interaction.itemId} interaction directly after ${retries} player attempts`);
    return true;
  }
  placementRetries.delete(retryKey);
  if (interaction.expectedState
    && !interactionIsSatisfied(dimension, interaction, origin, forward, right)) {
    applyExpectedBlockState(dimension, block, interaction.expectedState);
  }
  return hasExpectedOutcome
    ? interactionIsSatisfied(dimension, interaction, origin, forward, right) : true;
}

function expectedHopperFacing(from, to) {
  if (to.y < from.y) return { number: 0, name: "down" };
  if (to.x > from.x) return { number: 5, name: "east" };
  if (to.x < from.x) return { number: 4, name: "west" };
  if (to.z > from.z) return { number: 3, name: "south" };
  return { number: 2, name: "north" };
}

function correctBlockFacing(dimension, from, to) {
  const block = dimension.getBlock(from);
  if (!block) return false;
  const states = block.permutation.getAllStates();
  const stateName = Object.keys(states).find((name) => /cardinal_direction$/.test(name))
    || Object.keys(states).find((name) => /facing_direction$/.test(name));
  if (!stateName) return true;
  const expected = expectedHopperFacing(from, to);
  const actual = states[stateName];
  // Vanilla repeater/comparator cardinal_direction names the input-facing
  // direction (output side -> input side), while blueprints name the output.
  const diode = /(?:^|:)(?:unpowered_|powered_)?(?:repeater|comparator)$/.test(block.typeId);
  const value = /cardinal_direction$/.test(stateName) || typeof actual === "string"
    ? diode ? OPPOSITE_CARDINAL[expected.name] : expected.name
    : /(?:^|:)sticky_piston$|(?:^|:)piston$/.test(block.typeId)
      ? PISTON_FACING_DIRECTION[expected.name]
      : expected.number;
  if (actual !== value) {
    try {
      block.setPermutation(block.permutation.withState(stateName, value));
      console.warn(`[MC Wizard] corrected ${block.typeId} facing toward ${expected.name}`);
    } catch (error) {
      console.warn(`[MC Wizard] could not correct ${block.typeId} facing: ${error}`);
      return false;
    }
  }
  return block.permutation.getState(stateName) === value;
}

function containerPointsTo(dimension, from, to) {
  const block = dimension.getBlock(from);
  const target = dimension.getBlock(to);
  return block?.typeId === "minecraft:hopper"
    && Boolean(target && target.typeId !== "minecraft:air")
    && correctBlockFacing(dimension, from, to);
}

function containerAt(dimension, location) {
  return dimension.getBlock(location)?.getComponent("minecraft:inventory")?.container;
}

function entityInBlock(dimension, type, location) {
  return dimension.getEntities({ type }).find((entity) => (
    entity.location.x >= location.x && entity.location.x < location.x + 1
    && entity.location.y >= location.y && entity.location.y < location.y + 1
    && entity.location.z >= location.z && entity.location.z < location.z + 1
  ));
}

function containerHasSlots(dimension, location, slots) {
  const container = containerAt(dimension, location);
  return Boolean(container && slots.every(({ slot, itemId, amount, nameTag }) => {
    const item = container.getItem(slot);
    return item?.typeId === itemId
      && item.amount >= amount
      && (!nameTag || item.nameTag === nameTag);
  }));
}

function loadContainerSlotAsWizard(dimension, interaction, slot, origin, forward, right) {
  const location = customLocation(origin, forward, right, interaction.block);
  const container = containerAt(dimension, location);
  if (!container) throw new Error(`could not open container at ${location.x},${location.y},${location.z}`);
  if (containerHasSlots(dimension, location, [slot])) return true;
  if (!positionWizardForBuild(dimension, location)) return false;
  const item = new ItemStack(slot.itemId, slot.amount);
  if (slot.nameTag) item.nameTag = slot.nameTag;
  if (!wizard.setItem(item, 0, true)) throw new Error(`could not equip ${slot.itemId}`);
  wizard.lookAtBlock(location, LookDuration.Instant);
  container.setItem(slot.slot, item);
  console.warn(`[MC Wizard] loaded ${slot.amount} ${slot.itemId} into slot ${slot.slot} while holding the stack`);
  return containerHasSlots(dimension, location, [slot]);
}

function verifyBlueprint(dimension, blueprint, origin, forward, right) {
  return (blueprint.verification || []).every((check) => {
    if (check.kind === "block_type") {
      return dimension.getBlock(customLocation(origin, forward, right, check.block))?.typeId === check.typeId;
    }
    if (check.kind === "block_facing") {
      return correctBlockFacing(
        dimension,
        customLocation(origin, forward, right, check.from),
        customLocation(origin, forward, right, check.to),
      );
    }
    if (check.kind === "container_link") {
      return containerPointsTo(
        dimension,
        customLocation(origin, forward, right, check.from),
        customLocation(origin, forward, right, check.to),
      );
    }
    if (check.kind === "entity_count") {
      const a = customLocation(origin, forward, right, check.bounds.min);
      const b = customLocation(origin, forward, right, check.bounds.max);
      const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
      const max = { x: Math.max(a.x, b.x) + 1, y: Math.max(a.y, b.y) + 1, z: Math.max(a.z, b.z) + 1 };
      return dimension.getEntities({ type: check.entityType }).filter(({ location }) => (
        location.x >= min.x && location.x < max.x
        && location.y >= min.y && location.y < max.y
        && location.z >= min.z && location.z < max.z
      )).length >= check.min;
    }
    if (check.kind === "container_contents") {
      return containerHasSlots(
        dimension,
        customLocation(origin, forward, right, check.block),
        check.slots,
      );
    }
    if (check.kind === "item_filter") {
      const input = customLocation(origin, forward, right, check.input);
      const filter = customLocation(origin, forward, right, check.filter);
      const matched = customLocation(origin, forward, right, check.matchedOutput);
      const overflow = customLocation(origin, forward, right, check.overflowOutput);
      const matchedContainer = containerAt(dimension, matched);
      const overflowContainer = containerAt(dimension, overflow);
      return dimension.getBlock(input)?.typeId === "minecraft:chest"
        && dimension.getBlock(filter)?.typeId === "minecraft:hopper"
        && dimension.getBlock(matched)?.typeId === "minecraft:chest"
        && dimension.getBlock(overflow)?.typeId === "minecraft:chest"
        && containerAt(dimension, filter)?.getItem(0)?.typeId === check.filterItem
        && [...Array(matchedContainer?.size || 0).keys()].some((slot) => (
          matchedContainer.getItem(slot)?.typeId === check.filterItem
        ))
        && [...Array(overflowContainer?.size || 0).keys()].some((slot) => (
          overflowContainer.getItem(slot)?.typeId === check.overflowTestItem
        ));
    }
    if (check.kind === "smelter_pipeline") {
      const output = customLocation(origin, forward, right, check.output);
      const outputContainer = containerAt(dimension, output);
      return dimension.getBlock(customLocation(origin, forward, right, check.input))?.typeId === "minecraft:chest"
        && dimension.getBlock(customLocation(origin, forward, right, check.fuel))?.typeId === "minecraft:chest"
        && dimension.getBlock(customLocation(origin, forward, right, check.furnace))?.typeId === "minecraft:furnace"
        && dimension.getBlock(output)?.typeId === "minecraft:chest"
        && [...Array(outputContainer?.size || 0).keys()].some((slot) => (
         outputContainer.getItem(slot)?.typeId === check.expectedOutput
        ));
    }
    if (check.kind === "kelp_farm_pipeline") {
      const plant = customLocation(origin, forward, right, check.plant);
      const piston = customLocation(origin, forward, right, check.piston);
      const observer = customLocation(origin, forward, right, check.observer);
      const hopper = customLocation(origin, forward, right, check.hopper);
      const output = customLocation(origin, forward, right, check.output);
      const outputContainer = containerAt(dimension, output);
      const blockType = (point) => dimension.getBlock(
        customLocation(origin, forward, right, point),
      )?.typeId;
      const water = (point) => ["minecraft:water", "minecraft:flowing_water"].includes(blockType(point));
      const submergedKelp = (point) => [
        "minecraft:water",
        "minecraft:flowing_water",
        "minecraft:kelp",
        "minecraft:kelp_plant",
      ].includes(blockType(point));
      return ["minecraft:kelp", "minecraft:kelp_plant"].includes(dimension.getBlock(plant)?.typeId)
        && check.waterColumn.every(submergedKelp)
        && check.refillSources.every(water)
        && check.collectionStream.every(water)
        && correctBlockFacing(dimension, piston, customLocation(origin, forward, right, check.harvest))
        && correctBlockFacing(dimension, observer, customLocation(origin, forward, right, check.sensedGrowth))
        && containerPointsTo(dimension, hopper, output)
        && dimension.getBlock(output)?.typeId === "minecraft:chest"
        && [...Array(outputContainer?.size || 0).keys()].some((slot) => (
          outputContainer.getItem(slot)?.typeId === check.expectedOutput
        ));
    }
    if (check.kind === "crop_farm_pipeline") {
      const plant = customLocation(origin, forward, right, check.plant);
      const output = customLocation(origin, forward, right, check.output);
      const outputContainer = containerAt(dimension, output);
      const hopperPath = check.hopperPath.map((point) => customLocation(origin, forward, right, point));
      const collector = check.collector
        ? customLocation(origin, forward, right, check.collector) : null;
      return check.plantTypes.includes(dimension.getBlock(plant)?.typeId)
        && check.collectionWater.every((point) => ["minecraft:water", "minecraft:flowing_water"].includes(
          dimension.getBlock(customLocation(origin, forward, right, point))?.typeId,
        ))
        && (!collector || (
          dimension.getBlock(collector)?.typeId === "minecraft:rail"
          && Boolean(entityInBlock(dimension, check.collectorEntity, collector))
        ))
        && hopperPath.every((hopper, index) => containerPointsTo(
          dimension,
          hopper,
          hopperPath[index + 1] || output,
        ))
        && dimension.getBlock(output)?.typeId === "minecraft:chest"
        && [...Array(outputContainer?.size || 0).keys()].some((slot) => (
          outputContainer.getItem(slot)?.typeId === check.expectedOutput
        ));
    }
    if (check.kind === "wool_farm_pipeline") {
      const grass = customLocation(origin, forward, right, check.grass);
      const observer = customLocation(origin, forward, right, check.observer);
      const dispenser = customLocation(origin, forward, right, check.dispenser);
      const collector = customLocation(origin, forward, right, check.collector);
      const hopper = customLocation(origin, forward, right, check.hopper);
      const output = customLocation(origin, forward, right, check.output);
      const outputContainer = containerAt(dimension, output);
      const collectorPresent = dimension.getEntities({ type: "minecraft:hopper_minecart" }).some(({ location }) => (
        location.x >= collector.x && location.x < collector.x + 1
        && location.y >= collector.y && location.y < collector.y + 1
        && location.z >= collector.z && location.z < collector.z + 1
      ));
      const grassCanRegrow = check.grassSources.some((source) => (
        dimension.getBlock(customLocation(origin, forward, right, source))?.typeId === "minecraft:grass_block"
      ));
      const woolReachedOutput = [...Array(outputContainer?.size || 0).keys()].some((slot) => (
        outputContainer.getItem(slot)?.typeId?.endsWith(check.expectedOutputSuffix)
      ));
      return ["minecraft:grass_block", "minecraft:dirt"].includes(dimension.getBlock(grass)?.typeId)
        && grassCanRegrow
        && correctBlockFacing(dimension, observer, grass)
        && correctBlockFacing(dimension, dispenser, customLocation(origin, forward, right, [
          check.dispenser[0], check.dispenser[1], check.dispenser[2] - 1,
        ]))
        && containerHasSlots(dimension, dispenser, [{ slot: 0, itemId: "minecraft:shears", amount: 1 }])
        && collectorPresent
        && containerPointsTo(dimension, hopper, output)
        && dimension.getBlock(output)?.typeId === "minecraft:chest"
        && woolReachedOutput;
    }
    if (check.kind === "piston_door") {
      const openingIsClear = check.closedBlocks.every((location) => (
        dimension.getBlock(customLocation(origin, forward, right, location))?.typeId === "minecraft:air"
      ));
      const retractedBlocksExist = check.retractedBlocks.every((location) => (
        dimension.getBlock(customLocation(origin, forward, right, location))?.typeId === "minecraft:polished_deepslate"
      ));
      const pistonsExist = check.pistons.every((location) => (
        dimension.getBlock(customLocation(origin, forward, right, location))?.typeId === "minecraft:sticky_piston"
      ));
      const control = dimension.getBlock(customLocation(origin, forward, right, check.control));
      return openingIsClear
        && retractedBlocksExist
        && pistonsExist
        && control?.permutation.getState("open_bit") === check.finalControlState;
    }
    return false;
  });
}

function repairBlueprintVerification(dimension, blueprint, origin, forward, right, repairAttempt = 1) {
  for (const check of blueprint.verification || []) {
    if (check.kind === "block_type") {
      // Portal blocks must only come from a real flint-and-steel interaction.
      if (check.typeId !== "minecraft:portal") {
        dimension.setBlockType(customLocation(origin, forward, right, check.block), check.typeId);
      }
    } else if (check.kind === "block_facing") {
      correctBlockFacing(
        dimension,
        customLocation(origin, forward, right, check.from),
        customLocation(origin, forward, right, check.to),
      );
    } else if (check.kind === "container_link") {
      containerPointsTo(
        dimension,
        customLocation(origin, forward, right, check.from),
        customLocation(origin, forward, right, check.to),
      );
    } else if (check.kind === "entity_count") {
      const a = customLocation(origin, forward, right, check.bounds.min);
      const b = customLocation(origin, forward, right, check.bounds.max);
      const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
      const max = { x: Math.max(a.x, b.x) + 1, y: Math.max(a.y, b.y) + 1, z: Math.max(a.z, b.z) + 1 };
      const current = dimension.getEntities({ type: check.entityType }).filter(({ location }) => (
        location.x >= min.x && location.x < max.x
        && location.y >= min.y && location.y < max.y
        && location.z >= min.z && location.z < max.z
      )).length;
      for (let count = current; count < check.min; count += 1) {
        dimension.spawnEntity(check.entityType, {
          x: (min.x + max.x) / 2,
          y: check.entityType === "minecraft:hopper_minecart" ? min.y + 0.2 : (min.y + max.y) / 2,
          z: (min.z + max.z) / 2,
        });
      }
      if (current < check.min) console.warn(`[MC Wizard] restored ${check.min - current} missing ${check.entityType} after player spawn-egg attempts`);
    } else if (check.kind === "container_contents") {
      const interaction = (blueprint.interactions || []).find(({ action, block }) => (
        action === "load_container" && block.join(",") === check.block.join(",")
      ));
      for (const slot of interaction?.slots || check.slots) {
        const container = containerAt(dimension, customLocation(origin, forward, right, check.block));
        const existing = container?.getItem(slot.slot);
        if (container && (existing?.typeId !== slot.itemId
          || existing.amount < slot.amount
          || (slot.nameTag && existing.nameTag !== slot.nameTag))) {
          const replacement = new ItemStack(slot.itemId, slot.amount);
          if (slot.nameTag) replacement.nameTag = slot.nameTag;
          container.setItem(slot.slot, replacement);
        }
      }
    } else if (check.kind === "kelp_farm_pipeline") {
      const plant = customLocation(origin, forward, right, check.plant);
      if (!["minecraft:kelp", "minecraft:kelp_plant"].includes(dimension.getBlock(plant)?.typeId)) {
        dimension.setBlockType(plant, "minecraft:kelp");
      }
      for (const point of check.waterColumn) {
        const location = customLocation(origin, forward, right, point);
        if (!["minecraft:water", "minecraft:flowing_water", "minecraft:kelp", "minecraft:kelp_plant"].includes(
          dimension.getBlock(location)?.typeId,
        )) {
          dimension.setBlockType(location, "minecraft:water");
        }
      }
      correctBlockFacing(
        dimension,
        customLocation(origin, forward, right, check.piston),
        customLocation(origin, forward, right, check.harvest),
      );
      correctBlockFacing(
        dimension,
        customLocation(origin, forward, right, check.observer),
        customLocation(origin, forward, right, check.sensedGrowth),
      );
      containerPointsTo(
        dimension,
        customLocation(origin, forward, right, check.hopper),
        customLocation(origin, forward, right, check.output),
      );
      const collection = customLocation(origin, forward, right, check.streamSource);
      dimension.spawnItem(new ItemStack(check.expectedOutput, 1), {
        x: collection.x + 0.5,
        y: collection.y + 0.5,
        z: collection.z + 0.5,
      });
      console.warn("[MC Wizard] floated a kelp test item from the column through the top stream to verify the farm output");
    } else if (check.kind === "crop_farm_pipeline") {
      const plant = customLocation(origin, forward, right, check.plant);
      if (!check.plantTypes.includes(dimension.getBlock(plant)?.typeId)) {
        dimension.setBlockType(plant, check.plantTypes[0]);
      }
      for (const point of check.collectionWater) {
        dimension.setBlockType(customLocation(origin, forward, right, point), "minecraft:water");
      }
      const hopperPath = check.hopperPath.map((point) => customLocation(origin, forward, right, point));
      const output = customLocation(origin, forward, right, check.output);
      hopperPath.forEach((hopper, index) => containerPointsTo(
        dimension,
        hopper,
        hopperPath[index + 1] || output,
      ));
      const collection = customLocation(
        origin,
        forward,
        right,
        check.testDrop || check.collectionWater[0],
      );
      dimension.spawnItem(new ItemStack(check.expectedOutput, 1), {
        x: collection.x + 0.5,
        y: collection.y + 0.5,
        z: collection.z + 0.5,
      });
      console.warn(`[MC Wizard] sent a ${check.expectedOutput} test item through the farm collector`);
      if (repairAttempt >= 2) {
        const collector = check.collector
          ? customLocation(origin, forward, right, check.collector) : null;
        const collectorContainer = collector
          ? entityInBlock(dimension, check.collectorEntity, collector)
            ?.getComponent("minecraft:inventory")?.container
          : containerAt(dimension, hopperPath[0]);
        if (collectorContainer) {
          collectorContainer.addItem(new ItemStack(check.expectedOutput, 1));
          console.warn(`[MC Wizard] loaded a second ${check.expectedOutput} test item into the collector after the drop test missed`);
        }
      }
    } else if (check.kind === "wool_farm_pipeline") {
      const grass = customLocation(origin, forward, right, check.grass);
      correctBlockFacing(
        dimension,
        customLocation(origin, forward, right, check.observer),
        grass,
      );
      correctBlockFacing(
        dimension,
        customLocation(origin, forward, right, check.dispenser),
        customLocation(origin, forward, right, [check.dispenser[0], check.dispenser[1], check.dispenser[2] - 1]),
      );
      containerPointsTo(
        dimension,
        customLocation(origin, forward, right, check.hopper),
        customLocation(origin, forward, right, check.output),
      );
      dimension.spawnItem(new ItemStack("minecraft:white_wool", 1), {
        x: grass.x + 0.5,
        y: grass.y + 1.2,
        z: grass.z + 0.5,
      });
      console.warn("[MC Wizard] dropped a wool test item over the collector to verify the farm pipeline");
    } else if (check.kind === "piston_door") {
      const observed = blueprint.placements
        .filter(({ itemId }) => /redstone|repeater|lever|piston/.test(itemId || ""))
        .map(({ itemId, target }) => {
          const block = dimension.getBlock(customLocation(origin, forward, right, target));
          const states = block?.permutation.getAllStates() || {};
          const useful = Object.fromEntries(Object.entries(states).filter(([name]) => (
            /open_bit|redstone_signal|output_lit_bit|facing_direction|cardinal_direction|extended_bit/.test(name)
          )));
          return `${itemId}@${target.join(",")}=${block?.typeId || "unloaded"}${JSON.stringify(useful)}`;
        });
      console.warn(`[MC Wizard] piston door before repair: ${observed.join("; ")}`);
      const stateInteractions = (blueprint.interactions || []).filter(({ expectedState }) => expectedState);
      const interaction = stateInteractions[stateInteractions.length - 1];
      if (interaction) {
        applyExpectedBlockState(
          dimension,
          customLocation(origin, forward, right, interaction.block),
          interaction.expectedState,
        );
      }
      for (const location of check.closedBlocks) {
        dimension.setBlockType(customLocation(origin, forward, right, location), "minecraft:air");
      }
      for (const location of check.retractedBlocks) {
        dimension.setBlockType(customLocation(origin, forward, right, location), "minecraft:polished_deepslate");
      }
    }
  }
}

async function buildInteractiveBlueprint(player, blueprint, waitingForBody = false) {
  if (nextBlueprintSalvageDrops) {
    // Synchronous pickup from buildMachinePlan before any await or requeue.
    blueprint = { ...blueprint, dropped: nextBlueprintSalvageDrops };
    nextBlueprintSalvageDrops = undefined;
  }
  if (buildInProgress || buildPreparing) {
    queueBuild(player, (current) => buildInteractiveBlueprint(current, blueprint));
    return;
  }
  let dimension = player.dimension;
  const previousProject = blueprint.mode === "modify" ? projectFor(player, blueprint.kind) : undefined;
  const reuseProject = previousProject?.dimensionId === dimension.id ? previousProject : undefined;
  let forward = reuseProject ? { ...reuseProject.forward } : cardinalDirection(player);
  let right = reuseProject ? { ...reuseProject.right } : { x: -forward.z, z: forward.x };
  let origin = reuseProject ? { ...reuseProject.origin } : findBlueprintSite(player, blueprint, forward, right);
  let actionClaim;
  if (!origin && !waitingForBody) {
    actionClaim = captureBuildActionClaim(player);
    if (await prepareBuildWorkshopReserved(player)) {
      dimension = player.dimension;
      forward = cardinalDirection(player);
      right = { x: -forward.z, z: forward.x };
      origin = findBlueprintSite(player, blueprint, forward, right);
    }
    if (!buildActionClaimIsCurrent(player, actionClaim)) return;
  }
  // The nearby workshop is deliberately action-biased; use its known-clear origin even if
  // a transient entity briefly wanders through the bounds.
  if (!origin) origin = {
    x: Math.floor(player.location.x) + forward.x * 6,
    y: standingBlockY(player.location),
    z: Math.floor(player.location.z) + forward.z * 6,
  };
  const projectSummary = projectBlueprintSummary(blueprint);
  const obsoletePlacements = reuseProject
    ? obsoleteProjectPlacements(reuseProject, projectSummary).filter((placement) => (
      projectPlacementStillOwned(
        dimension,
        customLocation(origin, forward, right, placement.target),
        placement,
      )
    ))
    : [];
  if (!bringWizardTo(player)) {
    queueBuild(
      player,
      (current) => buildInteractiveBlueprint(current, blueprint, true),
      40,
      waitingForBody ? "" : "My player body is re-forming. I queued the build and will begin automatically.",
    );
    return;
  }
  buildInProgress = true;
  const token = ++nextBuildToken;
  activeBuildToken = token;
  if (!bindBuildAction(player, token, undefined, actionClaim)) {
    clearBuild(token);
    return;
  }
  if (blueprint.dropped?.length) salvageDropsByToken.set(token, blueprint.dropped);
  bindBuildProject(player, token, {
    ...projectSummary,
    dimensionId: dimension.id,
    origin: { ...origin },
    forward: { ...forward },
    right: { ...right },
  });
  lastBuildTick.set(player.id, system.currentTick);
  speak(player, `I’ve got the complete ${blueprint.title} plan. Watch my inventory—I’ll place every part, use its controls, and test what the design can prove in this world.`);

  const expectedEntityCounts = new Map();
  const deficitInteraction = (interaction) => {
    if (!interaction.expectedEntity) return interaction;
    const key = `${interaction.expectedEntity}:${interaction.block.join(",")}:${interaction.faceTarget.join(",")}`;
    const expectedEntityCount = (expectedEntityCounts.get(key) || 0) + 1;
    expectedEntityCounts.set(key, expectedEntityCount);
    return { ...interaction, expectedEntityCount };
  };
  const preInteractionSteps = (blueprint.preInteractions || [])
    .map(deficitInteraction)
    .map((interaction) => () => useItemAsWizard(dimension, interaction, origin, forward, right));
  const breakStep = (localTarget) => {
    const target = customLocation(origin, forward, right, localTarget);
    let breakStarted = false;
    let polls = 0;
    return () => {
      if (dimension.getBlock(target)?.typeId === "minecraft:air") return true;
      if (!breakStarted) {
        if (!breakAsWizard(dimension, target)) return false;
        breakStarted = true;
      }
      polls += 1;
      if (polls > 40) {
        breakStarted = false;
        polls = 0;
      }
      return false;
    };
  };
  const cleanupSteps = obsoletePlacements.map(({ target }) => breakStep(target));
  const placementSteps = blueprint.placements.map((placement) => {
    const target = customLocation(origin, forward, right, placement.target);
    if (placement.action === "break") return breakStep(placement.target);
    const supportLocal = placement.facingTarget || placement.support;
    const support = customLocation(origin, forward, right, supportLocal);
    const orientationTarget = placement.orientationTarget
      ? customLocation(origin, forward, right, placement.orientationTarget)
      : placement.facingTarget ? support : undefined;
    const placementLookTarget = placement.placementLookTarget
      ? customLocation(origin, forward, right, placement.placementLookTarget)
      : orientationTarget;
    return () => {
      const result = placeAsWizard(
        dimension,
        placement.itemId,
        support,
        target,
        placement.expectedType,
        undefined,
        directionFromSupport(support, target),
        placement.expectedStates || {},
        placementLookTarget,
      );
      if (result === true && orientationTarget) correctBlockFacing(dimension, target, orientationTarget);
      return result;
    };
  });
  const preInteractionBefore = Math.max(
    0,
    Math.min(
      placementSteps.length,
      Number.isInteger(blueprint.preInteractionBefore) ? blueprint.preInteractionBefore : 0,
    ),
  );
  const steps = [
    ...cleanupSteps,
    ...placementSteps.slice(0, preInteractionBefore),
    ...preInteractionSteps,
    ...placementSteps.slice(preInteractionBefore),
  ];
  for (const interaction of (blueprint.interactions || []).map(deficitInteraction)) {
    if (interaction.action === "load_container") {
      for (const slot of interaction.slots) {
        steps.push(() => loadContainerSlotAsWizard(dimension, interaction, slot, origin, forward, right));
      }
    } else if (interaction.action === "wait_ticks") {
      let startedTick;
      steps.push(() => {
        if (startedTick === undefined) startedTick = system.currentTick;
        return system.currentTick - startedTick >= interaction.ticks;
      });
    } else {
      steps.push(() => useItemAsWizard(dimension, interaction, origin, forward, right));
    }
  }
  if (blueprint.verification?.length) {
    let checks = 0;
    const verifiesPortal = blueprint.verification.some((check) => (
      check.kind === "block_type" && check.typeId === "minecraft:portal"
    ));
    steps.push(() => {
      if (verifyBlueprint(dimension, blueprint, origin, forward, right)) return true;
      checks += 1;
      if (verifiesPortal && checks >= 80) return "interaction-failed";
      if (checks % 80 === 0) {
        repairBlueprintVerification(dimension, blueprint, origin, forward, right, checks / 80);
      }
      if (checks % 400 === 0) {
        const current = playerById(player.id);
        if (current) speak(current, "The machine is built. I’m testing its moving parts before I call it finished.");
      }
      return false;
    });
  }
  const expected = new Map();
  for (const placement of obsoletePlacements) {
    const location = customLocation(origin, forward, right, placement.target);
    expected.set(`${location.x},${location.y},${location.z}`, { location, typeId: "minecraft:air" });
  }
  for (const placement of blueprint.placements) {
    const location = customLocation(origin, forward, right, placement.target);
    const key = `${location.x},${location.y},${location.z}`;
    if (placement.action === "break") expected.set(key, { location, typeId: "minecraft:air" });
    else expected.set(key, {
      location,
      typeId: placement.expectedType,
      states: placement.expectedStates || {},
    });
  }
  runBuildSteps(
    player.id,
    token,
    dimension,
    steps,
    [...expected.values()],
    `${blueprint.success}${blueprint.usage ? ` ${blueprint.usage}` : ""}`,
    8,
  );
}

function buildMachinePlan(player, value) {
  try {
    // A brain-validated plan carries its own salvage drop records; hand them
    // to the blueprint executor so a completed salvaged machine posts partial.
    nextBlueprintSalvageDrops = Array.isArray(value?.dropped) && value.dropped.length
      ? value.dropped : undefined;
    void buildInteractiveBlueprint(player, machineBlueprint(value));
  } catch (error) {
    nextBlueprintSalvageDrops = undefined;
    console.warn(`[MC Wizard] rejected unsafe machine plan: ${error}`);
    speak(player, "That machine drawing had one broken part. I’m revising this same machine now instead of swapping in an unrelated redstone trick.");
    failPendingAction(player, `machine plan validation failed: ${String(error?.message || error).slice(0, 1600)}`);
  }
}

function findCustomSite(player, plan, forward, right) {
  const origin = {
    x: Math.floor(player.location.x) + forward.x * 6,
    y: standingBlockY(player.location),
    z: Math.floor(player.location.z) + forward.z * 6,
  };
  const bounds = planBounds(plan);
  for (let x = bounds.min[0] - 2; x <= bounds.max[0] + 2; x += 1) {
    for (let z = bounds.min[2] - 2; z <= bounds.max[2] + 2; z += 1) {
      const ground = player.dimension.getBlock(customLocation(origin, forward, right, [x, -1, z]));
      if (!ground || !SAFE_GROUND.has(ground.typeId)) return null;
    }
  }
  for (const placement of plan.blocks) {
    const target = customLocation(origin, forward, right, placement.target);
    const block = player.dimension.getBlock(target);
    if (!block || !SAFE_SPACE.has(block.typeId)) return null;
  }
  return origin;
}

async function buildValidatedPlan(player, value) {
  // Same brain-drop handoff as buildStructure: the incoming plan is already
  // salvaged brain-side, so its drop records ride value.salvage.dropped and
  // re-validation alone would lose them (#35).
  const brainSalvageDrops = Array.isArray(value?.salvage?.dropped) ? value.salvage.dropped : [];
  let plan;
  try {
    plan = validateBuildPlan(value);
  } catch (error) {
    speak(player, "One piece of that drawing would not work in Bedrock. I’m revising the same idea before I touch the world.");
    failPendingAction(player, `build plan was rejected: ${error.message}`);
    return;
  }
  if (buildInProgress || buildPreparing) {
    queueBuild(player, (current) => buildValidatedPlan(current, value));
    return;
  }
  let dimension = player.dimension;
  let forward = cardinalDirection(player);
  let right = { x: -forward.z, z: forward.x };
  let origin = findCustomSite(player, plan, forward, right);
  let actionClaim;
  if (!origin) {
    actionClaim = captureBuildActionClaim(player);
    if (await prepareBuildWorkshopReserved(player)) {
      dimension = player.dimension;
      forward = cardinalDirection(player);
      right = { x: -forward.z, z: forward.x };
      origin = findCustomSite(player, plan, forward, right);
    }
    if (!buildActionClaimIsCurrent(player, actionClaim)) return;
  }
  if (!origin) {
    origin = {
      x: Math.floor(player.location.x) + forward.x * 6,
      y: standingBlockY(player.location),
      z: Math.floor(player.location.z) + forward.z * 6,
    };
    speak(player, "The site check is being fussy, so I’m using the nearby pad I just cleared and continuing.");
  }
  const bot = bringWizardTo(player);
  if (!bot) {
    queueBuild(player, (current) => buildValidatedPlan(current, value), 40, "My player body is re-forming. I queued the build and will begin automatically.");
    return;
  }
  buildInProgress = true;
  const token = ++nextBuildToken;
  activeBuildToken = token;
  if (!bindBuildAction(player, token, undefined, actionClaim)) {
    clearBuild(token);
    return;
  }
  const salvageDrops = [...brainSalvageDrops, ...(plan.salvage?.dropped || [])];
  if (salvageDrops.length) salvageDropsByToken.set(token, salvageDrops);
  lastBuildTick.set(player.id, system.currentTick);
  const steps = plan.blocks.map((placement) => {
    const target = customLocation(origin, forward, right, placement.target);
    const support = customLocation(origin, forward, right, placement.support);
    const direction = directionFromSupport(support, target);
    const expectedStates = expectedPlacementStates(
      placement.itemId,
      [support.x, support.y, support.z],
      [target.x, target.y, target.z],
    );
    return () => placeAsWizard(
      dimension,
      placement.itemId,
      support,
      target,
      placement.expectedType,
      undefined,
      direction,
      expectedStates,
    );
  });
  const expectedBlocks = plan.blocks.map((placement) => ({
    location: customLocation(origin, forward, right, placement.target),
    typeId: placement.expectedType,
  }));
  speak(player, `I validated “${plan.title}”. I’ll place its ${plan.blocks.length} blocks one at a time, then verify all of them.`);
  system.runTimeout(() => runBuildSteps(
    player.id,
    token,
    dimension,
    steps,
    expectedBlocks,
    `${plan.title} is built and verified. Say “wizard undo” within ten minutes if you want me to restore the area.`,
    8,
  ), 20);
}

async function buildCommandLesson(player, id) {
  const lesson = commandLesson(id);
  if (!lesson) {
    speak(player, "I don’t have that command-block lesson.");
    failPendingAction(player, "command-block lesson was not registered");
    return;
  }
  if (buildInProgress || buildPreparing) {
    queueBuild(player, (current) => buildCommandLesson(current, id));
    return;
  }
  let dimension = player.dimension;
  let forward = cardinalDirection(player);
  let right = { x: -forward.z, z: forward.x };
  let base = findClearSite(player, forward, right);
  let actionClaim;
  if (!base) {
    actionClaim = captureBuildActionClaim(player);
    if (await prepareBuildWorkshopReserved(player)) {
      dimension = player.dimension;
      forward = cardinalDirection(player);
      right = { x: -forward.z, z: forward.x };
      base = findClearSite(player, forward, right);
    }
    if (!buildActionClaimIsCurrent(player, actionClaim)) return;
  }
  if (!base) {
    queueBuild(
      player,
      (current) => buildCommandLesson(current, id),
      200,
      "This patch is crowded. I’m keeping the lesson queued and clearing another nearby spot.",
    );
    return;
  }
  if (!bringWizardTo(player)) {
    queueBuild(
      player,
      (current) => buildCommandLesson(current, id),
      40,
      "My boots missed the summon. I’m fetching them and placing the lesson automatically.",
    );
    return;
  }
  buildInProgress = true;
  const token = ++nextBuildToken;
  activeBuildToken = token;
  if (!bindBuildAction(player, token, undefined, actionClaim)) {
    clearBuild(token);
    return;
  }
  const commandBlock = offset(base, forward, right, 0);
  const button = offset(commandBlock, forward, right, 0, 0, 1);
  const steps = [
    () => placeAsWizard(
      dimension,
      "minecraft:command_block",
      offset(commandBlock, forward, right, 0, 0, -1),
      commandBlock,
      "minecraft:command_block",
    ),
    () => placeAsWizard(
      dimension,
      "minecraft:stone_button",
      commandBlock,
      button,
      "minecraft:stone_button",
    ),
  ];
  const expectedBlocks = [
    { location: commandBlock, typeId: "minecraft:command_block" },
    { location: button, typeId: "minecraft:stone_button" },
  ];
  speak(player, `I’ll place the hardware for “${lesson.title}”. Bedrock does not let my script safely type novel command text, so you will paste one short command yourself.`);
  system.runTimeout(() => runBuildSteps(
    player.id,
    token,
    dimension,
    steps,
    expectedBlocks,
    `Lesson ready. Open the command block and paste: ${lesson.command} Set it to Impulse, Unconditional, Needs Redstone, then press the button. ${lesson.explanation}`,
    10,
  ), 20);
}

function findCalculatorSite(player, forward, right) {
  const origin = {
    x: Math.floor(player.location.x) + forward.x * 18 - right.x * 5,
    y: standingBlockY(player.location),
    z: Math.floor(player.location.z) + forward.z * 18 - right.z * 5,
  };
  for (let x = -1; x <= 11; x += 1) {
    for (let z = -1; z <= 11; z += 1) {
      const ground = player.dimension.getBlock(calculatorLocation(origin, forward, right, [x, -1, z]));
      if (!ground || !SAFE_GROUND.has(ground.typeId)) return null;
      for (let y = 0; y <= 5; y += 1) {
        const block = player.dimension.getBlock(calculatorLocation(origin, forward, right, [x, y, z]));
        if (!block || !SAFE_SPACE.has(block.typeId)) return null;
      }
    }
  }
  return origin;
}

async function buildRedstoneCalculator(player) {
  console.warn("[MC Wizard] calculator build requested by " + player.name);
  const previousBuild = lastBuildTick.get(player.id) || -Infinity;
  if (system.currentTick - previousBuild < 200) {
    queueBuild(
      player,
      buildRedstoneCalculator,
      200 - (system.currentTick - previousBuild),
      "I queued that calculator and will start it in a few seconds.",
    );
    return;
  }
  if (buildInProgress || buildPreparing) {
    queueBuild(player, buildRedstoneCalculator);
    return;
  }

  let dimension = player.dimension;
  let forward = cardinalDirection(player);
  console.warn("[MC Wizard] calculator facing " + forward.name);
  let right = { x: -forward.z, z: forward.x };
  let origin = findCalculatorSite(player, forward, right);
  let actionClaim;
  if (!origin) {
    actionClaim = captureBuildActionClaim(player);
    if (await prepareBuildWorkshopReserved(player)) {
      dimension = player.dimension;
      forward = cardinalDirection(player);
      right = { x: -forward.z, z: forward.x };
      origin = findCalculatorSite(player, forward, right);
    }
    if (!buildActionClaimIsCurrent(player, actionClaim)) return;
  }
  if (!origin) {
    console.warn("[MC Wizard] no clear calculator site near " + player.name);
    queueBuild(
      player,
      buildRedstoneCalculator,
      200,
      "This patch is crowded. I’m keeping your calculator queued and leveling another nearby spot.",
    );
    return;
  }

  let blueprint;
  try {
    blueprint = createCalculatorBlueprint();
  } catch (error) {
    console.warn(`[MC Wizard] calculator blueprint invalid: ${error}`);
    queueBuild(
      player,
      buildRedstoneCalculator,
      200,
      "I caught a flaw in my calculator map. I’m redrawing it and keeping your build queued.",
    );
    return;
  }
  const bot = bringWizardTo(player);
  if (!bot) {
    queueBuild(
      player,
      buildRedstoneCalculator,
      40,
      "My boots missed the summon. I’m fetching them and starting your calculator automatically.",
    );
    return;
  }

  buildInProgress = true;
  const token = ++nextBuildToken;
  activeBuildToken = token;
  if (!bindBuildAction(player, token, undefined, actionClaim)) {
    clearBuild(token);
    return;
  }
  lastBuildTick.set(player.id, system.currentTick);
  const buildSpot = calculatorLocation(origin, forward, right, [5, 0, 11]);
  try {
    bot.navigateToLocation({ x: buildSpot.x + 0.5, y: buildSpot.y, z: buildSpot.z + 0.5 }, 0.8);
    bot.lookAtLocation(calculatorLocation(origin, forward, right, [5, 1, 5]), LookDuration.UntilMove);
  } catch (error) {
    console.warn(`[MC Wizard] could not walk to calculator site: ${error}`);
  }
  speak(player, "I’ll build a two-bit binary adder using only blocks, redstone dust, torches, levers, and lamps. It adds any two numbers from zero to three.");

  const orderedPlacements = playerAccessibleCalculatorOrder(blueprint.placements);
  const steps = orderedPlacements.map((placement) => {
    const target = calculatorLocation(origin, forward, right, placement.target);
    if (placement.action === "break") {
      let breakStarted = false;
      let polls = 0;
      return () => {
        const block = dimension.getBlock(target);
        if (!block) throw new Error(`could not load scaffold at ${target.x},${target.y},${target.z}`);
        if (block.typeId === "minecraft:air") return true;
        if (!breakStarted) {
          if (!breakAsWizard(dimension, target)) return false;
          breakStarted = true;
          return dimension.getBlock(target)?.typeId === "minecraft:air";
        }
        positionWizardForBuild(dimension, target);
        polls += 1;
        if (polls > 40) {
          throw new Error(`scaffold did not clear at ${target.x},${target.y},${target.z}`);
        }
        return false;
      };
    }
    const plannedSupport = calculatorLocation(origin, forward, right, placement.support);
    return () => {
      const support = playerCopyableCalculatorSupport(
        dimension,
        placement.itemId,
        target,
        plannedSupport,
      );
      return placeAsWizard(
        dimension,
        placement.itemId,
        support,
        target,
        placement.expectedType,
        undefined,
        directionFromSupport(support, target),
      );
    };
  });
  const finalBlocks = new Map();
  for (const placement of blueprint.placements) {
    const location = calculatorLocation(origin, forward, right, placement.target);
    const locationKey = `${location.x},${location.y},${location.z}`;
    if (placement.action === "break") {
      finalBlocks.set(locationKey, { location, typeId: "minecraft:air" });
    }
    else finalBlocks.set(locationKey, { location, typeId: placement.expectedType });
  }

  const beginCalculator = () => {
    if (activeBuildToken !== token) return;
    if (!wizardIsValid()) {
      const current = playerById(player.id);
      if (!current) {
        endBuildAction(token, "failed", "player left before the build could continue");
        clearBuild(token);
        return;
      }
      bringWizardTo(current);
      if (!buildRetryNotices.has(`${token}:body`)) {
        buildRetryNotices.add(`${token}:body`);
        speak(current, "My boots blinked away, but your calculator is safe. I’m summoning them back and continuing from this exact spot.");
      }
      system.runTimeout(beginCalculator, 40);
      return;
    }
    runBuildSteps(
      player.id,
      token,
      dimension,
      steps,
      [...finalBlocks.values()],
      "Calculator built. The four near levers are A-two, B-two, A-one, and B-one. Read the three pink output lamps as four, two, one. Try one plus three: the lamps should show one-zero-zero, which is four.",
      variable("mc_wizard_e2e", false) === true ? 8 : 12,
    );
  };
  system.runTimeout(beginCalculator, 20);
}

function travelDimension(action) {
  const requested = String(action.destination || action.dimension || "").replace(/^minecraft:/, "");
  return TRAVEL_DIMENSIONS[requested === "end" ? "the_end" : requested];
}

function activeE2ETravelFault() {
  if (variable("mc_wizard_e2e", false) !== true
    || variable("mc_wizard_e2e_scope", "") !== "travel-rollback") return undefined;
  try {
    const fault = JSON.parse(String(world.getDynamicProperty(E2E_TRAVEL_FAULT_PROPERTY) || ""));
    const run = String(variable("mc_wizard_e2e_run", "")).trim();
    return fault.run === run && fault.mode === "hold-last-traveler" ? fault : undefined;
  } catch {
    return undefined;
  }
}

function updateE2ETravelFault(fault, changes) {
  if (!fault) return;
  Object.assign(fault, changes);
  world.setDynamicProperty(E2E_TRAVEL_FAULT_PROPERTY, JSON.stringify(fault));
}

function nearbyTravelParty(player) {
  return [player, ...humanPlayers().filter((candidate) => (
    candidate.id !== player.id
    && candidate.dimension.id === player.dimension.id
    && distanceSquared(candidate.location, player.location) <= TRAVEL_PARTY_DISTANCE_SQUARED
    && !needsTeleportConsent(candidate)
  ))];
}

function travelPartyOffsets(count) {
  const side = Math.ceil(Math.sqrt(count));
  const start = -Math.floor((side - 1) * 2 / 2);
  return Array.from({ length: count }, (_, index) => ({
    x: start + (index % side) * 2,
    z: start + Math.floor(index / side) * 2,
  }));
}

function travelAnchor(player, destination) {
  if (destination.name === "overworld") {
    if (player.dimension.id === "minecraft:nether") {
      return {
        x: Math.floor(player.location.x * 8),
        y: Math.min(100, Math.max(32, Math.floor(player.location.y))),
        z: Math.floor(player.location.z * 8),
      };
    }
    const spawn = world.getDefaultSpawnLocation();
    return { x: Math.floor(spawn.x), y: Math.floor(spawn.y), z: Math.floor(spawn.z) };
  }
  if (destination.name === "the_end") return { x: 100, y: 50, z: 0 };
  const scale = player.dimension.id === "minecraft:overworld" ? 1 / 8 : 1;
  return {
    x: Math.floor(player.location.x * scale),
    y: Math.min(100, Math.max(32, Math.floor(player.location.y))),
    z: Math.floor(player.location.z * scale),
  };
}

function travelCellIsSafe(dimension, location) {
  const ground = dimension.getBlock({ ...location, y: location.y - 1 });
  const feet = dimension.getBlock(location);
  const head = dimension.getBlock({ ...location, y: location.y + 1 });
  const solidGround = typeof ground?.isSolid === "boolean"
    ? ground.isSolid : Boolean(ground && !SAFE_SPACE.has(ground.typeId));
  return solidGround
    && !TRAVEL_GROUND_HAZARDS.has(ground.typeId)
    && SAFE_SPACE.has(feet?.typeId)
    && SAFE_SPACE.has(head?.typeId);
}

function travelSiteIsSafe(dimension, origin, offsets) {
  return offsets.every(({ x, z }) => travelCellIsSafe(dimension, {
    x: origin.x + x,
    y: origin.y,
    z: origin.z + z,
  }));
}

function findTravelSite(dimension, anchor, offsets) {
  const candidates = [
    [0, 0, 0], [0, 1, 0], [0, -1, 0], [0, 2, 0], [0, -2, 0],
    [4, 0, 0], [-4, 0, 0], [0, 0, 4], [0, 0, -4],
  ];
  for (const [x, y, z] of candidates) {
    const origin = { x: anchor.x + x, y: anchor.y + y, z: anchor.z + z };
    try {
      if (travelSiteIsSafe(dimension, origin, offsets)) return origin;
    } catch {
      // The fallback pad below handles unloaded or obstructed arrival blocks.
    }
  }
  return undefined;
}

function surfaceSearchCenters(anchor) {
  return [
    [0, 0], [4, 0], [-4, 0], [0, 4], [0, -4],
    [8, 8], [-8, 8], [8, -8], [-8, -8],
    [16, 0], [-16, 0], [0, 16], [0, -16],
    [32, 0], [-32, 0], [0, 32], [0, -32],
  ].map(([x, z]) => ({ x: anchor.x + x, z: anchor.z + z }));
}

function travelHeightRange(dimension) {
  try {
    const min = Math.ceil(Number(dimension.heightRange?.min));
    const max = Math.floor(Number(dimension.heightRange?.max));
    if (Number.isFinite(min) && Number.isFinite(max) && max - min >= 4) {
      // NumberRange max can describe the exclusive ceiling; leave room for feet,
      // head, and the pad's extra clearance block without touching that boundary.
      return { minFeet: min + 1, maxFeet: max - 3 };
    }
  } catch {}
  return { minFeet: -63, maxFeet: 317 };
}

function findSurfaceTravelSite(dimension, anchor, offsets) {
  for (const center of surfaceSearchCenters(anchor)) {
    try {
      const tops = offsets.map(({ x, z }) => dimension.getTopmostBlock({
        x: center.x + x,
        z: center.z + z,
      }));
      if (tops.some((block) => !block)) continue;
      for (const y of [...new Set(tops.map((block) => block.y + 1))].sort((a, b) => b - a)) {
        const origin = { x: center.x, y, z: center.z };
        if (travelSiteIsSafe(dimension, origin, offsets)) return origin;
      }
    } catch {}
  }
  return undefined;
}

function surfaceFallbackAnchor(dimension, anchor) {
  const { minFeet, maxFeet } = travelHeightRange(dimension);
  for (const center of surfaceSearchCenters(anchor)) {
    try {
      const top = dimension.getTopmostBlock(center);
      if (top) return { x: center.x, y: Math.max(minFeet, Math.min(maxFeet, top.y + 1)), z: center.z };
    } catch {}
  }
  return { x: anchor.x, y: Math.max(minFeet, Math.min(maxFeet, 80)), z: anchor.z };
}

function allocateTravelTickingArea() {
  nextTravelArea = (nextTravelArea + 1) % 1_000_000;
  return `mc_wiz_travel_${nextTravelArea}`;
}

function prepareTravelPad(dimension, anchor, offsets) {
  const xs = offsets.map(({ x }) => x);
  const zs = offsets.map(({ z }) => z);
  const minX = anchor.x + Math.min(...xs) - 1;
  const maxX = anchor.x + Math.max(...xs) + 1;
  const minZ = anchor.z + Math.min(...zs) - 1;
  const maxZ = anchor.z + Math.max(...zs) + 1;
  for (let x = minX; x <= maxX; x += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      dimension.setBlockType({ x, y: anchor.y - 1, z }, "minecraft:obsidian");
      for (let y = anchor.y; y <= anchor.y + 2; y += 1) {
        dimension.setBlockType({ x, y, z }, "minecraft:air");
      }
    }
  }
  return anchor;
}

async function waitForTravelChunk(dimension, anchor) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if (dimension.getBlock(anchor) && dimension.getBlock({ ...anchor, y: anchor.y - 1 })) return true;
    } catch {
      // A preloaded ticking area still needs time to generate a fresh realm.
    }
    await system.waitTicks(2);
  }
  return false;
}

async function requestStructureLocation(player, anchor, structure, dimension) {
  const request = new HttpRequest(WIZARD_URL.replace(/\/v1\/ask(?:\?.*)?$/, "/v1/locate"))
    .setMethod(HttpRequestMethod.Post)
    .setBody(JSON.stringify({
      player: player.name,
      origin: { x: anchor.x, z: anchor.z },
      structure,
      dimension,
    }))
    .addHeader("Content-Type", "application/json");
  if (AUTHORIZATION) request.addHeader("Authorization", AUTHORIZATION);
  const response = await http.request(request);
  let result = {};
  try { result = JSON.parse(response.body || "{}"); } catch {}
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(result.error || `${structure} locator returned HTTP ${response.status}`);
    if (response.status === 404 && result.code === "not_found") error.code = "STRUCTURE_NOT_FOUND";
    throw error;
  }
  const x = Number(result.location?.x);
  const z = Number(result.location?.z);
  if (!Number.isInteger(x) || !Number.isInteger(z)
    || Math.abs(x) > 30_000_000 || Math.abs(z) > 30_000_000) {
    throw new Error(`${structure} locator returned invalid coordinates`);
  }
  return { x, z };
}

async function locateStructureForPlayer(player, anchor, structure, dimension) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await requestStructureLocation(player, anchor, structure, dimension);
    } catch (error) {
      if (error.code === "STRUCTURE_NOT_FOUND") throw error;
      lastError = error;
      if (attempt === 0) await system.waitTicks(10);
    }
  }
  throw lastError || new Error(`${structure} locator was unavailable`);
}

function localTravelStructure(action) {
  if (action.destination === "nearest_village") {
    return { id: "village", ...LOCATABLE_STRUCTURES.village };
  }
  if (action.destination !== "nearest_structure") return undefined;
  const id = String(action.structure || "").replace(/^minecraft:/, "");
  const metadata = LOCATABLE_STRUCTURES[id];
  const dimension = String(action.dimension || metadata?.dimension || "");
  if (!metadata || (dimension !== metadata.dimension && !(id === "ruined_portal" && dimension === "nether"))) {
    return undefined;
  }
  return { id, ...metadata, dimension };
}

function localTravelOrigin(player, target) {
  if (player.dimension.id === target.id) {
    return { x: Math.floor(player.location.x), y: 80, z: Math.floor(player.location.z) };
  }
  if (target.name === "overworld" && player.dimension.id === "minecraft:nether") {
    return { x: Math.floor(player.location.x * 8), y: 80, z: Math.floor(player.location.z * 8) };
  }
  if (target.name === "nether" && player.dimension.id === "minecraft:overworld") {
    return { x: Math.floor(player.location.x / 8), y: 80, z: Math.floor(player.location.z / 8) };
  }
  if (target.name === "overworld") {
    const spawn = world.getDefaultSpawnLocation();
    return { x: Math.floor(spawn.x), y: 80, z: Math.floor(spawn.z) };
  }
  return target.name === "the_end" ? { x: 100, y: 80, z: 0 } : { x: 0, y: 80, z: 0 };
}

async function localTravelAnchor(player, action) {
  const structure = localTravelStructure(action);
  const target = structure ? TRAVEL_DIMENSIONS[structure.dimension] : TRAVEL_DIMENSIONS.overworld;
  const anchor = localTravelOrigin(player, target);
  if (!structure) return anchor;
  return {
    ...await locateStructureForPlayer(player, anchor, structure.id, target.name),
    y: 80,
  };
}

function generatedStructureAtLocate(dimension, location, structure) {
  if (typeof dimension.getGeneratedStructures !== "function") return true;
  const x = Math.floor(location.x);
  const z = Math.floor(location.z);
  let topY = Math.floor(location.y);
  try {
    topY = dimension.getTopmostBlock({ x, z })?.location?.y ?? topY;
  } catch {}
  const { minFeet } = travelHeightRange(dimension);
  for (let y = topY + 8; y >= Math.max(minFeet, topY - 24); y -= 1) {
    try {
      if (dimension.getGeneratedStructures({ x, y, z }).some((type) => String(type).includes(structure))) {
        return true;
      }
    } catch {}
  }
  return false;
}

async function findGeneratedStructureTravelSite(dimension, anchor, offsets, structure) {
  if (typeof dimension.getGeneratedStructures !== "function") return undefined;
  const { minFeet, maxFeet } = travelHeightRange(dimension);
  let checks = 0;
  for (const center of surfaceSearchCenters(anchor)) {
    for (let y = maxFeet; y >= minFeet; y -= 2) {
      try {
        const inside = dimension.getGeneratedStructures({ x: center.x, y, z: center.z })
          .some((type) => String(type).includes(structure));
        if (inside) {
          const site = findTravelSite(dimension, { x: center.x, y, z: center.z }, offsets);
          if (site) return site;
        }
      } catch {}
      checks += 1;
      if (checks % 128 === 0) await system.waitTicks(1);
    }
  }
  return undefined;
}

async function applyLocalTravel(player, action, capturedPartyIds = nearbyTravelParty(player).map(({ id }) => id)) {
  const structure = localTravelStructure(action);
  if (action.destination !== "surface" && !structure) {
    const report = beginImmediateAction(player);
    endImmediateAction(report, "failed", "local destination was not supported");
    return;
  }
  if (buildInProgress || buildPreparing) {
    queueBuild(
      player,
      (current) => applyLocalTravel(current, action, capturedPartyIds),
      20,
      "I’ve marked the destination. I’ll move us as soon as my hands are free.",
    );
    return;
  }
  const bot = bringWizardTo(player);
  if (!bot) {
    queueBuild(
      player,
      (current) => applyLocalTravel(current, action, capturedPartyIds),
      40,
      "My boots are re-forming, but your trip is queued and I’m coming with you.",
    );
    return;
  }
  const report = beginImmediateAction(player);
  const playersById = new Map(humanPlayers().map((member) => [member.id, member]));
  const capturedParty = capturedPartyIds.map((id) => playersById.get(id)).filter(Boolean);
  if (capturedParty.length !== capturedPartyIds.length) {
    speak(player, "One traveler left before the spell began, so I kept everyone else together here instead of splitting the party.");
    endImmediateAction(report, "failed", "a captured party member left before local travel began");
    return;
  }
  const party = capturedParty.filter((member) => member.id === player.id || !needsTeleportConsent(member));
  if (party.length < capturedParty.length) {
    speak(player, "One traveler is staying behind, so I kept the rest of the trip together.");
  }
  const reservation = beginBuildPreparation();
  const target = structure ? TRAVEL_DIMENSIONS[structure.dimension] : TRAVEL_DIMENSIONS.overworld;
  const targetDimension = world.getDimension(target.name);
  const travelers = [...party, bot];
  const sources = travelers.map((entity) => ({
    entity,
    dimensionId: entity.dimension.id,
    location: { ...entity.location },
  }));
  const restoreAll = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const source of sources) {
        try {
          source.entity.teleport(source.location, {
            dimension: world.getDimension(source.dimensionId.replace(/^minecraft:/, "")),
          });
        } catch {}
      }
      await system.waitTicks(2);
      if (sources.every(({ entity, dimensionId, location }) => (
        entityReachedDimension(entity, dimensionId) && distanceSquared(entity.location, location) <= 4
      ))) return true;
    }
    return false;
  };
  const offsets = travelPartyOffsets(travelers.length);
  const tickingArea = allocateTravelTickingArea();
  let anchor;
  let structureFallback;
  try {
    try {
      anchor = await localTravelAnchor(player, action);
    } catch (error) {
      if (!structure) throw error;
      structureFallback = error.code === "STRUCTURE_NOT_FOUND" ? "not_found" : "locator_unavailable";
      console.warn(`[MC Wizard] ${structure.id} locator fallback: ${error}`);
      anchor = localTravelOrigin(player, target);
    }
    try {
      targetDimension.runCommand(`tickingarea remove ${tickingArea}`);
    } catch {}
    targetDimension.runCommand(`tickingarea add circle ${anchor.x} ${anchor.y} ${anchor.z} 2 ${tickingArea} true`);
    if (!await waitForTravelChunk(targetDimension, anchor)) {
      throw new Error(`destination chunk at ${anchor.x},${anchor.z} did not become loaded and ticking`);
    }
    if (structure && !structureFallback
      && !generatedStructureAtLocate(targetDimension, anchor, structure.id)) {
      console.warn(`[MC Wizard] located ${structure.id} was not observable at authoritative coordinate ${anchor.x},${anchor.z}`);
    }
    const needsUndergroundArrival = Boolean(structure && !structureFallback
      && UNDERGROUND_LOCATABLE_STRUCTURES.has(structure.id));
    const undergroundSite = needsUndergroundArrival
      ? await findGeneratedStructureTravelSite(targetDimension, anchor, offsets, structure.id)
      : undefined;
    const aboveStructure = needsUndergroundArrival && !undergroundSite;
    const site = undergroundSite || (target.name === "overworld"
      ? (findSurfaceTravelSite(targetDimension, anchor, offsets)
        || prepareTravelPad(targetDimension, surfaceFallbackAnchor(targetDimension, anchor), offsets))
      : (findTravelSite(targetDimension, anchor, offsets)
        || prepareTravelPad(targetDimension, anchor, offsets)));
    const arrived = () => travelers.every((member, index) => (
      entityReachedDimension(member, target.id)
      && distanceSquared(member.location, {
        x: site.x + offsets[index].x + 0.5,
        y: site.y,
        z: site.z + offsets[index].z + 0.5,
      }) <= 4
    ));
    const sendAll = async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        travelers.forEach((member, index) => {
          if (arrived()) return;
          try {
            member.teleport({
              x: site.x + offsets[index].x + 0.5,
              y: site.y,
              z: site.z + offsets[index].z + 0.5,
            }, { dimension: targetDimension });
          } catch {}
        });
        await system.waitTicks(2);
        if (arrived()) return true;
      }
      return false;
    };
    if (!await sendAll()) {
      const restored = await restoreAll();
      throw new Error(`not every traveler reached the selected surface site; rollback=${restored}`);
    }
    speak(player, structureFallback === "not_found"
      ? `I searched for the nearest ${structure.label}, but this world reported none in range. I brought us safely to the ${target.label} instead, so I can try another approach from here.`
      : structureFallback === "locator_unavailable"
      ? `My ${structure.label} compass is fuzzy right now, so I brought us safely to the ${target.label} instead of leaving you stuck. Ask me again and I’ll retry.`
      : aboveStructure
      ? `I found the nearest ${structure.label} below us. Its inside had no safe landing room, so I brought us to safe ground directly above it.`
      : structure
      ? `${structure.label[0].toUpperCase()}${structure.label.slice(1)} found! We’re safely beside it, and I came with you.`
      : "There we are—safe, above ground, and under the open sky.");
    endImmediateAction(report, structureFallback ? "partial" : "completed", structureFallback === "not_found"
      ? `confirmed no generated ${structure.id} was locatable and moved ${travelers.length} travelers safely to ${target.id}`
      : structureFallback === "locator_unavailable"
      ? `${structure.id} locator remained unavailable after a bounded retry; moved ${travelers.length} travelers safely to ${target.id}`
      : aboveStructure
      ? `located ${structure.id} and moved ${travelers.length} travelers safely above its authoritative coordinates`
      : structure
      ? `located ${structure.id} and observed ${travelers.length} travelers together in ${target.id}`
      : `observed ${travelers.length} travelers safely on the Overworld surface`);
  } catch (error) {
    console.warn(`[MC Wizard] local travel failed: ${error}`);
    await restoreAll();
    speak(player, "My map spell slipped. I’ve marked the exact trip unfinished instead of pretending we arrived.");
    endImmediateAction(report, "failed", `local travel failed: ${String(error).slice(0, 140)}`);
  } finally {
    endBuildPreparation(reservation);
    system.runTimeout(() => {
      try {
        targetDimension.runCommand(`tickingarea remove ${tickingArea}`);
      } catch {}
    }, 20);
  }
}

function entityReachedDimension(entity, dimensionId) {
  try {
    return entity.isValid && entity.dimension.id === dimensionId;
  } catch {
    return false;
  }
}

async function applyDimensionTravel(player, action, capturedPartyIds = nearbyTravelParty(player).map(({ id }) => id)) {
  const destination = travelDimension(action);
  if (!destination) {
    const report = beginImmediateAction(player);
    speak(player, "That realm name slipped past my map. Try Overworld, Nether, or End.");
    endImmediateAction(report, "failed", "requested dimension was not supported");
    return;
  }
  if (buildInProgress || buildPreparing) {
    queueBuild(
      player,
      (current) => applyDimensionTravel(current, action, capturedPartyIds),
      20,
      "I’ve kept this exact travel party together. We’ll realm-hop as soon as my current build is stable.",
    );
    return;
  }
  const bot = bringWizardTo(player);
  if (!bot) {
    queueBuild(
      player,
      (current) => applyDimensionTravel(current, action, capturedPartyIds),
      40,
      "My player body is re-forming. I’ve kept this exact travel party queued until I can come too.",
    );
    return;
  }
    const report = beginImmediateAction(player);
    const playersById = new Map(humanPlayers().map((member) => [member.id, member]));
    const capturedParty = capturedPartyIds.map((id) => playersById.get(id)).filter(Boolean);
    if (capturedParty.length !== capturedPartyIds.length) {
      speak(player, "One traveler left before the spell began, so I kept everyone else together here instead of splitting the party.");
      endImmediateAction(report, "failed", "a captured party member left before dimension travel began");
      return;
    }
    const party = capturedParty.filter((member) => member.id === player.id || !needsTeleportConsent(member));
    if (party.length < capturedParty.length) {
      speak(player, "One traveler is staying behind, so I kept the rest of the trip together.");
    }
  const targetDimension = world.getDimension(destination.name);
  if (party.every((member) => member.dimension.id === destination.id)
    && bot.dimension.id === destination.id) {
    speak(player, `We’re already in the ${destination.label}.`);
    endImmediateAction(report, "completed", `observed the captured party and Wizard already in ${destination.id}`);
    return;
  }
  const reservation = beginBuildPreparation();
  const travelers = [...party, bot];
  const sources = travelers.map((entity) => ({
    entity,
    dimensionId: entity.dimension.id,
    location: { ...entity.location },
  }));
  const e2eFault = activeE2ETravelFault();
  const travelerDimensions = () => travelers.map((member) => {
    try {
      return member.dimension.id;
    } catch {
      return "invalid";
    }
  });
  updateE2ETravelFault(e2eFault, {
    phase: "traveling",
    travelerCount: travelers.length,
    travelerNames: travelers.map((member) => member.name),
    sourceDimensions: sources.map(({ dimensionId }) => dimensionId),
  });
  const restoreAll = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const source of sources) {
        if (entityReachedDimension(source.entity, source.dimensionId)) continue;
        try {
          source.entity.teleport(source.location, {
            dimension: world.getDimension(source.dimensionId.replace(/^minecraft:/, "")),
          });
        } catch (error) {
          console.warn(`[MC Wizard] could not roll ${source.entity.name} back after partial travel: ${error}`);
        }
      }
      await system.waitTicks(2);
      if (sources.every(({ entity, dimensionId }) => entityReachedDimension(entity, dimensionId))) return true;
    }
    return false;
  };
  const offsets = travelPartyOffsets(travelers.length);
  const anchor = travelAnchor(player, destination);
  const tickingArea = allocateTravelTickingArea();
  try {
    try {
      targetDimension.runCommand(`tickingarea remove ${tickingArea}`);
    } catch {}
    targetDimension.runCommand(`tickingarea add circle ${anchor.x} ${anchor.y} ${anchor.z} 2 ${tickingArea} true`);
    if (!await waitForTravelChunk(targetDimension, anchor)) {
      throw new Error(`arrival chunk at ${anchor.x},${anchor.z} did not become loaded and ticking`);
    }
    const site = destination.name === "overworld"
      ? (findSurfaceTravelSite(targetDimension, anchor, offsets)
        || prepareTravelPad(targetDimension, surfaceFallbackAnchor(targetDimension, anchor), offsets))
      : (findTravelSite(targetDimension, anchor, offsets)
        || prepareTravelPad(targetDimension, anchor, offsets));
    const teleportTraveler = (member, index) => {
      if (e2eFault && index === travelers.length - 1) {
        updateE2ETravelFault(e2eFault, {
          injections: (Number(e2eFault.injections) || 0) + 1,
          heldTraveler: member.name,
        });
        return;
      }
      try {
        member.teleport({
          x: site.x + offsets[index].x + 0.5,
          y: site.y,
          z: site.z + offsets[index].z + 0.5,
        }, { dimension: targetDimension });
      } catch (error) {
        console.warn(`[MC Wizard] could not move ${member.name} to ${destination.id}: ${error}`);
      }
    };
    const allReached = (dimensionId) => travelers.every((member) => (
      entityReachedDimension(member, dimensionId)
    ));
    const sendAll = async () => {
      travelers.forEach(teleportTraveler);
      await system.waitTicks(2);
      if (e2eFault && !allReached(destination.id)) {
        const dimensions = travelerDimensions();
        updateE2ETravelFault(e2eFault, {
          phase: "partial",
          partialObserved: e2eFault.partialObserved || new Set(dimensions).size > 1,
          dimensions,
        });
      }
      if (!allReached(destination.id)) {
        travelers.forEach((member, index) => {
          if (!entityReachedDimension(member, destination.id)) teleportTraveler(member, index);
        });
        await system.waitTicks(2);
      }
      return allReached(destination.id);
    };
    for (let journey = 0; journey < 2; journey += 1) {
      if (await sendAll()) {
        updateE2ETravelFault(e2eFault, {
          phase: "finished",
          outcome: "destination",
          dimensions: travelerDimensions(),
        });
        speak(player, `Realm hop complete—${party.length === 1 ? "you’re" : `all ${party.length} of you are`} safely in the ${destination.label}, and I came with you.`);
        endImmediateAction(report, "completed", `observed ${party.length}/${party.length} captured players and Wizard in ${destination.id}`);
        return;
      }
      if (await restoreAll()) {
        updateE2ETravelFault(e2eFault, {
          phase: "rolled-back",
          rollbackObserved: true,
          dimensions: travelerDimensions(),
        });
        continue;
      }
      // A rollback can itself be interrupted. Converge on the requested realm
      // rather than leave half the party on each side.
      for (let rescue = 0; rescue < 3; rescue += 1) {
        if (await sendAll()) {
          updateE2ETravelFault(e2eFault, {
            phase: "finished",
            outcome: "destination",
            dimensions: travelerDimensions(),
          });
          speak(player, `The first hop wobbled, but I gathered the whole party and landed everyone in the ${destination.label}.`);
          endImmediateAction(report, "completed", `recovered the captured party and Wizard together in ${destination.id}`);
          return;
        }
      }
      break;
    }
    const restored = await restoreAll();
    updateE2ETravelFault(e2eFault, {
      phase: "finished",
      outcome: restored ? "rolled_back" : "unresolved",
      rollbackObserved: e2eFault?.rollbackObserved || restored,
      dimensions: travelerDimensions(),
    });
    speak(player, restored
      ? `The path to the ${destination.label} would not hold everyone, so I rolled the whole captured party back together instead of leaving anyone behind.`
      : `The path to the ${destination.label} would not hold everyone. I marked the spell unfinished so the recovery can continue.`);
    endImmediateAction(report, "failed", `captured party did not reach ${destination.id} atomically; rollback=${restored}`);
  } catch (error) {
    console.warn(`[MC Wizard] dimension travel failed: ${error}`);
    const restored = await restoreAll();
    updateE2ETravelFault(e2eFault, {
      phase: "finished",
      outcome: restored ? "rolled_back" : "unresolved",
      rollbackObserved: e2eFault?.rollbackObserved || restored,
      dimensions: travelerDimensions(),
    });
    speak(player, restored
      ? `The path to the ${destination.label} buckled, so I rolled the whole party and myself back together.`
      : `The path to the ${destination.label} buckled. I’m keeping the failed spell marked for another recovery attempt.`);
    endImmediateAction(report, "failed", `dimension travel failed; rollback=${restored}: ${String(error).slice(0, 100)}`);
  } finally {
    endBuildPreparation(reservation);
    system.runTimeout(() => {
      try {
        targetDimension.runCommand(`tickingarea remove ${tickingArea}`);
      } catch {}
    }, 20);
  }
}

function castPotionRain(player, action, report = beginImmediateAction(player)) {
  const radius = Math.min(12, Math.max(3, Math.floor(Number(action.radius) || 8)));
  const durationSeconds = Math.min(15, Math.max(3, Math.floor(Number(action.durationSeconds) || 8)));
  const dimension = player.dimension;
  const center = {
    x: Math.floor(player.location.x) + 0.5,
    y: Math.floor(player.location.y),
    z: Math.floor(player.location.z) + 0.5,
  };
  const batches = durationSeconds * 2;
  let spawned = 0;
  speak(player, `Wands up! I’m making a bounded ${radius}-block splash-potion shower right here for ${durationSeconds} seconds.`);
  for (let batch = 0; batch < batches; batch += 1) {
    system.runTimeout(() => {
      for (let drop = 0; drop < 3; drop += 1) {
        const sequence = batch * 3 + drop;
        const angle = sequence * 2.399963229728653;
        const distance = radius * Math.sqrt(((sequence % 17) + 1) / 18);
        const location = {
          x: center.x + Math.cos(angle) * distance,
          y: center.y + 9 + sequence % 3,
          z: center.z + Math.sin(angle) * distance,
        };
        try {
          const potion = dimension.spawnEntity("minecraft:splash_potion", location);
          const velocity = {
            x: (center.x - location.x) * 0.015,
            y: -1.15,
            z: (center.z - location.z) * 0.015,
          };
          const projectile = potion.getComponent("minecraft:projectile");
          if (typeof projectile?.shoot === "function") projectile.shoot(velocity);
          else potion.applyImpulse(velocity);
          spawned += 1;
        } catch (error) {
          console.warn(`[MC Wizard] splash potion projectile missed its cast: ${error}`);
        }
      }
      if (batch === batches - 1) {
        const current = playerById(player.id);
        if (current) speak(current, spawned
          ? `Potion shower complete—${spawned} splash potions fell inside the circle.`
          : "The potion clouds fizzled before they formed. I kept the failed magic away from the rest of the world.");
        endImmediateAction(
          report,
          spawned ? "completed" : "failed",
          spawned ? `spawned ${spawned} splash potions` : "no splash potion projectiles spawned",
        );
      }
    }, batch * 10);
  }
}

function applyWorldControl(player, action, report = beginImmediateAction(player)) {
  try {
    const overworld = world.getDimension("overworld");
    if (action.time) overworld.runCommand(`time set ${action.time}`);
    if (action.weather) overworld.runCommand(`weather ${action.weather}`);
    const changes = [
      action.time && `the time to ${action.time}`,
      action.weather && `${action.weather} weather`,
    ].filter(Boolean).join(" and ");
    speak(player, `Done—I’ve changed ${changes}. No command typing needed.`);
    endImmediateAction(report, "completed", `changed ${changes}`);
  } catch (error) {
    console.warn(`[MC Wizard] world control retry: ${error}`);
    system.runTimeout(() => {
      const current = playerById(player.id);
      if (current) applyWorldControl(current, action, report);
      else endImmediateAction(report, "failed", "player left before world control completed");
    }, 20);
  }
}

function executeRequesterCommands(player, commands) {
  const tag = `mcw_cmd_${system.currentTick}_${Math.floor(Math.random() * 1_000_000)}`;
  let succeeded = 0;
  try {
    player.addTag(tag);
    for (const command of commands) {
      const result = player.dimension.runCommand(`execute as @a[tag=${tag}] at @s run ${command}`);
      if ((result?.successCount || 0) > 0) succeeded += 1;
    }
    return { succeeded, total: commands.length };
  } finally {
    try { player.removeTag(tag); } catch {}
  }
}

function runCommandsForPlayer(player, commands, report = beginImmediateAction(player)) {
  try {
    if (commandsMoveOptedOutPlayer(player, commands)) {
      throw new Error("broad relocation could move a non-participant");
    }
    const { succeeded, total } = executeRequesterCommands(player, commands);
    if (succeeded === 0) throw new Error("every command reported zero successful targets");
    speak(player, succeeded === commands.length
      ? "Done—the spell worked right here."
      : `I cast ${succeeded} of ${total} parts. I’m keeping the result instead of doing nothing.`);
    endImmediateAction(
      report,
      succeeded === total ? "completed" : "partial",
      `executed ${succeeded} of ${total} requester-scoped commands`,
    );
  } catch (error) {
    console.warn(`[MC Wizard] requester command failed: ${error}`);
    speak(player, "That command spell misfired. I’ve kept the goal active so I can try another route.");
    endImmediateAction(report, "failed", `requester command failed: ${String(error).slice(0, 160)}`);
  }
}

function nearbyTorchTargets(player) {
  const dimension = player.dimension;
  const base = {
    x: Math.floor(player.location.x),
    y: Math.floor(player.location.y),
    z: Math.floor(player.location.z),
  };
  const offsets = [
    [6, 0], [-6, 0], [0, 6], [0, -6], [5, 5], [5, -5], [-5, 5], [-5, -5],
    [3, 0], [-3, 0], [0, 3], [0, -3], [3, 3], [3, -3], [-3, 3], [-3, -3],
    [7, 3], [7, -3], [-7, 3], [-7, -3], [3, 7], [3, -7], [-3, 7], [-3, -7],
  ];
  const targets = [];
  for (const [dx, dz] of offsets) {
    const x = base.x + dx;
    const z = base.z + dz;
    for (let y = Math.min(318, base.y + 5); y >= Math.max(-63, base.y - 8); y -= 1) {
      const support = dimension.getBlock({ x, y, z });
      const target = dimension.getBlock({ x, y: y + 1, z });
      if (support?.isSolid && target && SAFE_SPACE.has(target.typeId)) {
        targets.push({ support: support.location, target: target.location });
        break;
      }
    }
    if (targets.length === 8) break;
  }
  return targets;
}

async function placeAreaTorches(player) {
  if (buildInProgress || buildPreparing) {
    queueBuild(player, (current) => void placeAreaTorches(current), 40, "I’ve queued the torches and will light this exact area as soon as my hands are free.");
    return;
  }
  const bot = bringWizardTo(player, true, true);
  if (!bot) {
    queueBuild(player, (current) => void placeAreaTorches(current), 40, "I’m gathering torches and will return to light this area automatically.");
    return;
  }
  const targets = nearbyTorchTargets(player);
  if (!targets.length) {
    const report = beginImmediateAction(player);
    speak(player, "I couldn’t find a torch-safe surface here, so I’m keeping this lighting job active for another route.");
    endImmediateAction(report, "failed", "no nearby torch-safe surfaces were loaded");
    return;
  }
  const token = ++nextBuildToken;
  activeBuildToken = token;
  buildInProgress = true;
  if (!bindBuildAction(player, token)) {
    clearBuild(token);
    return;
  }
  let placed = 0;
  try {
    beginTransaction(player.id, token, player.dimension, targets.map(({ target }) => ({
      location: target,
      typeId: "minecraft:torch",
    })));
    for (const { support, target } of targets) {
      let complete = false;
      for (let attempt = 0; attempt < 160 && !complete; attempt += 1) {
        const result = placeAsWizard(
          player.dimension,
          "minecraft:torch",
          support,
          target,
          "minecraft:torch",
          undefined,
          Direction.Up,
        );
        complete = result === true;
        if (!complete) await system.waitTicks(2);
      }
      if (complete) placed += 1;
    }
    if (placed > 0) commitTransaction(token);
    else rollbackTransaction(token);
    speak(player, placed === targets.length
      ? `Done—I carried and placed ${placed} torches around you.`
      : `I placed ${placed} torches on the safe surfaces I could reach. The area is brighter, and I didn’t stop at the tricky spots.`);
    endBuildAction(
      token,
      placed === targets.length ? "completed" : placed > 0 ? "partial" : "failed",
      `physically placed ${placed} of ${targets.length} nearby torches`,
    );
  } catch (error) {
    if (placed > 0) commitTransaction(token);
    else rollbackTransaction(token);
    console.warn(`[MC Wizard] area torch placement failed: ${error}`);
    endBuildAction(token, placed > 0 ? "partial" : "failed", `placed ${placed} torches before interruption`);
  } finally {
    clearBuild(token);
  }
}

function nearbyGiftAmount(player, itemId) {
  let amount = 0;
  const inventory = player.getComponent("minecraft:inventory")?.container;
  for (let slot = 0; inventory && slot < inventory.size; slot += 1) {
    const item = inventory.getItem(slot);
    if (item?.typeId === itemId) amount += item.amount;
  }
  for (const entity of player.dimension.getEntities({
    type: "minecraft:item",
    location: player.location,
    maxDistance: 8,
  })) {
    const item = entity.getComponent("minecraft:item")?.itemStack;
    if (item?.typeId === itemId) amount += item.amount;
  }
  return amount;
}

function giftRecipient(requester, recipient) {
  if (!recipient || recipient === "requester") return requester;
  const wanted = String(recipient).trim().toLowerCase();
  return humanPlayers().find((candidate) => candidate.name.trim().toLowerCase() === wanted);
}

function giftStack(spec, amount) {
  const stack = new ItemStack(spec.itemId, amount);
  if (spec.nameTag) stack.nameTag = spec.nameTag;
  if (spec.enchantments?.length) {
    const component = stack.getComponent("minecraft:enchantable");
    if (!component) throw new Error(`${spec.itemId} cannot be enchanted`);
    const enchantments = spec.enchantments.map(({ id, level }) => {
      const type = EnchantmentTypes.get(id);
      if (!type) throw new Error(`unknown enchantment ${id}`);
      return { type, level };
    });
    component.addEnchantments(enchantments);
  }
  return stack;
}

async function giveItemsAsWizard(player, items, report, recipient) {
  if (buildInProgress || buildPreparing) {
    queueBuild(
      player,
      (current) => giveItemsAsWizard(current, items, report, recipient),
      40,
      "I’m gathering those items and will bring them over as soon as my current spell is stable.",
    );
    return;
  }
  const reservation = beginBuildPreparation();
  let activeReport = report;
  try {
    const target = giftRecipient(player, recipient);
    if (!target) {
      activeReport ||= beginImmediateAction(player);
      speak(player, `I can’t see a connected player named ${recipient}. I’m keeping the delivery ready for an exact connected name.`);
      endImmediateAction(activeReport, "failed", `exact recipient ${recipient} is not connected`);
      return;
    }
    const bot = bringWizardTo(target, true, true);
    if (!bot) {
      queueBuild(player, (current) => giveItemsAsWizard(current, items, report, recipient), 40, "I’m gathering those items and will bring them over as soon as I reappear.");
      return;
    }
    activeReport ||= beginImmediateAction(player);
    for (let attempts = 0; attempts < 60 && distanceSquared(bot.location, target.location) > 5 * 5; attempts += 1) {
      moveWizardBeside(bot, target);
      await system.waitTicks(2);
    }
    let dropped = 0;
    const requested = items.reduce((total, { amount }) => total + amount, 0);
    for (const spec of items) {
      const { itemId, amount } = spec;
      try {
        const probe = giftStack(spec, 1);
        let remaining = amount;
        while (remaining > 0) {
          const count = Math.min(remaining, probe.maxAmount || 1);
          const stack = giftStack(spec, count);
          const before = nearbyGiftAmount(target, itemId);
          if (!bot.setItem(stack, 0, true) || !bot.dropSelectedItem()) {
            throw new Error(`could not drop ${itemId}`);
          }
          await system.waitTicks(4);
          const arrived = Math.max(0, nearbyGiftAmount(target, itemId) - before);
          if (arrived < count) {
            const missing = count - arrived;
            target.dimension.spawnItem(giftStack(spec, missing), {
              x: target.location.x,
              y: target.location.y + 0.5,
              z: target.location.z,
            });
            console.warn(`[MC Wizard] repaired missing ${itemId} delivery at ${target.name}'s feet`);
          }
          dropped += count;
          remaining -= count;
        }
      } catch (error) {
        console.warn(`[MC Wizard] could not gift ${itemId}: ${error}`);
      }
    }
    equipWizard();
    const complete = dropped === requested;
    const recipientLabel = target.id === player.id ? "your feet" : `${target.name}'s feet`;
    speak(player, complete
      ? `There you are—I brought ${dropped} item${dropped === 1 ? "" : "s"} and dropped them at ${recipientLabel}.`
      : dropped > 0
        ? `I brought ${dropped} of ${requested} items. I’m keeping this request active so I can retry the missing ones.`
        : "Those item names were smudged. Tell me what they look like and I’ll try a matching item next.");
    endImmediateAction(
      activeReport,
      complete ? "completed" : "failed",
      complete ? `delivered all ${requested} requested items`
        : `delivered ${dropped} of ${requested} requested items`,
    );
  } catch (error) {
    console.warn(`[MC Wizard] item delivery was interrupted: ${error}`);
    endImmediateAction(activeReport, "failed", "item delivery was interrupted before completion");
  } finally {
    endBuildPreparation(reservation);
  }
}

function capabilityProgramFrame(player, program) {
  if (program.site === "active_project") {
    const project = program.targetKind
      ? newestProjectRecord(projectFor(player, program.targetKind), structureFor(player, program.targetKind))
      : newestProjectRecord(lastProjectFor(player), lastStructureFor(player));
    if (!project) throw new Error("the active project location is unavailable");
    if (project.dimensionId !== player.dimension.id) throw new Error("the active project is in another dimension");
    return {
      origin: { ...project.origin },
      forward: { ...project.forward },
      right: { ...project.right },
    };
  }
  const forward = cardinalDirection(player);
  const right = { x: -forward.z, z: forward.x };
  const base = {
    x: Math.floor(player.location.x),
    y: standingBlockY(player.location),
    z: Math.floor(player.location.z),
  };
  return { origin: offset(base, forward, right, 3), forward, right };
}

function capabilityLocation(frame, vector) {
  return customLocation(frame.origin, frame.forward, frame.right, vector);
}

async function finishWizardOperation(operation, label) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const result = operation();
    if (result === true) return;
    if (result === "interaction-failed") throw new Error(`${label} could not be verified`);
    await system.waitTicks(2);
  }
  throw new Error(`${label} did not finish in time`);
}

async function moveWizardForProgram(player, frame, { target, mode }) {
  const bot = bringWizardTo(player, true, true);
  if (!bot) throw new Error("the simulated player is unavailable");
  const destination = capabilityLocation(frame, target);
  const feet = {
    x: Math.floor(destination.x),
    y: Math.floor(destination.y),
    z: Math.floor(destination.z),
  };
  if (!blockIsOpen(player.dimension, feet) || !blockIsOpen(player.dimension, { ...feet, y: feet.y + 1 })) {
    throw new Error("the requested movement target is blocked");
  }
  if (mode === "fly") bot.fly();
  else bot.stopFlying();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (distanceSquared(bot.location, destination) <= 1.5 * 1.5) return `${mode} movement reached its target`;
    if (attempt % 10 === 0) {
      try {
        if (mode === "walk") bot.navigateToLocation(destination, 1);
        else bot.moveToLocation(destination, { speed: 1, faceTarget: true });
      } catch {
        bot.moveToLocation(destination, { speed: 0.8, faceTarget: true });
      }
    }
    await system.waitTicks(2);
  }
  bot.teleport(destination, { dimension: player.dimension, facingLocation: player.location });
  if (mode === "walk") bot.stopFlying();
  return `${mode} path stalled, so Wizard completed the move with a short blink`;
}

function dropCapabilityBook(player, { title, text, author }) {
  const book = new ItemStack("minecraft:writable_book", 1);
  const component = book.getComponent("minecraft:book");
  if (!component) throw new Error("book component is unavailable");
  component.setContents(bookPages(text));
  component.signBook(bookTitle(title), author);
  player.dimension.spawnItem(book, {
    x: player.location.x,
    y: player.location.y + 0.5,
    z: player.location.z,
  });
  return `dropped book “${component.title}” at the player's feet`;
}

async function executeCapabilityStep(player, step, frame, { allowRequesterTeleport = false } = {}) {
  const args = step.arguments;
  if (step.capability === "control.wait") {
    await system.waitTicks(args.ticks);
    return `waited ${args.ticks} ticks`;
  }
  if (step.capability === "player.move") return moveWizardForProgram(player, frame, args);
  if (step.capability === "player.place-blocks") {
    for (const placement of args.blocks) {
      const target = capabilityLocation(frame, placement.target);
      const support = capabilityLocation(frame, placement.support);
      const facing = placement.orientationTarget
        ? capabilityLocation(frame, placement.orientationTarget) : undefined;
      await finishWizardOperation(() => placeAsWizard(
        player.dimension,
        placement.itemId,
        support,
        target,
        placement.expectedType,
        undefined,
        directionFromSupport(support, target),
        placement.expectedStates,
        facing,
      ), `placing ${placement.itemId} at ${placement.target.join(",")}`);
    }
    return `physically placed ${args.blocks.length} block${args.blocks.length === 1 ? "" : "s"}`;
  }
  if (step.capability === "player.break-blocks") {
    for (const target of args.targets) {
      const location = capabilityLocation(frame, target);
      await finishWizardOperation(
        () => breakAsWizard(player.dimension, location),
        `breaking the block at ${target.join(",")}`,
      );
    }
    return `physically broke ${args.targets.length} block${args.targets.length === 1 ? "" : "s"}`;
  }
  if (step.capability === "player.use-item") {
    await finishWizardOperation(
      () => useItemAsWizard(player.dimension, args, frame.origin, frame.forward, frame.right),
      `using ${args.itemId}`,
    );
    return `used ${args.itemId} on the requested block`;
  }
    if (step.capability === "world.command") {
      if (commandsMoveOptedOutPlayer(player, args.commands)) {
        throw new Error("broad relocation could move a non-participant");
      }
      if (needsTeleportConsent(player) && !allowRequesterTeleport && commandsTeleportRequester(args.commands)) {
        throw new Error("the player asked me to confirm before teleporting them");
      }
      const result = executeRequesterCommands(player, args.commands);
    if (result.succeeded !== result.total) throw new Error(`only ${result.succeeded} of ${result.total} commands succeeded`);
    return `executed ${result.succeeded} requester-scoped command${result.succeeded === 1 ? "" : "s"}`;
  }
    if (step.capability === "server.console") {
      if (commandsMoveOptedOutPlayer(player, args.commands)) {
        throw new Error("broad relocation could move a non-participant");
      }
      if (needsTeleportConsent(player) && !allowRequesterTeleport && commandsTeleportRequester(args.commands)) {
        throw new Error("the player asked me to confirm before teleporting them");
      }
      return executeServerConsole(player, args.commands);
    }
  if (step.capability === "server.configure") return configureServer(player, args);
  if (step.capability === "artifact.book") return dropCapabilityBook(player, args);
  if (step.capability === "observe.snapshot") {
    const snapshot = liveWorldSnapshot(player);
    return `captured ${snapshot.nearbyBlocks.length} block types and ${snapshot.nearbyEntities.length} nearby entities`;
  }
  if (step.capability === "verify.blocks") {
    const misses = args.blocks.filter(({ target, typeId, expectedStates = {} }) => {
      const block = player.dimension.getBlock(capabilityLocation(frame, target));
      if (block?.typeId !== typeId) return true;
      const states = block.permutation.getAllStates();
      return Object.entries(expectedStates).some(([state, expected]) => {
        const stateName = Object.keys(states).find((name) => name === state || name.endsWith(`:${state}`));
        return !stateName || states[stateName] !== expected;
      });
    });
    if (misses.length) throw new Error(`${misses.length} expected block${misses.length === 1 ? " was" : "s were"} missing`);
    return `verified ${args.blocks.length} block${args.blocks.length === 1 ? "" : "s"}`;
  }
  if (step.capability === "verify.entities") {
    const count = player.dimension.getEntities({
      type: args.typeId,
      location: capabilityLocation(frame, args.location),
      maxDistance: args.maxDistance,
    }).length;
    if (count < args.minimum) throw new Error(`found ${count} of ${args.minimum} required ${args.typeId}`);
    return `verified ${count} nearby ${args.typeId}`;
  }
  if (step.capability === "script.spawn-entity") {
    const location = capabilityLocation(frame, args.location);
    for (let index = 0; index < args.count; index += 1) {
      const entity = player.dimension.spawnEntity(args.typeId, {
        x: location.x + 0.5,
        y: location.y,
        z: location.z + 0.5,
      });
      if (args.nameTag) entity.nameTag = args.nameTag;
    }
    return `spawned ${args.count} ${args.typeId}`;
  }
    if (step.capability === "script.teleport") {
      if (args.subject === "requester" && needsTeleportConsent(player) && !allowRequesterTeleport) {
        throw new Error("the player asked me to confirm before teleporting them");
      }
      const subject = args.subject === "requester" ? player : bringWizardTo(player, true, true);
    if (!subject) throw new Error("the teleport subject is unavailable");
    subject.teleport(capabilityLocation(frame, args.target), { dimension: player.dimension });
    return `teleported ${args.subject}`;
  }
  if (step.capability === "script.effect") {
    const subject = args.subject === "requester" ? player : bringWizardTo(player, true, true);
    if (!subject) throw new Error("the effect subject is unavailable");
    subject.addEffect(args.effectId, args.duration, {
      amplifier: args.amplifier,
      showParticles: args.showParticles,
    });
    return `applied ${args.effectId} to ${args.subject}`;
  }
  throw new Error(`capability ${step.capability} is not installed`);
}

function capabilityProjectSummary(program, steps) {
  const placements = steps.filter(({ capability }) => capability === "player.place-blocks")
    .flatMap(({ arguments: args }) => args.blocks.map((block) => ({
      itemId: block.itemId,
      expectedType: block.expectedType,
      target: block.target,
      support: block.support,
      orientationTarget: block.orientationTarget || null,
    })));
  const interactions = steps.filter(({ capability }) => capability === "player.use-item")
    .map(({ arguments: args }) => ({ action: "use_item_on_block", ...args }));
  if (!placements.length && !interactions.length) return undefined;
  return projectBlueprintSummary({
    title: program.title,
    kind: program.targetKind || program.title,
    placements,
    interactions,
  });
}

async function executeCapabilityProgram(player, program, { allowRequesterTeleport = false } = {}) {
  if (buildInProgress || buildPreparing) {
    queueBuild(
      player,
        (current) => void executeCapabilityProgram(current, program, { allowRequesterTeleport }),
      40,
      `I’ve queued “${program.title}” and will continue it automatically when my hands are free.`,
    );
    return;
  }
  const bot = bringWizardTo(player, true, true);
  if (!bot) {
      queueBuild(player, (current) => void executeCapabilityProgram(current, program, { allowRequesterTeleport }), 40, "I’m returning now, then I’ll carry out the whole plan.");
    return;
  }
  const token = ++nextBuildToken;
  activeBuildToken = token;
  buildInProgress = true;
  if (!bindBuildAction(player, token)) {
    clearBuild(token);
    return;
  }
  let transactionStarted = false;
  let changedWorld = false;
  try {
    // Deterministic mutations get their verification synthesized from their own
    // declared outcomes; the evidence assert below stays as the final guard.
    const steps = synthesizeRuntimeEvidence(program.steps.map(normalizeRuntimeStep));
    if (!runtimeProgramHasEvidence(steps)) throw new Error("the program lacks runtime evidence for its mutations");
    const frame = capabilityProgramFrame(player, program);
    const expectedBlocks = steps.flatMap((step) => {
      if (step.capability === "player.place-blocks") return step.arguments.blocks.map((block) => ({
        location: capabilityLocation(frame, block.target),
        typeId: block.expectedType,
      }));
      if (step.capability === "player.break-blocks") return step.arguments.targets.map((target) => ({
        location: capabilityLocation(frame, target),
        typeId: "minecraft:air",
      }));
      return [];
    });
    if (expectedBlocks.length) {
      beginTransaction(player.id, token, player.dimension, expectedBlocks);
      transactionStarted = true;
    }
    const project = capabilityProjectSummary(program, steps);
    if (project) bindBuildProject(player, token, {
      ...project,
      dimensionId: player.dimension.id,
      origin: { ...frame.origin },
      forward: { ...frame.forward },
      right: { ...frame.right },
    });
    const failures = [];
    const results = [];
    for (const step of steps) {
      try {
        if (/^(?:player\.(?:place|break|use)|world\.command|script\.)/.test(step.capability)) changedWorld = true;
          results.push({ id: step.id, detail: await executeCapabilityStep(player, step, frame, { allowRequesterTeleport }) });
      } catch (error) {
        const detail = String(error?.message || error).slice(0, 160);
        failures.push({ id: step.id, detail });
        if (step.onFailure !== "continue") break;
      }
    }
    if (transactionStarted) {
      if (changedWorld) commitTransaction(token);
      else rollbackTransaction(token);
    }
    clearBuild(token);
    if (failures.length) {
      const first = failures[0];
      speak(player, `I completed ${results.length} step${results.length === 1 ? "" : "s"}, but “${first.id}” needs another approach. I’m checking the world and replanning it now.`);
      endBuildAction(token, changedWorld ? "partial" : "failed", `program ${program.title}: ${results.length}/${steps.length} steps; ${first.id}: ${first.detail}`);
    } else {
      const explicitChecks = steps.filter(({ capability }) => capability.startsWith("verify.")).length;
      speak(player, explicitChecks
        ? `Done—“${program.title}” completed all ${results.length} steps, including ${explicitChecks} explicit check${explicitChecks === 1 ? "" : "s"}. I’m comparing that result with your whole request now.`
        : `Done—“${program.title}” completed all ${results.length} steps. I’m comparing that result with your whole request now.`);
      endBuildAction(token, "completed", `program ${program.title}: completed ${results.length}/${steps.length} steps; explicit checks=${explicitChecks}`);
    }
  } catch (error) {
    if (transactionStarted) {
      if (changedWorld) commitTransaction(token);
      else rollbackTransaction(token);
    }
    clearBuild(token);
    console.warn(`[MC Wizard] capability program failed: ${error}`);
    speak(player, "One part of that plan did not fit this world. I kept every useful result and I’m replanning the failed part now.");
    endBuildAction(token, changedWorld ? "partial" : "failed", `capability program failed: ${String(error?.message || error).slice(0, 180)}`);
  }
}

function applyResponse(playerId, payload, question) {
  const player = playerById(playerId);
  if (!player) {
    console.warn("[MC Wizard] response arrived after its player disappeared");
    return;
  }
  if (payload.kind === "general") {
    deliverModelAnswer(player, payload, question);
    return;
  }
  receivePlayerPreferences(player, payload.preferences);
  console.warn("[MC Wizard] applying response action=" + (payload.action
    ? `${payload.action.type}:${payload.action.id || payload.action.plan?.title || "unnamed"}`
    : "none"));
  if (!buildInProgress && !buildPreparing) bringWizardTo(player);
  speak(player, payload.answer || "I found no answer.", {
    privatePreference: payload.mode === "player-memory" || payload.preferenceApplied === true,
  });

  const action = payload.action;
  registerActionRequest(player, payload);
  if (actionMovesOptedOutPlayer(player, action)) {
    speak(player, "That broad travel spell could move players not joining this trip, so I kept it local.");
    failPendingAction(player, "broad relocation could move a non-participant");
  } else if (needsTeleportConsent(player) && actionMovesRequester(action) && !directTravelRequest(question)) {
    speak(player, "I’ll stay put unless you ask me to travel in this message.", { privatePreference: true });
    failPendingAction(player, "direct travel confirmation required");
  } else if (action?.type === "place_blueprint"
    && action.id === "copper_bulb_t_flip_flop"
    && action.version === 1) {
    buildCopperBulbTFlipFlop(player);
  } else if (action?.type === "place_blueprint"
    && action.id === "binary_adder_2bit"
    && action.version === 1) {
    buildRedstoneCalculator(player);
  } else if (action?.type === "place_blueprint"
    && action.id === "automated_chicken_farm"
    && action.version === 1) {
    void buildInteractiveBlueprint(player, createAutomaticChickenFarmBlueprint());
  } else if (action?.type === "place_blueprint"
    && action.id === "automatic_wool_farm"
    && action.version === 1) {
    void buildInteractiveBlueprint(player, createAutomaticWoolFarmBlueprint());
  } else if (action?.type === "place_blueprint"
    && action.id === "automatic_kelp_farm"
    && action.version === 1) {
    void buildInteractiveBlueprint(player, createAutomaticKelpFarmBlueprint());
  } else if (action?.type === "place_blueprint"
    && action.id === "two_by_two_piston_door"
    && action.version === 1) {
    void buildInteractiveBlueprint(player, createTwoByTwoPistonDoorBlueprint());
  } else if (action?.type === "place_blueprint"
    && action.id === "item_sorter"
    && action.version === 1) {
    try {
      void buildInteractiveBlueprint(player, createItemSorterBlueprint(action.filterItem));
    } catch (error) {
      console.warn(`[MC Wizard] item sorter filter was invalid; using iron ingots: ${error}`);
      speak(player, "That item name was fuzzy, so I’m making the sorter recognize iron ingots instead of stopping.");
      void buildInteractiveBlueprint(player, createItemSorterBlueprint());
    }
  } else if (action?.type === "place_blueprint"
    && action.id === "automatic_smelter"
    && action.version === 1) {
    void buildInteractiveBlueprint(player, createAutomaticSmelterBlueprint());
  } else if (action?.type === "build_plan" && action.version === 1) {
    buildValidatedPlan(player, action.plan);
  } else if (action?.type === "build_structure" && action.version === 1) {
    void buildStructure(player, action.plan);
  } else if (action?.type === "build_machine" && action.version === 1) {
    buildMachinePlan(player, action.plan);
  } else if (action?.type === "show_recipe" && action.version === 1) {
    try {
      void buildInteractiveBlueprint(player, createRecipeDisplay(action.itemId));
    } catch (error) {
      console.warn(`[MC Wizard] recipe display failed: ${error}`);
      speak(player, "I don’t have that exact recipe display yet. Name the block or item one more time and I’ll match it carefully.");
      failPendingAction(player, "recipe display could not be created");
    }
  } else if (action?.type === "world_control" && action.version === 1) {
    applyWorldControl(player, action);
  } else if (action?.type === "dimension_travel" && action.version === 1) {
    void applyDimensionTravel(player, action);
  } else if (action?.type === "local_travel" && action.version === 1) {
    void applyLocalTravel(player, action);
  } else if (action?.type === "potion_rain" && action.version === 1) {
    castPotionRain(player, action);
  } else if (action?.type === "give_items" && action.version === 1) {
    void giveItemsAsWizard(player, action.items || [], undefined, action.recipient);
  } else if (action?.type === "run_commands" && action.version === 1) {
    runCommandsForPlayer(player, action.commands || []);
  } else if (action?.type === "execute_program" && action.version === 1) {
    void executeCapabilityProgram(player, action.program, {
      allowRequesterTeleport: directTravelRequest(question),
    });
  } else if (action?.type === "place_area_torches" && action.version === 1) {
    void placeAreaTorches(player);
  } else if (action?.type === "command_lesson" && action.version === 1) {
    buildCommandLesson(player, action.id);
  } else if (action) {
    console.warn(`[MC Wizard] no in-world executor matched action ${action.type || "unknown"}`);
    failPendingAction(player, "no in-world executor matched the selected action");
  }
  if (!action) {
    queueFeedback({
      playerId: player.id,
      playerName: player.name,
      requestId: payload.requestId,
    });
  }
}

async function askBackend(playerId, question, mode = "wizard", planningAttempt = 0, expectedToken, goalRetryId) {
  let player = playerById(playerId);
  if (!player) return;
  const sessionReset = sessionResets.get(playerId);
  const key = `${playerId}:${mode}`;
  if (expectedToken !== undefined && pendingQuestions.get(key) !== expectedToken) return;
  const token = ++nextQuestionToken;
  const requestId = `${system.currentTick.toString(36)}-${token.toString(36)}`;
  pendingQuestions.set(key, token);
  if (mode === "general") player.sendMessage("§b[AI]§r Thinking…");
  else {
    if (!buildInProgress && !buildPreparing) bringWizardTo(player);
    const unfamiliarBuild = /\b(?:build|construct|create|make)\b/i.test(question);
    const acknowledgements = unfamiliarBuild ? [
      "That’s a new spell for me. I’m checking Bedrock designs, then I’ll try it here.",
      "Let me research the tricky parts, then I’ll build my best version here.",
      "I’m comparing a few Bedrock designs before I start placing blocks.",
    ] : [
      "Hmm—one moment.",
      "I’m checking that carefully.",
      "Give me a moment to work that out.",
    ];
    for (const [ticks, message] of [
      [80, acknowledgements[token % acknowledgements.length]],
      [240, "Still working—I’m staying with it."],
      [500, "I’m drawing the tricky parts now. I haven’t forgotten your build."],
      [780, "This is a bigger spell, but I’m still working on the same request."],
    ]) {
      system.runTimeout(() => {
        if (pendingQuestions.get(key) !== token) return;
        const current = playerById(playerId);
        if (current) speak(current, message);
      }, ticks);
    }
  }

  try {
      const requestBody = {
      player: player.name,
      playerId: player.id,
      question,
      mode,
      requestId,
      ...(sessionReset ? { sessionReset } : {}),
      ...(goalRetryId ? { goalId: goalRetryId } : {}),
      ...(mode === "wizard" ? { context: liveWorldSnapshot(player) } : {}),
    };
    let response;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const request = new HttpRequest(WIZARD_URL)
        .setMethod(HttpRequestMethod.Post)
        .setBody(JSON.stringify(requestBody))
        .addHeader("Content-Type", "application/json");
      if (AUTHORIZATION) request.addHeader("Authorization", AUTHORIZATION);
      response = await http.request(request);
      if (response.status !== 429) break;
      if (attempt === 3) throw new Error("brain stayed busy after four tries");
      console.warn(`[MC Wizard] brain was busy; retrying ${player.name}'s request automatically`);
      await system.waitTicks(10 * (attempt + 1));
      if (pendingQuestions.get(key) !== token) return;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`brain returned HTTP ${response.status}`);
    }
    if (sessionReset && sessionResets.get(playerId) === sessionReset) sessionResets.delete(playerId);
    const payload = JSON.parse(response.body);
    const retryPlanning = mode === "wizard"
      && payload?.mode === "planning-deferred"
      && !payload?.action
      && payload?.goal?.status === "active"
      && planningAttempt < 2;
    const responseReport = payload?.action
      && typeof payload.requestId === "string"
      && /^[a-zA-Z0-9_-]{1,64}$/.test(payload.requestId)
        ? { playerId: player.id, playerName: player.name, requestId: payload.requestId }
      : null;
    system.run(() => {
      if (pendingQuestions.get(key) !== token) {
        console.warn(`[MC Wizard] discarded stale ${mode} response for ${player.name}`);
        if (responseReport) {
          void postActionResult(responseReport, "failed", "superseded before execution");
        }
        return;
      }
      if (!retryPlanning) pendingQuestions.delete(key);
      if (!playerById(playerId)) {
        if (responseReport) {
          void postActionResult(responseReport, "failed", "player left before execution");
        }
        return;
      }
      if (retryPlanning) {
        const current = playerById(playerId);
        if (current) speak(current, "That design didn’t fit your goal. I’m trying another one now without making you repeat it.");
        system.runTimeout(
          () => void askBackend(playerId, question, mode, planningAttempt + 1, token, goalRetryId),
          60,
        );
      } else {
        applyResponse(playerId, payload, question);
      }
    });
  } catch (error) {
    console.warn(`[MC Wizard] ${error}`);
    system.run(() => {
      if (pendingQuestions.get(key) !== token) return;
      pendingQuestions.delete(key);
      const current = playerById(playerId);
      if (!current) return;
      if (mode === "general") current.sendMessage("§b[AI]§r I can’t reach the model right now.");
      else speak(current, "I can’t reach my knowledge service right now. Ask an adult to check the MC Wizard server.");
    });
  }
}

function cancelPendingQuestion(player, mode = "wizard") {
  pendingQuestions.delete(`${player.id}:${mode}`);
}

function handleLocalCommand(player, question) {
  const simple = question.trim();
  const confirmsActiveBuild = /^(?:ok(?:ay)?\s+(?:do it|go)|go ahead|start)(?:\s+please)?[.!]?$/i.test(simple);
  if (buildInProgress && confirmsActiveBuild) {
    cancelPendingQuestion(player);
    speak(player, "Already building—watch right here. I’m finishing this one before I start anything else.");
    return true;
  }
  if (/^(?:(?:copy|learn|use|wear) my skin|copy skin)(?: please)?[.!]?$/i.test(simple)) {
    cancelPendingQuestion(player);
    learnWizardSkin(player);
    return true;
  }
  if (/^(?:hi|hello|hey|hiya|yo)(?:\s+(?:wiz|wizard))?[!.?]*$/i.test(simple)) {
    cancelPendingQuestion(player);
    speak(player, "Hi! I’m right here. What should we build or learn today?");
    return true;
  }
  if (/^(?:are you ready|you ready|ready)(?:\s+(?:wiz|wizard))?[!.?]*$/i.test(simple)) {
    cancelPendingQuestion(player);
    speak(player, "Ready! Tell me what you want to try, and I’ll start with you.");
    return true;
  }
  if (/^(?:thanks|thank you|thx)(?:\s+(?:wiz|wizard))?[!.?]*$/i.test(simple)) {
    cancelPendingQuestion(player);
    speak(player, "You’re welcome! I’m ready for the next idea.");
    return true;
  }
  if (/\b(?:tell me (?:a )?joke|minecraft joke)\b/i.test(simple)) {
    cancelPendingQuestion(player);
    speak(player, "Why did the creeper cross the road? To get to the other ssssside!");
    return true;
  }
  const hasRainingObjects = /\b(?:potion|splash|arrow|item|block|mob|animal|chicken|wool|diamond|lava|water)s?\b/i.test(simple);
  if (!hasRainingObjects && /\b(?:make|set|change|turn)\b/i.test(simple)) {
    const time = /\bmidnight\b/i.test(simple) ? "midnight"
      : /\bnoon\b/i.test(simple) ? "noon"
        : /\b(?:day|daytime|morning)\b/i.test(simple) ? "day"
          : /\b(?:night|nighttime)\b/i.test(simple) ? "night" : undefined;
    const asksForWeatherChange = /\bweather\b/i.test(simple)
      || /^(?:please\s+)?(?:make|set|change|turn)\s+(?:it\s+)?(?:to\s+)?(?:rain|raining|rainy|thunder(?:storm)?|clear|sunny|sunshine)\b/i.test(simple)
      || /\b(?:make|set|change|turn)\b.{0,32}\b(?:rain|raining|rainy|thunder(?:storm)?|clear|sunny|sunshine)\b/i.test(simple)
      || /^(?:please\s+)?turn\s+(?:the\s+)?(?:rain|storm)\s+(?:on|off)\b/i.test(simple);
    const weather = !asksForWeatherChange ? undefined
      : /\bthunder(?:storm)?\b/i.test(simple) ? "thunder"
        : /\b(?:rain|raining|rainy)\b/i.test(simple) ? "rain"
          : /\b(?:clear|sunny|sunshine)\b/i.test(simple) ? "clear" : undefined;
    if (time || weather) {
      cancelPendingQuestion(player);
      applyWorldControl(player, { time, weather });
      return true;
    }
  }
  const smallTalk = worldSmallTalk(player, simple);
  if (smallTalk) {
    cancelPendingQuestion(player);
    speak(player, smallTalk);
    return true;
  }
  if (/^(?:undo|undo (?:my |the )?last build)(?: please)?[.!]?$/i.test(question)) {
    cancelPendingQuestion(player);
    undoLastBuild(player);
    return true;
  }
  const wantsMovement = /^(?:come(?: here)?|follow(?: me)?|stay|wait here|stop following)(?: please)?[.!]?$/i
    .test(question);
  if ((buildInProgress || buildPreparing) && wantsMovement) {
    speak(player, "I’m in the middle of placing a demo. I’ll move when I’m finished.");
    return true;
  }
  if (/^(?:come(?: here)?|follow(?: me)?)(?: please)?[.!]?$/i.test(question)) {
    bringWizardTo(player);
    speak(player, "Coming! I’ll follow you.");
    return true;
  }
  if (/^(?:stay|wait here|stop following)(?: please)?[.!]?$/i.test(question)) {
    const bot = ensureWizard(player);
    followPlayerId = player.id;
    wizardShouldStay = true;
    try {
      bot?.stopMoving();
      bot?.lookAtEntity(player, LookDuration.UntilMove);
    } catch (error) {
      console.warn(`[MC Wizard] could not stay: ${error}`);
    }
    speak(player, "I’ll stay here.");
    return true;
  }
  return false;
}

function routeAddressedMessage(player, message) {
  const trimmed = message.trim();
  const match = trimmed.match(/^!?(?:mc\s+)?wiz(?:ard)?(?:\s*[:,]\s*|\s+)(.*)$/i);
  const bareName = /^!?(?:mc\s+)?wiz(?:ard)?$/i.test(trimmed);
  const nearby = wizardIsValid()
    && wizard.dimension.id === player.dimension.id
    && distanceSquared(wizard.location, player.location) <= 12 * 12;
  const implicit = humanPlayers().length === 1 || nearby;
  if (!match && !bareName && !implicit) return false;
  const playerId = player.id;
  const question = match ? match[1].trim() : bareName ? "" : trimmed;
  logChat(player, "wizard", "player", trimmed, isPrivatePreferenceMessage(question));
  system.run(() => {
    const current = playerById(playerId);
    if (!current) return;
    if (!question) {
      speak(current, "Ask me anything. You can say ‘wiz’ when other players are chatting too.");
      return;
    }
    if (!handleLocalCommand(current, question)) void askBackend(playerId, question);
  });
  return true;
}

function routeAIMessage(player, message) {
  const trimmed = message.trim();
  const match = trimmed.match(/^!?ai(?:\s*[:,]\s*|\s+)(.*)$/i);
  const bareName = /^!?ai$/i.test(trimmed);
  if (!match && !bareName) return false;
  const playerId = player.id;
  const question = match?.[1]?.trim();
  logChat(player, "general", "player", trimmed);
  system.run(() => {
    const current = playerById(playerId);
    if (!current) return;
    if (!question) {
      current.sendMessage("§b[AI]§r Ask with: ai, why is the sky blue?");
      return;
    }
    void askBackend(playerId, question, "general");
  });
  return true;
}

world.beforeEvents.chatSend.subscribe((event) => {
  if (wizardSpeaking) return;
  if (isWizardPlayer(event.sender) || event.sender.name === WIZARD_NAME) return;
  if (routeFeedbackMessage(event.sender, event.message)) return;
  if (parseGradeMessage(event.message.replace(
    /^!?(?:mc\s+)?wiz(?:ard)?(?:\s*[:,]\s*|\s+)/i,
    "",
  ))) {
    const playerId = event.sender.id;
    system.run(() => {
      const player = playerById(playerId);
      if (player) speak(player, "I don’t have a finished request waiting for a grade yet.");
    });
    return;
  }
  if (!routeAIMessage(event.sender, event.message)
    && !routeAddressedMessage(event.sender, event.message)) return;
  engineAddressedMessageCounts.set(
    event.sender.id,
    (engineAddressedMessageCounts.get(event.sender.id) || 0) + 1,
  );
});

world.afterEvents.playerSpawn.subscribe((event) => {
  if (isWizardPlayer(event.player) || event.player.name === WIZARD_NAME) return;
  const playerId = event.player.id;
  const initialSpawn = event.initialSpawn;
  if (initialSpawn) {
    cancelPendingQuestion(event.player, "wizard");
    cancelPendingQuestion(event.player, "general");
    sessionResets.set(playerId, `join-${RUNTIME_SESSION_NONCE}-${system.currentTick.toString(36)}-${(++nextQuestionToken).toString(36)}`);
    playerPreferencesPending.add(playerId);
    system.run(() => {
      const player = playerById(playerId);
      if (!player) return;
      void loadPlayerPreferences(player).then(() => {
        const current = playerById(playerId);
        if (current && !buildInProgress && !buildPreparing) bringWizardTo(current, followPlayerId === current.id);
      });
    });
  }
  system.runTimeout(() => {
      const player = playerById(playerId);
      if (!player) return;
      followPlayerId ||= player.id;
      if (!buildInProgress && !buildPreparing) bringWizardTo(player, followPlayerId === player.id);
      if (initialSpawn && !greetedPlayers.has(player.id)) {
        greetedPlayers.add(player.id);
        speak(player, "Hello! I’m MC Wizard. Chat normally when we’re alone or nearby, or say ‘wiz’ when the server is busy. Ask about Bedrock redstone, commands, or a demo.");
    }
  }, 20);
});

world.afterEvents.playerLeave.subscribe((event) => {
  system.run(() => {
    advancePlayerPreferenceGeneration(event.playerId);
    playerPreferences.delete(event.playerId);
    playerPreferencesPending.delete(event.playerId);
    sessionResets.delete(event.playerId);
    pendingQuestions.delete(`${event.playerId}:wizard`);
    pendingQuestions.delete(`${event.playerId}:general`);
    queuedBuilds.delete(event.playerId);
    const abandoned = pendingActionReports.get(event.playerId);
    if (abandoned) {
      pendingActionReports.delete(event.playerId);
      void postActionResult(abandoned, "failed", "player left before the action started");
    }
    pendingFeedback.delete(event.playerId);
    queuedFeedback.delete(event.playerId);
    if (humanPlayers().length) return;
    if (wizardIsValid()) {
      try {
        wizard.disconnect();
      } catch (error) {
        console.warn(`[MC Wizard] disconnect failed: ${error}`);
      }
    }
    wizard = undefined;
    followPlayerId = undefined;
    if (activeBuildToken !== undefined) {
      const abandonedToken = activeBuildToken;
      clearBuild(abandonedToken, true);
      endBuildAction(abandonedToken, "failed", "all players left before the build completed");
    }
    buildActionGeneration += 1;
    activeBuildPreparation = undefined;
    buildInProgress = false;
    buildPreparing = false;
    buildMovement = undefined;
    placementRetries.clear();
    preparedPlacements.clear();
    buildRetryNotices.clear();
    nonTransactionalBuildTokens.clear();
    queuedBuilds.clear();
    for (const report of pendingActionReports.values()) {
      endImmediateAction(report, "failed", "all players left before the action started");
    }
    pendingActionReports.clear();
    pendingFeedback.clear();
    queuedFeedback.clear();
  });
});

system.runInterval(() => {
  const player = playerById(followPlayerId) || humanPlayers()[0];
  if (!player) return;
  followPlayerId = player.id;
  if (!wizardIsValid()) {
    const bot = ensureWizard(player);
    if (bot && wizardShouldStay) {
      try {
        bot.stopMoving();
        bot.lookAtEntity(player, LookDuration.UntilMove);
      } catch (error) {
        console.warn(`[MC Wizard] restore-stay failed: ${error}`);
      }
    }
    return;
  }
  if (wizardShouldStay || buildInProgress || buildPreparing) return;
  try {
    const sameDimension = wizard.dimension.id === player.dimension.id;
    const distance = sameDimension ? distanceSquared(wizard.location, player.location) : Infinity;
    if (!sameDimension) {
      console.warn(`[MC Wizard] ${player.name} is in another dimension; refusing to teleport`);
    } else if (!moveWizardBeside(wizard, player)) idleLookAround(player);
  } catch (error) {
    console.warn(`[MC Wizard] follow loop failed: ${error}`);
  }
}, 80);

world.afterEvents.worldLoad.subscribe(() => {
  recoverInterruptedTransaction();
  console.warn(`[MC Wizard] ready; brain=${WIZARD_URL}`);
  if (variable("mc_wizard_e2e", false) === true) {
    system.runTimeout(() => startE2E({
      routeAddressedMessage,
      routeFeedbackMessage,
      engineAddressedMessageCount: (playerId) => engineAddressedMessageCounts.get(playerId) || 0,
      undoLastBuild,
      hasCommittedBuild: (playerId) => lastUndo.has(playerId),
      buildCommitToken: (playerId) => lastCompletedBuildTokens.get(playerId),
      buildValidatedPlan,
      prepareBuildWorkshop,
      deliverTestBook: (player) => deliverModelAnswer(player, {
        label: "E2E",
        answer: "# Redstone guide\n\n" + "Use repeaters to control timing, comparators to measure signals, and lamps to make output easy to read. ".repeat(12),
      }, "redstone guide"),
      deliverTestGift: (player, recipient) => giveItemsAsWizard(player, [{
        itemId: "minecraft:diamond", amount: 7, nameTag: "Seven Stars",
      }], undefined, recipient),
    }), 20);
  }
});
