import { access, readFile, writeFile } from "node:fs/promises";
import { updateServerProperties } from "../src/server-control.mjs";

const propertiesFile = "runtime/bedrock/server.properties";
const markerFile = "runtime/bedrock/.mc-wizard-properties-initialized";

try {
  await access(markerFile);
} catch {
  const source = await readFile(propertiesFile, "utf8");
  await writeFile(propertiesFile, updateServerProperties(source, {
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
  }), { mode: 0o600 });
  await writeFile(markerFile, "initialized\n", { mode: 0o600 });
}
