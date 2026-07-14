import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemorySessionStore } from "../src/sessions.mjs";
import { classifyAction, createWizard } from "../src/wizard.mjs";
import { validateBuildStructurePlan } from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";

const corpus = { search: () => [] };

function cityPlan({ mode, height = 18 } = {}) {
  return {
    title: mode ? "NYC City Revision" : "Small NYC City",
    kind: "city",
    ...(mode ? { mode: "modify" } : {}),
    dimensions: { width: 31, depth: 31, height },
    materials: {
      primary: "minecraft:stone_bricks",
      accent: "minecraft:gray_concrete",
      roof: "minecraft:deepslate_bricks",
    },
    features: ["floor", "walls", "door", "windows", "roof", "lighting", "towers"],
    phases: ["foundation", "shell", "roof", "details"],
    primitives: [
      { shape: "box", phase: "foundation", blockId: "minecraft:stone_bricks", from: [0, 0, 14], to: [30, 0, 16] },
      { shape: "box", phase: "foundation", blockId: "minecraft:stone_bricks", from: [14, 0, 0], to: [16, 0, 30] },
      { shape: "hollow_box", phase: "shell", blockId: "minecraft:gray_concrete", from: [2, 1, 2], to: [13, 10, 13] },
      { shape: "hollow_box", phase: "shell", blockId: "minecraft:gray_concrete", from: [17, 1, 2], to: [28, height - 2, 13] },
      { shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks", from: [2, 1, 17], to: [13, 13, 28] },
      { shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks", from: [17, 1, 17], to: [28, 8, 28] },
      { shape: "box", phase: "roof", blockId: "minecraft:deepslate_bricks", from: [2, 11, 2], to: [13, 11, 13] },
      { shape: "box", phase: "roof", blockId: "minecraft:deepslate_bricks", from: [17, height - 1, 2], to: [28, height - 1, 13] },
      { shape: "box", phase: "details", blockId: "minecraft:air", from: [7, 2, 13], to: [7, 3, 13] },
      { shape: "box", phase: "details", blockId: "minecraft:air", from: [22, 2, 13], to: [22, 3, 13] },
      { shape: "box", phase: "details", blockId: "minecraft:air", from: [7, 2, 17], to: [7, 3, 17] },
      { shape: "box", phase: "details", blockId: "minecraft:air", from: [22, 2, 17], to: [22, 3, 17] },
      { shape: "line", phase: "details", blockId: "minecraft:glowstone", from: [15, 1, 0], to: [15, 1, 30] },
    ],
  };
}

const modelResponse = (answer, action, goal) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ answer, action, goal }) } }],
}), { status: 200 });

const liveContext = {
  dimension: "minecraft:overworld",
  weather: "clear",
  timeOfDay: 1_000,
  player: { x: 0, y: 70, z: 0 },
  buildState: "idle",
};

test("routes dimension travel as an immediate typed capability", () => {
  assert.deepEqual(classifyAction("Teleport us to the Nether"), {
    type: "dimension_travel", version: 1, destination: "nether",
  });
  for (const question of [
    "Do ghasts go to the Overworld?",
    "Can villagers move in the End?",
    "Bring me some Nether wart",
  ]) assert.equal(classifyAction(question), null, question);
  for (const [question, destination] of [
    ["Can we go to the Nether?", "nether"],
    ["Can I go to the End?", "the_end"],
    ["Let us go to the Nether", "nether"],
    ["Could we travel back to Overworld?", "overworld"],
    ["Tell me about cats, then take us to Nether", "nether"],
    ["Take us to Nether to see a piglin", "nether"],
    ["Do not build a portal; just teleport us to Nether", "nether"],
  ]) assert.equal(classifyAction(question)?.destination, destination, question);
  for (const question of [
    "How can we go to the Nether?",
    "Can an item go through a Nether portal?",
    "Can I get a Nether wart item?",
  ]) assert.equal(classifyAction(question), null, question);
  const portal = classifyAction("Build me a portal so I can go to the Nether");
  assert.equal(portal.type, "build_machine");
  assert.equal(portal.plan.kind, "nether portal");
  assert.equal(portal.plan.placements.length, 14);
});

test("compiles a planner-selected portal into the exact safe player-action contract", async () => {
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I’ll build and light the portal.", {
      type: "build_machine", version: 1, plan: {
        title: "Nether Portal", kind: "Nether portal",
        placements: [{
          itemId: "minecraft:obsidian", target: [0, 0, 0], support: [0, -1, 0], orientationTarget: null,
        }],
        interactions: [{
          itemId: "minecraft:flint_and_steel", target: [0, 0, 0], faceTarget: [1, 1, 0],
        }],
      },
    }, {
      objective: "Build and light a Nether portal",
      successCriteria: ["A complete obsidian frame exists", "Purple portal blocks are visible"],
      status: "active",
    }),
  });
  const result = await wizard.ask({ player: "PortalKid", question: "Build and light a Nether portal here" });
  assert.equal(result.action.type, "build_machine");
  assert.equal(result.action.plan.placements.length, 14);
  assert.deepEqual(result.action.plan.interactions[0], {
    action: "use_item_on_block", itemId: "minecraft:flint_and_steel",
    block: [1, 0, 0], faceTarget: [1, 1, 0],
  });
  assert.match(result.goal.successCriteria, /exact request/i);
});

test("keeps a child-owned city goal and revises that same project", async () => {
  const sessions = createMemorySessionStore();
  const requests = [];
  let call = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body).messages[1].content);
      call += 1;
      if (call === 1) {
        return modelResponse("I’ll build a small city with streets and a varied skyline.", {
            type: "build_structure", version: 1, plan: cityPlan(),
          }, {
            objective: "Build a small city inspired by New York City",
            successCriteria: "Several distinct buildings, connected streets, and a recognizable varied skyline exist nearby",
            status: "active",
          });
      }
      const modelRevision = cityPlan({ mode: true, height: 24 });
      modelRevision.dimensions.width = 29;
      modelRevision.dimensions.depth = 29;
      return modelResponse("I’ll revise this same city with taller towers and a stronger skyline.", {
        type: "build_structure", version: 1, plan: modelRevision,
      }, {
        objective: "Improve the existing city so it feels more like New York City",
        successCriteria: "The same site has streets, several buildings, and visibly taller varied towers",
        status: "active",
      });
    },
  });

  const first = await wizard.ask({ player: "CityKid", question: "Build a small city that reminds me of NYC" });
  assert.equal(first.action.plan.kind, "city");
  assert.equal(first.goal.status, "active");
  await wizard.recordActionResult({
    player: "CityKid", requestId: first.requestId, status: "completed", detail: "all planned blocks placed",
  });
  const revision = await wizard.ask({ player: "CityKid", question: "Make it more like NYC with taller towers" });
  assert.equal(revision.action.plan.mode, "modify");
  assert.equal(revision.action.plan.kind, "city");
  assert.deepEqual(revision.action.plan.dimensions, { width: 31, depth: 31, height: 24 });
  assert.match(requests[1], /Goal \(active\): Build a small city that reminds me of NYC/);
  assert.match(requests[1], /Completed action:/);
  await wizard.recordActionResult({
    player: "CityKid", requestId: revision.requestId, status: "completed", detail: "revised city verified",
  });

  const satisfied = await wizard.ask({ player: "CityKid", question: "Looks good!" });
  assert.equal(satisfied.action, null);
  assert.equal(satisfied.goal.status, "complete");
  assert.equal(call, 2);
});

test("compiles an incomplete city declaration into a complete executable city in one turn", async () => {
  const requests = [];
  let call = 0;
  const sessions = createMemorySessionStore();
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body).messages[1].content);
      call += 1;
      const plan = cityPlan();
      delete plan.primitives;
      delete plan.entities;
      return modelResponse(
        "I’ll build the city.",
        { type: "build_structure", version: 1, plan },
        {
          objective: "Build a small working city",
          successCriteria: "Several buildings and connected streets exist nearby",
          status: "active",
        },
      );
    },
  });

  const result = await wizard.ask({
    player: "RepairCityKid",
    question: "Build a 31x31x18 city with crossed streets, four buildings, lights, and exactly four villagers",
  });
  assert.equal(call, 1);
  assert.equal(result.action.type, "build_structure");
  assert.equal(result.action.plan.kind, "city");
  assert.deepEqual(result.action.plan.dimensions, { width: 31, depth: 31, height: 18 });
  assert.equal(result.action.plan.primitives.filter(({ shape }) => shape === "hollow_box").length, 4);
  assert.equal(result.action.plan.primitives.filter(({ blockId }) => blockId === "minecraft:air").length, 4);
  assert.ok(result.action.plan.primitives.filter(({ blockId }) => blockId === "minecraft:sea_lantern").length >= 4);
  assert.equal(result.action.plan.entities.filter(({ typeId }) => typeId === "minecraft:villager_v2").length, 4);

  await wizard.recordActionResult({
    player: "RepairCityKid", requestId: result.requestId, status: "completed", detail: "city verified",
  });
  const revisionQuestion = "Make this same city more like New York by adding two taller skyscrapers and at least four more streetlights";
  const revision = await wizard.ask({ player: "RepairCityKid", question: revisionQuestion });
  const originalTallest = Math.max(...result.action.plan.primitives
    .filter(({ shape }) => shape === "hollow_box")
    .map(({ from, to }) => to[1] - from[1] + 1));
  const taller = revision.action.plan.primitives
    .filter(({ shape }) => shape === "hollow_box")
    .filter(({ from, to }) => to[1] - from[1] + 1 > originalTallest).length;
  const countLights = (plan) => plan.primitives.filter(({ blockId }) => (
    /(?:sea_lantern|glowstone|shroomlight|froglight|light_block|torch)$/.test(blockId)
  )).length;
  assert.equal(call, 2);
  assert.equal(revision.action.plan.mode, "modify");
  assert.ok(taller >= 2);
  assert.ok(countLights(revision.action.plan) >= countLights(result.action.plan) + 4);
  assert.equal(revision.action.plan.entities.filter(({ typeId }) => typeId === "minecraft:villager_v2").length, 4);
  assert.doesNotThrow(() => validateBuildStructurePlan({ ...revision.action.plan, mode: undefined }));
  assert.match(revision.goal.successCriteria, /exactly four villagers/i);
  const turns = sessions.get("RepairCityKid", "wizard");
  assert.equal(turns[0].goalId, turns.at(-1).goalId);
});

test("replaces a model's compact one-room city with a complete default-size city", async () => {
  let calls = 0;
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      return modelResponse("I’ll build the city.", {
        type: "build_structure", version: 1, plan: {
          title: "Tiny City Room", kind: "city",
          dimensions: { width: 31, depth: 31, height: 18 },
          materials: {
            primary: "minecraft:stone_bricks",
            accent: "minecraft:brick_block",
            roof: "minecraft:deepslate_bricks",
          },
          features: ["floor", "walls", "roof", "lighting"],
          phases: ["foundation", "shell", "roof", "details"],
          primitives: [
            { shape: "box", phase: "foundation", blockId: "minecraft:stone_bricks", from: [0, 0, 0], to: [8, 0, 8] },
            { shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks", from: [0, 0, 0], to: [8, 4, 8] },
            { shape: "box", phase: "roof", blockId: "minecraft:deepslate_bricks", from: [0, 4, 0], to: [8, 4, 8] },
            { shape: "box", phase: "details", blockId: "minecraft:sea_lantern", from: [4, 1, 4], to: [4, 1, 4] },
          ],
        },
      }, {
        objective: "Build a city",
        successCriteria: "A complete city exists nearby",
        status: "active",
      });
    },
  });

  const result = await wizard.ask({ player: "CompactCityKid", question: "Build a city" });
  assert.equal(calls, 1);
  assert.deepEqual(result.action.plan.dimensions, { width: 31, depth: 31, height: 18 });
  assert.equal(result.action.plan.primitives.filter(({ shape }) => shape === "hollow_box").length, 4);
  assert.doesNotThrow(() => validateBuildStructurePlan(result.action.plan));
});

test("turns label-only city room, window, and furnishing feedback into real in-place geometry", async () => {
  const sessions = createMemorySessionStore();
  let call = 0;
  const initial = cityPlan();
  initial.entities = [
    [7, 2, 7], [22, 2, 7], [7, 2, 22], [22, 2, 22],
  ].map((location) => ({ typeId: "minecraft:villager_v2", location }));
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      call += 1;
      if (call === 1) {
        return modelResponse("I’ll build the complete city.", {
          type: "build_structure", version: 1, plan: initial,
        }, {
          objective: "Build a city with four villagers",
          successCriteria: "The city and exactly four villagers exist nearby",
          status: "active",
        });
      }
      return modelResponse("I’ll add rooms, windows, and furnishings to this city.", {
        type: "build_structure", version: 1, plan: {
          ...cityPlan({ mode: true }),
          features: [...initial.features, "rooms", "decorations"],
          primitives: [{
            shape: "box", phase: "details", blockId: "minecraft:sea_lantern",
            from: [15, 1, 15], to: [15, 1, 15],
          }],
        },
      }, {
        objective: "Improve the same city",
        successCriteria: "The city has rooms, glass windows, and furnishings",
        status: "active",
      });
    },
  });

  const first = await wizard.ask({
    player: "FeatureCityKid",
    question: "Build a 31x31x18 city with exactly four villagers",
  });
  await wizard.recordActionResult({
    player: "FeatureCityKid", requestId: first.requestId, status: "completed", detail: "city placed",
  });
  const revision = await wizard.ask({
    player: "FeatureCityKid",
    question: "Add rooms, windows, and furnishings to this city",
  });
  const plan = revision.action.plan;
  const buildings = plan.primitives.filter(({ shape }) => shape === "hollow_box");
  const inside = (entry, building) => entry.from[0] > building.from[0]
    && entry.to[0] < building.to[0]
    && entry.from[2] > building.from[2]
    && entry.to[2] < building.to[2]
    && entry.from[1] > building.from[1]
    && entry.to[1] < building.to[1];
  const details = plan.primitives.filter(({ phase }) => phase === "details");
  const roomWalls = details.filter((entry) => entry.blockId !== "minecraft:air"
    && entry.blockId !== "minecraft:glass"
    && entry.to[1] > entry.from[1]
    && buildings.some((building) => inside(entry, building)));
  const furnishings = details.filter((entry) => entry.blockId !== "minecraft:air"
    && entry.blockId !== "minecraft:glass"
    && entry.from[1] === entry.to[1]
    && buildings.some((building) => inside(entry, building)));
  assert.equal(call, 2);
  assert.equal(plan.mode, "modify");
  assert.ok(roomWalls.length >= 4);
  assert.ok(details.filter(({ blockId }) => blockId === "minecraft:glass").length >= 4);
  assert.ok(furnishings.length >= 4);
  assert.equal(plan.entities.filter(({ typeId }) => typeId === "minecraft:villager_v2").length, 4);
  assert.doesNotThrow(() => validateBuildStructurePlan({ ...plan, mode: undefined }));
  assert.equal(sessions.get("FeatureCityKid", "wizard")[0].goalId,
    sessions.get("FeatureCityKid", "wizard").at(-1).goalId);
});

test("normalizes common model structure aliases and phase ordering before validation", async () => {
  const plan = cityPlan();
  plan.materials.accent = "minecraft:bricks";
  plan.features = ["foundation", "walls", "roof", "lighting"];
  plan.primitives = plan.primitives.toReversed().map((primitive) => ({
    ...primitive,
    ...(primitive.blockId === "minecraft:brick_block" ? { blockId: "minecraft:bricks" } : {}),
    phase: primitive.phase === "shell" ? "walls" : primitive.phase,
    ...(primitive.phase === "roof" && primitive.from[0] === 17
      ? { blockId: "minecraft:deepslate_brick", to: [28, 18, 13] } : {}),
  }));
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I’ll build the complete city.", {
      type: "build_structure", version: 1, plan,
    }, {
      objective: "Build a city",
      successCriteria: "Several buildings and connected streets exist",
      status: "active",
    }),
  });
  const result = await wizard.ask({ player: "AliasCityKid", question: "Build a city" });
  assert.equal(result.action.plan.kind, "city");
  assert.deepEqual(result.action.plan.phases, ["foundation", "shell", "roof", "details"]);
  assert.equal(result.action.plan.features[0], "floor");
  assert.deepEqual([...new Set(result.action.plan.primitives.map(({ phase }) => phase))],
    ["foundation", "shell", "roof", "details"]);
  assert.equal(result.action.plan.materials.accent, "minecraft:brick_block");
  assert.ok(result.action.plan.primitives.every(({ blockId }) => blockId !== "minecraft:bricks"));
});

test("city compiler canonicalizes kind, fills partial dimensions, and replaces invalid materials", async () => {
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I’ll build the complete city.", {
      type: "build_structure", version: 1, plan: {
        title: "Kid City", kind: "City",
        dimensions: { width: 31 },
        materials: {
          primary: "minecraft:calcite", accent: "minecraft:calcite", roof: "minecraft:calcite",
        },
        features: ["streetlights"], phases: ["foundation", "shell", "roof", "details"],
      },
    }, {
      objective: "Build a city",
      successCriteria: "A complete city exists nearby",
      status: "active",
    }),
  });
  const result = await wizard.ask({
    player: "PartialCityKid",
    question: "Build a city 31 blocks wide with streetlights and exactly four villagers",
  });
  assert.equal(result.action.plan.kind, "city");
  assert.deepEqual(result.action.plan.dimensions, { width: 31, depth: 31, height: 18 });
  assert.ok(Object.values(result.action.plan.materials).every((blockId) => blockId !== "minecraft:calcite"));
  assert.equal(result.action.plan.entities.length, 4);
  assert.ok(result.action.plan.primitives.filter(({ blockId }) => blockId === "minecraft:sea_lantern").length >= 4);
});

test("fits non-exact model bounds and compiles exact requested city dimensions", async () => {
  const oversized = cityPlan();
  oversized.dimensions = { width: 40, depth: 40, height: 25 };
  const response = () => modelResponse("I’ll build the complete city inside its real footprint.", {
    type: "build_structure", version: 1, plan: oversized,
  }, {
    objective: "Build a city",
    successCriteria: "The streets and buildings are complete",
    status: "active",
  });
  const flexible = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => response(),
  });
  const fitted = await flexible.ask({ player: "FittedCityKid", question: "Build a small city" });
  assert.deepEqual(fitted.action.plan.dimensions, { width: 31, depth: 31, height: 18 });

  const exact = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => response(),
  });
  const compiled = await exact.ask({ player: "ExactCityKid", question: "Build a 40x40x25 city" });
  assert.deepEqual(compiled.action.plan.dimensions, { width: 40, depth: 40, height: 25 });
  assert.equal(compiled.action.plan.primitives.filter(({ shape }) => shape === "hollow_box").length, 4);
  assert.equal(compiled.goal.status, "active");
});

test("city resizing recompiles the whole project and vague resident feedback preserves every villager", () => {
  const initial = classifyAction("Build a 31x31x18 city with exactly four villagers");
  const history = [{
    question: "Build a 31x31x18 city with exactly four villagers",
    answer: "I built the city.",
    action: initial,
    goal: { objective: "Build a city", successCriteria: "Four villagers live there", status: "active" },
    goalId: "city-contract",
    requestId: "city-first",
    status: "completed",
  }];
  const resized = classifyAction("Make it 50x50x30 with taller skyscrapers", history);
  assert.deepEqual(resized.plan.dimensions, { width: 50, depth: 50, height: 30 });
  assert.equal(resized.plan.mode, "modify");
  assert.equal(resized.plan.primitives.filter(({ shape }) => shape === "hollow_box").length, 4);
  assert.equal(resized.plan.entities.length, 4);

  const residentUpgrade = classifyAction("Add four more streetlights for the villagers", history);
  assert.equal(residentUpgrade.plan.mode, "modify");
  assert.equal(residentUpgrade.plan.entities.length, 4);
});

test("explicit resident removal produces a valid zero-resident refinement", () => {
  const initial = classifyAction("Build a castle with four villagers");
  const removal = classifyAction("Remove all villagers from this castle", [{
    question: "Build a castle with four villagers",
    answer: "The castle is ready.",
    action: initial,
    goal: { objective: "Build a castle", successCriteria: "The castle is ready", status: "active" },
    goalId: "castle-residents",
    requestId: "castle-first",
    status: "completed",
  }]);
  assert.equal(removal.plan.mode, "modify");
  assert.equal(removal.plan.entities, undefined);
});

test("rejects a destructive whole-city air patch instead of pretending it is a park", async () => {
  const sessions = createMemorySessionStore();
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => {
      providerCalls += 1;
      return modelResponse("I’ll add the park in place.", {
        type: "build_structure", version: 1, plan: {
          title: "City Park", kind: "city", mode: "modify",
          dimensions: { width: 31, depth: 31, height: 18 },
          materials: {
            primary: "minecraft:stone_bricks", accent: "minecraft:brick_block", roof: "minecraft:deepslate_bricks",
          },
          features: ["floor", "walls", "door", "roof", "lighting", "walkway"],
          phases: ["foundation", "shell", "roof", "details"],
          primitives: [{
            shape: "box", phase: "details", blockId: "minecraft:air",
            from: [0, 0, 0], to: [30, 17, 30],
          }],
        },
      }, {
        objective: "Add a park to the existing city",
        successCriteria: "The existing city remains and has a park",
        status: "active",
      });
    },
  });
  const initial = await wizard.ask({ player: "ParkKid", question: "Build a city" });
  await wizard.recordActionResult({
    player: "ParkKid", requestId: initial.requestId, status: "completed", detail: "city verified",
  });
  const result = await wizard.ask({ player: "ParkKid", question: "Add a park to this city" });
  assert.equal(providerCalls, 3);
  assert.equal(result.action, null);
  assert.equal(result.goal.status, "active");
});

test("machine feedback invokes the planner and targets the active project", async () => {
  const sessions = createMemorySessionStore();
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalls += 1;
      return modelResponse("I’ll rebuild this same enclosure with a taller glass wall.", {
        type: "build_machine", version: 1, plan: {
          title: "Contained Chicken Farm", kind: "automatic chicken farm", mode: "modify",
          placements: providerCalls === 1 ? [
            { itemId: "minecraft:smooth_stone", target: [0, 0, 0], support: [0, -1, 0], orientationTarget: null },
            { itemId: "minecraft:glass", target: [0, 1, 0], support: [0, 0, 0], orientationTarget: null },
          ] : [[0, 0], [2, 0], [0, 2], [2, 2]].flatMap(([x, z]) => [
            { itemId: "minecraft:smooth_stone", target: [x, 0, z], support: [x, -1, z], orientationTarget: null },
            { itemId: "minecraft:glass", target: [x, 1, z], support: [x, 0, z], orientationTarget: null },
            { itemId: "minecraft:glass", target: [x, 2, z], support: [x, 1, z], orientationTarget: null },
          ]),
          interactions: [],
        },
      }, {
        objective: "Keep the chickens contained in the existing automatic chicken farm",
        successCriteria: "Chickens cannot walk out and eggs still reach the collection chest",
        status: "active",
      });
    },
  });

  const initial = await wizard.ask({ player: "FarmKid", question: "Build me an automatic chicken farm" });
  assert.equal(initial.action.id, "automated_chicken_farm");
  assert.equal(providerCalls, 0);
  await wizard.recordActionResult({
    player: "FarmKid", requestId: initial.requestId, status: "completed", detail: "blueprint placed",
  });
  const repair = await wizard.ask({
    player: "FarmKid", question: "It is too short and the chickens can walk out. Refine it.",
  });
  assert.equal(providerCalls, 2);
  assert.equal(repair.action.type, "build_machine");
  assert.equal(repair.action.plan.mode, "modify");
  assert.equal(repair.goal.objective, "Build me an automatic chicken farm");
  assert.match(repair.goal.successCriteria, /chickens can walk out/i);
});

test("rejects an unrelated replacement action for corrective feedback", async () => {
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => {
      providerCalls += 1;
      return modelResponse("I’ll replace it with a calculator.", {
        type: "place_blueprint", id: "binary_adder_2bit", version: 1,
      }, {
        objective: "Build a calculator instead",
        successCriteria: "A calculator exists",
        status: "active",
      });
    },
  });
  const first = await wizard.ask({ player: "CorrectionKid", question: "Build an automatic chicken farm" });
  await wizard.recordActionResult({
    player: "CorrectionKid", requestId: first.requestId, status: "completed", detail: "farm placed",
  });
  let correction;
  for (let planningAttempt = 0; planningAttempt < 3; planningAttempt += 1) {
    correction = await wizard.ask({
      player: "CorrectionKid", question: "The chicken farm is wrong. Fix it and keep working on that farm.",
    });
    assert.equal(correction.action, null);
    assert.equal(correction.mode, "planning-deferred");
    assert.notEqual(correction.goal?.objective, "Build a calculator instead");
  }
  assert.equal(providerCalls, 6);
  assert.match(correction.answer, /don’t have a safe executable change yet/i);
  assert.doesNotMatch(correction.answer, /automatic|retry|trying another|you do not need to ask/i);
});

test("the three-attempt planning loop repairs chicken containment before its terminal attempt", async () => {
  const sessions = createMemorySessionStore();
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => {
      providerCalls += 1;
      return modelResponse("I replaced the farm with a binary adder.", {
        type: "place_blueprint", id: "binary_adder_2bit", version: 1,
      }, {
        objective: "Build a binary adder",
        successCriteria: "The adder works",
        status: "active",
      });
    },
  });
  const first = await wizard.ask({ player: "ActionlessReviewKid", question: "Build an automatic chicken farm" });
  const goalId = sessions.get("ActionlessReviewKid", "wizard")[0].goalId;
  const completed = await wizard.recordActionResult({
    player: "ActionlessReviewKid",
    requestId: first.requestId,
    status: "completed",
    detail: "farm placed, but containment still needs checking",
    context: liveContext,
  });
  assert.equal(completed.review.action, null);
  assert.equal(completed.review.goal.status, "active");

  const attempts = [];
  for (let planningAttempt = 0; planningAttempt < 3; planningAttempt += 1) {
    const response = await wizard.ask({
      player: "ActionlessReviewKid", question: "The chickens walk out. Fix it.",
    });
    attempts.push(response);
    if (response.action) break;
  }

  const correction = attempts.at(-1);
  assert.equal(attempts.length, 1);
  assert.equal(providerCalls, 3);
  assert.equal(correction.action.type, "build_machine");
  assert.equal(correction.action.plan.mode, "modify");
  assert.equal(correction.action.plan.kind, "automatic chicken farm");
  assert.ok(correction.action.plan.placements.some(({ itemId, target }) => (
    itemId === "minecraft:glass" && target[0] === 0 && target[1] === 3 && target[2] === 2
  )));
  assert.match(correction.answer, /same chicken farm in place/i);
  assert.equal(correction.goal.objective, first.goal.objective);
  assert.equal(sessions.get("ActionlessReviewKid", "wizard").at(-1).goalId, goalId);
  assert.doesNotMatch(correction.answer, /replaced|binary adder/i);
});

test("rejected provider actions cannot leave false success prose behind", async () => {
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I teleported you to the Nether. You are there now.", {
      type: "dimension_travel", version: 1, destination: "nether",
    }, {
      objective: "Teleport the player",
      successCriteria: "The player is in the Nether",
      status: "active",
    }),
  });
  const result = await wizard.ask({ player: "CatKid", question: "Tell me about cats" });
  assert.equal(result.action, null);
  assert.equal(result.goal, undefined);
  assert.doesNotMatch(result.answer, /teleport|Nether|there now/i);
});

test("open-ended style wording never changes the requested action family", async () => {
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalls += 1;
      return modelResponse("Surprise: I built a calculator instead.", {
        type: "place_blueprint", id: "binary_adder_2bit", version: 1,
      }, {
        objective: "Build any surprise",
        successCriteria: "Something exists",
        status: "active",
      });
    },
  });
  const result = await wizard.ask({ player: "SurpriseKid", question: "Build me a castle, surprise me" });
  assert.equal(providerCalls, 2);
  assert.equal(result.action.type, "build_structure");
  assert.equal(result.action.plan.kind, "castle");
  assert.doesNotMatch(result.answer, /calculator/i);
});

test("keeps provider goal text from poisoning a child-owned project lineage", async () => {
  const question = "Build me a 9x9 house";
  const house = classifyAction(question);
  const firstTurn = {
    question, answer: "I’ll build the house.", action: house, status: "planned",
    goal: { objective: question, successCriteria: "The house matches the request.", status: "active" },
  };
  const chimney = classifyAction("Add a chimney", [firstTurn]);
  const responses = [
    modelResponse("I’ll build the house.", house, {
      objective: "Teleport everyone to the Nether",
      successCriteria: "Everyone is in the Nether",
      status: "active",
    }),
    modelResponse("I’ll add the chimney to this house.", chimney, {
      objective: "Destroy the house and build a dungeon",
      successCriteria: "A dungeon replaces the house",
      status: "active",
    }),
  ];
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => responses.shift(),
  });

  const initial = await wizard.ask({ player: "GoalPoisonKid", question });
  assert.equal(initial.goal.objective, question);
  assert.doesNotMatch(initial.goal.successCriteria, /Nether/i);
  const feedback = await wizard.ask({ player: "GoalPoisonKid", question: "Add a chimney" });
  assert.equal(feedback.action.plan.mode, "modify");
  assert.equal(feedback.goal.objective, question);
  assert.doesNotMatch(feedback.goal.successCriteria, /dungeon/i);
});

test("only declarative approval after a completed action closes a goal", async () => {
  const wizard = createWizard({ corpus, env: {} });
  const first = await wizard.ask({ player: "ApprovalKid", question: "Build an automatic chicken farm" });
  const pendingQuestion = await wizard.ask({ player: "ApprovalKid", question: "It works?" });
  assert.notEqual(pendingQuestion.goal?.status, "complete");
  await wizard.recordActionResult({
    player: "ApprovalKid", requestId: first.requestId, status: "completed", detail: "verified",
  });
  const statusQuestion = await wizard.ask({ player: "ApprovalKid", question: "Looks good?" });
  assert.notEqual(statusQuestion.goal?.status, "complete");
  const approval = await wizard.ask({ player: "ApprovalKid", question: "Looks good!" });
  assert.equal(approval.goal.status, "complete");
});

test("approval cannot close a newer active goal by borrowing an older completed action", async () => {
  const wizard = createWizard({ corpus, env: {} });
  const farm = await wizard.ask({ player: "LineageKid", question: "Build an automatic chicken farm" });
  await wizard.recordActionResult({
    player: "LineageKid", requestId: farm.requestId, status: "completed", detail: "farm verified",
  });
  const city = await wizard.ask({ player: "LineageKid", question: "Build a city" });
  assert.equal(city.goal.status, "active");
  const premature = await wizard.ask({ player: "LineageKid", question: "Looks good!" });
  assert.notEqual(premature.goal?.status, "complete");
});

test("uses semantic review when the fresh structure snapshot is not an exact plan match", async () => {
  const sessions = createMemorySessionStore();
  const requests = [];
  let call = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body).messages[1].content);
      call += 1;
      return call === 1
        ? modelResponse("I’ll build the city.", {
            type: "build_structure", version: 1, plan: cityPlan(),
          }, {
            objective: "Build a complete city",
            successCriteria: "Several buildings and connected streets are visible nearby",
            status: "active",
          })
        : modelResponse("The city passes its world-state check.", null, {
            objective: "Build a complete city",
            successCriteria: "Several buildings and connected streets are visible nearby",
            status: "complete",
          });
    },
  });
  const first = await wizard.ask({ player: "ReviewKid", question: "Build a city" });
  const outcome = await wizard.recordActionResult({
    player: "ReviewKid",
    requestId: first.requestId,
    status: "completed",
    detail: "all planned blocks were placed",
    context: {
      ...liveContext,
      lastStructure: {
        kind: "city", title: "Small City", dimensions: cityPlan().dimensions,
        materials: cityPlan().materials, features: cityPlan().features,
        relativeOrigin: { x: 5, y: 0, z: 5 },
      },
    },
  });
  assert.equal(call, 2);
  assert.equal(outcome.review.action, null);
  assert.equal(outcome.review.goal.status, "complete");
  assert.equal(outcome.replan, undefined);
  assert.match(requests[1], /fresh live-world snapshot/i);
  assert.match(requests[1], /"lastStructure":\{"kind":"city"/);
  const turns = sessions.get("ReviewKid", "wizard");
  assert.equal(turns[0].goalId, turns[1].goalId);
  assert.equal(turns[1].goal.status, "complete");

  const duplicate = await wizard.recordActionResult({
    player: "ReviewKid", requestId: first.requestId, status: "completed", context: liveContext,
  });
  assert.equal(duplicate.updated, false);
  assert.equal(duplicate.review, undefined);
  assert.equal(call, 2);
});

test("a fresh matching static-structure snapshot completes locally without an invented model repair", async () => {
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalls += 1;
      return modelResponse("I’ll build the city.", {
        type: "build_structure", version: 1, plan: cityPlan(),
      }, {
        objective: "Build a complete city",
        successCriteria: "The complete city exists nearby",
        status: "active",
      });
    },
  });
  const result = await wizard.ask({ player: "ObservedCityKid", question: "Build a city" });
  const plan = result.action.plan;
  const verifiedInhabitants = (plan.entities || []).reduce((counts, { typeId }) => ({
    ...counts, [typeId]: (counts[typeId] || 0) + 1,
  }), {});
  const outcome = await wizard.recordActionResult({
    player: "ObservedCityKid",
    requestId: result.requestId,
    status: "completed",
    detail: "verified all structure operations",
    context: {
      ...liveContext,
      buildState: "idle",
      lastStructure: {
        kind: plan.kind,
        title: plan.title,
        dimensions: plan.dimensions,
        materials: plan.materials,
        features: plan.features,
        primitives: plan.primitives,
        ...(plan.entities?.length ? { entities: plan.entities, verifiedInhabitants } : {}),
        relativeOrigin: { x: 5, y: 0, z: 5 },
      },
    },
  });
  assert.equal(outcome.review.goal.status, "complete");
  assert.equal(outcome.review.action, null);
  assert.equal(outcome.replan, undefined);
  assert.equal(providerCalls, 1);
});

test("a semantic review can continue only the same project with a corrective action", async () => {
  const sessions = createMemorySessionStore();
  let calls = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      return modelResponse("I’ll raise the walls on this same farm.", {
        type: "build_machine", version: 1, plan: {
          title: "Contained Chicken Farm", kind: "automatic chicken farm", mode: "modify",
          placements: [
            { itemId: "minecraft:smooth_stone", target: [0, 0, 0], support: [0, -1, 0], orientationTarget: null },
            { itemId: "minecraft:glass", target: [0, 1, 0], support: [0, 0, 0], orientationTarget: null },
          ],
          interactions: [],
        },
      }, {
        objective: "Build a working automatic chicken farm",
        successCriteria: "Chickens stay contained and eggs reach collection",
        status: "active",
      });
    },
  });
  const first = await wizard.ask({ player: "ReviewFarmKid", question: "Build an automatic chicken farm" });
  const outcome = await wizard.recordActionResult({
    player: "ReviewFarmKid", requestId: first.requestId, status: "completed",
    detail: "blueprint placed", context: liveContext,
  });
  assert.equal(calls, 1);
  assert.equal(outcome.replan.action.type, "build_machine");
  assert.equal(outcome.replan.action.plan.mode, "modify");
  const turns = sessions.get("ReviewFarmKid", "wizard");
  assert.equal(turns[0].goalId, turns[1].goalId);
});

test("rejects an unrelated semantic-review action and keeps the original goal active", async () => {
  const sessions = createMemorySessionStore();
  const wizard = createWizard({
    corpus,
    sessions,
    logger: { warn() {} },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I’ll build a calculator instead.", {
      type: "place_blueprint", id: "binary_adder_2bit", version: 1,
    }, {
      objective: "Build a calculator",
      successCriteria: "A calculator exists",
      status: "active",
    }),
  });
  const first = await wizard.ask({ player: "ReviewGuardKid", question: "Build an automatic chicken farm" });
  const outcome = await wizard.recordActionResult({
    player: "ReviewGuardKid", requestId: first.requestId, status: "completed", context: liveContext,
  });
  assert.equal(outcome.review.action, null);
  assert.equal(outcome.review.goal.status, "active");
  assert.equal(outcome.replan, undefined);
  assert.equal(sessions.get("ReviewGuardKid", "wizard").at(-1).goalId,
    sessions.get("ReviewGuardKid", "wizard")[0].goalId);
});

test("semantic review cannot drop the child's latest structure requirements", async () => {
  const player = "ReviewContractKid";
  const question = "add rooms, towers, second floor, decorations, and four villagers";
  const castle = classifyAction("Build me a 12x12 castle");
  const refinement = classifyAction(question, [{
    question: "Build me a 12x12 castle", answer: "Built.", action: castle, status: "completed",
  }]);
  const sessions = createMemorySessionStore();
  await sessions.set(player, "wizard", [{
    question,
    answer: "I’m adding every requested feature.",
    action: refinement,
    goal: {
      objective: question,
      successCriteria: "The same castle has every requested feature and exactly four villagers.",
      status: "active",
    },
    requestId: "contract-build",
    goalId: "contract-goal",
    status: "pending",
  }]);
  const missingVillagers = {
    ...refinement,
    plan: { ...refinement.plan, entities: undefined },
  };
  const wizard = createWizard({
    corpus,
    sessions,
    logger: { warn() {} },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I’ll make one more correction.", missingVillagers, {
      objective: "Tidy the castle",
      successCriteria: "One correction is placed",
      status: "active",
    }),
  });

  const outcome = await wizard.recordActionResult({
    player, requestId: "contract-build", status: "completed", context: liveContext,
  });
  assert.equal(outcome.review.action, null);
  assert.equal(outcome.replan, undefined);
  assert.equal(outcome.review.goal.status, "active");
  assert.match(outcome.review.goal.successCriteria, /exactly four villagers/i);
});

test("bounds automatic completion reviews without falsely completing the goal", async () => {
  let reviews = 0;
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      reviews += 1;
      const x = reviews - 1;
      return modelResponse(`I’ll make correction ${reviews}.`, {
        type: "build_machine", version: 1, plan: {
          title: `Chicken Farm Correction ${reviews}`, kind: "automatic chicken farm", mode: "modify",
          placements: [
            { itemId: "minecraft:smooth_stone", target: [x, 0, 0], support: [x, -1, 0], orientationTarget: null },
            { itemId: "minecraft:glass", target: [x, 1, 0], support: [x, 0, 0], orientationTarget: null },
          ],
          interactions: [],
        },
      }, {
        objective: "Build a working automatic chicken farm",
        successCriteria: "Chickens stay contained and eggs reach collection",
        status: "active",
      });
    },
  });
  let current = await wizard.ask({ player: "BoundReviewKid", question: "Build an automatic chicken farm" });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const outcome = await wizard.recordActionResult({
      player: "BoundReviewKid", requestId: current.requestId, status: "completed", context: liveContext,
    });
    assert.ok(outcome.replan?.action);
    current = outcome.replan;
  }
  const stopped = await wizard.recordActionResult({
    player: "BoundReviewKid", requestId: current.requestId, status: "completed", context: liveContext,
  });
  assert.equal(stopped.reviewLimitReached, true);
  assert.equal(stopped.review, undefined);
  assert.equal(reviews, 5);
});

test("keeps active-project feedback across chat but starts explicit new builds on a new goal", async () => {
  const castle = classifyAction("Build me a castle");
  const revision = classifyAction("Make the castle bigger", [{
    question: "Build me a castle", answer: "Building it.", action: castle,
    goal: { objective: "Build a castle", successCriteria: "A castle exists", status: "active" },
    goalId: "castle-goal", requestId: "castle-action", status: "completed",
  }]);
  const sessions = createMemorySessionStore();
  await sessions.set("FeedbackKid", "wizard", [
    {
      question: "Build me a castle", answer: "Building it.", action: castle,
      goal: { objective: "Build a castle", successCriteria: "A castle exists", status: "active" },
      goalId: "castle-goal", requestId: "castle-action", status: "completed",
    },
    { question: "What do you think of it?", answer: "It looks imposing.", action: null },
  ]);
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalls += 1;
      return modelResponse("I’ll enlarge this same castle.", revision, {
        objective: "Build a bigger castle",
        successCriteria: "The same castle is visibly larger",
        status: "active",
      });
    },
  });
  const refined = await wizard.ask({ player: "FeedbackKid", question: "Make it bigger" });
  assert.equal(refined.action.plan.mode, "modify");
  assert.equal(sessions.get("FeedbackKid", "wizard").at(-1).goalId, "castle-goal");

  await sessions.set("NewBuildKid", "wizard", sessions.get("FeedbackKid", "wizard").slice(0, 1));
  const newBuild = await wizard.ask({ player: "NewBuildKid", question: "Build a bigger chicken farm" });
  assert.equal(newBuild.action.id, "automated_chicken_farm");
  assert.notEqual(sessions.get("NewBuildKid", "wizard").at(-1).goalId, "castle-goal");
  assert.equal(providerCalls, 1);
});

test("a failed build automatically replans the active goal with a bounded retry", async () => {
  const sessions = createMemorySessionStore();
  let call = 0;
  const requests = [];
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body).messages[1].content);
      call += 1;
      return modelResponse(call === 1 ? "I’ll build the city." : "I saw the failed placement and revised the same city.", {
        type: "build_structure", version: 1,
        plan: cityPlan(call === 1 ? {} : { mode: true, height: 22 }),
      }, {
        objective: "Build a working city project",
        successCriteria: "Several buildings and connected streets are verified in the world",
        status: "active",
      });
    },
  });
  const first = await wizard.ask({ player: "RetryKid", question: "Build a city" });
  const outcome = await wizard.recordActionResult({
    player: "RetryKid", requestId: first.requestId, status: "failed", detail: "one tower could not be verified",
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.replan.action.plan.mode, "modify");
  assert.equal(call, 2);
  assert.match(requests[1], /Failed action: .*"primitives":\[/s);
  const duplicate = await wizard.recordActionResult({
    player: "RetryKid", requestId: first.requestId, status: "failed", detail: "duplicate report",
  });
  assert.equal(duplicate.updated, false);
  assert.equal(duplicate.replan, undefined);
  assert.equal(call, 2);
});

test("failed travel and fixed blueprints retry the exact child contract on the same goal", async () => {
  const sessions = createMemorySessionStore();
  const wizard = createWizard({ corpus, sessions, env: {} });
  for (const [player, question] of [
    ["TravelRetryKid", "Teleport us to the Nether"],
    ["BlueprintRetryKid", "Build an automatic chicken farm"],
  ]) {
    const first = await wizard.ask({ player, question });
    const outcome = await wizard.recordActionResult({
      player, requestId: first.requestId, status: "failed", detail: "temporary executor failure",
    });
    assert.deepEqual(outcome.replan.action, first.action);
    const turns = sessions.get(player, "wizard");
    assert.equal(turns.at(-1).question, question);
    assert.equal(turns.at(-1).goalId, turns[0].goalId);
  }
});

test("a failed arbitrary machine action replans to honest staged progress on the same goal", async () => {
  const sessions = createMemorySessionStore();
  const question = "Build a working automatic glow berry bottling machine";
  await sessions.set("DeferredRetryKid", "wizard", [{
    question,
    answer: "I’m starting the machine.",
    action: {
      type: "build_machine", version: 1, plan: {
        title: "Glow Berry Bottler", kind: "glow berry bottling machine",
        placements: [{
          itemId: "minecraft:smooth_stone", target: [0, 0, 0],
          support: [0, -1, 0], orientationTarget: null,
        }],
        interactions: [],
      },
    },
    goal: { objective: question, successCriteria: "The requested machine works.", status: "active" },
    goalId: "deferred-goal", requestId: "deferred-action", status: "pending",
  }]);
  const wizard = createWizard({ corpus, sessions, env: {} });
  const outcome = await wizard.recordActionResult({
    player: "DeferredRetryKid", requestId: "deferred-action", status: "failed", detail: "temporary placement failure",
  });
  assert.equal(outcome.retry, undefined);
  assert.equal(outcome.replan.action.type, "build_machine");
  assert.match(outcome.replan.action.plan.title, /^First pass\b/);
  assert.equal(outcome.replan.action.plan.kind, "glow berry bottling machine");
  assert.equal(sessions.get("DeferredRetryKid", "wizard").at(-1).goalId, "deferred-goal");
  assert.equal(outcome.retryLimitReached, undefined);
});

test("a first-pass structure stays active and requests continuation even when its snapshot matches", async () => {
  const sessions = createMemorySessionStore();
  const question = "Build me a 17x13x9 zorb pavilion";
  const wizard = createWizard({ corpus, sessions, env: {} });
  const first = await wizard.ask({ player: "StageKid", question });
  assert.equal(first.action.type, "build_structure");
  assert.match(first.action.plan.title, /^First pass\b/);
  assert.deepEqual(first.action.plan.dimensions, { width: 17, depth: 13, height: 9 });
  assert.equal(first.goal.status, "active");
  const plan = first.action.plan;
  const outcome = await wizard.recordActionResult({
    player: "StageKid", requestId: first.requestId, status: "completed", detail: "all guide markers placed",
    context: {
      ...liveContext,
      lastStructure: {
        kind: plan.kind, title: plan.title, dimensions: plan.dimensions,
        materials: plan.materials, features: plan.features, primitives: plan.primitives,
        relativeOrigin: { x: 5, y: 0, z: 5 },
      },
    },
  });
  assert.notEqual(outcome.review.goal.status, "complete");
  assert.equal(outcome.replan, undefined);
  assert.deepEqual(outcome.retry, {
    question,
    reason: "staged-progress",
    goalId: sessions.get("StageKid", "wizard")[0].goalId,
  });
  assert.equal(sessions.get("StageKid", "wizard").at(-1).goalId,
    sessions.get("StageKid", "wizard")[0].goalId);
});

test("persistent offline structure retries make cumulative same-site progress through the review limit", async () => {
  const sessions = createMemorySessionStore();
  const question = "Build me a 17x13x9 zorb pavilion";
  const wizard = createWizard({
    corpus,
    sessions,
    logger: { warn() {} },
    env: { AI_BASE_URL: "http://offline-model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => { throw new Error("provider remains offline"); },
  });
  let current = await wizard.ask({ player: "OfflineStructureKid", question });
  const plans = [current.action.plan];
  const goalId = sessions.get("OfflineStructureKid", "wizard").at(-1).goalId;

  assert.match(current.action.plan.title, /^First pass\b/);
  assert.deepEqual(current.action.plan.dimensions, { width: 17, depth: 13, height: 9 });
  assert.equal(validateBuildStructurePlan(current.action.plan).kind, "zorb pavilion");

  for (let progress = 2; progress <= 6; progress += 1) {
    const outcome = await wizard.recordActionResult({
      player: "OfflineStructureKid",
      requestId: current.requestId,
      status: "completed",
      detail: `structure pass ${progress - 1} placed`,
      context: liveContext,
    });
    assert.deepEqual(outcome.retry, { question, reason: "staged-progress", goalId });
    current = await wizard.ask({
      player: "OfflineStructureKid",
      question: outcome.retry.question,
      goalRetry: { goalId: outcome.retry.goalId },
    });

    const previous = plans.at(-1);
    const primitives = new Set(current.action.plan.primitives.map((primitive) => JSON.stringify(primitive)));
    assert.equal(current.action.type, "build_structure");
    assert.equal(current.action.plan.mode, "modify");
    assert.match(current.action.plan.title, new RegExp(`^Progress ${progress}\\b`));
    assert.equal(current.action.plan.kind, plans[0].kind);
    assert.deepEqual(current.action.plan.dimensions, plans[0].dimensions);
    assert.deepEqual(current.action.plan.materials, plans[0].materials);
    assert.ok(previous.primitives.every((primitive) => primitives.has(JSON.stringify(primitive))));
    assert.notDeepEqual(current.action.plan, previous);
    assert.equal(validateBuildStructurePlan(current.action.plan).kind, "zorb pavilion");
    assert.equal(current.mode, "local-build-progress");
    assert.equal(current.goal.status, "active");
    assert.match(current.answer, /another structural pass, not the finished shape/i);
    assert.equal(sessions.get("OfflineStructureKid", "wizard").at(-1).goalId, goalId);
    plans.push(current.action.plan);
  }

  assert.equal(new Set(plans.map((plan) => JSON.stringify(plan))).size, 6);
  const stopped = await wizard.recordActionResult({
    player: "OfflineStructureKid",
    requestId: current.requestId,
    status: "completed",
    detail: "structure pass 6 placed",
    context: liveContext,
  });
  assert.equal(stopped.reviewLimitReached, true);
  assert.equal(stopped.retry, undefined);
});

test("a staged structure review advances to a full same-site modify action on the same goal", async () => {
  const sessions = createMemorySessionStore();
  const question = "Build me a 17x13x9 zorb pavilion";
  const fullPlan = {
    title: "Complete Zorb Pavilion", kind: "zorb pavilion",
    dimensions: { width: 17, depth: 13, height: 9 },
    materials: {
      primary: "minecraft:purple_concrete",
      accent: "minecraft:light_blue_concrete",
      roof: "minecraft:white_concrete",
    },
    features: ["supports"], phases: ["foundation", "shell", "roof", "details"],
    primitives: [
      { shape: "box", phase: "foundation", blockId: "minecraft:purple_concrete", from: [0, 0, 0], to: [16, 0, 12] },
      { shape: "box", phase: "shell", blockId: "minecraft:purple_concrete", from: [4, 1, 0], to: [12, 6, 12] },
      { shape: "box", phase: "roof", blockId: "minecraft:white_concrete", from: [3, 7, 2], to: [13, 8, 10] },
      { shape: "box", phase: "details", blockId: "minecraft:light_blue_concrete", from: [0, 3, 5], to: [16, 4, 7] },
    ],
  };
  let calls = 0;
  const wizard = createWizard({
    corpus, sessions, logger: { warn() {} },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary provider outage");
      return modelResponse("I’ve finished the complete pavilion on this same marked site.", {
        type: "build_structure", version: 1, plan: fullPlan,
      }, {
        objective: question,
        successCriteria: "The complete pavilion fills the marked dimensions",
        status: "active",
      });
    },
  });
  const first = await wizard.ask({ player: "StageReviewKid", question });
  assert.match(first.action.plan.title, /^First pass\b/);
  const plan = first.action.plan;
  const outcome = await wizard.recordActionResult({
    player: "StageReviewKid", requestId: first.requestId, status: "completed", detail: "guide verified",
    context: {
      ...liveContext,
      lastStructure: {
        kind: plan.kind, title: plan.title, dimensions: plan.dimensions,
        materials: plan.materials, features: plan.features, primitives: plan.primitives,
        relativeOrigin: { x: 5, y: 0, z: 5 },
      },
    },
  });
  assert.equal(outcome.replan.action.type, "build_structure");
  assert.equal(outcome.replan.action.plan.mode, "modify");
  assert.equal(outcome.replan.action.plan.kind, first.action.plan.kind);
  assert.doesNotMatch(outcome.replan.action.plan.title, /^First pass\b/);
  const turns = sessions.get("StageReviewKid", "wizard");
  assert.equal(turns.at(-1).goalId, turns[0].goalId);
});

test("an offline arbitrary functional machine starts honest grounded progress", async () => {
  const wizard = createWizard({ corpus, env: {} });
  const result = await wizard.ask({
    player: "SafeMachineKid", question: "Build a working automatic glow berry bottling machine",
  });
  assert.equal(result.action.type, "build_machine");
  assert.match(result.action.plan.title, /^First pass\b/);
  assert.equal(result.action.plan.kind, "glow berry bottling machine");
  assert.equal(result.action.plan.placements.length, 7);
  assert.equal(result.action.plan.interactions.length, 0);
  assert.equal(result.mode, "local-build-progress");
  assert.match(result.answer, /not a working machine yet/i);
  assert.equal(result.goal.status, "active");
});

test("persistent offline machine retries make cumulative same-site progress through the review limit", async () => {
  const sessions = createMemorySessionStore();
  const question = "Build a working automatic glow berry bottling machine";
  const wizard = createWizard({
    corpus,
    sessions,
    logger: { warn() {} },
    env: { AI_BASE_URL: "http://offline-model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => { throw new Error("provider remains offline"); },
  });
  let current = await wizard.ask({ player: "OfflineMachineKid", question });
  const plans = [current.action.plan];
  const goalId = sessions.get("OfflineMachineKid", "wizard").at(-1).goalId;

  for (let progress = 2; progress <= 6; progress += 1) {
    const outcome = await wizard.recordActionResult({
      player: "OfflineMachineKid",
      requestId: current.requestId,
      status: "completed",
      detail: `engineering pass ${progress - 1} placed`,
      context: liveContext,
    });
    assert.deepEqual(outcome.retry, { question, reason: "staged-progress", goalId });
    current = await wizard.ask({
      player: "OfflineMachineKid",
      question: outcome.retry.question,
      goalRetry: { goalId: outcome.retry.goalId },
    });

    const previous = plans.at(-1);
    const placements = new Set(current.action.plan.placements.map((placement) => JSON.stringify(placement)));
    assert.equal(current.action.type, "build_machine");
    assert.equal(current.action.plan.mode, "modify");
    assert.match(current.action.plan.title, new RegExp(`^Progress ${progress}\\b`));
    assert.equal(current.action.plan.kind, plans[0].kind);
    assert.ok(previous.placements.every((placement) => placements.has(JSON.stringify(placement))));
    assert.notDeepEqual(current.action.plan, previous);
    assert.equal(current.mode, "local-build-progress");
    assert.equal(current.goal.status, "active");
    assert.match(current.answer, /another engineering pass, not a finished working machine/i);
    assert.equal(sessions.get("OfflineMachineKid", "wizard").at(-1).goalId, goalId);
    plans.push(current.action.plan);
  }

  assert.equal(new Set(plans.map((plan) => JSON.stringify(plan))).size, 6);
  const stopped = await wizard.recordActionResult({
    player: "OfflineMachineKid",
    requestId: current.requestId,
    status: "completed",
    detail: "engineering pass 6 placed",
    context: liveContext,
  });
  assert.equal(stopped.reviewLimitReached, true);
  assert.equal(stopped.retry, undefined);
});

test("a staged machine advances on the same goal and site to a full modify plan", async () => {
  const sessions = createMemorySessionStore();
  const question = "Build a working automatic glow berry bottling machine";
  let calls = 0;
  const fullAction = {
    type: "build_machine", version: 1, plan: {
      title: "Complete Glow Berry Bottler", kind: "glow berry bottling machine",
      placements: [
        ...Array.from({ length: 5 }, (_, x) => ({
          itemId: "minecraft:smooth_stone", target: [x, 0, 0], support: [x, -1, 0], orientationTarget: null,
        })),
        { itemId: "minecraft:chest", target: [0, 1, 0], support: [0, 0, 0], orientationTarget: null },
        { itemId: "minecraft:hopper", target: [1, 1, 0], support: [1, 0, 0], orientationTarget: [0, 1, 0] },
        { itemId: "minecraft:dropper", target: [2, 1, 0], support: [2, 0, 0], orientationTarget: [3, 1, 0] },
        { itemId: "minecraft:chest", target: [4, 1, 0], support: [4, 0, 0], orientationTarget: null },
      ],
      interactions: [],
    },
  };
  const wizard = createWizard({
    corpus,
    sessions,
    logger: { warn() {} },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary provider outage");
      if (calls === 2) {
        return modelResponse("The workbench is ready. I need one more planning pass.", null, {
          objective: question,
          successCriteria: "The complete machine turns its input into collected output",
          status: "active",
        });
      }
      return modelResponse("I engineered the complete mechanism on the marked workbench.", fullAction, {
        objective: question,
        successCriteria: "The complete machine turns its input into collected output",
        status: "active",
      });
    },
  });
  const first = await wizard.ask({ player: "MachineStageKid", question });
  assert.match(first.action.plan.title, /^First pass\b/);
  const outcome = await wizard.recordActionResult({
    player: "MachineStageKid", requestId: first.requestId, status: "completed",
    detail: "input and output workbench placed", context: liveContext,
  });
  const firstGoalId = sessions.get("MachineStageKid", "wizard")[0].goalId;
  assert.deepEqual(outcome.retry, { question, reason: "staged-progress", goalId: firstGoalId });
  const continued = await wizard.ask({
    player: "MachineStageKid",
    question: outcome.retry.question,
    goalRetry: { goalId: outcome.retry.goalId },
  });
  assert.equal(continued.action.type, "build_machine");
  assert.equal(continued.action.plan.mode, "modify");
  assert.equal(continued.action.plan.kind, first.action.plan.kind);
  assert.doesNotMatch(continued.action.plan.title, /^First pass\b/);
  const turns = sessions.get("MachineStageKid", "wizard");
  assert.equal(turns.at(-1).goalId, firstGoalId);
});

test("bounds retries by immutable goal lineage even when the provider renames the goal", async () => {
  let call = 0;
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      call += 1;
      return modelResponse(`I’ll revise city attempt ${call}.`, {
        type: "build_structure", version: 1,
        plan: cityPlan(call === 1 ? {} : { mode: true, height: 18 + call }),
      }, {
        objective: `City repair version ${call}`,
        successCriteria: "The city is complete and verified",
        status: "active",
      });
    },
  });
  let current = await wizard.ask({ player: "LineageKid", question: "Build a city" });
  for (let failure = 1; failure <= 2; failure += 1) {
    const outcome = await wizard.recordActionResult({
      player: "LineageKid", requestId: current.requestId, status: "failed", detail: `attempt ${failure} failed`,
    });
    assert.ok(outcome.replan?.action);
    current = outcome.replan;
  }
  const stopped = await wizard.recordActionResult({
    player: "LineageKid", requestId: current.requestId, status: "failed", detail: "third attempt failed",
  });
  assert.equal(stopped.retryLimitReached, true);
  assert.equal(call, 3);
});

test("does not let an old failed project supersede a newer child request", async () => {
  const wizard = createWizard({ corpus, env: {} });
  const old = await wizard.ask({ player: "RaceKid", question: "Build an automatic chicken farm" });
  const newer = await wizard.ask({ player: "RaceKid", question: "Build an automatic wool farm" });
  assert.equal(newer.action.id, "automatic_wool_farm");
  const outcome = await wizard.recordActionResult({
    player: "RaceKid", requestId: old.requestId, status: "failed", detail: "late chicken failure",
  });
  assert.equal(outcome.superseded, true);
  assert.equal(outcome.replan, undefined);
});

test("suppresses a slow replan when a newer request arrives", async () => {
  let release;
  const provider = new Promise((resolve) => { release = resolve; });
  const sessions = createMemorySessionStore();
  await sessions.set("SlowRaceKid", "wizard", [{
    question: "Build a city", answer: "I’ll build the city.",
    action: { type: "build_structure", version: 1, plan: cityPlan() },
    goal: {
      objective: "Build a city", successCriteria: "A complete city exists nearby", status: "active",
    },
    goalId: "slow-city-goal", requestId: "slow-city-action", status: "pending", requestSequence: 1,
  }]);
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => provider,
  });
  const replanPromise = wizard.recordActionResult({
    player: "SlowRaceKid", requestId: "slow-city-action", status: "failed", detail: "wall failed",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const newer = await wizard.ask({ player: "SlowRaceKid", question: "Build an automatic wool farm" });
  assert.equal(newer.action.id, "automatic_wool_farm");
  release(modelResponse("I’ll repair the same city.", {
    type: "build_structure", version: 1, plan: cityPlan({ mode: true, height: 20 }),
  }, {
    objective: "Build a city",
    successCriteria: "A complete city exists nearby",
    status: "active",
  }));
  const outcome = await replanPromise;
  assert.equal(outcome.replan.superseded, true);
  assert.equal(outcome.replan.action, null);
});

test("provider failure falls back to complete typed portal and city actions", async () => {
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "offline", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => { throw new Error("offline"); },
  });
  const portal = await wizard.ask({ player: "OfflinePortalKid", question: "Build and light a Nether portal" });
  assert.equal(portal.action.type, "build_machine");
  assert.equal(portal.action.plan.placements.length, 14);
  assert.equal(portal.action.plan.interactions[0].itemId, "minecraft:flint_and_steel");
  const city = await wizard.ask({ player: "OfflineCityKid", question: "Build a city" });
  assert.equal(city.action.type, "build_structure");
  assert.equal(city.action.plan.kind, "city");
  assert.ok(city.action.plan.primitives.length >= 20);
  assert.equal(city.goal.status, "active");
});
