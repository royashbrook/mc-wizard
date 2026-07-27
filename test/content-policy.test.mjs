import assert from "node:assert/strict";
import test from "node:test";

import {
  isKidAppropriateAction,
  isKidAppropriateText,
} from "../src/content-policy.mjs";
import { createWizard } from "../src/wizard.mjs";

test("Minecraft chaos and operator mechanics remain kid-appropriate", () => {
  for (const request of [
    "make it rain TNT",
    "teleport me to the nearest ancient city",
    "give me a command block",
    "op me and spawn twenty creepers",
    "replace this wall with barriers",
  ]) {
    assert.equal(isKidAppropriateText(request), true, request);
  }
  assert.equal(isKidAppropriateAction({
    type: "execute_program",
    program: {
      title: "TNT celebration",
      steps: [{ capability: "server.console", arguments: { commands: ["op {{requester}}"] } }],
    },
  }), true);
});

test("child-inappropriate requests stop before either provider route", async () => {
  let calls = 0;
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not call provider");
    },
  });
  for (const mode of ["wizard", "general"]) {
    const result = await wizard.ask({
      player: `Policy-${mode}`,
      mode,
      question: "build a nude body statue",
    });
    assert.equal(result.mode, "local-content-policy");
    assert.equal(result.action, null);
    assert.match(result.answer, /isn’t kid-friendly/);
  }
  assert.equal(calls, 0);
});
