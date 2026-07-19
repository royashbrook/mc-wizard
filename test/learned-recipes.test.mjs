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
import { createMemoryPlayerPreferenceStore } from "../src/player-preferences.mjs";
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
  assert.match(researchPrompt, /cached, promoted Bedrock sources/i);
  assert.doesNotMatch(researchPrompt, /web research|video descriptions|transcripts/i);
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

test("a child-specific material note never promotes a shared learned recipe", async () => {
  const sessions = createMemorySessionStore();
  const recipes = createMemoryLearnedRecipeStore();
  const preferences = createMemoryPlayerPreferenceStore();
  await preferences.set("first-kid", {
    kind: "material", blockId: "minecraft:red_mushroom_block", label: "mushroom blocks", exclusive: true,
  });
  const wizard = createWizard({
    corpus: { search: () => [] }, sessions, recipes, preferences, logger: quiet,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      answer: "I’ll build the furniture now.",
      action: furnitureAction,
      goal: { objective: "Build furniture", successCriteria: "Furniture exists", status: "active" },
    }) } }] }), { status: 200 }),
  });
  const question = "please research and build furniture";
  const first = await wizard.ask({ player: "FirstKid", playerId: "first-kid", question, requestId: "private-furniture" });
  assert.deepEqual(sessions.get("bedrock:first-kid", "wizard")[0].preferenceDependencies, ["material"]);
  await wizard.recordActionResult({
    player: "FirstKid", playerId: "first-kid", requestId: first.requestId, status: "completed", detail: "verified in world",
    context: {
      dimension: "minecraft:overworld", buildState: "idle",
      lastStructure: {
        kind: first.action.plan.kind, title: first.action.plan.title, dimensions: first.action.plan.dimensions,
        materials: first.action.plan.materials, features: first.action.plan.features,
        primitives: first.action.plan.primitives, relativeOrigin: { x: 3, y: 0, z: 3 },
      },
    },
  });
  const feedback = await wizard.recordFeedback({
    player: "FirstKid", playerId: "first-kid", requestId: first.requestId, grade: 5,
  });
  assert.equal(feedback.learned, undefined);
  assert.equal(await recipes.find(question), null);
});

test("a low grade on a personalized learned recipe cannot delete the shared recipe", async () => {
  const sessions = createMemorySessionStore();
  const recipes = createMemoryLearnedRecipeStore();
  const preferences = createMemoryPlayerPreferenceStore();
  await recipes.promote({ question: "build furniture", action: furnitureAction, grade: 5, verified: true });
  await preferences.set("private-kid", {
    kind: "material", blockId: "minecraft:red_mushroom_block", label: "mushroom blocks", exclusive: true,
  });
  const wizard = createWizard({ corpus: { search: () => [] }, sessions, recipes, preferences, logger: quiet, env: {} });
  const result = await wizard.ask({
    player: "PrivateKid", playerId: "private-kid", question: "build furniture", requestId: "private-recipe",
  });
  assert.equal(result.mode, "learned-recipe");
  assert.deepEqual(sessions.get("bedrock:private-kid", "wizard")[0].preferenceDependencies, ["material"]);
  await sessions.updateAction("bedrock:private-kid", "wizard", {
    requestId: result.requestId, status: "completed", detail: "built with the child’s material note",
  });
  await wizard.recordFeedback({
    player: "PrivateKid", playerId: "private-kid", requestId: result.requestId, grade: 1,
  });
  assert.deepEqual((await recipes.find("build furniture")).action, furnitureAction);
});

test("a rejected learned recipe is removed and durable recipes survive reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-recipes-"));
  const filePath = join(directory, "recipes.json");
  try {
    const recipes = await createFileLearnedRecipeStore({ filePath });
    await recipes.promote({ question: "build furniture", action: furnitureAction, grade: 4, verified: true });
    // #35: file format bumped to version 3 (tier + success/failure counters).
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).version, 3);
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
  // #35: the procedural floor now answers "build furniture" with a complete
  // "Blocky furniture" plan, which may legitimately persist — but only as a
  // provisional recipe, never as a tested/verified one.
  const complete = await wizard.ask({ player: "StagedKid", question: "build furniture" });
  assert.doesNotMatch(complete.action.plan.title, /^(?:First pass|Progress \d+)\b/);
  await sessions.updateAction("StagedKid", "wizard", {
    requestId: complete.requestId, status: "completed", detail: "placed but never world-verified",
  });
  const completeFeedback = await wizard.recordFeedback({
    player: "StagedKid", requestId: complete.requestId, grade: 5,
  });
  assert.equal(completeFeedback.learned, true);
  const [provisional] = await recipes.list();
  assert.equal(provisional.tier, "provisional");
  assert.equal(provisional.successes, 0);
  // The original staged-progress intent, preserved with a build that still
  // stages offline: a graded first pass is never advertised or stored.
  const first = await wizard.ask({ player: "StagedFarmKid", question: "build a gold farm" });
  assert.match(first.action.plan.title, /^First pass\b/);
  await sessions.updateAction("StagedFarmKid", "wizard", {
    requestId: first.requestId, status: "completed", detail: "first pass placed",
  });
  const feedback = await wizard.recordFeedback({
    player: "StagedFarmKid", requestId: first.requestId, grade: 5,
  });
  assert.equal(feedback.learned, undefined);
  assert.doesNotMatch(feedback.message, /tested recipe/i);
  assert.equal((await recipes.list()).length, 1);
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
  // #35: the lineage still cannot lend its verification — but a completed grade-5
  // action now accrues as a provisional recipe instead of being dropped entirely.
  assert.equal(feedback.learned, true);
  const [entry] = await recipes.list();
  assert.equal(entry.tier, "provisional");
  assert.equal(entry.successes, 0);
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
  // #35: the smuggled program is still rejected verbatim at the research gate,
  // but the consultation gates now burn the two bounded repair rounds before
  // engaging the local fallback: one ask plus two repairs.
  assert.equal(calls, 3);
  assert.ok(result.action, "the rejected research plan must still make safe build progress");
  assert.equal(result.action.type, "build_structure");
  assert.ok(result.telemetry.rejections.some(({ gate, reason }) => (
    gate === "research-restriction"
    && reason === "web-researched build plans cannot contain server administration or arbitrary commands"
  )));
  assert.doesNotMatch(JSON.stringify(result.action), /server\.console|server\.configure|world\.command|op \{\{requester\}\}/);
});

test("findBest reuses a verified recipe for reworded and synonym questions", async () => {
  const recipes = createMemoryLearnedRecipeStore();
  await recipes.promote({ question: "build me a dog", action: furnitureAction, grade: 5, verified: true });
  const match = await recipes.findBest("make a puppy dog please");
  assert.ok(match, "reworded question must hit the learned recipe");
  assert.ok(match.similarity >= 0.8, `similarity ${match.similarity}`);
  assert.equal(match.exact, false);
  assert.equal(match.entry.tier, "verified");
  assert.deepEqual(match.entry.action, furnitureAction);
  const synonym = await recipes.findBest("could you make me a puppy");
  assert.ok(synonym && synonym.similarity >= 0.8, "synonym-only rewording must hit");
  const exact = await recipes.findBest("build me a dog");
  assert.equal(exact.exact, true);
  assert.equal(exact.similarity, 1);
});

test("findBest subject guard rejects unrelated and merely overlapping requests", async () => {
  const recipes = createMemoryLearnedRecipeStore();
  await recipes.promote({ question: "build me a dog", action: furnitureAction, grade: 5, verified: true });
  assert.equal(await recipes.findBest("build me a rocket"), null);
  await recipes.promote({ question: "build a red dragon", action: furnitureAction, grade: 5, verified: true });
  assert.equal(await recipes.findBest("build a red house"), null);
});

test("a completed but unverified grade-4 action persists provisionally and verifies on success", async () => {
  const recipes = createMemoryLearnedRecipeStore();
  const entry = await recipes.promote({ question: "build me a dog", action: furnitureAction, grade: 4, verified: false });
  assert.equal(entry.tier, "provisional");
  assert.equal(entry.successes, 0);
  assert.equal(entry.failures, 0);
  const outcome = await recipes.recordOutcome("build me a dog", { success: true });
  assert.equal(outcome.removed, false);
  assert.equal(outcome.entry.tier, "verified");
  assert.equal(outcome.entry.successes, 1);
  assert.equal((await recipes.findBest("build me a dog")).entry.tier, "verified");
});

test("success and failure counters replace binary recipe deletion", async () => {
  // #35: one failure no longer erases a proven recipe; removal needs failures >= successes + 2.
  const recipes = createMemoryLearnedRecipeStore();
  await recipes.promote({ question: "build me a dog", action: furnitureAction, grade: 5, verified: true });
  for (let i = 0; i < 9; i += 1) await recipes.recordOutcome("build me a dog", { success: true });
  const failure = await recipes.recordOutcome("build me a dog", { success: false });
  assert.equal(failure.removed, false);
  const survivor = await recipes.find("build me a dog");
  assert.equal(survivor.successes, 10);
  assert.equal(survivor.failures, 1);

  await recipes.promote({ question: "build a shaky boat", action: furnitureAction, grade: 4, verified: false });
  assert.equal((await recipes.recordOutcome("build a shaky boat", { success: false })).removed, false);
  assert.equal((await recipes.recordOutcome("build a shaky boat", { success: false })).removed, true);
  assert.equal(await recipes.find("build a shaky boat"), null);
  assert.equal(await recipes.recordOutcome("build a shaky boat", { success: false }), null);
});

test("a provisional recipe is never returned when a verified match exists", async () => {
  const recipes = createMemoryLearnedRecipeStore();
  await recipes.promote({ question: "build a big dog", action: furnitureAction, grade: 4, verified: false });
  await recipes.promote({ question: "build me a dog", action: furnitureAction, grade: 5, verified: true });
  const match = await recipes.findBest("make a big puppy");
  assert.equal(match.entry.tier, "verified");
  assert.equal(match.entry.key, "dog");
});

test("v2 recipe files migrate as verified entries with a single success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-v2-recipes-"));
  const filePath = join(directory, "recipes.json");
  try {
    await writeFile(filePath, JSON.stringify({ version: 2, recipes: [{
      key: "proved furniture", action: furnitureAction, grade: 5, verified: true, uses: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }] }));
    const recipes = await createFileLearnedRecipeStore({ filePath });
    const [entry] = await recipes.list();
    assert.equal(entry.tier, "verified");
    assert.equal(entry.successes, 1);
    assert.equal(entry.failures, 0);
    assert.equal(entry.uses, 2);
    assert.deepEqual((await recipes.find("proved furniture")).action, furnitureAction);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v3 recipe files round-trip tiers and counters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-v3-recipes-"));
  const filePath = join(directory, "recipes.json");
  try {
    const recipes = await createFileLearnedRecipeStore({ filePath });
    await recipes.promote({ question: "build me a dog", action: furnitureAction, grade: 5, verified: true });
    await recipes.promote({ question: "build a big cat", action: furnitureAction, grade: 4, verified: false });
    await recipes.recordOutcome("build me a dog", { success: true });
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).version, 3);
    const reloaded = await createFileLearnedRecipeStore({ filePath });
    const entries = await reloaded.list();
    const dog = entries.find((entry) => entry.key === "dog");
    assert.equal(dog.tier, "verified");
    assert.equal(dog.successes, 2);
    assert.equal(dog.failures, 0);
    const cat = entries.find((entry) => entry.key === "big cat");
    assert.equal(cat.tier, "provisional");
    assert.equal(cat.successes, 0);
    assert.equal(cat.failures, 0);
    assert.equal((await reloaded.findBest("make me a kitten")).entry.tier, "provisional");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
