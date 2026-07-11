import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { httpUpstream, serveChat } from "mtok-bridge";

const host = "127.0.0.1";
const port = Number(process.env.MTOK_PORT) || 8790;
const provider = process.env.MTOK_PROVIDER || "claude";
const model = process.env.MTOK_MODEL || provider;
const upstream = provider === "ollama"
  ? httpUpstream({ baseUrl: process.env.MTOK_UPSTREAM || "http://127.0.0.1:11434/v1" })
  : claudeUpstream;

function claudeUpstream(payload) {
  const systemPrompt = payload.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const prompt = payload.messages
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role === "assistant" ? "Assistant" : "Player"}: ${message.content}`)
    .join("\n\n");
  return new Promise((resolve, reject) => {
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
    const timeout = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(0, 64 * 1024); });
    child.stderr.on("data", (chunk) => { errorOutput = (errorOutput + chunk).slice(-2_000); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(errorOutput.trim() || `Claude exited ${code}`));
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
  const result = await serveChat({ body, models: [model], upstream });
  response.writeHead(result.status, { "content-type": "application/json" });
  response.end(JSON.stringify(result.json));
});

server.listen(port, host, () => {
  console.log(`[mc-wizard] mtok bridge: http://${host}:${port}/v1 -> ${provider} ${model}`);
});
