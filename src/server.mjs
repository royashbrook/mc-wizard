import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createNodeServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  STRUCTURE_LIMITS,
  STRUCTURE_PHASES,
  STRUCTURE_PRIMITIVE_LIMIT,
} from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";
import { loadCorpus } from "./rag.mjs";
import { createInteractionLog } from "./interaction-log.mjs";
import { createFileSessionStore } from "./sessions.mjs";
import { createFileLearnedRecipeStore } from "./learned-recipes.mjs";
import { createFilePlayerPreferenceStore } from "./player-preferences.mjs";
import { createWizard } from "./wizard.mjs";
import { LOCATABLE_STRUCTURES } from "./skills.mjs";
import { readRuntimeSettings } from "./runtime-settings.mjs";
import { createServerControl } from "./server-control.mjs";
import { normalizeRuntimeStep } from "../bedrock/behavior_packs/mc_wizard/scripts/capability-runtime.js";
import {
  requesterCommand,
  locateBedrockStructure,
  runProcess,
  sendBedrockCommand,
  validateMinecraftCommand,
} from "./bedrock-console.mjs";

const MAX_BODY_BYTES = 128 * 1024;
const CONTEXT_BLOCK_ID = /^minecraft:[a-z0-9_]{1,48}$/;
const PLAYER_ID = /^[A-Za-z0-9._:-]{1,192}$/;
const SESSION_RESET = /^[a-zA-Z0-9_-]{1,64}$/;

function opaquePlayerId(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !PLAYER_ID.test(value)) {
    const error = new Error("playerId must be a 1–192 character opaque Bedrock player identifier");
    error.status = 400;
    throw error;
  }
  return value;
}

const finiteInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max
  ? value : undefined;

function worldVector(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const vector = {
    x: finiteInt(value.x, -30_000_000, 30_000_000),
    y: finiteInt(value.y, -512, 1_024),
    z: finiteInt(value.z, -30_000_000, 30_000_000),
  };
  return Object.values(vector).every(Number.isInteger) ? vector : undefined;
}

export function validateLocateBody(body) {
  const player = typeof body?.player === "string" ? body.player.trim() : "";
  const origin = worldVector({ x: body?.origin?.x, y: 80, z: body?.origin?.z });
  if (!player || player.length > 32) throw Object.assign(new Error("player must be 1-32 characters"), { status: 400 });
  if (!origin) throw Object.assign(new Error("origin must contain bounded integer x and z coordinates"), { status: 400 });
  const structure = String(body.structure || "").replace(/^minecraft:/, "");
  const metadata = LOCATABLE_STRUCTURES[structure];
  const dimension = String(body.dimension || metadata?.dimensions[0] || "");
  if (!metadata) throw Object.assign(new Error("structure must be a supported Bedrock locate structure"), { status: 400 });
  if (!metadata.dimensions.includes(dimension)) {
    throw Object.assign(new Error("dimension does not support that generated structure"), { status: 400 });
  }
  return { player, origin: { x: origin.x, z: origin.z }, structure, dimension };
}

function structurePoint(value, dimensions) {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const limits = [dimensions.width, dimensions.height, dimensions.depth];
  const point = value.map((coordinate, axis) => finiteInt(coordinate, 0, limits[axis] - 1));
  return point.every(Number.isInteger) ? point : undefined;
}

function structurePrimitives(value, dimensions) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > STRUCTURE_PRIMITIVE_LIMIT) return undefined;
  const primitives = [];
  let lastPhase = 0;
  let totalVolume = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const shape = ["box", "line", "hollow_box"].includes(entry.shape) ? entry.shape : undefined;
    const phaseIndex = STRUCTURE_PHASES.indexOf(entry.phase);
    const blockId = typeof entry.blockId === "string" && CONTEXT_BLOCK_ID.test(entry.blockId)
      ? entry.blockId : undefined;
    const first = structurePoint(entry.from, dimensions);
    const second = structurePoint(entry.to, dimensions);
    if (!shape || phaseIndex < lastPhase || !blockId || !first || !second) return undefined;
    lastPhase = phaseIndex;
    const from = first.map((coordinate, axis) => Math.min(coordinate, second[axis]));
    const to = first.map((coordinate, axis) => Math.max(coordinate, second[axis]));
    if (shape === "line" && from.filter((coordinate, axis) => coordinate === to[axis]).length < 2) {
      return undefined;
    }
    if (shape === "hollow_box" && from.some((coordinate, axis) => to[axis] - coordinate + 1 < 3)) {
      return undefined;
    }
    totalVolume += (to[0] - from[0] + 1) * (to[1] - from[1] + 1) * (to[2] - from[2] + 1);
    if (totalVolume > 2_000_000) return undefined;
    primitives.push({ shape, phase: entry.phase, blockId, from, to });
  }
  return primitives;
}

function structureEntities(value, dimensions) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 8) return undefined;
  const entities = value.map((entry) => {
    const typeId = typeof entry?.typeId === "string" && CONTEXT_BLOCK_ID.test(entry.typeId)
      ? entry.typeId : undefined;
    const location = structurePoint(entry?.location, dimensions);
    return typeId && location ? { typeId, location } : undefined;
  });
  return entities.every(Boolean) ? entities : undefined;
}

function verifiedInhabitantCounts(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 8) return undefined;
  const counts = entries.map(([typeId, count]) => (
    CONTEXT_BLOCK_ID.test(typeId) && Number.isInteger(finiteInt(count, 0, 8))
      ? [typeId, count] : undefined
  ));
  return counts.every(Boolean) ? Object.fromEntries(counts) : undefined;
}

function projectPoint(value) {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const point = value.map((coordinate) => finiteInt(coordinate, -64, 64));
  return point.every(Number.isInteger) ? point : undefined;
}

function projectText(value, max) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, max)
    : "";
}

function projectSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const title = projectText(value.title, 64);
  const kind = projectText(value.kind, 64).toLowerCase();
  const relativeOrigin = worldVector(value.relativeOrigin);
  const min = projectPoint(value.bounds?.min);
  const max = projectPoint(value.bounds?.max);
  if (!title || !kind || !relativeOrigin || !min || !max
    || min.some((coordinate, axis) => coordinate > max[axis])) return undefined;
  const placements = Array.isArray(value.placements) ? value.placements.slice(0, 128)
    .map((entry) => {
      const itemId = typeof entry?.itemId === "string" && CONTEXT_BLOCK_ID.test(entry.itemId)
        ? entry.itemId : undefined;
      const target = projectPoint(entry?.target);
      const support = projectPoint(entry?.support);
      const orientationTarget = entry?.orientationTarget === null ? null : projectPoint(entry?.orientationTarget);
      return itemId && target && support && orientationTarget !== undefined
        ? { itemId, target, support, orientationTarget } : undefined;
    }).filter(Boolean) : [];
  const interactions = Array.isArray(value.interactions) ? value.interactions.slice(0, 24)
    .map((entry) => {
      const action = entry?.action === "use_item_on_block" ? entry.action : undefined;
      const itemId = typeof entry?.itemId === "string" && CONTEXT_BLOCK_ID.test(entry.itemId)
        ? entry.itemId : undefined;
      const block = projectPoint(entry?.block);
      const faceTarget = projectPoint(entry?.faceTarget);
      return action && itemId && block && faceTarget ? { action, itemId, block, faceTarget } : undefined;
    }).filter(Boolean) : [];
  return { title, kind, relativeOrigin, bounds: { min, max }, placements, interactions };
}

export function validateWorldContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const dimension = typeof value.dimension === "string" && /^minecraft:[a-z0-9_]+$/.test(value.dimension)
    ? value.dimension : undefined;
  const weather = ["clear", "rain", "thunder", "unknown"].includes(value.weather)
    ? value.weather : "unknown";
  const timeOfDay = finiteInt(value.timeOfDay, 0, 23_999);
  const player = worldVector(value.player);
  if (!dimension || timeOfDay === undefined || !player) return undefined;
  const nearbyBlocks = Array.isArray(value.nearbyBlocks) ? value.nearbyBlocks.slice(0, 16)
    .map((entry) => ({
      typeId: typeof entry?.typeId === "string" && /^minecraft:[a-z0-9_]+$/.test(entry.typeId)
        ? entry.typeId : undefined,
      count: finiteInt(entry?.count, 1, 10_000),
    })).filter(({ typeId, count }) => typeId && count) : [];
  const nearbyEntities = Array.isArray(value.nearbyEntities) ? value.nearbyEntities.slice(0, 12)
    .map((entry) => ({
      typeId: typeof entry?.typeId === "string" && /^minecraft:[a-z0-9_]+$/.test(entry.typeId)
        ? entry.typeId : undefined,
      relative: worldVector(entry?.relative),
    })).filter(({ typeId, relative }) => typeId && relative) : [];
  const suppliedDimensions = value.lastStructure?.dimensions;
  const dimensions = suppliedDimensions && {
    width: finiteInt(suppliedDimensions.width, 1, STRUCTURE_LIMITS.width),
    depth: finiteInt(suppliedDimensions.depth, 1, STRUCTURE_LIMITS.depth),
    height: finiteInt(suppliedDimensions.height, 1, STRUCTURE_LIMITS.height),
  };
  const validDimensions = dimensions && Object.values(dimensions).every(Number.isInteger)
    ? dimensions : undefined;
  const material = (name) => typeof value.lastStructure?.materials?.[name] === "string"
    && /^minecraft:[a-z0-9_]+$/.test(value.lastStructure.materials[name])
    ? value.lastStructure.materials[name] : undefined;
  const materials = {
    primary: material("primary"),
    accent: material("accent"),
    roof: material("roof"),
  };
  const features = Array.isArray(value.lastStructure?.features)
    ? value.lastStructure.features.slice(0, 16)
      .map((feature) => String(feature).replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 32))
      .filter(Boolean)
    : [];
  const primitives = validDimensions
    ? structurePrimitives(value.lastStructure?.primitives, validDimensions) : undefined;
  const entities = validDimensions
    ? structureEntities(value.lastStructure?.entities, validDimensions) : undefined;
  const verifiedInhabitants = verifiedInhabitantCounts(value.lastStructure?.verifiedInhabitants);
  const lastStructure = typeof value.lastStructure?.kind === "string" ? {
    kind: value.lastStructure.kind.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 48),
    title: String(value.lastStructure.title || "").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64),
    dimensions: validDimensions,
    ...(Object.values(materials).every(Boolean) ? { materials } : {}),
    ...(features.length ? { features } : {}),
    ...(primitives?.length ? { primitives } : {}),
    ...(entities?.length ? { entities } : {}),
    ...(verifiedInhabitants && Object.keys(verifiedInhabitants).length ? { verifiedInhabitants } : {}),
    relativeOrigin: worldVector(value.lastStructure.relativeOrigin),
  } : undefined;
  const lastProject = projectSummary(value.lastProject);
  const buildState = ["idle", "queued", "building"].includes(value.buildState)
    ? value.buildState : "idle";
  return {
    dimension, weather, timeOfDay, player, buildState,
    nearbyBlocks,
    nearbyEntities,
    ...(lastStructure?.kind && lastStructure.dimensions ? { lastStructure } : {}),
    ...(lastProject ? { lastProject } : {}),
  };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function recordInteraction(interactionLog, method, value, logger) {
  try {
    await interactionLog?.[method]?.(value);
  } catch (error) {
    logger.error?.(`[interaction-log] ${error.stack || error}`);
  }
}

function redactedPreferenceResult(value) {
  const redact = (response) => {
    if (!response?.preferenceApplied || typeof response !== "object") return response;
    const { preferences, ...safe } = response;
    return { ...safe, answer: "[private player preference applied]" };
  };
  const result = redact(value);
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    ...(result.replan && { replan: redact(result.replan) }),
    ...(result.review && { review: redact(result.review) }),
    ...(result.followUp && { followUp: redact(result.followUp) }),
  };
}

function authorized(request, expectedToken) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function readJson(request) {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    const error = new Error("request body is too large");
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("request body must be valid JSON");
    error.status = 400;
    throw error;
  }
}

export function validateAskBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("request body must be a JSON object");
    error.status = 400;
    throw error;
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question || question.length > 800) {
    const error = new Error("question must be 1–800 characters");
    error.status = 400;
    throw error;
  }
  const player = typeof body.player === "string"
    ? body.player.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64) || "anonymous"
    : "anonymous";
  const playerId = opaquePlayerId(body.playerId);
  const mode = body.mode === "general" ? "general" : "wizard";
  const requestId = typeof body.requestId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(body.requestId)
    ? body.requestId : undefined;
  const goalId = typeof body.goalId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(body.goalId)
    ? body.goalId : undefined;
  if (body.goalId !== undefined && !goalId) {
    const error = new Error("goalId must be 1–64 letters, numbers, underscores, or dashes");
    error.status = 400;
    throw error;
  }
  const sessionReset = typeof body.sessionReset === "string" && SESSION_RESET.test(body.sessionReset)
    ? body.sessionReset : undefined;
  if (body.sessionReset !== undefined && !sessionReset) {
    const error = new Error("sessionReset must be 1–64 letters, numbers, underscores, or dashes");
    error.status = 400;
    throw error;
  }
  const context = validateWorldContext(body.context);
  return {
    question, player, mode,
    ...(playerId && { playerId }),
    ...(requestId && { requestId }),
    ...(goalId && { goalId }),
    ...(sessionReset && { sessionReset }),
    ...(context && { context }),
  };
}

export function validateActionResultBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("request body must be a JSON object");
    error.status = 400;
    throw error;
  }
  const player = typeof body.player === "string"
    ? body.player.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64).trim()
    : "";
  if (!player) {
    const error = new Error("player must be 1–64 safe characters");
    error.status = 400;
    throw error;
  }
  const playerId = opaquePlayerId(body.playerId);
  const requestId = typeof body.requestId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(body.requestId)
    ? body.requestId : undefined;
  if (!requestId) {
    const error = new Error("requestId must be 1–64 letters, numbers, underscores, or dashes");
    error.status = 400;
    throw error;
  }
  if (!["started", "completed", "failed", "partial"].includes(body.status)) {
    const error = new Error("status must be started, completed, failed, or partial");
    error.status = 400;
    throw error;
  }
  // The pack slices action-result detail at 1600 characters so salvage drop
  // records and violation lists arrive whole; the caps must match or the pack's
  // terminal partial/failed reports are deterministically rejected with a 400.
  if (body.detail !== undefined && (typeof body.detail !== "string" || body.detail.length > 1600)) {
    const error = new Error("detail must be at most 1600 characters");
    error.status = 400;
    throw error;
  }
  const detail = body.detail?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const context = validateWorldContext(body.context);
  if (body.context !== undefined && !context) {
    const error = new Error("context must be a valid live-world snapshot");
    error.status = 400;
    throw error;
  }
  if (body.status === "completed" && !context) {
    const error = new Error("completed actions require a fresh live-world context");
    error.status = 400;
    throw error;
  }
  return {
    player, ...(playerId && { playerId }), requestId, status: body.status,
    ...(detail && { detail }),
    ...(context && { context }),
  };
}

export function validateServerCommandsBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("request body must be a JSON object"), { status: 400 });
  }
  const player = typeof body.player === "string"
    ? body.player.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64).trim() : "";
  if (!player) throw Object.assign(new Error("player must be 1-64 safe characters"), { status: 400 });
  if (!Array.isArray(body.commands) || body.commands.length < 1 || body.commands.length > 16) {
    throw Object.assign(new Error("commands must contain 1-16 Minecraft commands"), { status: 400 });
  }
  return {
    player,
    commands: body.commands.map((command, index) => validateMinecraftCommand(command, `commands[${index}]`)),
  };
}

export function validateServerConfigurationBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("request body must be a JSON object"), { status: 400 });
  }
  const player = typeof body.player === "string"
    ? body.player.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64).trim() : "";
  if (!player) throw Object.assign(new Error("player must be 1-64 safe characters"), { status: 400 });
  try {
    return { player, settings: normalizeRuntimeStep({ capability: "server.configure", arguments: body.settings }).arguments };
  } catch (error) {
    throw Object.assign(new Error(String(error.message || error)), { status: 400 });
  }
}

export function validateFeedbackBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("request body must be a JSON object");
    error.status = 400;
    throw error;
  }
  const player = typeof body.player === "string"
    ? body.player.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64).trim()
    : "";
  if (!player) {
    const error = new Error("player must be 1–64 safe characters");
    error.status = 400;
    throw error;
  }
  const playerId = opaquePlayerId(body.playerId);
  const requestId = typeof body.requestId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(body.requestId)
    ? body.requestId : undefined;
  if (!requestId) {
    const error = new Error("requestId must be 1–64 letters, numbers, underscores, or dashes");
    error.status = 400;
    throw error;
  }
  if (!Number.isInteger(body.grade) || body.grade < 1 || body.grade > 5) {
    const error = new Error("grade must be an integer from 1 to 5");
    error.status = 400;
    throw error;
  }
  if (body.feedback !== undefined
    && (typeof body.feedback !== "string" || body.feedback.length > 500)) {
    const error = new Error("feedback must be at most 500 characters");
    error.status = 400;
    throw error;
  }
  const feedback = body.feedback
    ?.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const context = validateWorldContext(body.context);
  if (body.context !== undefined && !context) {
    const error = new Error("context must be a valid live-world snapshot");
    error.status = 400;
    throw error;
  }
  return {
    player, ...(playerId && { playerId }), requestId, grade: body.grade,
    ...(feedback && { feedback }),
    ...(context && { context }),
  };
}

export function validatePlayerPreferencesBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("request body must be a JSON object"), { status: 400 });
  }
  const player = typeof body.player === "string"
    ? body.player.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64).trim()
    : "";
  if (!player) throw Object.assign(new Error("player must be 1–64 safe characters"), { status: 400 });
  const playerId = opaquePlayerId(body.playerId);
  if (!playerId) throw Object.assign(new Error("playerId is required"), { status: 400 });
  return { player, playerId };
}

export function createHttpServer({
  wizard,
  corpus,
  token,
  interactionLog,
  maxConcurrent = 4,
  cooldownMs = 1_500,
  executeServerCommand,
  locateStructure,
  serverControl,
  logger = console,
}) {
  let inFlight = 0;
  const lastRequestAt = new Map();
  const appliedSessionResets = new Map();
  const resetSessions = async ({ player, playerId, sessionReset }) => {
    if (!sessionReset) return;
    const key = `${playerId || player}\u0000${sessionReset}`;
    let reset = appliedSessionResets.get(key);
    if (!reset) {
      reset = Promise.all([
        wizard.clearSession(player, "wizard", playerId),
        wizard.clearSession(player, "general", playerId),
      ]);
      appliedSessionResets.set(key, reset);
      while (appliedSessionResets.size > 256) appliedSessionResets.delete(appliedSessionResets.keys().next().value);
    }
    try {
      await reset;
    } catch (error) {
      if (appliedSessionResets.get(key) === reset) appliedSessionResets.delete(key);
      throw error;
    }
  };
  return createNodeServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        corpusChunks: corpus.size,
        graph: corpus.graph || { revision: "unavailable", documents: 0, nodes: 0, edges: 0 },
        provider: wizard.provider,
        inFlight,
        preferences: wizard.preferenceHealth?.() || { players: 0, preferences: 0 },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/server-commands") {
      if (!authorized(request, token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (!executeServerCommand) {
        sendJson(response, 503, { error: "server console is unavailable" });
        return;
      }
      try {
        const { player, commands } = validateServerCommandsBody(await readJson(request));
        const results = [];
        for (const command of commands) {
          const expanded = requesterCommand(command, player);
          const result = await executeServerCommand(expanded);
          results.push({ command: expanded.split(/\s+/, 1)[0], code: result.code, output: String(result.output || "").slice(0, 500) });
        }
        const succeeded = results.filter(({ code }) => code === 0).length;
        logger.log(`[mc-wizard] server console executed ${succeeded}/${commands.length} commands for a player`);
        sendJson(response, succeeded ? 200 : 503, { succeeded, total: commands.length, results });
      } catch (error) {
        if (!error.status || error.status >= 500) logger.error(`[server-console] ${error.stack || error}`);
        sendJson(response, error.status || 500, { error: error.status ? error.message : "server command failed" });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/locate") {
      if (!authorized(request, token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (!locateStructure) {
        sendJson(response, 503, { error: "structure locator is unavailable" });
        return;
      }
      try {
        const { origin, structure, dimension } = validateLocateBody(await readJson(request));
        const location = await locateStructure({ ...origin, structure, dimension });
        logger.log(`[mc-wizard] located ${structure} for local travel`);
        sendJson(response, 200, { structure, location });
      } catch (error) {
        if (error.code !== "STRUCTURE_NOT_FOUND" && (!error.status || error.status >= 500)) {
          logger.error(`[server-locate] ${error.stack || error}`);
        }
        if (error.code === "STRUCTURE_NOT_FOUND") {
          sendJson(response, 404, { error: error.message, code: "not_found" });
        } else {
          sendJson(response, error.status || 503, { error: error.status ? error.message : "structure locate failed" });
        }
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/server-control") {
      if (!authorized(request, token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (!serverControl) {
        sendJson(response, 503, { error: "server configuration is unavailable" });
        return;
      }
      try {
        const { settings } = validateServerConfigurationBody(await readJson(request));
        sendJson(response, 202, serverControl.queue(settings));
        logger.log("[mc-wizard] authenticated player queued a Bedrock settings restart");
      } catch (error) {
        sendJson(response, error.status || 500, { error: error.status ? error.message : "server configuration failed" });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/preferences") {
      if (!authorized(request, token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      try {
        const { playerId } = validatePlayerPreferencesBody(await readJson(request));
        sendJson(response, 200, { preferences: wizard.getPlayerPreferences(playerId) });
      } catch (error) {
        sendJson(response, error.status || 500, { error: error.status ? error.message : "internal error" });
      }
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/v1/session") {
      if (!authorized(request, token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      try {
        const { player, playerId, mode } = validateAskBody({ ...(await readJson(request)), question: "delete" });
        const deleted = await wizard.clearSession(player, mode, playerId);
        sendJson(response, 200, { deleted });
      } catch (error) {
        sendJson(response, error.status || 500, { error: error.status ? error.message : "internal error" });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/feedback") {
      if (!authorized(request, token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (inFlight >= maxConcurrent) {
        sendJson(response, 429, { error: "wizard is busy; try again in a moment" });
        return;
      }
      inFlight += 1;
      try {
        const feedback = validateFeedbackBody(await readJson(request));
        const result = await wizard.recordFeedback(feedback);
        if (!result.matched) {
          sendJson(response, 404, { error: "matching request was not found" });
          return;
        }
        if (result.pending) {
          sendJson(response, 409, { error: "the matching action is still running" });
          return;
        }
        if (result.recorded) {
          await recordInteraction(interactionLog, "recordFeedback", {
            ...feedback, result: redactedPreferenceResult(result),
          }, logger);
        }
        sendJson(response, 200, result);
        logger.log(`[mc-wizard] feedback recorded; grade=${result.grade}`);
      } catch (error) {
        if (!error.status || error.status >= 500) logger.error(`[server] ${error.stack || error}`);
        sendJson(response, error.status || 500, { error: error.status ? error.message : "internal error" });
      } finally {
        inFlight -= 1;
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/action-result") {
      if (!authorized(request, token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      try {
        const actionResult = validateActionResultBody(await readJson(request));
        const result = await wizard.recordActionResult(actionResult);
        await recordInteraction(interactionLog, "recordActionResult", {
          ...actionResult, result: redactedPreferenceResult(result),
        }, logger);
        if (!result.matched) {
          sendJson(response, 404, { error: "matching action was not found" });
          return;
        }
        sendJson(response, 200, result);
        logger.log(`[mc-wizard] action result recorded; status=${result.status}`);
      } catch (error) {
        if (!error.status || error.status >= 500) logger.error(`[server] ${error.stack || error}`);
        sendJson(response, error.status || 500, { error: error.status ? error.message : "internal error" });
      }
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/ask") {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    if (!authorized(request, token)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (inFlight >= maxConcurrent) {
      sendJson(response, 429, { error: "wizard is busy; try again in a moment" });
      return;
    }

    inFlight += 1;
    try {
      const { question, player, playerId, mode, requestId, goalId, sessionReset, context } = validateAskBody(await readJson(request));
      const requester = playerId || player;
      await resetSessions({ player, playerId, sessionReset });
      const now = Date.now();
      if (sessionReset) lastRequestAt.delete(requester);
      if (!sessionReset && now - (lastRequestAt.get(requester) || 0) < cooldownMs) {
        sendJson(response, 429, { error: "please wait a moment before asking again" });
        return;
      }
      lastRequestAt.set(requester, now);
      logger.log("[mc-wizard] ask request received");
      const result = await wizard.ask({
        question, player, playerId, mode, requestId, context,
        ...(goalId && { goalRetry: { goalId } }),
      });
      // Gate telemetry is operator-only: log it, never send it to the pack (#35).
      const { telemetry, ...clientResult } = result;
      if (result.mode !== "player-memory") {
        await recordInteraction(interactionLog, "recordAsk", {
          question, player, mode, requestId, telemetry, result: redactedPreferenceResult(clientResult),
        }, logger);
      }
      sendJson(response, 200, clientResult);
      logger.log("[mc-wizard] ask response sent; action="
        + (result.action?.id || result.action?.plan?.title || result.action?.type || "none"));
    } catch (error) {
      if (!error.status || error.status >= 500) logger.error(`[server] ${error.stack || error}`);
      sendJson(response, error.status || 500, {
        error: error.status ? error.message : "internal error",
      });
    } finally {
      inFlight -= 1;
    }
  });
}

export async function startServer({ env = process.env, logger = console } = {}) {
  const token = env.BRIDGE_TOKEN || "dev-only-change-me";
  const host = env.HOST || "127.0.0.1";
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback && (token === "dev-only-change-me" || token.length < 24)) {
    throw new Error("Refusing a default or short bridge token on a non-loopback address; use at least 24 characters");
  }
  const corpus = await loadCorpus();
  const configuredWizardSalt = String(env.WIZARD_SALT || "").trim();
  const privateWizardSalt = configuredWizardSalt.length >= 24
    && configuredWizardSalt !== "change-me-before-sharing";
  if (configuredWizardSalt && !privateWizardSalt) {
    logger.warn("[mc-wizard] ignoring default or short WIZARD_SALT");
  }
  const privateBridgeToken = token !== "dev-only-change-me" && token.length >= 24;
  const wizardSalt = privateWizardSalt
    ? configuredWizardSalt
    : privateBridgeToken
      ? createHmac("sha256", token).update("mc-wizard:server-private-state:v1").digest("hex")
      : randomBytes(32).toString("hex");
  const sessions = await createFileSessionStore({
    filePath: env.SESSION_FILE || "runtime/brain/sessions.json",
    salt: wizardSalt,
    maxTurns: Math.min(Math.max(Number(env.SESSION_MAX_TURNS) || 12, 1), 50),
    ttlMs: Math.min(Math.max(Number(env.SESSION_TTL_MS) || 86_400_000, 60_000), 30 * 86_400_000),
  });
  const recipes = await createFileLearnedRecipeStore({
    filePath: env.LEARNED_RECIPES_FILE || "runtime/brain/learned-recipes.json",
    maxRecipes: Math.min(Math.max(Number(env.LEARNED_RECIPES_MAX) || 100, 1), 500),
  });
  const preferences = await createFilePlayerPreferenceStore({
    filePath: env.PLAYER_PREFERENCES_FILE || "runtime/brain/player-preferences.json",
    salt: wizardSalt,
  });
  const settingsFile = env.RUNTIME_SETTINGS_FILE || "runtime/admin/settings.json";
  const wizard = createWizard({
    corpus,
    env,
    safetySalt: wizardSalt,
    logger,
    sessions,
    recipes,
    preferences,
    settings: () => readRuntimeSettings(settingsFile, logger),
  });
  const interactionLog = createInteractionLog({
    filePath: env.INTERACTION_LOG_FILE || "runtime/brain/interactions.jsonl",
    salt: wizardSalt,
  });
  const port = Number(env.PORT) || 3000;
  const cooldownMs = Math.min(Math.max(Number(env.REQUEST_COOLDOWN_MS) || 1_500, 0), 60_000);
  const server = createHttpServer({
    wizard, corpus, token, interactionLog, cooldownMs, logger,
    executeServerCommand: (command) => sendBedrockCommand(runProcess, command, env.BEDROCK_CONTAINER_NAME),
    locateStructure: (request) => locateBedrockStructure(runProcess, {
      ...request, containerName: env.BEDROCK_CONTAINER_NAME,
    }),
    serverControl: createServerControl({ logger }),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  if (token === "dev-only-change-me") logger.warn("[mc-wizard] using the development bridge token");
  logger.log(`[mc-wizard] listening on http://${host}:${port}`);
  logger.log(`[mc-wizard] ${corpus.size} knowledge chunks; provider=${wizard.provider}`);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
