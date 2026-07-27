import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packSource = () => readFile(
  new URL("../bedrock/behavior_packs/mc_wizard/scripts/main.js", import.meta.url),
  "utf8",
);

test("Bedrock terrain work snapshots, mutates, reports, and remains undoable", async () => {
  const source = await packSource();
  assert.match(source, /action\?\.type === "terrain_work"/);
  assert.match(source, /findTerrainAnchor\(dimension, player\.location\)/);
  assert.match(source, /terrainWorkBounds\(anchor, action\)/);
  assert.match(source, /createFromWorld\(/);
  assert.match(source, /saveMode: StructureSaveMode\.World/);
  assert.match(source, /dimension\.fillBlocks\(new BlockVolume\(bounds\.clear\.from, bounds\.clear\.to\), "minecraft:air"\)/);
  assert.match(source, /if \(bounds\.level\)[\s\S]*dimension\.fillBlocks/);
  assert.match(source, /commitTransaction\(token\)/);
  assert.match(source, /rollbackTransaction\(token\)/);
  assert.match(source, /world\.structureManager\.place\(transaction\.structureId/);
  assert.match(source, /deleteTransactionBackup\(transaction\)/);
});

test("configured spawn protection is checked before the terrain snapshot", async () => {
  const source = await packSource();
  const guard = source.indexOf("terrainHitsProtectedSpawn(dimension, bounds.snapshot)");
  const snapshot = source.indexOf("world.structureManager.createFromWorld", guard);
  assert.ok(guard >= 0);
  assert.ok(snapshot > guard);
  assert.match(source.slice(guard, snapshot), /protected spawn area/);
});

test("terrain work uses the build lifecycle so disconnect rolls it back", async () => {
  const source = await packSource();
  const start = source.indexOf("function applyTerrainWork");
  const end = source.indexOf("function nearbyTorchTargets", start);
  const terrain = source.slice(start, end);
  assert.match(terrain, /activeBuildToken = token/);
  assert.match(terrain, /bindBuildAction\(player, token\)/);
  assert.match(terrain, /clearBuild\(token\)/);
  assert.match(source, /clearBuild\(abandonedToken, true\)/);
});
