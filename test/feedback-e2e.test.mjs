import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pack = readFileSync(
  new URL("../bedrock/behavior_packs/mc_wizard/scripts/e2e.js", import.meta.url),
  "utf8",
);
const runner = readFileSync(new URL("../scripts/run-e2e-container.sh", import.meta.url), "utf8");
const installer = readFileSync(new URL("../scripts/install-pack.mjs", import.meta.url), "utf8");

test("offers a physical feedback scope that refines the same completed structure", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageJson.scripts["test:e2e:feedback"],
    "MC_WIZARD_E2E_SCOPE=feedback sh scripts/run-e2e-container.sh",
  );
  assert.match(pack, /scope === "feedback"/);
  assert.match(runner, /E2E_SCOPE" != "feedback"/);
  assert.match(installer, /"refinement", "feedback", "farms"/);
  assert.match(pack, /runFeedbackAcceptance\(kid\)/);
  assert.match(pack, /routeFeedbackMessage\(kid, message\)/);
  assert.match(pack, /grade 2: it is too dark, add more lights/);
  assert.match(pack, /lights >= lightsBefore \+ 8/);
  assert.match(pack, /addedFoundations\.length > 0/);
});
