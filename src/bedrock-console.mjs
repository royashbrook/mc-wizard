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

export async function sendBedrockCommand(execute, command) {
  let result = await execute("container", ["exec", "mc-wizard-bedrock", "send-command", command]);
  if (result.code !== 0 && /unable to find bedrock server process/i.test(result.output)) {
    result = await execute("container", ["exec", "mc-wizard-bedrock", "sh", "-c", ROSETTA_SEND_SCRIPT, "mc-wizard", command]);
  }
  return result;
}

export function requesterCommand(command, player) {
  const quotedPlayer = `"${String(player).replace(/["\\]/g, "")}"`;
  return command.replaceAll("{{requester}}", quotedPlayer);
}
