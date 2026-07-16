import assert from "node:assert/strict";
import test from "node:test";
import {
  locateBedrockStructure,
  locateStructureNotFound,
  parseLocatedStructure,
  sendBedrockCommand,
  requesterCommand,
  validateMinecraftCommand,
} from "../src/bedrock-console.mjs";
import { updateServerProperties } from "../src/server-control.mjs";
import {
  validateLocateBody,
  validateServerCommandsBody,
  validateServerConfigurationBody,
} from "../src/server.mjs";

test("server console expands only the explicit requester placeholder", () => {
  assert.equal(requesterCommand("op {{requester}}", "Kid Builder"), 'op "Kid Builder"');
  assert.equal(validateMinecraftCommand("/allowlist off"), "allowlist off");
  assert.throws(() => validateMinecraftCommand("say hi\nstop"), /one line/);
  assert.deepEqual(validateServerCommandsBody({
    player: "Kid Builder", commands: ["op {{requester}}", "stop"],
  }).commands, ["op {{requester}}", "stop"]);
});

test("trusted server configuration validates arbitrary properties and world metadata", () => {
  const value = validateServerConfigurationBody({
    player: "Kid Builder",
    settings: {
      properties: { "default-player-permission-level": "operator", difficulty: "hard" },
      experiments: { gametest: true, holiday_creator_features: false },
      worldOptions: { educationFeaturesEnabled: true, eduOffer: 1 },
    },
  });
  assert.equal(value.settings.properties["default-player-permission-level"], "operator");
  assert.equal(value.settings.worldOptions.educationFeaturesEnabled, true);
  assert.throws(() => validateServerConfigurationBody({
    player: "Kid", settings: { properties: { "bad key": "value" } },
  }), /invalid/);
});

test("server.properties updates preserve comments and append new settings", () => {
  assert.equal(updateServerProperties(
    "difficulty=peaceful\n# explanation\nmax-players=10\n",
    { difficulty: "hard", "default-player-permission-level": "operator" },
  ), "difficulty=hard\n# explanation\nmax-players=10\n\ndefault-player-permission-level=operator");
});

test("nearest-village adapter parses only the fixed BDS locate output", async () => {
  const line = "[2026-07-16 22:04:20:548 INFO] The nearest minecraft:village is at block -264, (y?), -392 (472 blocks away)";
  assert.deepEqual(parseLocatedStructure(line), { x: -264, z: -392 });
  assert.equal(parseLocatedStructure("The nearest monument is at block 1, (y?), 2"), undefined);
  assert.equal(locateStructureNotFound("No valid structure found within a reasonable distance"), true);
  const calls = [];
  let logReads = 0;
  const unrelated = "[2026-07-16 22:04:20:547 INFO] The nearest minecraft:village is at block 5000, (y?), 5000 (5 blocks away)";
  const execute = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === "logs") {
      logReads += 1;
      return { code: 0, output: logReads === 1 ? "old log" : `old log\n${line}\n${unrelated}` };
    }
    return { code: 0, output: "" };
  };
  const located = locateBedrockStructure(execute, {
    x: 12.8, z: -7.2, containerName: "isolated-bedrock", timeoutMs: 1_000,
  });
  const queuedCommand = sendBedrockCommand(execute, "say after-locate", "isolated-bedrock");
  assert.deepEqual(await located, { x: -264, z: -392 });
  await queuedCommand;
  assert.ok(calls.some(([, args]) => args.includes("isolated-bedrock")));
  assert.ok(calls.some(([, args]) => args.includes("execute positioned 12 80 -8 run locate structure village")));
  const locateIndex = calls.findIndex(([, args]) => args.includes("execute positioned 12 80 -8 run locate structure village"));
  const generalIndex = calls.findIndex(([, args]) => args.includes("say after-locate"));
  assert.ok(generalIndex > locateIndex, "all bridge commands must wait for the correlated locate poll");
});

test("nearest-village endpoint accepts only bounded fixed requests", () => {
  assert.deepEqual(validateLocateBody({
    player: "Kid", origin: { x: 12, z: -7 }, structure: "village",
  }), { player: "Kid", origin: { x: 12, z: -7 }, structure: "village" });
  assert.throws(() => validateLocateBody({
    player: "Kid", origin: { x: 12, z: -7 }, structure: "fortress",
  }), /structure must be village/);
  assert.throws(() => validateLocateBody({
    player: "Kid", origin: { x: 31_000_000, z: 0 }, structure: "village",
  }), /origin/);
});
