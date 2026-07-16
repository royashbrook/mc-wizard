import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeRuntimeStep,
  RUNTIME_CAPABILITIES,
} from "../bedrock/behavior_packs/mc_wizard/scripts/capability-runtime.js";
import { wizardSkillPrompt } from "../src/skills.mjs";

const packScript = await readFile(new URL(
  "../bedrock/behavior_packs/mc_wizard/scripts/main.js",
  import.meta.url,
), "utf8");

const step = (capability, args) => ({
  id: "test_step",
  capability,
  arguments: args,
  expect: "The visible result is correct.",
  onFailure: "replan",
});

test("runtime manifest exposes composable player, script, command, artifact, observation, and verification hands", () => {
  assert.deepEqual(new Set(RUNTIME_CAPABILITIES), new Set([
    "artifact.book", "control.wait", "observe.snapshot", "player.break-blocks",
    "player.move", "player.place-blocks", "player.use-item", "script.effect",
    "script.spawn-entity", "script.teleport", "verify.blocks", "verify.entities",
    "verify.snapshot", "world.command",
  ]));
  const prompt = wizardSkillPrompt();
  for (const capability of RUNTIME_CAPABILITIES) assert.match(prompt, new RegExp(capability.replace(".", "\\.")));
});

test("runtime normalizes a physical build and its observable verification", () => {
  assert.deepEqual(normalizeRuntimeStep(step("player.place-blocks", { blocks: [{
    itemId: "minecraft:cake",
    target: [0, 0, 1],
    support: [0, -1, 1],
    expectedType: "minecraft:cake",
  }] })).arguments.blocks[0], {
    itemId: "minecraft:cake",
    target: [0, 0, 1],
    support: [0, -1, 1],
    expectedType: "minecraft:cake",
    expectedStates: {},
  });
  assert.deepEqual(normalizeRuntimeStep(step("verify.entities", {
    typeId: "minecraft:horse", minimum: 1, maxDistance: 32,
  })).arguments, { typeId: "minecraft:horse", minimum: 1, maxDistance: 32 });
});

test("runtime keeps ordinary commands requester-scoped and rejects server authority", () => {
  assert.deepEqual(normalizeRuntimeStep(step("world.command", {
    commands: ["effect @s night_vision 1200 0 true"],
  })).arguments.commands, ["effect @s night_vision 1200 0 true"]);
  for (const command of ["kick OtherKid", "effect @a night_vision 20", "/say nope"]) {
    assert.throws(() => normalizeRuntimeStep(step("world.command", { commands: [command] })), /authority|broad|safe command/);
  }
  assert.throws(() => normalizeRuntimeStep(step("knowledge.research", { query: "cake" })), /not installed/);
});

test("Bedrock executes programs sequentially and reports failed steps with a fresh snapshot", () => {
  assert.match(packScript, /import \{ normalizeRuntimeStep \} from "\.\/capability-runtime\.js"/);
  assert.match(packScript, /async function executeCapabilityProgram\(player, program\)/);
  assert.match(packScript, /program\.steps\.map\(normalizeRuntimeStep\)/);
  assert.match(packScript, /await executeCapabilityStep\(player, step, frame\)/);
  assert.match(packScript, /action\?\.type === "execute_program" && action\.version === 1/);
  assert.match(packScript, /void executeCapabilityProgram\(player, action\.program\)/);
  assert.match(packScript, /placeAsWizard\(/);
  assert.match(packScript, /breakAsWizard\(/);
  assert.match(packScript, /useItemAsWizard\(/);
  assert.match(packScript, /executeRequesterCommands\(/);
  assert.match(packScript, /dropCapabilityBook\(/);
  assert.match(packScript, /\["completed", "failed", "partial"\]\.includes\(status\)/);
  assert.match(packScript, /endBuildAction\(token, "failed", `program/);
  assert.ok(
    packScript.indexOf("/.test(step.capability)) changedWorld = true")
      < packScript.indexOf("await executeCapabilityStep(player, step, frame)"),
    "a partially completed mutating step must preserve useful world changes",
  );
});
