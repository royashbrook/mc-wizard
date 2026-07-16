import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  await sessions.updateAction("FirstKid", "wizard", {
    requestId: first.requestId, status: "completed", detail: "verified in world",
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
    await recipes.promote({ question: "build furniture", action: furnitureAction, grade: 4 });
    const reloaded = await createFileLearnedRecipeStore({ filePath });
    assert.deepEqual((await reloaded.find("make me furniture")).action, furnitureAction);
    assert.equal(await reloaded.remove("create furniture"), true);
    assert.equal(await reloaded.find("build furniture"), null);
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
  assert.equal(await recipes.promote({ question: "build furniture", action: furnitureAction }), null);
  assert.equal(await recipes.promote({ question: "build furniture", action: privileged, grade: 5 }), null);
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
  assert.equal(reusableLearnedAction(result.action), true);
  assert.doesNotMatch(JSON.stringify(result.action), /server\.console|server\.configure|world\.command|op \{\{requester\}\}/);
});

test("the provider compiler repairs mechanical placement support and evidence", async () => {
  let calls = 0;
  const blocks = [0, 1].map((x) => ({
    itemId: "minecraft:oak_planks",
    target: [x, 0, 0],
    support: [9, 9, 9],
    expectedType: "minecraft:oak_planks",
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
});
