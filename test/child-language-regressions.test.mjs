import assert from "node:assert/strict";
import test from "node:test";

import { createWizard } from "../src/wizard.mjs";

const askOffline = async (question) => createWizard({
  corpus: { search: () => [] },
  env: {},
}).ask({ player: "YoungKid", question });

test("common child misspellings still reach the intended deterministic hand", async () => {
  const travel = await askOffline("telport me to the surface pls");
  assert.equal(travel.action?.type, "local_travel");

  const gift = await askOffline("giv me 3 dimonds");
  assert.equal(gift.action?.type, "give_items");
  assert.equal(gift.action?.items?.[0]?.itemId, "minecraft:diamond");
  assert.equal(gift.action?.items?.[0]?.amount, 3);

  const effect = await askOffline("nite vison pls");
  assert.equal(effect.action?.type, "run_commands");
  assert.match(effect.action?.commands?.[0] || "", /night_vision/);

  const build = await askOffline("bild me a casle");
  assert.equal(build.action?.type, "build_structure");
  assert.equal(build.action?.plan?.kind, "castle");
});
