import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveChat } from "mtok-bridge";

const host = "127.0.0.1";
const port = Number(process.env.MTOK_PORT) || 8790;
const provider = process.env.MTOK_PROVIDER || "claude";
const model = process.env.MTOK_MODEL || (provider === "codex" ? "gpt-5.5" : provider);
const timeoutMs = Math.min(Math.max(Number(process.env.MTOK_TIMEOUT_MS) || 45_000, 5_000), 120_000);
const providerSchema = path.resolve("schemas/codex-provider-envelope.schema.json");
const providerActionSchema = path.resolve("schemas/codex-provider-action-envelope.schema.json");
const generalSchema = path.resolve("schemas/general-response.schema.json");
export const MAX_REQUEST_BODY_BYTES = 128 * 1024;
const scheduleProvider = createProviderScheduler({
  concurrency: process.env.MTOK_MAX_CONCURRENT,
  waitMs: process.env.MTOK_QUEUE_WAIT_MS,
});
const grokEnv = provider === "grok" ? isolatedGrokEnvironment() : process.env;
const upstream = provider === "ollama"
  ? httpProviderUpstream({ baseUrl: process.env.MTOK_UPSTREAM || "http://127.0.0.1:11434/v1" })
  : provider === "grok" ? grokUpstream
    : provider === "codex" ? codexUpstream
      : claudeUpstream;

export function createProviderScheduler({ concurrency = 3, waitMs = 10_000 } = {}) {
  const requestedConcurrency = Number(concurrency);
  const requestedWaitMs = Number(waitMs);
  const capacity = Number.isFinite(requestedConcurrency)
    ? Math.min(Math.max(Math.trunc(requestedConcurrency), 2), 4) : 3;
  const maxWaitMs = Number.isFinite(requestedWaitMs)
    ? Math.min(Math.max(Math.trunc(requestedWaitMs), 10), 30_000) : 10_000;
  const pending = [];
  let active = 0;

  const drain = () => {
    while (active < capacity && pending.length) pending.shift().start();
  };

  return (task, { signal } = {}) => new Promise((resolve, reject) => {
    let timer;
    const entry = {
      start() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        active += 1;
        Promise.resolve().then(task).then(resolve, reject).finally(() => {
          active -= 1;
          drain();
        });
      },
    };
    const remove = () => {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      remove();
      reject(Object.assign(new Error("provider queue wait was canceled"), { code: "ABORT_ERR" }));
    };

    if (signal?.aborted) return abort();
    if (active < capacity) return entry.start();
    pending.push(entry);
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      remove();
      reject(Object.assign(new Error(`provider queue wait exceeded ${maxWaitMs}ms`), { status: 503 }));
    }, maxWaitMs);
  });
}

export function validateBridgeRequest(request) {
  const contentType = String(request.headers?.["content-type"] || "")
    .split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw Object.assign(new Error("content-type must be application/json"), { status: 415 });
  }
  if (request.headers?.origin || request.headers?.["sec-fetch-site"] === "cross-site") {
    throw Object.assign(new Error("browser-originated requests are not allowed"), { status: 403 });
  }
}

export async function readBridgeJson(request) {
  const declaredLength = Number(request.headers?.["content-length"] || 0);
  if (declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw Object.assign(new Error("request body is too large"), { status: 413 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw Object.assign(new Error("request body is too large"), { status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("request body must be valid JSON"), { status: 400 });
  }
}

function canceledError() {
  return Object.assign(new Error("provider request was canceled"), { code: "ABORT_ERR" });
}

export function runCliProcess({
  command,
  args,
  options,
  input = "",
  signal,
  timeout = timeoutMs,
  label,
  decode,
  spawnImpl = spawn,
}) {
  if (signal?.aborted) return Promise.reject(canceledError());
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawnImpl(command, args, options);
    let output = "";
    let errorOutput = "";
    let settled = false;
    let timeoutTimer;
    let forceKillTimer;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", cancel);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const terminate = (error) => {
      if (settled) return;
      try { child.kill("SIGTERM"); } catch {}
      forceKillTimer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) {
          try { child.kill("SIGKILL"); } catch {}
        }
      }, 2_000);
      forceKillTimer.unref?.();
      settle(reject, error);
    };
    const cancel = () => terminate(canceledError());

    timeoutTimer = setTimeout(() => {
      terminate(new Error(`${label} timed out after ${timeout}ms`));
    }, timeout);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout?.on("data", (chunk) => { output = (output + chunk).slice(0, 64 * 1024); });
    child.stderr?.on("data", (chunk) => { errorOutput = (errorOutput + chunk).slice(-2_000); });
    child.stdin?.on("error", (error) => settle(reject, error));
    child.on("error", (error) => settle(reject, error));
    child.on("close", (code) => {
      clearTimeout(forceKillTimer);
      if (settled) return;
      console.log(`[mc-wizard] ${label.toLowerCase()} request finished in ${Date.now() - startedAt}ms; code=${code}`);
      if (code !== 0) {
        settle(reject, new Error(errorOutput.trim() || `${label} exited ${code}`));
        return;
      }
      try {
        settle(resolve, decode(output.trim()));
      } catch (error) {
        settle(reject, error);
      }
    });
    child.stdin?.end(input);
  });
}

function httpProviderUpstream({ baseUrl, key }) {
  const url = `${String(baseUrl || "").replace(/\/$/, "")}/chat/completions`;
  return async (payload, { signal } = {}) => {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: requestSignal,
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`non-JSON upstream response (${response.status})`); }
    if (!response.ok) throw new Error(json?.error?.message || `upstream ${response.status}`);
    return json;
  };
}

export function serveBridgeChat({ body, models, upstream: providerUpstream, signal }) {
  return serveChat({
    body,
    models,
    upstream: (payload) => providerUpstream(payload, { signal }),
  });
}

function isolatedGrokEnvironment() {
  const cleanHome = path.resolve(process.env.MTOK_GROK_HOME || "runtime/provider-home");
  const sourceAuth = path.join(homedir(), ".grok", "auth.json");
  const grokDirectory = path.join(cleanHome, ".grok");
  const targetAuth = path.join(grokDirectory, "auth.json");
  if (!existsSync(sourceAuth)) throw new Error(`Grok is not logged in: missing ${sourceAuth}`);
  mkdirSync(grokDirectory, { recursive: true, mode: 0o700 });
  if (!existsSync(targetAuth)) symlinkSync(sourceAuth, targetAuth);
  return { ...process.env, HOME: cleanHome };
}

function cliInput(payload) {
  return {
    systemPrompt: payload.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n"),
    prompt: payload.messages
      .filter((message) => message.role !== "system")
      .map((message) => `${message.role === "assistant" ? "Assistant" : "Player"}: ${message.content}`)
      .join("\n\n"),
  };
}

const CODEX_PROVIDER_ENVELOPE = `The output schema is a transport envelope and overrides only the final JSON shape requested above.
- Put the player-facing reply in answer.
- Put the exact action object you would otherwise return in action_json as serialized JSON, or use null.
- Put a durable multi-step goal object in goal_json as serialized JSON when the request needs planning, inspection, feedback, or more than one action; otherwise use null.
Do not use markdown fences inside either serialized JSON string.`;

function serializedJson(value, name) {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Codex ${name} must be a JSON string or null`);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Codex ${name} was not valid serialized JSON`);
  }
}

export function decodeCodexProviderEnvelope(output, { actionRequired = false } = {}) {
  let envelope;
  try {
    envelope = JSON.parse(output);
  } catch {
    throw new Error("Codex provider envelope was not valid JSON");
  }
  if (!envelope || typeof envelope.answer !== "string" || !envelope.answer.trim()) {
    throw new Error("Codex provider envelope had no answer");
  }
  const action = serializedJson(envelope.action_json, "action_json");
  const goal = serializedJson(envelope.goal_json, "goal_json");
  if (actionRequired && (!action || typeof action !== "object" || Array.isArray(action))) {
    throw new Error("Codex action-required envelope had no action");
  }
  if (actionRequired && (!goal || typeof goal !== "object" || Array.isArray(goal))) {
    throw new Error("Codex action-required envelope had no goal");
  }
  return JSON.stringify({ answer: envelope.answer.trim(), action, goal });
}

export function codexArguments({ modelName = model, schema = providerSchema, reasoningEffort = "none" } = {}) {
  return [
    "--search",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--color", "never",
    "--disable", "shell_tool",
    "--disable", "apps",
    "--disable", "multi_agent",
    "--output-schema", schema,
    "--config", `model_reasoning_effort="${reasoningEffort}"`,
    "--model", modelName,
    "-",
  ];
}

function completion(content, emptyMessage) {
  if (!content) throw new Error(emptyMessage);
  return {
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

function claudeUpstream(payload, { signal } = {}) {
  const { systemPrompt, prompt } = cliInput(payload);
  return runCliProcess({
    command: "claude",
    args: [
      "-p",
      "--safe-mode",
      "--tools", "",
      "--no-session-persistence",
      "--output-format", "text",
      "--system-prompt", systemPrompt || "Answer clearly and use no tools.",
    ],
    options: { cwd: "/private/tmp", env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    input: prompt,
    signal,
    label: "Claude",
    decode: (output) => completion(output, "Claude returned no output"),
  });
}

function codexUpstream(payload, { signal } = {}) {
  const { systemPrompt, prompt } = cliInput(payload);
  const wizardRequest = systemPrompt.includes("You are MC Wizard:");
  const actionRequired = wizardRequest && systemPrompt.includes("MC_WIZARD_ACTION_REQUIRED");
  const outputSchema = actionRequired ? providerActionSchema : wizardRequest ? providerSchema : generalSchema;
  return runCliProcess({
    command: "codex",
    args: codexArguments({
      schema: outputSchema,
      reasoningEffort: actionRequired ? "low" : "none",
    }),
    options: {
      cwd: "/private/tmp", env: process.env, stdio: ["pipe", "pipe", "pipe"],
    },
    input: `${systemPrompt || "Answer clearly and use no tools."}${wizardRequest ? `\n\n${CODEX_PROVIDER_ENVELOPE}` : ""}\n\n${prompt}`,
    signal,
    timeout: actionRequired ? Math.max(timeoutMs, 60_000) : timeoutMs,
    label: "Codex",
    decode: (output) => {
      const content = wizardRequest
        ? decodeCodexProviderEnvelope(output.trim(), { actionRequired })
        : output.trim();
      return completion(content, "Codex returned no output");
    },
  });
}

function grokUpstream(payload, { signal } = {}) {
  const { systemPrompt, prompt } = cliInput(payload);
  return runCliProcess({
    command: "grok",
    args: [
      "--single", prompt,
      "--cwd", "/private/tmp",
      "--no-memory",
      "--no-subagents",
      "--no-plan",
      "--disable-web-search",
      "--tools", "",
      "--max-turns", "3",
      "--output-format", "plain",
      "--system-prompt-override", systemPrompt || "Answer clearly and use no tools.",
      "--verbatim",
    ],
    options: { cwd: "/private/tmp", env: grokEnv, stdio: ["ignore", "pipe", "pipe"] },
    signal,
    label: "Grok",
    decode: (output) => completion(output, "Grok returned no output"),
  });
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, provider, model, tools: false, persistence: false }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let body;
  try {
    validateBridgeRequest(request);
    body = await readBridgeJson(request);
  } catch (error) {
    response.writeHead(error.status || 400).end();
    return;
  }
  const controller = new AbortController();
  const cancelWait = () => controller.abort();
  request.once("aborted", cancelWait);
  response.once("close", cancelWait);
  if (request.aborted || response.destroyed) controller.abort();
  try {
    const result = await scheduleProvider(
      () => serveBridgeChat({ body, models: [model], upstream, signal: controller.signal }),
      { signal: controller.signal },
    );
    if (controller.signal.aborted || response.destroyed) return;
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(JSON.stringify(result.json));
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) return;
    response.writeHead(error.status || 502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: String(error?.message || error) }));
  } finally {
    request.removeListener("aborted", cancelWait);
    response.removeListener("close", cancelWait);
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, host, () => {
    console.log(`[mc-wizard] mtok bridge: http://${host}:${port}/v1 -> ${provider} ${model}`);
  });
}
