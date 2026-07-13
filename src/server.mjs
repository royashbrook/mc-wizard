import { timingSafeEqual } from "node:crypto";
import { createServer as createNodeServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  STRUCTURE_LIMITS,
  STRUCTURE_PHASES,
  STRUCTURE_PRIMITIVE_LIMIT,
} from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";
import { loadCorpus } from "./rag.mjs";
import { createFileSessionStore } from "./sessions.mjs";
import { createWizard } from "./wizard.mjs";
import { readRuntimeSettings } from "./runtime-settings.mjs";

const MAX_BODY_BYTES = 32 * 1024;
const CONTEXT_BLOCK_ID = /^minecraft:[a-z0-9_]{1,48}$/;

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
    const shape = entry.shape === "box" || entry.shape === "line" ? entry.shape : undefined;
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
    totalVolume += (to[0] - from[0] + 1) * (to[1] - from[1] + 1) * (to[2] - from[2] + 1);
    if (totalVolume > 2_000_000) return undefined;
    primitives.push({ shape, phase: entry.phase, blockId, from, to });
  }
  return primitives;
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
  const lastStructure = typeof value.lastStructure?.kind === "string" ? {
    kind: value.lastStructure.kind.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 48),
    title: String(value.lastStructure.title || "").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64),
    dimensions: validDimensions,
    ...(Object.values(materials).every(Boolean) ? { materials } : {}),
    ...(features.length ? { features } : {}),
    ...(primitives?.length ? { primitives } : {}),
    relativeOrigin: worldVector(value.lastStructure.relativeOrigin),
  } : undefined;
  const buildState = ["idle", "queued", "building"].includes(value.buildState)
    ? value.buildState : "idle";
  return {
    dimension, weather, timeOfDay, player, buildState,
    nearbyBlocks,
    nearbyEntities,
    ...(lastStructure?.kind && lastStructure.dimensions ? { lastStructure } : {}),
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

function authorized(request, expectedToken) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function readJson(request) {
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
  const mode = body.mode === "general" ? "general" : "wizard";
  const requestId = typeof body.requestId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(body.requestId)
    ? body.requestId : undefined;
  const context = validateWorldContext(body.context);
  return {
    question, player, mode,
    ...(requestId && { requestId }),
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
  const requestId = typeof body.requestId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(body.requestId)
    ? body.requestId : undefined;
  if (!requestId) {
    const error = new Error("requestId must be 1–64 letters, numbers, underscores, or dashes");
    error.status = 400;
    throw error;
  }
  if (!["started", "completed", "failed"].includes(body.status)) {
    const error = new Error("status must be started, completed, or failed");
    error.status = 400;
    throw error;
  }
  if (body.detail !== undefined && (typeof body.detail !== "string" || body.detail.length > 500)) {
    const error = new Error("detail must be at most 500 characters");
    error.status = 400;
    throw error;
  }
  const detail = body.detail?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return { player, requestId, status: body.status, ...(detail && { detail }) };
}

export function createHttpServer({ wizard, corpus, token, maxConcurrent = 4, cooldownMs = 1_500, logger = console }) {
  let inFlight = 0;
  const lastRequestAt = new Map();
  return createNodeServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        corpusChunks: corpus.size,
        provider: wizard.provider,
        inFlight,
      });
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/v1/session") {
      if (!authorized(request, token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      try {
        const { player, mode } = validateAskBody({ ...(await readJson(request)), question: "delete" });
        const deleted = await wizard.clearSession(player, mode);
        sendJson(response, 200, { deleted });
      } catch (error) {
        sendJson(response, error.status || 500, { error: error.status ? error.message : "internal error" });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/action-result") {
      if (!authorized(request, token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      try {
        const result = await wizard.recordActionResult(validateActionResultBody(await readJson(request)));
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
      const { question, player, mode, requestId, context } = validateAskBody(await readJson(request));
      const now = Date.now();
      if (now - (lastRequestAt.get(player) || 0) < cooldownMs) {
        sendJson(response, 429, { error: "please wait a moment before asking again" });
        return;
      }
      lastRequestAt.set(player, now);
      logger.log("[mc-wizard] ask request received");
      const result = await wizard.ask({ question, player, mode, requestId, context });
      sendJson(response, 200, result);
      logger.log("[mc-wizard] ask response sent; action=" + (result.action?.id || "none"));
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
  const sessions = await createFileSessionStore({
    filePath: env.SESSION_FILE || "runtime/brain/sessions.json",
    salt: env.WIZARD_SALT || token,
    maxTurns: Math.min(Math.max(Number(env.SESSION_MAX_TURNS) || 12, 1), 50),
    ttlMs: Math.min(Math.max(Number(env.SESSION_TTL_MS) || 86_400_000, 60_000), 30 * 86_400_000),
  });
  const settingsFile = env.RUNTIME_SETTINGS_FILE || "runtime/admin/settings.json";
  const wizard = createWizard({
    corpus,
    env,
    logger,
    sessions,
    settings: () => readRuntimeSettings(settingsFile, logger),
  });
  const port = Number(env.PORT) || 3000;
  const cooldownMs = Math.min(Math.max(Number(env.REQUEST_COOLDOWN_MS) || 1_500, 0), 60_000);
  const server = createHttpServer({ wizard, corpus, token, cooldownMs, logger });
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
