import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNTIME = path.join(ROOT, "runtime", "admin");
const PID_FILE = path.join(RUNTIME, "admin.pid");
const LOG_FILE = path.join(RUNTIME, "admin.log");
const ADMIN_URL = `http://${process.env.ADMIN_HOST || "127.0.0.1"}:${process.env.ADMIN_PORT || 3001}`;

async function currentPid() {
  try {
    const pid = Number(await readFile(PID_FILE, "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

async function healthy() {
  try {
    return (await fetch(`${ADMIN_URL}/health`, { signal: AbortSignal.timeout(1_000) })).ok;
  } catch {
    return false;
  }
}

async function start() {
  if (await currentPid() && await healthy()) {
    console.log(`MC Wizard admin is already running at ${ADMIN_URL}`);
    return 0;
  }
  await mkdir(RUNTIME, { recursive: true });
  const log = await open(LOG_FILE, "a", 0o600);
  const child = spawn(process.execPath, [path.join(ROOT, "src", "admin.mjs")], {
    cwd: ROOT,
    detached: true,
    env: process.env,
    stdio: ["ignore", log.fd, log.fd],
  });
  child.unref();
  await writeFile(PID_FILE, `${child.pid}\n`, { mode: 0o600 });
  await log.close();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await healthy()) {
      console.log(`MC Wizard admin started at ${ADMIN_URL}`);
      return 0;
    }
  }
  try { process.kill(child.pid, "SIGTERM"); } catch {}
  await rm(PID_FILE, { force: true });
  throw new Error(`admin did not start; check ${LOG_FILE}`);
}

async function stop() {
  const pid = await currentPid();
  if (pid) process.kill(pid, "SIGTERM");
  await rm(PID_FILE, { force: true });
  console.log("MC Wizard admin stopped.");
  return 0;
}

async function status() {
  const result = { running: Boolean(await currentPid()), healthy: await healthy(), url: ADMIN_URL };
  console.log(JSON.stringify(result, null, 2));
  return result.running && result.healthy ? 0 : 1;
}

const command = process.argv[2] || "status";
process.exitCode = command === "start" ? await start()
  : command === "stop" ? await stop()
    : command === "status" ? await status()
      : 2;
