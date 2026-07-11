import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const MARKER = "MC_WIZARD_E2E ";
export const DEFAULT_TIMEOUT_MS = 600_000;

export function parseE2ELine(line) {
  const start = line.indexOf(MARKER);
  if (start < 0) return null;
  try {
    const value = JSON.parse(line.slice(start + MARKER.length));
    return value && typeof value.status === "string" ? value : null;
  } catch {
    return null;
  }
}

export function isTerminalE2EResultForRun(result, runId) {
  return result?.run === runId && ["PASS", "FAIL"].includes(result.status);
}

async function main() {
  const runId = (process.env.MC_WIZARD_E2E_RUN || "").trim();
  if (!runId) {
    console.error("MC_WIZARD_E2E_RUN is required to reject stale BDS log results");
    process.exit(1);
  }
  const timeoutMs = Math.max(Number(process.env.E2E_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, 1_000);
  const logFile = (process.env.E2E_LOG_FILE || "").trim();
  if (logFile) writeFileSync(logFile, "");
  const seenLines = new Set();
  const timer = setTimeout(() => {
    console.error(`MC Wizard E2E timed out after ${timeoutMs}ms`);
    process.exit(1);
  }, timeoutMs);
  for await (const line of createInterface({ input: process.stdin })) {
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    if (logFile) appendFileSync(logFile, line + "\n");
    const result = parseE2ELine(line);
    if (result?.run === runId && result.status === "CHECK") {
      console.log(["CHECK: ", result.check, result.detail ? " — " + result.detail : ""].join(""));
      continue;
    }
    if (!isTerminalE2EResultForRun(result, runId)) continue;
    clearTimeout(timer);
    const output = `${result.status}: ${result.check}${result.detail ? ` — ${result.detail}` : ""}`;
    if (result.status === "PASS") {
      console.log(output);
      process.exit(0);
    }
    console.error(output);
    process.exit(1);
  }
  clearTimeout(timer);
  console.error("BDS logs ended before MC Wizard E2E produced a result");
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
