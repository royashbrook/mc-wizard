import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  primitiveStructureOperations,
  validateBuildStructurePlan,
} from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";
import { classifyAction, createWizard } from "../src/wizard.mjs";

const customPlan = {
  title: "Emerald Dragon",
  kind: "dragon statue",
  dimensions: { width: 12, depth: 8, height: 10 },
  materials: {
    primary: "minecraft:green_concrete",
    accent: "minecraft:lime_concrete",
    roof: "minecraft:stone",
  },
  features: ["supports"],
  phases: ["foundation", "shell", "roof", "details"],
  primitives: [
    { shape: "line", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 3], to: [11, 0, 3] },
    { shape: "box", phase: "shell", blockId: "minecraft:green_concrete", from: [4, 1, 0], to: [7, 5, 7] },
    { shape: "line", phase: "roof", blockId: "minecraft:lime_concrete", from: [5, 6, 3], to: [5, 9, 3] },
    { shape: "box", phase: "details", blockId: "minecraft:white_concrete", from: [5, 7, 2], to: [5, 7, 2] },
  ],
};

test("validates compact phased primitives inside the requested bounds", () => {
  const plan = validateBuildStructurePlan(customPlan);
  assert.equal(plan.primitives.length, 4);
  assert.deepEqual(primitiveStructureOperations(plan), plan.primitives.map(({ phase, blockId, from, to }) => ({
    phase, blockId, from, to,
  })));
  assert.throws(() => validateBuildStructurePlan({
    ...customPlan,
    primitives: customPlan.primitives.map((primitive, index) => (
      index === 3 ? { ...primitive, to: [12, 7, 2] } : primitive
    )),
  }), /outside the requested dimensions/);
  assert.throws(() => validateBuildStructurePlan({
    ...customPlan,
    primitives: [customPlan.primitives[0], customPlan.primitives[2], customPlan.primitives[1], customPlan.primitives[3]],
  }), /phase order/);
  assert.throws(() => validateBuildStructurePlan({
    ...customPlan,
    primitives: customPlan.primitives.map((primitive, index) => (
      index === 2 ? { ...primitive, shape: "line", from: [1, 2, 1], to: [3, 4, 1] } : primitive
    )),
  }), /axis-aligned/);
  assert.throws(() => validateBuildStructurePlan({
    ...customPlan,
    primitives: customPlan.primitives.map((primitive, index) => (
      index === 0 ? { ...primitive, from: [1, 0, 3], to: [10, 0, 3] } : primitive
    )),
  }), /bounds must match/);
});

test("asks the model for an unusual exact-size structure instead of making a generic box", async () => {
  assert.equal(classifyAction("Build a 12x8x10 dragon statue"), null);
  assert.equal(classifyAction("Build a 14x12 treehouse"), null);
  assert.equal(classifyAction("Build a statue of my cat"), null);
  let providerCalled = false;
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalled = true;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "Stand back—this emerald dragon will rise from its feet to its horns.",
        action: { type: "build_structure", version: 1, plan: customPlan },
      }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await wizard.ask({ player: "BuilderKid", question: "Build a 12x8x10 dragon statue" });
  assert.equal(providerCalled, true);
  assert.equal(result.mode, "chat:model");
  assert.equal(result.action.plan.kind, "dragon statue");
  assert.deepEqual(result.action.plan.dimensions, { width: 12, depth: 8, height: 10 });
  assert.equal(result.action.plan.primitives.length, 4);
  assert.doesNotMatch(result.answer, /house|generic|prototype|pad/i);
});

test("the structured response and Bedrock executor require and consume model primitives", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/wizard-response.schema.json", import.meta.url), "utf8"));
  const structureAction = schema.properties.action.anyOf.find((candidate) => (
    candidate.properties?.type?.const === "build_structure"
  ));
  assert.ok(structureAction.properties.plan.required.includes("primitives"));
  const pack = readFileSync(new URL("../bedrock/behavior_packs/mc_wizard/scripts/main.js", import.meta.url), "utf8");
  assert.match(pack, /plan\.primitives\?\.length \? primitiveStructureOperations\(plan\) : structureOperations\(plan\)/);
});

test("wires a bounded live scope that verifies an exact-size dragon in the world", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageJson.scripts["test:e2e:arbitrary"],
    "MC_WIZARD_E2E_SCOPE=arbitrary sh scripts/run-e2e-container.sh",
  );
  const runner = readFileSync(new URL("../scripts/run-e2e-container.sh", import.meta.url), "utf8");
  assert.match(runner, /E2E_SCOPE.*arbitrary/);
  assert.match(runner, /E2E_TIMEOUT_MS=300000/);
  const pack = readFileSync(new URL("../bedrock/behavior_packs/mc_wizard/scripts/e2e.js", import.meta.url), "utf8");
  assert.match(pack, /"build me a 20x10x12 dragon"/);
  assert.match(pack, /bounds=20x10x12/);
  assert.match(pack, /density < 0\.35/);
  assert.match(pack, /Boolean\(wingLayer\)/);
  assert.match(pack, /bodyDepth >= 8/);
  assert.match(pack, /Boolean\(head\)/);
});
