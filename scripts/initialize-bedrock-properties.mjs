import { access, readFile, writeFile } from "node:fs/promises";
import { updateServerProperties } from "../src/server-control.mjs";

const propertiesFile = "runtime/bedrock/server.properties";
const markerFile = "runtime/bedrock/.mc-wizard-properties-initialized";

let initialized = true;
try {
  await access(markerFile);
} catch {
  initialized = false;
}

let source = "";
try {
  source = await readFile(propertiesFile, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const requiredProperties = { "texturepack-required": true };
if (!initialized) {
  Object.assign(requiredProperties, {
    "server-name": "MC Wizard",
    gamemode: "creative",
    "force-gamemode": true,
    difficulty: "peaceful",
    "allow-cheats": true,
    "max-players": 10,
    "online-mode": true,
    "allow-list": false,
    "server-port": 19132,
    "enable-lan-visibility": true,
    "default-player-permission-level": "operator",
    "content-log-file-enabled": true,
    "content-log-console-output-enabled": true,
  });
}

const updated = updateServerProperties(source, requiredProperties);
if (updated !== source) {
  await writeFile(propertiesFile, updated, { mode: 0o600 });
}
if (!initialized) {
  await writeFile(markerFile, "initialized\n", { mode: 0o600 });
}
