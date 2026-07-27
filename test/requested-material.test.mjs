import assert from "node:assert/strict";
import test from "node:test";

import { allowedWizardAction } from "../src/skills.mjs";
import { createWizard } from "../src/wizard.mjs";

const plan = (kind = "house") => ({
  title: `Giant ${kind}`,
  kind,
  dimensions: { width: 15, depth: 15, height: 10 },
  materials: {
    primary: "minecraft:oak_planks",
    accent: "minecraft:oak_log",
    roof: "minecraft:spruce_planks",
  },
  features: ["floor", "walls", "door", "windows", "roof", "lighting"],
  phases: ["foundation", "shell", "roof", "details"],
});

const response = (kind = "house") => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({
    answer: `I’ll build the giant ${kind} now.`,
    action: { type: "build_structure", version: 1, plan: plan(kind) },
    goal: {
      objective: `Build a giant ${kind}`,
      successCriteria: `A giant ${kind} stands nearby`,
      status: "active",
    },
  }) } }],
}), { status: 200 });

test("provider geometry is salvaged to the child's requested mushroom material", async () => {
  let calls = 0;
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      return response("house");
    },
  });
  const result = await wizard.ask({
    player: "MushroomKid",
    question: "build me a giant mushroom house",
  });
  assert.equal(calls, 1);
  assert.equal(result.action.plan.kind, "house");
  assert.equal(result.action.plan.materials.primary, "minecraft:red_mushroom_block");
  assert.equal(result.telemetry.rejections, undefined);
});

test("material salvage never rescues provider subject drift", async () => {
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => response("castle"),
  });
  const result = await wizard.ask({
    player: "SubjectKid",
    question: "build me a giant mushroom house",
  });
  assert.equal(result.action.plan.kind, "house");
  assert.equal(result.action.plan.materials.primary, "minecraft:red_mushroom_block");
  assert.ok(result.telemetry.rejections.some(({ gate }) => gate === "intent-match"));
});

test("offline fallbacks preserve several distinctive Bedrock materials", async () => {
  const cases = [
    ["amethyst", "minecraft:amethyst_block"],
    ["honey block", "minecraft:honey_block"],
    ["calcite", "minecraft:calcite"],
    ["mud", "minecraft:mud"],
  ];
  for (const [words, blockId] of cases) {
    const wizard = createWizard({ corpus: { search: () => [] }, env: {} });
    const result = await wizard.ask({
      player: `Material-${words}`,
      question: `build me a giant ${words} house`,
    });
    assert.equal(result.action.plan.materials.primary, blockId, words);
    assert.equal(result.action.plan.materials.accent, blockId, words);
    assert.equal(result.action.plan.materials.roof, blockId, words);
  }
});

test("malformed material identifiers still fail the action contract", () => {
  const bad = plan();
  bad.materials.primary = "minecraft:Bad!";
  assert.equal(allowedWizardAction({ type: "build_structure", version: 1, plan: bad }), null);
});
