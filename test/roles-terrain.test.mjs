import assert from "node:assert/strict";
import test from "node:test";

import {
  TERRAIN_WORK_LIMITS,
  findTerrainAnchor,
  terrainWorkBounds,
  validateTerrainWorkAction,
} from "../bedrock/behavior_packs/mc_wizard/scripts/terrain-work.js";
import { explicitlyRequestsCommand } from "../src/command-safety.mjs";
import { createTerrainPlanner, DEFAULT_FOOTPRINT, DEFAULT_HEIGHT, MAX_FOOTPRINT, MAX_HEIGHT } from "../src/roles/terrain.mjs";
import { allowedWizardAction } from "../src/skills.mjs";
import { createWizard, parseRequestedDimensions } from "../src/wizard.mjs";

const never = () => false;
const planner = createTerrainPlanner({
  parseRequestedDimensions,
  allowedWizardAction,
  explicitlyRequestsBuild: never,
  explicitlyRequestsCommand,
  isRecipeRequest: never,
  isOrdinaryConversation: never,
});

const LIVE_CLEAR = "clear a 50x50 area around me, starting at the ground beneath this tree";
const LIVE_LEVEL = "just level the ground, remove all blocks in a 50x50 area";

test("live terrain requests produce exact typed clear and level actions", () => {
  assert.deepEqual(planner.terrainAction(LIVE_CLEAR), {
    type: "terrain_work",
    version: 1,
    mode: "clear",
    width: 50,
    depth: 50,
    height: DEFAULT_HEIGHT,
    fillDepth: 0,
  });
  assert.deepEqual(planner.terrainAction(LIVE_LEVEL), {
    type: "terrain_work",
    version: 1,
    mode: "level",
    width: 50,
    depth: 50,
    height: DEFAULT_HEIGHT,
    fillDepth: 4,
  });
});

test("unsized terrain work uses the bounded default", () => {
  assert.deepEqual(planner.terrainAction("flatten this hill"), {
    type: "terrain_work",
    version: 1,
    mode: "level",
    width: DEFAULT_FOOTPRINT,
    depth: DEFAULT_FOOTPRINT,
    height: DEFAULT_HEIGHT,
    fillDepth: 4,
  });
});

test("the allowlist validates exact bounds and rejects malformed terrain actions", () => {
  const action = planner.terrainAction("clear a 20 by 30 space");
  assert.deepEqual(allowedWizardAction(action), action);
  for (const bad of [
    { ...action, width: 0 },
    { ...action, width: TERRAIN_WORK_LIMITS.width + 1 },
    { ...action, height: TERRAIN_WORK_LIMITS.height + 1 },
    { ...action, mode: "explode" },
    { ...action, extra: true },
  ]) {
    assert.equal(allowedWizardAction(bad), null);
  }
});

test("over-bound requests are not silently clamped into execution", () => {
  for (const question of ["clear a 500x500 area", "clear a 20x20 area 90 blocks tall"]) {
    const intent = planner.terrainIntent(question);
    assert.equal(intent.width <= MAX_FOOTPRINT, true);
    assert.equal(intent.height <= MAX_HEIGHT, true);
    assert.match(intent.caveat, /biggest safe|blocks up/);
    assert.equal(planner.terrainAction(question), null);
  }
});

test("an over-bound child request gets the concrete limit and can accept it", async () => {
  const wizard = createWizard({ corpus: { search: () => [] }, env: {} });
  const offered = await wizard.ask({ player: "TerrainLimitKid", question: "clear a 500x500 area" });
  assert.equal(offered.action, null);
  assert.match(offered.answer, /64 by 64/);
  const accepted = await wizard.ask({ player: "TerrainLimitKid", question: "yes" });
  assert.equal(accepted.action.type, "terrain_work");
  assert.equal(accepted.action.width, 64);
  assert.equal(accepted.action.depth, 64);
});

test("request framing and common child terrain nouns reach the typed executor", () => {
  for (const question of [
    "wiz can you clear the trees around here",
    "remove all blocks in a 50x50 area",
    "i want you to level the ground here",
    "dig out a big hole here",
    "flatten that mound",
    "make this flat",
  ]) {
    assert.equal(planner.terrainAction(question)?.type, "terrain_work", question);
  }
});

test("questions, command lessons, builds, and unrelated verbs are not terrain work", () => {
  for (const question of [
    "what command clears an area",
    "what happens if I dig straight down",
    "just explain how to clear a 50x50 area",
    "clear the ground and build me a castle",
    "make me a flat roof house",
    "clear your throat",
    "remove my hat",
    "make the weather clear",
  ]) {
    assert.equal(planner.terrainAction(question), null, question);
  }
});

test("every injected routing bail can suppress terrain work", () => {
  const question = "clear a 20x20 area";
  const base = {
    parseRequestedDimensions,
    allowedWizardAction,
    explicitlyRequestsBuild: never,
    explicitlyRequestsCommand,
    isRecipeRequest: never,
    isOrdinaryConversation: never,
  };
  for (const key of ["explicitlyRequestsBuild", "explicitlyRequestsCommand", "isRecipeRequest", "isOrdinaryConversation"]) {
    const routed = createTerrainPlanner({ ...base, [key]: () => true });
    assert.equal(routed.terrainAction(question), null, key);
  }
  for (const key of Object.keys(base)) {
    const missing = { ...base };
    delete missing[key];
    assert.throws(() => createTerrainPlanner(missing), new RegExp(key), key);
  }
});

test("anchor search skips a whole tree and foliage to find its ground", () => {
  const types = new Map([
    [90, "minecraft:oak_leaves"],
    [89, "minecraft:oak_log"],
    [88, "minecraft:oak_log"],
    [87, "minecraft:oak_log"],
    [86, "minecraft:dirt"],
  ]);
  const dimension = {
    heightRange: { min: -64, max: 320 },
    getBlock: ({ y }) => {
      const typeId = types.get(y) || "minecraft:air";
      return { typeId, isSolid: typeId !== "minecraft:air" };
    },
  };
  assert.deepEqual(findTerrainAnchor(dimension, { x: 10.8, y: 90.2, z: -4.1 }), {
    x: 10, y: 86, z: -5, typeId: "minecraft:dirt",
  });
});

test("terrain bounds preserve the exact requested footprint", () => {
  const anchor = { x: 100, y: 70, z: 200 };
  const clear = terrainWorkBounds(anchor, planner.terrainAction(LIVE_CLEAR));
  assert.deepEqual(clear.clear, {
    from: { x: 76, y: 71, z: 176 },
    to: { x: 125, y: 82, z: 225 },
  });
  const level = terrainWorkBounds(anchor, planner.terrainAction(LIVE_LEVEL));
  assert.deepEqual(level.level, {
    from: { x: 76, y: 67, z: 176 },
    to: { x: 125, y: 70, z: 225 },
  });
  assert.deepEqual(level.snapshot.from, level.level.from);
});

test("terrain helper remains dependency-free Bedrock-compatible JavaScript", async () => {
  const action = validateTerrainWorkAction({
    type: "terrain_work", version: 1, mode: "level",
    width: 64, depth: 64, height: 32, fillDepth: 4,
  });
  assert.equal(action.width, 64);
});
