import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("offers a physical requester-scoped command acceptance scope", async () => {
  const [packageJson, pack, runner, installer] = await Promise.all([
    readFile(new URL("package.json", root), "utf8").then(JSON.parse),
    readFile(new URL("bedrock/behavior_packs/mc_wizard/scripts/e2e.js", root), "utf8"),
    readFile(new URL("scripts/run-e2e-container.sh", root), "utf8"),
    readFile(new URL("scripts/install-pack.mjs", root), "utf8"),
  ]);
  assert.equal(
    packageJson.scripts["test:e2e:commands"],
    "MC_WIZARD_E2E_SCOPE=commands sh scripts/run-e2e-container.sh",
  );
  assert.match(pack, /scope === "commands"/);
  assert.match(pack, /kid\.getEffect\("night_vision"\)/);
  assert.match(pack, /eight nearby torches placed through the visible Wizard player/);
  assert.match(runner, /E2E_SCOPE" != "commands"/);
  assert.match(installer, /"machines", "commands", "arbitrary"/);
});
