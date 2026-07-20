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
  await mkdir(path.join(serverRoot, "config", "4e8790fe-18dc-46d1-aa31-ec78a924b717"), { recursive: true });
  await writeFile(path.join(serverRoot, "server.properties"), "texturepack-required=false\nmax-players=10\n");
  await writeFile(path.join(serverRoot, "world_resource_packs.json"), "[]\n");
  await writeFile(path.join(serverRoot, "worlds", "Family Lab", "world_resource_packs.json"), JSON.stringify([{
    pack_id: "5dd80b07-b583-4bb3-979c-41c25ce274d8",
    version: [0, 3, 0],
  }]));
  await writeFile(
    path.join(serverRoot, "config", "4e8790fe-18dc-46d1-aa31-ec78a924b717", "variables.json"),
    JSON.stringify({ mc_wizard_url: "http://192.168.1.50:3000/v1/ask" }),
  );
  await run(process.execPath, [
    "scripts/install-pack.mjs",
    serverRoot,
    "Family Lab",
  ], {
    cwd: repo,
    env: {
      ...process.env,
      MC_WIZARD_LAN_IP: "",
      WIZARD_URL: "",
      BRIDGE_TOKEN: "test-only-bridge-token-0123456789abcdef",
    },
  });
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
  const variables = JSON.parse(await readFile(
    path.join(serverRoot, "config", "4e8790fe-18dc-46d1-aa31-ec78a924b717", "variables.json"),
    "utf8",
  ));
  await readFile(path.join(serverRoot, "resource_packs", "mc_wizard", "entity", "player.entity.json"));

  assert.match(properties, /^texturepack-required=true$/m);
  assert.match(properties, /^max-players=10$/m);
  assert.deepEqual(assignments.find((pack) => pack.pack_id === manifest.header.uuid)?.version, [0, 4, 0]);
  assert.equal(variables.mc_wizard_url, "http://192.168.1.50:3000/v1/ask");
});

test("reinstalling mirrors the source and purges stale cruft from the destination", async () => {
  // Regression for issue #39: a stale Finder-duplicate directory left in the
  // installed pack must not survive a reinstall, or the image's forced pack
  // refresh aborts the whole BDS boot with "rm ...: Directory not empty".
  const staleDir = path.join(serverRoot, "resource_packs", "mc_wizard", "models 2");
  await mkdir(staleDir, { recursive: true });
  await writeFile(path.join(staleDir, "entity"), "leftover\n");

  await run(process.execPath, ["scripts/install-pack.mjs", serverRoot, "Family Lab"], {
    cwd: repo,
    env: {
      ...process.env,
      MC_WIZARD_LAN_IP: "",
      WIZARD_URL: "",
      BRIDGE_TOKEN: "test-only-bridge-token-0123456789abcdef",
    },
  });

  await assert.rejects(readFile(path.join(staleDir, "entity")), /ENOENT/);
  // The real pack content is still present after the mirror.
  await readFile(path.join(serverRoot, "resource_packs", "mc_wizard", "manifest.json"));
});

test("the tracked source packs contain no Finder-duplicate entries", async () => {
  const { stdout } = await run("find", [
    path.join(repo, "bedrock"),
    "(", "-name", "* 2", "-o", "-name", "* 3", "-o", "-name", "* 2.*", "-o", "-name", "* 3.*", ")",
  ]);
  assert.equal(stdout.trim(), "", `Finder-duplicate paths found under bedrock/:\n${stdout}`);
});

test("default or short bridge tokens are refused for a non-loopback brain URL", async () => {
  const guardedRoot = await mkdtemp(path.join(tmpdir(), "mc-wizard-install-guard-"));
  try {
    await mkdir(path.join(guardedRoot, "worlds", "Family Lab"), { recursive: true });
    await mkdir(path.join(guardedRoot, "config", "4e8790fe-18dc-46d1-aa31-ec78a924b717"), { recursive: true });
    await writeFile(path.join(guardedRoot, "server.properties"), "texturepack-required=false\nmax-players=10\n");
    await writeFile(
      path.join(guardedRoot, "config", "4e8790fe-18dc-46d1-aa31-ec78a924b717", "variables.json"),
      JSON.stringify({ mc_wizard_url: "http://192.168.1.50:3000/v1/ask" }),
    );
    await assert.rejects(
      run(process.execPath, [
        "scripts/install-pack.mjs",
        guardedRoot,
        "Family Lab",
      ], {
        cwd: repo,
        // BRIDGE_TOKEN deliberately empty: the script must fall back to its
        // default token and refuse the non-loopback brain URL.
        env: { ...process.env, MC_WIZARD_LAN_IP: "", WIZARD_URL: "", BRIDGE_TOKEN: "" },
      }),
      (error) => {
        assert.notEqual(error.code, 0);
        assert.match(String(error.stderr), /Refusing a default or short bridge token/);
        return true;
      },
    );
  } finally {
    await rm(guardedRoot, { recursive: true, force: true });
  }
});
