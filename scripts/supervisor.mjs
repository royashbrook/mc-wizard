import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNTIME = path.join(ROOT, "runtime", "supervisor");
const PID_FILE = path.join(RUNTIME, "mc-wizard.pid");
const LOG_FILE = path.join(RUNTIME, "mc-wizard.log");
const DAEMON_PATTERN = `${path.join(ROOT, "scripts", "supervisor.mjs")} daemon`.replace("/", "[/]");

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: options.stdio || "ignore", env: process.env });
    child.once("error", () => resolve(127));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function capture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"], env: process.env });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", () => resolve(""));
    child.once("exit", () => resolve(output));
  });
}

// `container list` (running only) prints one row per running container, first
// column the name, after a header row whose first column is "ID". A container
// that is booting is already "running", so presence here is the correct
// liveness signal; `container exec` fails for minutes during a cold BDS boot
// and must not be used to decide whether to recreate.
export function containerListHasRunning(listOutput, name) {
  return String(listOutput)
    .split(/\r?\n/)
    .some((line) => line.trim().split(/\s+/)[0] === name);
}

async function containerRunning(name) {
  return containerListHasRunning(await capture("container", ["list"]), name);
}

function daemonPids() {
  return new Promise((resolve) => {
    const child = spawn("pgrep", ["-f", DAEMON_PATTERN], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", () => resolve([]));
    child.once("exit", () => resolve(output.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0)));
  });
}

async function currentPid() {
  try {
    const pid = Number(await readFile(PID_FILE, "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    const [pid] = await daemonPids();
    if (!pid) return undefined;
    await mkdir(RUNTIME, { recursive: true });
    await writeFile(PID_FILE, `${pid}\n`, { mode: 0o600 });
    return pid;
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
  const [pid, brain, provider, admin, bedrockCode] = await Promise.all([
    currentPid(),
    probe(`http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3000}/health`),
    probe(`http://127.0.0.1:${process.env.MTOK_PORT || 8790}/health`),
    probe(`http://${process.env.ADMIN_HOST || "127.0.0.1"}:${process.env.ADMIN_PORT || 3001}/health`),
    containerRunning("mc-wizard-bedrock"),
  ]);
  const result = {
    supervisor: Boolean(pid),
    bedrock: Boolean(bedrockCode),
    brain: Boolean(brain.ok),
    provider: Boolean(provider.ok),
    admin: Boolean(admin.ok),
    corpusChunks: brain.corpusChunks || 0,
    providerName: provider.provider || brain.provider || "offline",
  };
  console.log(JSON.stringify(result, null, 2));
  return Object.values(result).includes(false) ? 1 : 0;
}

async function daemon() {
  if ((await daemonPids()).some((pid) => pid !== process.pid)) return;
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
  await run("sh", [path.join(ROOT, "scripts", "start-bedrock-container.sh")], { stdio: ["ignore", log.fd, log.fd] });

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const child of children.values()) child.kill("SIGTERM");
    await run("sh", [path.join(ROOT, "scripts", "stop-bedrock-container.sh")], { stdio: ["ignore", log.fd, log.fd] });
    await rm(PID_FILE, { force: true });
    await log.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // Recreate only when the container has actually stopped, and only after two
  // consecutive misses so a transient `container list` hiccup or an in-progress
  // boot never triggers a delete/recreate loop (see issue #38).
  let downChecks = 0;
  setInterval(async () => {
    if (stopping) return;
    if (await containerRunning("mc-wizard-bedrock")) { downChecks = 0; return; }
    downChecks += 1;
    if (downChecks < 2) return;
    downChecks = 0;
    await run("sh", [path.join(ROOT, "scripts", "start-bedrock-container.sh")], { stdio: ["ignore", log.fd, log.fd] });
  }, 10_000).unref();
}

async function start() {
  await run(process.execPath, [path.join(ROOT, "scripts", "admin-service.mjs"), "start"], { stdio: "inherit" });
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
  await run(process.execPath, [path.join(ROOT, "scripts", "admin-service.mjs"), "stop"], { stdio: "inherit" });
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

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const command = process.argv[2] || "status";
  process.exitCode = command === "daemon" ? await daemon()
    : command === "start" ? await start()
      : command === "stop" ? await stop()
        : command === "status" ? await status()
          : 2;
}
