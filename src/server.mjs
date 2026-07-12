import { timingSafeEqual } from "node:crypto";
import { createServer as createNodeServer } from "node:http";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "./rag.mjs";
import { createFileSessionStore } from "./sessions.mjs";
import { createWizard } from "./wizard.mjs";

const MAX_BODY_BYTES = 16 * 1024;

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
  return { question, player, mode };
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
      const { question, player, mode } = validateAskBody(await readJson(request));
      const now = Date.now();
      if (now - (lastRequestAt.get(player) || 0) < cooldownMs) {
        sendJson(response, 429, { error: "please wait a moment before asking again" });
        return;
      }
      lastRequestAt.set(player, now);
      logger.log("[mc-wizard] ask request received");
      const result = await wizard.ask({ question, player, mode });
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
  const wizard = createWizard({ corpus, env, logger, sessions });
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
