import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";
import {
  readJson,
  validateActionResultBody,
  validateAskBody,
  validateWorldContext,
} from "../src/server.mjs";

let packScript;
let serverScript;

before(async () => {
  [packScript, serverScript] = await Promise.all([
    readFile(new URL("../bedrock/behavior_packs/mc_wizard/scripts/main.js", import.meta.url), "utf8"),
    readFile(new URL("../src/server.mjs", import.meta.url), "utf8"),
  ]);
});

test("Bedrock sends a bounded live-world snapshot with correlated wizard requests", () => {
  assert.match(packScript, /function liveWorldSnapshot\(player\)/);
  assert.match(packScript, /maxDistance: 12/);
  assert.match(packScript, /\.slice\(0, 16\)/);
  assert.match(packScript, /\.slice\(0, 12\)/);
  assert.match(packScript, /lastStructureFor\(player\)/);
  assert.match(packScript, /function completeStructurePrimitives\(plan\)/);
  assert.match(packScript, /validateBuildStructurePlan\(\{ \.\.\.plan, mode: undefined \}\)/);
  assert.match(packScript, /complete\.primitives\.slice\(0, STRUCTURE_PRIMITIVE_LIMIT\)/);
  assert.match(serverScript, /const MAX_BODY_BYTES = 128 \* 1024/);
  assert.match(packScript, /const requestId = `\$\{system\.currentTick\.toString\(36\)\}-\$\{token\.toString\(36\)\}`/);
  assert.match(packScript, /mode === "wizard" \? \{ context: liveWorldSnapshot\(player\) \} : \{\}/);
  assert.match(packScript, /setBody\(JSON\.stringify\(requestBody\)\)/);
});

test("world context validation keeps only compact safe observations", () => {
  const nearbyBlocks = Array.from({ length: 18 }, (_, index) => ({
    typeId: `minecraft:test_block_${index}`,
    count: index + 1,
    secret: "discard me",
  }));
  const nearbyEntities = Array.from({ length: 14 }, (_, index) => ({
    typeId: `minecraft:test_entity_${index}`,
    relative: { x: index, y: 0, z: index ? -index : 0 },
    name: "discard me",
  }));
  const context = validateWorldContext({
    dimension: "minecraft:overworld",
    weather: "rain",
    timeOfDay: 13_000,
    player: { x: 12, y: 64, z: -9, rotation: 90 },
    buildState: "building",
    nearbyBlocks,
    nearbyEntities,
    lastStructure: {
      kind: "castle<script>",
      title: "Kid's Keep!",
      dimensions: { width: 20, depth: 20, height: 12, volume: 4_800 },
      materials: {
        primary: "minecraft:stone_bricks",
        accent: "minecraft:cobblestone",
        roof: "minecraft:deepslate_bricks",
        secret: "discard me",
      },
      features: ["floor", "rooms<script>", "towers"],
      primitives: [
        {
          shape: "box",
          phase: "foundation",
          blockId: "minecraft:stone_bricks",
          from: [19, 0, 19],
          to: [0, 0, 0],
          secret: "discard me",
        },
        {
          shape: "line",
          phase: "details",
          blockId: "minecraft:gold_block",
          from: [10, 1, 10],
          to: [10, 11, 10],
        },
      ],
      entities: [
        { typeId: "minecraft:villager_v2", location: [3, 1, 3], name: "discard me" },
        { typeId: "minecraft:villager_v2", location: [16, 1, 16] },
      ],
      verifiedInhabitants: { "minecraft:villager_v2": 2 },
      relativeOrigin: { x: 7, y: 0, z: -10 },
      plan: "discard me",
    },
    lastProject: {
      title: "Chicken Farm<script>",
      kind: "Automatic Chicken Farm!",
      relativeOrigin: { x: 5, y: 0, z: 8 },
      bounds: { min: [0, 0, 0], max: [4, 3, 6] },
      placements: [{
        itemId: "minecraft:glass", target: [0, 1, 0], support: [0, 0, 0],
        orientationTarget: null, secret: "discard me",
      }],
      interactions: [{
        action: "use_item_on_block", itemId: "minecraft:chicken_spawn_egg",
        block: [1, 1, 1], faceTarget: [1, 2, 1], command: "discard me",
      }],
    },
    promptInjection: "discard me",
  });

  assert.deepEqual(context.player, { x: 12, y: 64, z: -9 });
  assert.equal(context.nearbyBlocks.length, 16);
  assert.deepEqual(context.nearbyBlocks[0], { typeId: "minecraft:test_block_0", count: 1 });
  assert.equal(context.nearbyEntities.length, 12);
  assert.deepEqual(context.nearbyEntities[0], {
    typeId: "minecraft:test_entity_0",
    relative: { x: 0, y: 0, z: 0 },
  });
  assert.deepEqual(context.lastStructure, {
    kind: "castlescript",
    title: "Kids Keep",
    dimensions: { width: 20, depth: 20, height: 12 },
    materials: {
      primary: "minecraft:stone_bricks",
      accent: "minecraft:cobblestone",
      roof: "minecraft:deepslate_bricks",
    },
    features: ["floor", "roomsscript", "towers"],
    primitives: [
      {
        shape: "box",
        phase: "foundation",
        blockId: "minecraft:stone_bricks",
        from: [0, 0, 0],
        to: [19, 0, 19],
      },
      {
        shape: "line",
        phase: "details",
        blockId: "minecraft:gold_block",
        from: [10, 1, 10],
        to: [10, 11, 10],
      },
    ],
    entities: [
      { typeId: "minecraft:villager_v2", location: [3, 1, 3] },
      { typeId: "minecraft:villager_v2", location: [16, 1, 16] },
    ],
    verifiedInhabitants: { "minecraft:villager_v2": 2 },
    relativeOrigin: { x: 7, y: 0, z: -10 },
  });
  assert.deepEqual(context.lastProject, {
    title: "Chicken Farmscript",
    kind: "automatic chicken farm",
    relativeOrigin: { x: 5, y: 0, z: 8 },
    bounds: { min: [0, 0, 0], max: [4, 3, 6] },
    placements: [{
      itemId: "minecraft:glass", target: [0, 1, 0], support: [0, 0, 0], orientationTarget: null,
    }],
    interactions: [{
      action: "use_item_on_block", itemId: "minecraft:chicken_spawn_egg",
      block: [1, 1, 1], faceTarget: [1, 2, 1],
    }],
  });
  assert.deepEqual(Object.keys(context).sort(), [
    "buildState", "dimension", "lastProject", "lastStructure", "nearbyBlocks", "nearbyEntities",
    "player", "timeOfDay", "weather",
  ]);
});

test("last-structure primitives keep full bounded geometry and reject oversized or invalid plans", () => {
  const base = {
    dimension: "minecraft:overworld",
    weather: "clear",
    timeOfDay: 1_000,
    player: { x: 0, y: 70, z: 0 },
    lastStructure: {
      kind: "dragon statue",
      title: "Emerald Dragon",
      dimensions: { width: 12, depth: 8, height: 10 },
      primitives: Array.from({ length: 96 }, () => ({
        shape: "box",
        phase: "foundation",
        blockId: "minecraft:green_concrete",
        from: [0, 0, 0],
        to: [11, 0, 7],
      })),
    },
  };
  const accepted = validateWorldContext(base);
  assert.equal(accepted.lastStructure.primitives.length, 96);
  assert.deepEqual(accepted.lastStructure.primitives[0], {
    shape: "box",
    phase: "foundation",
    blockId: "minecraft:green_concrete",
    from: [0, 0, 0],
    to: [11, 0, 7],
  });

  const oversized = validateWorldContext({
    ...base,
    lastStructure: {
      ...base.lastStructure,
      primitives: [...base.lastStructure.primitives, base.lastStructure.primitives[0]],
    },
  });
  assert.equal(oversized.lastStructure.primitives, undefined);

  const outside = validateWorldContext({
    ...base,
    lastStructure: {
      ...base.lastStructure,
      primitives: [{ ...base.lastStructure.primitives[0], to: [12, 0, 7] }],
    },
  });
  assert.equal(outside.lastStructure.primitives, undefined);
});

test("last-structure context preserves bounded hollow buildings and whole-structure inhabitants", () => {
  const context = validateWorldContext({
    dimension: "minecraft:overworld",
    weather: "clear",
    timeOfDay: 1_000,
    player: { x: 0, y: 70, z: 0 },
    lastStructure: {
      kind: "city",
      title: "Kid City",
      dimensions: { width: 31, depth: 31, height: 18 },
      primitives: [{
        shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks",
        from: [1, 1, 1], to: [12, 10, 12],
      }],
      entities: [{ typeId: "minecraft:villager_v2", location: [5, 2, 5] }],
      verifiedInhabitants: { "minecraft:villager_v2": 1 },
      relativeOrigin: { x: 4, y: 0, z: 4 },
    },
  });
  assert.equal(context.lastStructure.primitives[0].shape, "hollow_box");
  assert.deepEqual(context.lastStructure.entities, [
    { typeId: "minecraft:villager_v2", location: [5, 2, 5] },
  ]);
  assert.deepEqual(context.lastStructure.verifiedInhabitants, { "minecraft:villager_v2": 1 });

  const invalid = validateWorldContext({
    ...context,
    lastStructure: {
      ...context.lastStructure,
      entities: [{ typeId: "minecraft:villager_v2", location: [31, 2, 5] }],
      verifiedInhabitants: { "minecraft:villager_v2": 9 },
    },
  });
  assert.equal(invalid.lastStructure.entities, undefined);
  assert.equal(invalid.lastStructure.verifiedInhabitants, undefined);
});

test("ask payload validation preserves safe correlation and rejects malformed context", () => {
  const accepted = validateAskBody({
    player: "BuilderKid",
    question: "make the castle taller",
    mode: "wizard",
    requestId: "abc-123",
    context: {
      dimension: "minecraft:overworld",
      weather: "clear",
      timeOfDay: 1_000,
      player: { x: 0, y: 70, z: 0 },
      buildState: "idle",
    },
  });
  assert.equal(accepted.requestId, "abc-123");
  assert.equal(accepted.context.dimension, "minecraft:overworld");

  const rejected = validateAskBody({
    question: "hello",
    requestId: "not valid!",
    context: { dimension: "../../server", timeOfDay: "nope", player: {} },
  });
  assert.equal(rejected.requestId, undefined);
  assert.equal(rejected.context, undefined);
});

test("terminal action results carry a validated fresh world snapshot for completion or replanning", () => {
  assert.match(packScript, /\["completed", "failed", "partial"\]\.includes\(status\) && actionPlayer\s*\? liveWorldSnapshot\(actionPlayer\)/);
  const accepted = validateActionResultBody({
    player: "BuilderKid",
    requestId: "castle-123",
    status: "completed",
    context: {
      dimension: "minecraft:overworld",
      weather: "clear",
      timeOfDay: 1_000,
      player: { x: 0, y: 70, z: 0 },
      buildState: "idle",
    },
  });
  assert.equal(accepted.context.dimension, "minecraft:overworld");
  assert.throws(() => validateActionResultBody({
    player: "BuilderKid",
    requestId: "castle-123",
    status: "completed",
    context: { dimension: "not-a-dimension" },
  }), (error) => error.status === 400);
  assert.throws(() => validateActionResultBody({
    player: "BuilderKid", requestId: "castle-123", status: "completed",
  }), (error) => error.status === 400 && /fresh live-world context/.test(error.message));
});

test("brain accepts the 128 KiB request boundary and rejects one byte more", async () => {
  const maxBytes = 128 * 1024;
  const empty = JSON.stringify({ question: "hello", padding: "" });
  const exact = JSON.stringify({
    question: "hello",
    padding: "x".repeat(maxBytes - Buffer.byteLength(empty)),
  });
  assert.equal(Buffer.byteLength(exact), maxBytes);
  const request = (body, declaredLength = Buffer.byteLength(body)) => ({
    headers: { "content-length": String(declaredLength) },
    async *[Symbol.asyncIterator]() {
      const buffer = Buffer.from(body);
      for (let offset = 0; offset < buffer.length; offset += 4_093) {
        yield buffer.subarray(offset, offset + 4_093);
      }
    },
  });
  assert.equal((await readJson(request(exact))).question, "hello");
  await assert.rejects(
    readJson(request(`${exact} `, 0)),
    (error) => error.status === 413,
  );
  await assert.rejects(
    readJson(request("{}", maxBytes + 1)),
    (error) => error.status === 413,
  );
});
