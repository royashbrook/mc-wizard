import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNTHETIC_PLAYER_NAMES,
  inspectPath,
  inspectText,
} from "../scripts/check-publication.mjs";

test("publication guard rejects private runtime paths even when force-added", () => {
  for (const path of [
    ".env",
    ".env.local",
    "runtime/brain/interactions.jsonl",
    "worlds/mc-wizard/db/current.ldb",
    "generated-books/guide.json",
    "server.log",
  ]) assert.ok(inspectPath(path).length, path);

  assert.deepEqual(inspectPath(".env.example"), []);
  assert.deepEqual(inspectPath("src/session-store.mjs"), []);
});

test("publication guard rejects credential material but permits documented placeholders", () => {
  const githubToken = ["gho", "123456789012345678901234"].join("_");
  const assignedKey = ["API_KEY", "abcdefghijklmnop12345678"].join("=");
  assert.match(inspectText("oops.txt", `token=${githubToken}`).join("\n"), /GitHub token/);
  assert.match(inspectText("oops.txt", assignedKey).join("\n"), /credential-like/);
  assert.deepEqual(inspectText(".env.example", "AI_API_KEY=your-key-if-required"), []);
});

test("publication guard requires suspicious gamertags to use a reviewed synthetic name", () => {
  const suspiciousName = ["Ch1ld", "Name303"].join("");
  assert.match(inspectText("fixture.json", `player: "${suspiciousName}"`).join("\n"), /plaintext player name/);
  assert.match(inspectText("fixture.json", `allowlist add ${suspiciousName}`).join("\n"), /plaintext player name/);
  assert.match(inspectText("fixture.json", `Give ${suspiciousName} 64 torches`).join("\n"), /plaintext player name/);

  assert.ok(SYNTHETIC_PLAYER_NAMES.has("BlockKid42"));
  assert.deepEqual(inspectText("fixture.json", 'player: "BlockKid42"'), []);
  assert.deepEqual(inspectText("fixture.json", "Give RedstonePal 64 torches"), []);
});
