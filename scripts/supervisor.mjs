import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNTIME = path.join(ROOT, "runtime", "supervisor");
const PID_FILE = path.join(RUNTIME, "mc-wizard.pid");
const LOG_FILE = path.join(RUNTIME, "mc-wizard.log");

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: options.stdio || "ignore", env: process.env });
    child.once("error", () => resolve(127));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function currentPid() {
  try {
    const pid = Number(await readFile(PID_FILE, "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? await response.json() : { ok: false, status: response.status };
  } catch {
    return { ok: false };
  }
}

async function status() {
  const [pid, brain, provider, bedrockCode] = await Promise.all([
    currentPid(),
    probe(`http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3000}/health`),
    probe(`http://127.0.0.1:${process.env.MTOK_PORT || 8790}/health`),
    run("container", ["exec", "mc-wizard-bedrock", "true"]),
  ]);
  const result = {
    supervisor: Boolean(pid),
    bedrock: bedrockCode === 0,
    brain: Boolean(brain.ok),
    provider: Boolean(provider.ok),
    corpusChunks: brain.corpusChunks || 0,
    providerName: provider.provider || brain.provider || "offline",
  };
  console.log(JSON.stringify(result, null, 2));
  return Object.values(result).includes(false) ? 1 : 0;
}

async function daemon() {
  await mkdir(RUNTIME, { recursive: true });
  await writeFile(PID_FILE, `${process.pid}\n`, { mode: 0o600 });
  const log = await open(LOG_FILE, "a", 0o600);
  const children = new Map();
  let stopping = false;

  function supervise(name, script, enabled = true) {
    if (!enabled) return;
    let failures = 0;
    const launch = () => {
      if (stopping) return;
      const child = spawn(process.execPath, [script], {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", log.fd, log.fd],
      });
      children.set(name, child);
      child.once("exit", () => {
        children.delete(name);
        if (stopping) return;
        failures += 1;
        const delay = Math.min(30_000, 1_000 * (2 ** Math.min(failures - 1, 5)));
        setTimeout(launch, delay);
      });
    };
    launch();
  }

  const localProvider = (process.env.AI_STYLE === "chat")
    && /127\.0\.0\.1:(?:8790|\$\{?MTOK_PORT)/.test(process.env.AI_BASE_URL || "");
  supervise("provider", path.join(ROOT, "scripts", "local-ai-bridge.mjs"), localProvider);
  supervise("brain", path.join(ROOT, "src", "server.mjs"));
  if (await run("container", ["start", "mc-wizard-bedrock"], { stdio: ["ignore", log.fd, log.fd] }) !== 0) {
    await run("sh", [path.join(ROOT, "scripts", "run-bedrock-container.sh")], { stdio: ["ignore", log.fd, log.fd] });
  }

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const child of children.values()) child.kill("SIGTERM");
    await run("container", ["stop", "--time", "60", "mc-wizard-bedrock"], { stdio: ["ignore", log.fd, log.fd] });
    await rm(PID_FILE, { force: true });
    await log.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  setInterval(async () => {
    if (!stopping && await run("container", ["exec", "mc-wizard-bedrock", "true"]) !== 0) {
      await run("container", ["start", "mc-wizard-bedrock"], { stdio: ["ignore", log.fd, log.fd] });
    }
  }, 10_000).unref();
}

async function start() {
  if (await currentPid()) {
    console.log("MC Wizard supervisor is already running.");
    return 0;
  }
  await mkdir(RUNTIME, { recursive: true });
  const child = spawn(process.execPath, [process.argv[1], "daemon"], {
    cwd: ROOT,
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await currentPid()) {
      console.log("MC Wizard supervisor started.");
      return 0;
    }
  }
  throw new Error("supervisor did not start; check runtime/supervisor/mc-wizard.log");
}

async function stop() {
  const pid = await currentPid();
  if (!pid) {
    await rm(PID_FILE, { force: true });
    console.log("MC Wizard supervisor is not running.");
    return 0;
  }
  process.kill(pid, "SIGTERM");
  console.log("MC Wizard supervisor is stopping cleanly.");
  return 0;
}

const command = process.argv[2] || "status";
const exitCode = command === "daemon" ? await daemon()
  : command === "start" ? await start()
    : command === "stop" ? await stop()
      : command === "status" ? await status()
        : 2;
process.exitCode = exitCode;
