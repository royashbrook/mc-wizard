import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { httpUpstream, serveChat } from "mtok-bridge";

const host = "127.0.0.1";
const port = Number(process.env.MTOK_PORT) || 8790;
const provider = process.env.MTOK_PROVIDER || "claude";
const model = process.env.MTOK_MODEL || (provider === "codex" ? "gpt-5.5" : provider);
const timeoutMs = Math.min(Math.max(Number(process.env.MTOK_TIMEOUT_MS) || 18_000, 5_000), 30_000);
const wizardSchema = path.resolve("schemas/wizard-response.schema.json");
const generalSchema = path.resolve("schemas/general-response.schema.json");
let queue = Promise.resolve();
const grokEnv = provider === "grok" ? isolatedGrokEnvironment() : process.env;
const upstream = provider === "ollama"
  ? httpUpstream({ baseUrl: process.env.MTOK_UPSTREAM || "http://127.0.0.1:11434/v1" })
  : provider === "grok" ? grokUpstream
    : provider === "codex" ? codexUpstream
      : claudeUpstream;

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

function claudeUpstream(payload) {
  const { systemPrompt, prompt } = cliInput(payload);
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("claude", [
      "-p",
      "--safe-mode",
      "--tools", "",
      "--no-session-persistence",
      "--output-format", "text",
      "--system-prompt", systemPrompt || "Answer clearly and use no tools.",
    ], { cwd: "/private/tmp", env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(0, 64 * 1024); });
    child.stderr.on("data", (chunk) => { errorOutput = (errorOutput + chunk).slice(-2_000); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      console.log(`[mc-wizard] claude request finished in ${Date.now() - startedAt}ms; code=${code}`);
      if (code !== 0) {
        reject(new Error(timedOut ? `Claude timed out after ${timeoutMs}ms` : errorOutput.trim() || `Claude exited ${code}`));
        return;
      }
      resolve({
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content: output.trim() }, finish_reason: "stop" }],
      });
    });
    child.stdin.end(prompt);
  });
}

function codexUpstream(payload) {
  const { systemPrompt, prompt } = cliInput(payload);
  const outputSchema = systemPrompt.includes("You are MC Wizard:") ? wizardSchema : generalSchema;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("codex", [
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
      "--output-schema", outputSchema,
      "--config", 'model_reasoning_effort="none"',
      "--model", model,
      "-",
    ], { cwd: "/private/tmp", env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(0, 64 * 1024); });
    child.stderr.on("data", (chunk) => { errorOutput = (errorOutput + chunk).slice(-2_000); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      console.log(`[mc-wizard] codex request finished in ${Date.now() - startedAt}ms; code=${code}`);
      if (code !== 0) {
        reject(new Error(timedOut ? `Codex timed out after ${timeoutMs}ms` : errorOutput.trim() || `Codex exited ${code}`));
        return;
      }
      const content = output.trim();
      if (!content) return reject(new Error("Codex returned no output"));
      resolve({
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      });
    });
    child.stdin.end(`${systemPrompt || "Answer clearly and use no tools."}\n\n${prompt}`);
  });
}

function grokUpstream(payload) {
  const { systemPrompt, prompt } = cliInput(payload);
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("grok", [
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
    ], { cwd: "/private/tmp", env: grokEnv, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(0, 64 * 1024); });
    child.stderr.on("data", (chunk) => { errorOutput = (errorOutput + chunk).slice(-2_000); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      console.log(`[mc-wizard] grok request finished in ${Date.now() - startedAt}ms; code=${code}`);
      if (code !== 0) {
        reject(new Error(timedOut ? `Grok timed out after ${timeoutMs}ms` : errorOutput.trim() || `Grok exited ${code}`));
        return;
      }
      const content = output.trim();
      if (!content) return reject(new Error("Grok returned no output"));
      resolve({
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      });
    });
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
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    response.writeHead(400).end();
    return;
  }
  const run = queue.then(() => serveChat({ body, models: [model], upstream }));
  queue = run.catch(() => undefined);
  try {
    const result = await run;
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(JSON.stringify(result.json));
  } catch (error) {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: String(error?.message || error) }));
  }
});

server.listen(port, host, () => {
  console.log(`[mc-wizard] mtok bridge: http://${host}:${port}/v1 -> ${provider} ${model}`);
});
