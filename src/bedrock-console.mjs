import { spawn } from "node:child_process";

const ROSETTA_SEND_SCRIPT = 'for p in /proc/[0-9]*; do cmd=$(tr "\\000" " " < "$p/cmdline" 2>/dev/null) || continue; case "$cmd" in ./bedrock_server-*) printf "%s\\n" "$1" > "$p/fd/0"; exit $?;; esac; done; echo "ERROR: Bedrock process not found" >&2; exit 2';

export function validateMinecraftCommand(value, name = "command") {
  const command = typeof value === "string" ? value.trim().replace(/^\//, "") : "";
  if (!command || command.length > 500 || /[\r\n\0]/.test(command)) {
    throw Object.assign(new Error(`${name} must be one line containing 1-500 characters of a Minecraft command`), { status: 400 });
  }
  return command;
}

export function runProcess(command, args, timeout = 8_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    let outputSize = 0;
    const collect = (chunk) => {
      if (outputSize >= 128 * 1024) return;
      output.push(chunk);
      outputSize += chunk.length;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, output: error.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: Buffer.concat(output).toString("utf8").trim() });
    });
  });
}

async function sendBedrockCommandUnlocked(execute, command, containerName = "mc-wizard-bedrock") {
  let result = await execute("container", ["exec", containerName, "send-command", command]);
  if (result.code !== 0 && /unable to find bedrock server process/i.test(result.output)) {
    result = await execute("container", ["exec", containerName, "sh", "-c", ROSETTA_SEND_SCRIPT, "mc-wizard", command]);
  }
  return result;
}

let commandQueue = Promise.resolve();

function withBedrockCommandLock(task) {
  const result = commandQueue.then(task);
  commandQueue = result.catch(() => undefined);
  return result;
}

export function sendBedrockCommand(execute, command, containerName = "mc-wizard-bedrock") {
  return withBedrockCommandLock(() => sendBedrockCommandUnlocked(execute, command, containerName));
}

export function parseLocatedStructureReport(output, structure = "village") {
  const escaped = String(structure).replace(/[^a-z0-9_]/gi, "");
  const pattern = new RegExp(`nearest\\s+(?:minecraft:)?${escaped}\\s+is at block\\s+(-?\\d+),\\s+\\(y\\?\\),\\s+(-?\\d+)\\s+\\((\\d+)\\s+blocks?\\s+away\\)`, "i");
  const match = String(output || "").match(pattern);
  return match ? { x: Number(match[1]), z: Number(match[2]), distance: Number(match[3]) } : undefined;
}

export function parseLocatedStructure(output, structure = "village") {
  const report = parseLocatedStructureReport(output, structure);
  return report ? { x: report.x, z: report.z } : undefined;
}

function locatedReportMatchesOrigin(report, x, z) {
  const expected = Math.hypot(report.x - Math.floor(x), report.z - Math.floor(z));
  return Math.abs(report.distance - expected) <= 2;
}

export function locateStructureNotFound(output) {
  return /no valid structure found within a reasonable distance/i.test(String(output || ""));
}

export function locateBedrockStructure(execute, {
  x, z, structure = "village", containerName = "mc-wizard-bedrock", timeoutMs = 8_000,
}) {
  return withBedrockCommandLock(async () => {
    const readLogs = () => execute("container", ["logs", "-n", "500", containerName], 4_000);
    const before = await readLogs();
    const previousLines = new Set(String(before.output || "").split("\n"));
    const command = `execute positioned ${Math.floor(x)} 80 ${Math.floor(z)} run locate structure ${structure}`;
    const sent = await sendBedrockCommandUnlocked(execute, command, containerName);
    if (sent.code !== 0) throw new Error(sent.output || "could not send locate command to Bedrock");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = await readLogs();
      const newLines = String(current.output || "").split("\n").filter((line) => !previousLines.has(line));
      for (const line of newLines.reverse()) {
        const located = parseLocatedStructureReport(line, structure);
        if (located && locatedReportMatchesOrigin(located, x, z)) {
          return { x: located.x, z: located.z };
        }
        if (locateStructureNotFound(line)) {
          throw Object.assign(new Error(`no generated ${structure} exists within Bedrock's locator range`), {
            code: "STRUCTURE_NOT_FOUND",
          });
        }
      }
    }
    throw new Error(`Bedrock did not report the nearest ${structure} within ${timeoutMs}ms`);
  });
}

export function requesterCommand(command, player) {
  const quotedPlayer = `"${String(player).replace(/["\\]/g, "")}"`;
  return command.replaceAll("{{requester}}", quotedPlayer);
}
