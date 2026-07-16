import assert from "node:assert/strict";
import test from "node:test";
import { requesterCommand, validateMinecraftCommand } from "../src/bedrock-console.mjs";
import { updateServerProperties } from "../src/server-control.mjs";
import { validateServerCommandsBody, validateServerConfigurationBody } from "../src/server.mjs";

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
