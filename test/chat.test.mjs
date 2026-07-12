import assert from "node:assert/strict";
import test from "node:test";
import { splitMessage } from "../bedrock/behavior_packs/mc_wizard/scripts/chat.js";

test("chunks Wizard chat only between complete sentences", () => {
  const answer = [
    "Cats are friendly mobs that can live in your house.",
    "To tame one, hold raw cod or raw salmon, approach slowly, and use the fish on the cat until hearts appear.",
    "Want me to help you find a village cat next?",
  ].join(" ");

  assert.deepEqual(splitMessage(answer, 120), [
    "Cats are friendly mobs that can live in your house.",
    "To tame one, hold raw cod or raw salmon, approach slowly, and use the fish on the cat until hearts appear.",
    "Want me to help you find a village cat next?",
  ]);
});

test("packs short sentences together and never invents a fragment", () => {
  const answer = "I love cats. Want to tame one? Tell me which cat you found, and I’ll help.";

  assert.deepEqual(splitMessage(answer, 36), [
    "I love cats. Want to tame one?",
    "Tell me which cat you found, and I’ll help.",
  ]);
  assert.deepEqual(splitMessage("  Hi!\n\nReady?  "), ["Hi! Ready?"]);
  assert.deepEqual(splitMessage(""), []);
});

test("keeps an unusually long single sentence whole", () => {
  const sentence = `A ${"very ".repeat(60)}long sentence.`;
  assert.deepEqual(splitMessage(sentence, 40), [sentence]);
});
