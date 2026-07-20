import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateServerProperties } from "../src/server-control.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACK_ID = "48450204-0c54-4c3b-855a-c76eda67275d";
const RESOURCE_PACK_ID = "5dd80b07-b583-4bb3-979c-41c25ce274d8";
const MODULE_ID = "4e8790fe-18dc-46d1-aa31-ec78a924b717";
const manifest = JSON.parse(await readFile(
  path.join(ROOT, "bedrock", "behavior_packs", "mc_wizard", "manifest.json"),
  "utf8",
));
const VERSION = manifest.header.version;
const resourceManifest = JSON.parse(await readFile(
  path.join(ROOT, "bedrock", "resource_packs", "mc_wizard", "manifest.json"),
  "utf8",
));
const RESOURCE_VERSION = resourceManifest.header.version;
if (![VERSION, RESOURCE_VERSION].every((version) => Array.isArray(version) && version.length === 3)) {
  throw new Error("Pack manifests must have three-part header versions");
}

const [serverDirectory, worldName, requestedUrl] = process.argv.slice(2);
if (!serverDirectory || !worldName) {
  console.error('Usage: npm run install:pack -- "/path/to/bedrock-server" "World Name" [brain-url]');
  process.exit(1);
}

const serverRoot = path.resolve(serverDirectory);
const worldsRoot = path.join(serverRoot, "worlds");
const worldRoot = path.resolve(worldsRoot, worldName);
const configTarget = path.join(serverRoot, "config", MODULE_ID);
if (path.basename(worldName) !== worldName || !worldRoot.startsWith(`${worldsRoot}${path.sep}`)) {
  console.error("World name must be a folder directly inside the BDS worlds directory.");
  process.exit(1);
}
try {
  const info = await stat(worldRoot);
  if (!info.isDirectory()) throw new Error("not a directory");
} catch {
  console.error(`World directory does not exist: ${worldRoot}`);
  console.error("Run BDS once and make sure the world name matches server.properties exactly.");
  process.exit(1);
}

let existingBrainUrl;
try {
  const existingVariables = JSON.parse(await readFile(path.join(configTarget, "variables.json"), "utf8"));
  existingBrainUrl = existingVariables.mc_wizard_url;
} catch (error) {
  if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
}
const lanBrainUrl = process.env.MC_WIZARD_LAN_IP
  ? `http://${process.env.MC_WIZARD_LAN_IP}:3000/v1/ask`
  : undefined;
const brainUrl = requestedUrl
  || process.env.WIZARD_URL
  || lanBrainUrl
  || existingBrainUrl
  || "http://127.0.0.1:3000/v1/ask";
const parsedUrl = new URL(brainUrl);
if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("Brain URL must use http or https");
const token = process.env.BRIDGE_TOKEN || "dev-only-change-me";
const e2eEnabled = process.env.MC_WIZARD_E2E === "1";
const e2eRun = (process.env.MC_WIZARD_E2E_RUN || "").trim();
const e2eScope = (process.env.MC_WIZARD_E2E_SCOPE || "full").trim();
if (e2eEnabled && !e2eRun) {
  throw new Error("MC_WIZARD_E2E_RUN is required when MC_WIZARD_E2E=1");
}
if (!new Set(["full", "machines", "commands", "arbitrary", "portal", "travel-rollback", "local-travel", "city", "child", "refinement", "feedback", "farms", "kelp", "delivery"]).has(e2eScope)) {
  throw new Error("MC_WIZARD_E2E_SCOPE must be full, machines, commands, arbitrary, portal, travel-rollback, local-travel, city, child, refinement, feedback, farms, kelp, or delivery");
}
const loopbackBrain = parsedUrl.hostname === "localhost"
  || parsedUrl.hostname === "[::1]"
  || /^127(?:\.\d{1,3}){3}$/.test(parsedUrl.hostname);
if (!loopbackBrain && (token === "dev-only-change-me" || token.length < 24)) {
  throw new Error("Refusing a default or short bridge token for a non-loopback brain URL; use at least 24 characters");
}
const packTarget = path.join(serverRoot, "behavior_packs", "mc_wizard");
const resourcePackTarget = path.join(serverRoot, "resource_packs", "mc_wizard");
await mkdir(path.dirname(packTarget), { recursive: true });
await mkdir(configTarget, { recursive: true });
// Mirror, don't merge: remove the destination first so stale files (e.g. a
// Finder-duplicate "models 2" directory) can never survive an install and
// later wedge the image's forced pack refresh (rm ...: Directory not empty).
// See issue #39.
await rm(packTarget, { recursive: true, force: true });
await cp(path.join(ROOT, "bedrock", "behavior_packs", "mc_wizard"), packTarget, {
  recursive: true,
  force: true,
});
await mkdir(path.dirname(resourcePackTarget), { recursive: true });
await rm(resourcePackTarget, { recursive: true, force: true });
await cp(path.join(ROOT, "bedrock", "resource_packs", "mc_wizard"), resourcePackTarget, {
  recursive: true,
  force: true,
});

const worldPacksFile = path.join(worldRoot, "world_behavior_packs.json");
let worldPacks = [];
try {
  worldPacks = JSON.parse(await readFile(worldPacksFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const existing = worldPacks.find((pack) => pack.pack_id === PACK_ID);
if (existing) existing.version = VERSION;
else worldPacks.push({ pack_id: PACK_ID, version: VERSION });
await writeFile(worldPacksFile, `${JSON.stringify(worldPacks, null, 2)}\n`);

const worldResourcePacksFile = path.join(worldRoot, "world_resource_packs.json");
let worldResourcePacks = [];
try {
  worldResourcePacks = JSON.parse(await readFile(worldResourcePacksFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const existingResourcePack = worldResourcePacks.find((pack) => pack.pack_id === RESOURCE_PACK_ID);
if (existingResourcePack) existingResourcePack.version = RESOURCE_VERSION;
else worldResourcePacks.push({ pack_id: RESOURCE_PACK_ID, version: RESOURCE_VERSION });
await writeFile(worldResourcePacksFile, `${JSON.stringify(worldResourcePacks, null, 2)}\n`);

const serverPropertiesFile = path.join(serverRoot, "server.properties");
let serverProperties = "";
try {
  serverProperties = await readFile(serverPropertiesFile, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await writeFile(
  serverPropertiesFile,
  updateServerProperties(serverProperties, { "texturepack-required": true }),
  { mode: 0o600 },
);

await writeFile(path.join(configTarget, "permissions.json"), `${JSON.stringify({
  allowed_modules: [
    "@minecraft/server",
    "@minecraft/server-ui",
    "@minecraft/server-admin",
    "@minecraft/server-net",
    "@minecraft/server-gametest",
  ],
  module_permissions: {
    "@minecraft/server-net": {
      allowed_uris: [`${parsedUrl.origin}/`],
      ...(parsedUrl.protocol === "https:" ? { force_tls: true } : {}),
      max_body_bytes: 1048576,
      max_concurrent_requests: 4,
    },
  },
}, null, 2)}\n`);
await writeFile(path.join(configTarget, "variables.json"), `${JSON.stringify({
  mc_wizard_url: brainUrl,
  mc_wizard_e2e: e2eEnabled,
  mc_wizard_e2e_run: e2eRun,
  mc_wizard_e2e_scope: e2eScope,
}, null, 2)}\n`);
const secretsFile = path.join(configTarget, "secrets.json");
await writeFile(secretsFile, `${JSON.stringify({
  mc_wizard_authorization: `Bearer ${token}`,
}, null, 2)}\n`, { mode: 0o600 });
await chmod(secretsFile, 0o600);

console.log(`Installed MC Wizard in ${serverRoot}`);
console.log(`Activated required behavior and appearance resource packs for world: ${worldName}`);
console.log(`Brain endpoint: ${brainUrl}`);
if (token === "dev-only-change-me") console.warn("Using the development bridge token; change it before exposing the service.");
console.warn("The world must already have the Beta APIs experiment enabled.");
