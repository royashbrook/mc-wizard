import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createAutomaticKelpFarmBlueprint } from "../bedrock/behavior_packs/mc_wizard/scripts/kelp-farm.js";
import { allowedWizardAction, wizardSkillPrompt } from "../src/skills.mjs";

const key = (point) => point.join(",");

test("automatic kelp farm has a planted source-water harvester and real output path", () => {
  const farm = createAutomaticKelpFarmBlueprint();
  assert.equal(farm.id, "automatic_kelp_farm");
  assert.deepEqual(farm.bounds, { min: [-2, -1, 1], max: [2, 5, 5] });

  const placed = new Map();
  for (const placement of farm.placements) {
    if (placement.action === "break") continue;
    assert.ok(placement.support[1] === -1 || placed.has(key(placement.support)),
      `${key(placement.target)} must use ground or an earlier support`);
    assert.equal(placed.has(key(placement.target)), false, `${key(placement.target)} is duplicated`);
    placed.set(key(placement.target), placement);
  }
  assert.equal(placed.get("0,0,4").itemId, "minecraft:sand");
  assert.deepEqual(placed.get("0,2,5").orientationTarget, [0, 2, 4]);
  assert.deepEqual(placed.get("-1,2,4").orientationTarget, [0, 2, 4]);
  for (const point of ["-2,2,4", "-2,2,5"]) {
    assert.equal(placed.get(point).expectedType, "minecraft:redstone_wire");
  }
  assert.deepEqual(placed.get("0,4,2").facingTarget, [0, 4, 1]);
  for (const y of [1, 2, 3]) assert.equal(placed.get(`0,${y},3`).itemId, "minecraft:glass");
  assert.equal(placed.get("0,4,3").itemId, "minecraft:smooth_stone");
  assert.equal(placed.get("0,5,1").itemId, "minecraft:glass");
  assert.equal(placed.has("1,2,4"), false);
  for (const point of ["2,2,4", "1,2,3", "1,2,5"]) assert.equal(placed.get(point).itemId, "minecraft:glass");

  const water = farm.interactions.filter(({ itemId }) => itemId === "minecraft:water_bucket");
  assert.deepEqual(water.map(({ faceTarget }) => faceTarget), [
    ...[1, 2, 3, 4, 5].map((y) => [0, y, 4]),
    [1, 2, 4],
  ]);
  const plantedKelp = farm.interactions.filter(({ itemId }) => itemId === "minecraft:kelp");
  assert.deepEqual(plantedKelp.map(({ faceTarget }) => faceTarget), [[0, 1, 4]]);
  assert.deepEqual(
    farm.interactions.find(({ itemId }) => itemId === "minecraft:redstone")?.faceTarget,
    [-1, 2, 5],
  );
  assert.deepEqual(farm.interactions.filter(({ action }) => action === "wait_ticks").map(({ ticks }) => ticks), [160]);

  const pipeline = farm.verification.find(({ kind }) => kind === "kelp_farm_pipeline");
  assert.deepEqual(pipeline.plant, [0, 1, 4]);
  assert.deepEqual(pipeline.waterColumn, [[0, 2, 4], [0, 3, 4], [0, 4, 4], [0, 5, 4]]);
  assert.deepEqual(pipeline.streamSource, [0, 5, 4]);
  assert.deepEqual(pipeline.collectionStream, [[0, 5, 3], [0, 5, 2]]);
  assert.deepEqual(pipeline.collectionWater, [0, 5, 2]);
  assert.deepEqual(pipeline.refillSource, [1, 2, 4]);
  assert.deepEqual(pipeline.output, [0, 4, 1]);
  assert.equal(pipeline.expectedOutput, "minecraft:kelp");
  assert.match(farm.success, /floating kelp.+output chest/i);
});

test("kelp fixed action is allowlisted by the model schema and Bedrock executor", async () => {
  const action = { type: "place_blueprint", id: "automatic_kelp_farm", version: 1 };
  assert.deepEqual(allowedWizardAction(action), action);
  assert.match(wizardSkillPrompt(), /build_automatic_kelp_farm/);

  const [schemaText, pack, e2e, installer, runner, packageText] = await Promise.all([
    readFile(new URL("../schemas/wizard-response.schema.json", import.meta.url), "utf8"),
    readFile(new URL("../bedrock/behavior_packs/mc_wizard/scripts/main.js", import.meta.url), "utf8"),
    readFile(new URL("../bedrock/behavior_packs/mc_wizard/scripts/e2e.js", import.meta.url), "utf8"),
    readFile(new URL("../scripts/install-pack.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-e2e-container.sh", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const ids = JSON.parse(schemaText).properties.action.anyOf
    .find(({ properties }) => properties?.type?.const === "place_blueprint")
    .properties.id.enum;
  assert.ok(ids.includes("automatic_kelp_farm"));
  assert.match(pack, /createAutomaticKelpFarmBlueprint/);
  assert.match(pack, /check\.kind === "kelp_farm_pipeline"/);
  assert.match(pack, /check\.collectionStream\.every\(water\)/);
  assert.match(pack, /check\.waterColumn\.every\(submergedKelp\)/);
  assert.match(pack, /check\.streamSource/);
  assert.match(pack, /floated a kelp test item from the column through the top stream/);
  assert.doesNotMatch(pack, /loaded a second kelp test item into the collection hopper/);
  assert.match(pack, /outputContainer\.getItem\(slot\)\?\.typeId === check\.expectedOutput/);
  assert.match(e2e, /async function proveLiveKelpHarvest/);
  assert.match(e2e, /clearSeededOutput\(\);[\s\S]+clearSeededOutput\(\);/);
  assert.match(e2e, /gamerule randomtickspeed 1000/);
  assert.match(e2e, /await proveLiveKelpHarvest\(kid, farmStation\)/);
  assert.match(e2e, /scope === "kelp"/);
  assert.match(installer, /"kelp"/);
  assert.match(runner, /E2E_SCOPE.*kelp/);
  assert.equal(
    JSON.parse(packageText).scripts["test:e2e:kelp"],
    "MC_WIZARD_E2E_SCOPE=kelp sh scripts/run-e2e-container.sh",
  );
});
