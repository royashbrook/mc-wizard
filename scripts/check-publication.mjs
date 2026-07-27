#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_TEXT_BYTES = 1_000_000;
const PLACEHOLDER = /(?:example|placeholder|replace[-_ ]?me|redacted|dummy|fake|test|your[-_ ]|change[-_ ]?me|not[-_ ]?a[-_ ]?secret)/i;

// Reviewed synthetic identities used in public tests. Additions should be rare,
// clearly fictional, and accompanied by a publication-guard test.
export const SYNTHETIC_PLAYER_NAMES = new Set([
  "ActualKidGamertag",
  "BlockKid42",
  "BuilderKid",
  "CannedKid2",
  "CannedKid3",
  "CannedKid4",
  "CommandKid2",
  "Day1Kid",
  "Day2Kid",
  "Day3Kid",
  "EnchantKid",
  "Kid",
  "MC Wizard",
  "Player",
  "RedstonePal",
  "SameDisplayName",
  "SecretGamertag",
  "TestKid",
]);

const PRIVATE_PATH_RULES = [
  { pattern: /(^|\/)runtime\//i, reason: "runtime state" },
  { pattern: /(^|\/)(?:minecraftworlds|worlds?)\//i, reason: "world data" },
  { pattern: /(^|\/)(?:books?|generated-books)\//i, reason: "generated books" },
  { pattern: /(^|\/)(?:db|database)\//i, reason: "world/database data" },
  { pattern: /\.(?:ldb|log|mcworld|mctemplate)$/i, reason: "runtime/world artifact" },
  { pattern: /(?:^|\/)(?:interactions|sessions|player-preferences|learned-recipes)\.jsonl?$/i, reason: "private session data" },
];

const SECRET_PATTERNS = [
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, reason: "private key" },
  { pattern: /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/, reason: "GitHub token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, reason: "AWS access key" },
  { pattern: /\b(?:sk|xox[baprs])[-_][A-Za-z0-9_-]{20,}\b/, reason: "provider token" },
  {
    pattern: /\b(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BRIDGE_TOKEN|CLIENT_SECRET|PASSWORD|SECRET)\b\s*=\s*([A-Za-z0-9_./+=-]{16,})/,
    reason: "credential-like environment assignment",
    valueGroup: 1,
  },
  {
    pattern: /\b(?:apiKey|accessToken|authToken|bridgeToken|clientSecret|password|secret)\b\s*:\s*["']([^"']{16,})["']/i,
    reason: "credential-like code assignment",
    valueGroup: 1,
  },
];

const FIELD_IDENTITY = /\b(?:gamertag|player(?:Name)?|recipient)\b\s*[:=]\s*["'`](?<name>[A-Za-z][A-Za-z0-9_ ]{2,20})["'`]/ig;
const COMMAND_IDENTITY = /\ballowlist\s+add\s+(?<name>[A-Za-z][A-Za-z0-9_]{2,15})\b/ig;
const GIVE_IDENTITY = /\bgive\s+(?<name>[A-Za-z][A-Za-z0-9_]{2,15})\s+\d+\b/ig;

function normalizedPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

export function inspectPath(filePath) {
  const path = normalizedPath(filePath);
  if (!path) return [];
  if (/(^|\/)\.env(?:\.|$)/i.test(path) && !/(^|\/)\.env\.example$/i.test(path)) {
    return [`${path}: environment file`];
  }
  return PRIVATE_PATH_RULES
    .filter(({ pattern }) => pattern.test(path))
    .map(({ reason }) => `${path}: ${reason}`);
}

function identityCandidates(line) {
  const names = [];
  for (const pattern of [FIELD_IDENTITY, COMMAND_IDENTITY, GIVE_IDENTITY]) {
    pattern.lastIndex = 0;
    for (const match of line.matchAll(pattern)) names.push(match.groups?.name);
  }
  return names.filter(Boolean);
}

function looksLikeRealGamertag(name) {
  const compact = name.trim();
  if (SYNTHETIC_PLAYER_NAMES.has(compact)) return false;
  if (/^(?:minecraft|requester|player|recipient|owner|friend|someone|everyone|self|nearest)$/i.test(compact)) return false;
  return /^[A-Za-z][A-Za-z0-9_]{2,15}$/.test(compact)
    && (/\d/.test(compact) || /[A-Za-z]\d[A-Za-z]/.test(compact));
}

export function inspectText(filePath, text) {
  const findings = [];
  const path = normalizedPath(filePath);
  const lines = String(text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const { pattern, reason, valueGroup } of SECRET_PATTERNS) {
      const match = pattern.exec(line);
      pattern.lastIndex = 0;
      if (!match) continue;
      const value = valueGroup ? match[valueGroup] : match[0];
      if (!PLACEHOLDER.test(value)) findings.push(`${path}:${index + 1}: ${reason}`);
    }
    for (const name of identityCandidates(line)) {
      if (looksLikeRealGamertag(name)) {
        findings.push(`${path}:${index + 1}: possible plaintext player name "${name}"`);
      }
    }
  }
  return findings;
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function stagedFiles() {
  return git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
    .split("\0").filter(Boolean);
}

function trackedFiles() {
  return git(["ls-files", "-z"]).split("\0").filter(Boolean);
}

function stagedAddedText(filePath) {
  const diff = git(["diff", "--cached", "--unified=0", "--no-color", "--diff-filter=ACMR", "--", filePath]);
  return diff.split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

async function readableText(filePath) {
  try {
    const bytes = await readFile(filePath);
    if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) return "";
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

export async function checkPublication({ mode = "staged" } = {}) {
  const files = mode === "all" ? trackedFiles() : stagedFiles();
  const findings = [];
  for (const filePath of files) {
    const text = mode === "all" ? await readableText(filePath) : stagedAddedText(filePath);
    if (mode === "all" && text === null) continue;
    findings.push(...inspectPath(filePath));
    if (text) findings.push(...inspectText(filePath, text));
  }
  return [...new Set(findings)];
}

async function main() {
  const mode = process.argv.includes("--all") ? "all" : "staged";
  const findings = await checkPublication({ mode });
  if (findings.length === 0) {
    console.log(`publication guard: ${mode} content looks publishable`);
    return;
  }
  console.error("publication guard rejected potentially private content:");
  for (const finding of findings) console.error(`- ${finding}`);
  if (process.env.PUBLICATION_GUARD_REVIEWED === "1" && !process.env.CI) {
    console.error("publication guard: local reviewed override accepted; CI will still enforce the repository scan");
    return;
  }
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
