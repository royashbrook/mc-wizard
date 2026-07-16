import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

const run = promisify(execFile);
const repo = path.resolve(new URL("..", import.meta.url).pathname);
let serverRoot;

before(async () => {
  serverRoot = await mkdtemp(path.join(tmpdir(), "mc-wizard-install-"));
  await mkdir(path.join(serverRoot, "worlds", "Family Lab"), { recursive: true });
  await writeFile(path.join(serverRoot, "server.properties"), "texturepack-required=false\nmax-players=10\n");
  await writeFile(path.join(serverRoot, "world_resource_packs.json"), "[]\n");
  await writeFile(path.join(serverRoot, "worlds", "Family Lab", "world_resource_packs.json"), JSON.stringify([{
    pack_id: "5dd80b07-b583-4bb3-979c-41c25ce274d8",
    version: [0, 3, 0],
  }]));
  await run(process.execPath, [
    "--env-file-if-exists=.env",
    "scripts/install-pack.mjs",
    serverRoot,
    "Family Lab",
  ], { cwd: repo });
});

after(async () => {
  await rm(serverRoot, { recursive: true, force: true });
});

test("standalone installs require and version the live Wizard appearance pack", async () => {
  const properties = await readFile(path.join(serverRoot, "server.properties"), "utf8");
  const assignments = JSON.parse(await readFile(
    path.join(serverRoot, "worlds", "Family Lab", "world_resource_packs.json"),
    "utf8",
  ));
  const manifest = JSON.parse(await readFile(
    path.join(serverRoot, "resource_packs", "mc_wizard", "manifest.json"),
    "utf8",
  ));
  await readFile(path.join(serverRoot, "resource_packs", "mc_wizard", "entity", "player.entity.json"));

  assert.match(properties, /^texturepack-required=true$/m);
  assert.match(properties, /^max-players=10$/m);
  assert.deepEqual(assignments.find((pack) => pack.pack_id === manifest.header.uuid)?.version, [0, 4, 0]);
});
