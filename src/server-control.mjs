import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./bedrock-console.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export function updateServerProperties(source, properties) {
  const pending = new Map(Object.entries(properties).map(([key, value]) => [key, String(value)]));
  const lines = source.split("\n").map((line) => {
    const match = /^([a-z][a-z0-9-]*)=/.exec(line);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  if (pending.size) {
    if (lines.at(-1) !== "") lines.push("");
    for (const [key, value] of pending) lines.push(`${key}=${value}`);
  }
  return lines.join("\n");
}

export function createServerControl({
  execute = runProcess,
  root = ROOT,
  delayMs = 2_500,
  logger = console,
} = {}) {
  let pending = false;
  const propertiesFile = path.join(root, "runtime", "bedrock", "server.properties");
  const levelFile = path.join(root, "runtime", "bedrock", "worlds", "mc-wizard", "level.dat");
  const patcher = path.join(root, "scripts", "enable-beta-apis.py");

  async function apply(settings) {
    const stopped = await execute("container", ["stop", "--time", "60", "mc-wizard-bedrock"], 75_000);
    if (stopped.code !== 0) throw new Error(stopped.output || "could not stop Bedrock cleanly");
    try {
      if (settings.properties) {
        const source = await readFile(propertiesFile, "utf8");
        await writeFile(propertiesFile, updateServerProperties(source, settings.properties), { mode: 0o600 });
      }
      if (settings.experiments || settings.worldOptions) {
        const result = await execute("python3", [
          patcher, "--control-json", levelFile,
          JSON.stringify({ experiments: settings.experiments || {}, worldOptions: settings.worldOptions || {} }),
        ], 30_000);
        if (result.code !== 0) throw new Error(result.output || "could not update world settings");
      }
    } finally {
      const started = await execute("container", ["start", "mc-wizard-bedrock"], 30_000);
      if (started.code !== 0) logger.error(`[server-control] Bedrock restart failed: ${started.output}`);
    }
  }

  return {
    queue(settings) {
      if (pending) throw Object.assign(new Error("a Bedrock settings restart is already queued"), { status: 409 });
      pending = true;
      setTimeout(() => {
        apply(settings)
          .then(() => logger.log("[server-control] Bedrock settings applied and server restarted"))
          .catch((error) => logger.error(`[server-control] ${error.stack || error}`))
          .finally(() => { pending = false; });
      }, delayMs).unref?.();
      return { queued: true, restartInMs: delayMs };
    },
    get pending() { return pending; },
  };
}
