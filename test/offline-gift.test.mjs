import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { offlineGiftRequest } from "../bedrock/behavior_packs/mc_wizard/scripts/offline-gift.js";

test("basic item requests remain executable without the brain", () => {
  assert.deepEqual(offlineGiftRequest("give me 1 dirt"), {
    itemId: "minecraft:dirt",
    amount: 1,
  });
  assert.deepEqual(offlineGiftRequest("give me an emerald"), {
    itemId: "minecraft:emerald",
    amount: 1,
  });
  assert.deepEqual(offlineGiftRequest("give me a command block"), {
    itemId: "minecraft:command_block",
    amount: 1,
  });
  assert.deepEqual(offlineGiftRequest("give me an end gateway block"), {
    itemId: "minecraft:end_gateway",
    amount: 1,
  });
});

test("offline gift parsing is narrow and quantity bounded", () => {
  assert.equal(offlineGiftRequest("is it big"), null);
  assert.equal(offlineGiftRequest("build me a dirt house"), null);
  assert.equal(offlineGiftRequest("give me a hug"), null);
  assert.equal(offlineGiftRequest("give me a diamond sword with sharpness 5"), null);
  assert.equal(offlineGiftRequest("give me a diamond named Sparkles"), null);
  assert.deepEqual(offlineGiftRequest("please bring me 999 diamonds please"), {
    itemId: "minecraft:diamond",
    amount: 256,
  });
});

test("Bedrock bounds every HTTP request and probes brain health before asking", async () => {
  const source = await readFile(
    new URL("../bedrock/behavior_packs/mc_wizard/scripts/main.js", import.meta.url),
    "utf8",
  );
  const requestCount = [...source.matchAll(/new HttpRequest\(/g)].length;
  const timeoutCount = [...source.matchAll(/\.setTimeout\(/g)].length;
  assert.equal(timeoutCount, requestCount);
  assert.match(source, /await requireHealthyBackend\(\)/);
  assert.match(source, /BACKEND_HEALTH_TIMEOUT_SECONDS = 4/);
  assert.match(source, /BACKEND_REQUEST_TIMEOUT_SECONDS = 120/);
  assert.match(source, /brain health circuit is open/);
});
