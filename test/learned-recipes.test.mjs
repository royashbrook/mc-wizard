import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileLearnedRecipeStore,
  createMemoryLearnedRecipeStore,
  recipeKey,
  reusableLearnedAction,
} from "../src/learned-recipes.mjs";
import { createMemorySessionStore } from "../src/sessions.mjs";
import { createWizard } from "../src/wizard.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const furnitureAction = {
  type: "build_structure",
  version: 1,
  plan: {
    title: "Furniture Set",
    kind: "furniture",
    dimensions: { width: 12, depth: 8, height: 10 },
    materials: {
      primary: "minecraft:green_concrete",
      accent: "minecraft:lime_concrete",
      roof: "minecraft:stone",
    },
    features: ["decorations"],
    phases: ["foundation", "shell", "roof", "details"],
    primitives: [
      { shape: "line", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 3], to: [11, 0, 3] },
      { shape: "box", phase: "shell", blockId: "minecraft:green_concrete", from: [4, 1, 0], to: [7, 5, 7] },
      { shape: "line", phase: "roof", blockId: "minecraft:lime_concrete", from: [5, 6, 3], to: [5, 9, 3] },
      { shape: "box", phase: "details", blockId: "minecraft:white_concrete", from: [5, 7, 2], to: [5, 7, 2] },
    ],
  },
};

test("recipe keys ignore invocation wording but preserve meaningful requirements", () => {
  assert.equal(
    recipeKey("Wiz, please build me a furnished reading room"),
    recipeKey("create the furnished reading room"),
  );
  assert.notEqual(recipeKey("build a red reading room"), recipeKey("build a blue reading room"));
});

test("unfamiliar furniture is researched, graded, and reused without another model call", async () => {
  const sessions = createMemorySessionStore();
  const recipes = createMemoryLearnedRecipeStore();
  let calls = 0;
  let researchPrompt = "";
  const wizard = createWizard({
    corpus: { search: () => [] }, sessions, recipes, logger: quiet,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async (_url, options) => {
      calls += 1;
      researchPrompt = JSON.parse(options.body).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "I found a sturdy Bedrock design. I’ll build the reading room and its furniture now.",
        action: furnitureAction,
        goal: { objective: "Build a furnished reading room", successCriteria: "A furnished reading room exists", status: "active" },
      }) } }] }), { status: 200 });
    },
  });

  const question = "Wiz, please research and build me furniture";
  const first = await wizard.ask({ player: "FirstKid", question, requestId: "furniture-first" });
  assert.equal(calls, 1, first.mode);
  assert.match(researchPrompt, /MC_WIZARD_RESEARCH_REQUIRED/);
  assert.match(researchPrompt, /video descriptions or transcripts/);
  assert.match(researchPrompt, /furniture and other compact decorative assemblies/);
  assert.equal(first.action.plan.kind, "furniture");
  await wizard.recordActionResult({
    player: "FirstKid", requestId: first.requestId, status: "completed", detail: "verified in world",
    context: {
      dimension: "minecraft:overworld",
      buildState: "idle",
      lastStructure: {
        kind: first.action.plan.kind,
        title: first.action.plan.title,
        dimensions: first.action.plan.dimensions,
        materials: first.action.plan.materials,
        features: first.action.plan.features,
        primitives: first.action.plan.primitives,
        relativeOrigin: { x: 3, y: 0, z: 3 },
      },
    },
  });
  const feedback = await wizard.recordFeedback({
    player: "FirstKid", requestId: first.requestId, grade: 5,
  });
  assert.equal(feedback.learned, true);
  assert.match(feedback.message, /tested recipe/i);

  const second = await wizard.ask({
    player: "SecondKid", question: "create furniture", requestId: "furniture-second",
  });
  assert.equal(calls, 1);
  assert.equal(second.mode, "learned-recipe");
  assert.deepEqual(second.action, first.action);
});

test("a rejected learned recipe is removed and durable recipes survive reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-recipes-"));
  const filePath = join(directory, "recipes.json");
  try {
    const recipes = await createFileLearnedRecipeStore({ filePath });
    await recipes.promote({ question: "build furniture", action: furnitureAction, grade: 4, verified: true });
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).version, 2);
    assert.equal(Object.hasOwn((await recipes.list())[0], "question"), false);
    const reloaded = await createFileLearnedRecipeStore({ filePath });
    assert.deepEqual((await reloaded.find("make me furniture")).action, furnitureAction);
    assert.equal(await reloaded.remove("create furniture"), true);
    assert.equal(await reloaded.find("build furniture"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy recipe files retain proved entries but invalidate recipes without verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-legacy-recipes-"));
  const filePath = join(directory, "recipes.json");
  try {
    await writeFile(filePath, JSON.stringify({ version: 1, recipes: [{
      key: "unsafe old furniture", action: furnitureAction, grade: 5,
    }, {
      key: "proved old furniture", action: furnitureAction, grade: 5, verified: true,
    }] }));
    const recipes = await createFileLearnedRecipeStore({ filePath });
    assert.equal(await recipes.find("unsafe old furniture"), null);
    assert.deepEqual((await recipes.find("proved old furniture")).action, furnitureAction);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("staged progress is never advertised or stored as a tested recipe", async () => {
  const sessions = createMemorySessionStore();
  const recipes = createMemoryLearnedRecipeStore();
  const wizard = createWizard({ corpus: { search: () => [] }, sessions, recipes, logger: quiet, env: {} });
  const first = await wizard.ask({ player: "StagedKid", question: "build furniture" });
  assert.match(first.action.plan.title, /^First pass\b/);
  await sessions.updateAction("StagedKid", "wizard", {
    requestId: first.requestId, status: "completed", detail: "first pass placed",
  });
  const feedback = await wizard.recordFeedback({
    player: "StagedKid", requestId: first.requestId, grade: 5,
  });
  assert.equal(feedback.learned, undefined);
  assert.doesNotMatch(feedback.message, /tested recipe/i);
  assert.deepEqual(await recipes.list(), []);
  const stagedMachine = { type: "build_machine", version: 1, plan: {
    title: "First pass furniture", kind: "furniture",
    placements: [{ itemId: "minecraft:stone", target: [0, 0, 0], support: [0, -1, 0], orientationTarget: null }],
    interactions: [],
  } };
  assert.equal(reusableLearnedAction(stagedMachine), false);
  assert.equal(await recipes.promote({ question: "build furniture", action: stagedMachine, grade: 5, verified: true }), null);
  const trivialMachine = { ...stagedMachine, plan: { ...stagedMachine.plan, title: "Furniture" } };
  assert.equal(reusableLearnedAction(trivialMachine), false);
  assert.equal(await recipes.promote({ question: "build working furniture", action: trivialMachine, grade: 5, verified: true }), null);
});

test("a grade cannot borrow an older completion from the same goal lineage", async () => {
  const sessions = createMemorySessionStore();
  const recipes = createMemoryLearnedRecipeStore();
  const player = "LineageKid";
  await sessions.set(player, "wizard", [{
    question: "Review the old furniture attempt",
    answer: "The old attempt passed.",
    action: null,
    goal: { objective: "Build furniture", successCriteria: "Furniture exists", status: "complete" },
    goalId: "furniture-goal",
    requestId: "old-review",
    requestSequence: 1,
  }, {
    question: "replace it with better furniture",
    answer: "I built a new attempt.",
    action: furnitureAction,
    goal: { objective: "Improve furniture", successCriteria: "Better furniture exists", status: "active" },
    goalId: "furniture-goal",
    requestId: "new-attempt",
    requestSequence: 2,
    status: "completed",
  }]);
  const wizard = createWizard({ corpus: { search: () => [] }, sessions, recipes, logger: quiet, env: {} });

  const feedback = await wizard.recordFeedback({ player, requestId: "new-attempt", grade: 5 });
  assert.equal(feedback.learned, undefined);
  assert.deepEqual(await recipes.list(), []);
});

test("durable recipe writes serialize concurrent promotions without losing entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-recipe-writes-"));
  try {
    const recipes = await createFileLearnedRecipeStore({ filePath: join(directory, "recipes.json") });
    await Promise.all([
      recipes.promote({ question: "build red furniture", action: furnitureAction, grade: 4, verified: true }),
      recipes.promote({ question: "build blue furniture", action: furnitureAction, grade: 5, verified: true }),
    ]);
    const reloaded = await createFileLearnedRecipeStore({ filePath: join(directory, "recipes.json") });
    assert.equal((await reloaded.list()).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("learned recipes require a real grade and never persist privileged programs", async () => {
  const recipes = createMemoryLearnedRecipeStore();
  const privileged = { type: "execute_program", version: 1, program: {
    title: "Grant operator",
    steps: [{ id: "op", capability: "server.console", arguments: { commands: ["op {{requester}}"] }, expect: "Requester is an operator" }],
  } };
  assert.equal(reusableLearnedAction(furnitureAction), true);
  assert.equal(reusableLearnedAction(privileged), false);
  assert.equal(await recipes.promote({ question: "build furniture", action: furnitureAction, verified: true }), null);
  assert.equal(await recipes.promote({ question: "build furniture", action: privileged, grade: 5, verified: true }), null);
  assert.deepEqual(await recipes.list(), []);
});

test("an unfamiliar build retries one malformed provider transport before making staged progress", async () => {
  let calls = 0;
  const wizard = createWizard({
    corpus: { search: () => [] }, logger: quiet,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "goal_json was not valid serialized JSON" }), { status: 502 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "I researched the furniture and I’m building it now.",
        action: furnitureAction,
        goal: { objective: "Build furniture", successCriteria: "Furniture exists", status: "active" },
      }) } }] }), { status: 200 });
    },
  });
  const result = await wizard.ask({ player: "RetryKid", question: "build furniture" });
  assert.equal(calls, 2);
  assert.equal(result.mode, "chat:model");
  assert.equal(result.action.plan.kind, "furniture");
});

test("an unfamiliar build retries an empty successful provider response", async () => {
  let calls = 0;
  const wizard = createWizard({
    corpus: { search: () => [] }, logger: quiet,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: calls === 1 ? [] : [{ message: { content: JSON.stringify({
        answer: "I found a Bedrock design and I’m building it now.",
        action: furnitureAction,
        goal: { objective: "Build furniture", successCriteria: "Furniture exists", status: "active" },
      }) } }] }), { status: 200 });
    },
  });
  const result = await wizard.ask({ player: "EmptyRetryKid", question: "build furniture" });
  assert.equal(calls, 2);
  assert.equal(result.action.plan.kind, "furniture");
});

test("web-researched build plans cannot smuggle server administration", async () => {
  let calls = 0;
  const privileged = { type: "execute_program", version: 1, program: {
    title: "Furniture and operator",
    steps: [{ id: "op", capability: "server.console", arguments: { commands: ["op {{requester}}"] }, expect: "Furniture research grants operator" }],
  } };
  const wizard = createWizard({
    corpus: { search: () => [] }, logger: quiet,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "I’ll build the furniture now.", action: privileged,
        goal: { objective: "Build furniture", successCriteria: "Furniture exists", status: "active" },
      }) } }] }), { status: 200 });
    },
  });
  const result = await wizard.ask({ player: "ResearchSafetyKid", question: "research and build furniture" });
  assert.equal(calls, 2);
  assert.ok(result.action, "the rejected research plan must still make safe build progress");
  assert.equal(reusableLearnedAction(result.action), false);
  assert.doesNotMatch(JSON.stringify(result.action), /server\.console|server\.configure|world\.command|op \{\{requester\}\}/);
});

test("the provider compiler repairs mechanical placement support and evidence", async () => {
  let calls = 0;
  const blocks = [0, 1].map((x) => ({
    itemId: "minecraft:oak_planks",
    target: [x, 0, 0],
    support: [9, 9, 9],
    expectedType: "minecraft:oak_planks",
    expectedStates: { "minecraft:cardinal_direction": "north" },
  }));
  const wizard = createWizard({
    corpus: { search: () => [] }, logger: quiet,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "I researched the furniture and I’m building it now.",
        action: { type: "execute_program", version: 1, program: {
          title: "Furniture set",
          steps: [{
            id: "place_furniture", capability: "player.place-blocks", arguments: { blocks },
            expect: "The furniture is placed.",
          }],
        } },
        goal: { objective: "Build furniture", successCriteria: "Furniture exists", status: "active" },
      }) } }] }), { status: 200 });
    },
  });
  const result = await wizard.ask({ player: "CompilerKid", question: "build furniture" });
  assert.equal(calls, 1);
  assert.equal(result.action.type, "execute_program");
  assert.deepEqual(result.action.program.steps[0].arguments.blocks.map(({ support }) => support), [
    [0, -1, 0], [1, -1, 0],
  ]);
  assert.equal(result.action.program.steps.at(-1).capability, "verify.blocks");
  assert.deepEqual(result.action.program.steps.at(-1).arguments.blocks[0].expectedStates, {
    "minecraft:cardinal_direction": "north",
  });
});
