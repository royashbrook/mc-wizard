// #35: novel-request quality-floor regression suite. This file is the
// executable definition of the goal: an unscripted child phrasing must yield a
// real authored build action offline, imperfect-but-salvageable provider plans
// must be accepted, graded builds must improve across days, and the safety
// lines (subject fidelity, command ban, banned executor blocks, telemetry
// privacy) must survive the acceptance softening. Fully hermetic: memory
// stores, scripted fetchImpl, no BDS, no .env, no network.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateBuildPlan } from "../bedrock/behavior_packs/mc_wizard/scripts/build-plan.js";
import {
  STRUCTURE_PRIMITIVE_LIMIT,
  validateBuildStructurePlan,
} from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";
import { validateMachinePlan } from "../bedrock/behavior_packs/mc_wizard/scripts/machine-plan.js";
import { createInteractionLog, readRecentInteractions } from "../src/interaction-log.mjs";
import { createMemoryLearnedRecipeStore } from "../src/learned-recipes.mjs";
import { SILHOUETTES, composeStructurePlan, extractDescriptor } from "../src/procedural-builder.mjs";
import { createHttpServer } from "../src/server.mjs";
import { createMemorySessionStore } from "../src/sessions.mjs";
import { createWizard } from "../src/wizard.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const providerEnv = { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" };
const chatEnvelope = (payload) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify(payload) } }],
}), { status: 200, headers: { "content-type": "application/json" } });
const offlineWizard = (overrides = {}) => createWizard({
  corpus: { search: () => [] }, env: {}, logger: quiet, ...overrides,
});

const PLANNING_DEFERRED = /don’t have a safe executable change yet/i;
const STAGED_TITLE = /^(?:First pass|Progress \d+)\b/i;

// A complete authored couch: real seat, backrest, armrests, and cushions that
// pass authoredSubjectGeometry, reusable as a scripted provider plan.
const couchPlan = {
  title: "Cozy Couch",
  kind: "couch",
  dimensions: { width: 7, depth: 4, height: 5 },
  materials: {
    primary: "minecraft:red_concrete",
    accent: "minecraft:white_concrete",
    roof: "minecraft:red_concrete",
  },
  features: ["decorations"],
  phases: ["foundation", "shell", "roof", "details"],
  primitives: [
    { shape: "box", phase: "foundation", blockId: "minecraft:red_concrete", from: [0, 0, 0], to: [0, 0, 3] },
    { shape: "box", phase: "foundation", blockId: "minecraft:red_concrete", from: [6, 0, 0], to: [6, 0, 3] },
    { shape: "box", phase: "shell", blockId: "minecraft:red_concrete", from: [0, 1, 0], to: [6, 2, 3] },
    { shape: "box", phase: "shell", blockId: "minecraft:white_concrete", from: [1, 1, 1], to: [5, 2, 2] },
    { shape: "box", phase: "roof", blockId: "minecraft:red_concrete", from: [0, 3, 3], to: [6, 4, 3] },
    { shape: "box", phase: "roof", blockId: "minecraft:red_concrete", from: [0, 3, 0], to: [0, 4, 2] },
    { shape: "box", phase: "roof", blockId: "minecraft:red_concrete", from: [6, 3, 0], to: [6, 4, 2] },
    { shape: "box", phase: "details", blockId: "minecraft:white_concrete", from: [2, 3, 3], to: [4, 3, 3] },
  ],
};

// ---------------------------------------------------------------------------
// Section 1 — OFFLINE FLOOR: no provider at all, unscripted child phrasings.
// ---------------------------------------------------------------------------

const OFFLINE_MATRIX = [
  { question: "build me a dog", noun: /dog/i },
  { question: "build me a giant rainbow", noun: /rainbow/i },
  { question: "make a giant rainbow", noun: /rainbow/i }, // #35: original spec phrasing restored
  { question: "build a rocket ship", noun: /rocket/i },
  { question: "can you build me a couch", noun: /couch/i },
  { question: "build a pink cat 20x10x8", noun: /pink cat/i, dimensions: { width: 20, depth: 10, height: 8 } },
  { question: "build me a dragon", noun: /dragon/i },
  { question: "build me a dargon", noun: /dargon/i }, // misspelled subject
  { question: "bild me a dragon", noun: /dragon/i }, // #35: misspelled build verb
  { question: "can you make me a doggy", noun: /doggy/i }, // young phrasing
  { question: "make a couch", noun: /couch/i },
  { question: "make me somefin cool wif a unicorn", noun: /unicorn/i }, // young phrasing
  { question: "build a wheat farm", noun: /wheat farm/i, machine: true },
];

test("offline, every unscripted phrasing yields a real authored build action", async () => {
  for (const { question, noun, dimensions, machine } of OFFLINE_MATRIX) {
    const wizard = offlineWizard();
    const result = await wizard.ask({ player: "FloorKid", question });
    assert.ok(result.action, `${question} produced no action (mode=${result.mode})`);
    assert.doesNotMatch(result.answer, PLANNING_DEFERRED, question);
    assert.match(result.answer, noun, question);
    if (machine) {
      assert.equal(result.action.type, "build_machine", question);
      const validated = validateMachinePlan(result.action.plan);
      assert.ok(validated.placements.length >= 5, `${question} placed only ${validated.placements.length}`);
      continue;
    }
    assert.equal(result.action.type, "build_structure", question);
    const plan = result.action.plan;
    // never the 4-primitive corner-and-edges guide
    assert.doesNotMatch(plan.title || "", STAGED_TITLE, question);
    assert.ok(plan.primitives.length >= 8, `${question} authored ${plan.primitives.length} primitives`);
    const validated = validateBuildStructurePlan(plan);
    assert.ok(validated.primitives.length >= 8, question);
    if (dimensions) assert.deepEqual(plan.dimensions, dimensions, question);
  }
});

test("offline, a known parametric kind still gets its deterministic template", async () => {
  // #35: original spec phrasing restored — "i want a <noun>" now registers as
  // a build request, so the workaround "i want you to build …" is gone.
  const wizard = offlineWizard();
  const result = await wizard.ask({ player: "BridgeKid", question: "i want a rainbow bridge" });
  assert.equal(result.action?.type, "build_structure");
  assert.equal(result.action.plan.kind, "bridge");
  assert.doesNotMatch(result.action.plan.title || "", STAGED_TITLE);
  assert.doesNotMatch(result.answer, PLANNING_DEFERRED);
  assert.match(result.answer, /bridge/i);
});

// #35 review: explicit dimensions below a silhouette template minimum must
// not dead-end with no action at all. The clamped procedural plan is accepted
// with an honest in-character size caveat and the goal stays active.
test("offline, explicit dimensions below the silhouette minimum still build with a size caveat", async () => {
  const wizard = offlineWizard();
  const result = await wizard.ask({ player: "TinyHeartKid", question: "Build a 5x5x5 heart" });
  assert.ok(result.action, `no action (mode=${result.mode})`);
  assert.equal(result.action.type, "build_structure");
  assert.match(result.action.plan.title, /^Blocky heart/i);
  // the heart template minimum width is 7; the clamp raised, never shrank
  assert.ok(result.action.plan.dimensions.width >= 7);
  for (const axis of ["width", "depth", "height"]) {
    assert.ok(result.action.plan.dimensions[axis] >= 5, axis);
  }
  assert.doesNotMatch(result.answer, PLANNING_DEFERRED);
  assert.match(result.answer, /little bigger/i);
  assert.equal(result.goal.status, "active");
  assert.equal(result.mode, "local-structure-fallback");
});

test("offline, dimensions above the hard structure limit still refuse to build", async () => {
  // negative: the clamp tolerance is raise-only — an oversize request must
  // never be silently shrunk into acceptance (unsafe-limit stays hard).
  const wizard = offlineWizard();
  const result = await wizard.ask({ player: "HugeHeartKid", question: "Build a 500x500 heart" });
  assert.equal(result.action, null);
  assert.equal(result.mode, "planning-deferred");
});

// #35 review: a bare "yes" must bind to a concrete pending offer. The offline
// capability menu ("...ask me one of those...") is not an offer a bare "yes"
// can pick from, so the wizard asks one precise clarification instead of
// building an unrequested generic 8x8x8 quartz cube.
test("a bare yes after the offline capability menu asks for a precise choice instead of building", async () => {
  const wizard = offlineWizard({ sessions: createMemorySessionStore() });
  const first = await wizard.ask({ player: "MenuKid", question: "wiz do you like pizza?" });
  assert.equal(first.action, null);
  const confirmation = await wizard.ask({ player: "MenuKid", question: "yes" });
  assert.equal(confirmation.action, null, `built ${JSON.stringify(confirmation.action?.plan?.title)}`);
  assert.match(confirmation.answer, /which one|exactly/i);
  assert.doesNotMatch(confirmation.answer, /sculpted my best/i);
});

test("a bare yes after a concrete offer builds exactly the offered subject", async () => {
  // positive: when the previous turn offered one concrete build, "yes" binds
  // to that offer's subject instead of a generic structure.
  const sessions = createMemorySessionStore();
  await sessions.append("OfferKid", "wizard", {
    question: "can you make something for my base?",
    answer: "Want me to build a small castle for your base?",
    action: null,
    responseMode: "offline",
  });
  const wizard = offlineWizard({ sessions });
  const confirmation = await wizard.ask({ player: "OfferKid", question: "yes" });
  assert.equal(confirmation.action?.type, "build_structure");
  assert.equal(confirmation.action.plan.kind, "castle");
  assert.equal(confirmation.goal.status, "active");
});

test("every silhouette template survives the real pack validator across nouns, sizes, and colors", () => {
  const sizes = ["", "tiny ", "small ", "big ", "giant "];
  const colors = ["", "red ", "light blue "];
  for (const { nouns } of SILHOUETTES) {
    for (const noun of nouns) {
      for (const size of sizes) {
        for (const color of colors) {
          const question = `build me a ${size}${color}${noun}`;
          const plan = composeStructurePlan(extractDescriptor(question));
          const validated = validateBuildStructurePlan(plan);
          assert.ok(plan.primitives.length >= 8, `${question} authored ${plan.primitives.length} primitives`);
          assert.ok(validated.primitives.length <= STRUCTURE_PRIMITIVE_LIMIT, question);
          assert.doesNotMatch(validated.title, STAGED_TITLE, question);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Section 2 — SALVAGE ACCEPTANCE: imperfect-but-salvageable provider envelopes
// are accepted and executable, never punted to the fallback.
// ---------------------------------------------------------------------------

test("a synonym-kind dragon with scrambled phases and an off-bounds wing is accepted", async () => {
  let calls = 0;
  const wizard = createWizard({
    corpus: { search: () => [] }, env: providerEnv, logger: quiet,
    fetchImpl: async () => {
      calls += 1;
      return chatEnvelope({
        answer: "I sketched a dragon design and I am building it now.",
        action: {
          type: "build_structure", version: 1,
          plan: {
            title: "Emerald Dragon",
            kind: "pet dragon", // synonym/generic-adjective kind, not the exact request string
            dimensions: { width: 12, depth: 8, height: 10 },
            materials: {
              primary: "minecraft:green_concrete",
              accent: "minecraft:lime_concrete",
              roof: "minecraft:stone",
            },
            features: ["supports"],
            phases: ["foundation", "shell", "roof", "details"],
            primitives: [
              // scrambled phase order plus a wing reaching past the declared width
              { shape: "box", phase: "details", blockId: "minecraft:white_concrete", from: [5, 7, 2], to: [5, 7, 2] },
              { shape: "line", phase: "roof", blockId: "minecraft:lime_concrete", from: [5, 6, 3], to: [5, 9, 3] },
              { shape: "line", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 3], to: [11, 0, 3] },
              { shape: "box", phase: "shell", blockId: "minecraft:green_concrete", from: [4, 1, 0], to: [7, 5, 7] },
              { shape: "box", phase: "shell", blockId: "minecraft:green_concrete", from: [8, 2, 3], to: [13, 3, 4] },
            ],
          },
        },
        goal: { objective: "Build a dragon", successCriteria: "A dragon statue exists", status: "active" },
      });
    },
  });
  const result = await wizard.ask({ player: "SalvageKid", question: "build me a dragon" });
  assert.equal(calls, 1, "acceptance must not burn repair rounds");
  assert.equal(result.mode, "chat:model");
  assert.equal(result.action.type, "build_structure");
  assert.equal(result.action.plan.kind, "pet dragon");
  assert.equal(result.action.plan.primitives.length, 5, "no primitive may be dropped");
  const order = ["foundation", "shell", "roof", "details"];
  const indices = result.action.plan.primitives.map(({ phase }) => order.indexOf(phase));
  assert.ok(indices.every((index, position) => !position || indices[position - 1] <= index), "phases re-sorted");
  // the accepted plan must round-trip the pack-side executor validator
  const revalidated = validateBuildStructurePlan(result.action.plan);
  assert.equal(revalidated.primitives.length, 5);
});

test("an execute_program with garbage supports and no verify step is compiled, not rejected", async () => {
  let calls = 0;
  const blocks = [0, 1, 2].flatMap((x) => [0, 1].map((z) => ({
    itemId: "minecraft:oak_planks", target: [x, 0, z], support: [9, 9, 9],
    expectedType: "minecraft:oak_planks",
  })));
  const wizard = createWizard({
    corpus: { search: () => [] }, env: providerEnv, logger: quiet,
    fetchImpl: async () => {
      calls += 1;
      return chatEnvelope({
        answer: "I planned your couch and I am placing it now.",
        action: {
          type: "execute_program", version: 1,
          program: {
            title: "Cozy couch",
            steps: [{
              id: "place_couch", capability: "player.place-blocks",
              arguments: { blocks }, expect: "The couch seat is placed.",
            }],
          },
        },
        goal: { objective: "Build a couch", successCriteria: "A couch exists", status: "active" },
      });
    },
  });
  const result = await wizard.ask({ player: "ProgramKid", question: "build me a couch" });
  assert.equal(calls, 1);
  assert.equal(result.mode, "chat:model");
  assert.equal(result.action.type, "execute_program");
  for (const { support, target } of result.action.program.steps[0].arguments.blocks) {
    assert.deepEqual(support, [target[0], -1, target[2]], "garbage supports must be re-derived");
  }
  assert.equal(result.action.program.steps.at(-1).capability, "verify.blocks", "verify evidence must be synthesized");
});

// ---------------------------------------------------------------------------
// Section 3 — IMPROVEMENT SIMULATION: novel ask → provisional recipe →
// verified recipe → silent replay with zero provider calls.
// ---------------------------------------------------------------------------

test("a graded novel build becomes a provisional, then verified, then silently replayed recipe", async () => {
  const recipes = createMemoryLearnedRecipeStore();

  // Day 1: the provider authors a couch; the child grades it 4 (completed but
  // never world-verified) — it must persist as a provisional recipe.
  let day1Calls = 0;
  const day1 = createWizard({
    corpus: { search: () => [] }, env: providerEnv, logger: quiet,
    sessions: createMemorySessionStore(), recipes,
    fetchImpl: async () => {
      day1Calls += 1;
      return chatEnvelope({
        answer: "I designed a cozy couch and I am building it now.",
        action: { type: "build_structure", version: 1, plan: couchPlan },
        goal: { objective: "Build a couch", successCriteria: "A couch exists", status: "active" },
      });
    },
  });
  const first = await day1.ask({ player: "Day1Kid", question: "build me a couch", requestId: "day1-couch" });
  assert.equal(day1Calls, 1);
  assert.equal(first.mode, "chat:model");
  assert.equal(first.action.plan.kind, "couch");
  await day1.recordActionResult({
    player: "Day1Kid", requestId: first.requestId, status: "completed", detail: "placed every primitive",
  });
  const day1Feedback = await day1.recordFeedback({ player: "Day1Kid", requestId: first.requestId, grade: 4 });
  assert.equal(day1Feedback.learned, true);
  assert.deepEqual((await recipes.list()).map(({ key, tier }) => ({ key, tier })), [
    { key: "couch", tier: "provisional" },
  ]);

  // Day 2: the provider is hard down; a reworded synonym ask must be served
  // from the provisional recipe instead of the corner guide, and a verified
  // grade-5 completion promotes it to the verified tier.
  let day2Calls = 0;
  const day2 = createWizard({
    corpus: { search: () => [] }, env: providerEnv, logger: quiet,
    sessions: createMemorySessionStore(), recipes,
    fetchImpl: async () => { day2Calls += 1; throw new Error("provider hard down"); },
  });
  const second = await day2.ask({ player: "Day2Kid", question: "make me a sofa", requestId: "day2-sofa" });
  assert.ok(day2Calls >= 1, "the provider was consulted and failed");
  assert.equal(second.mode, "learned-recipe-provisional");
  assert.equal(second.action.plan.kind, "couch");
  assert.doesNotMatch(second.action.plan.title || "", STAGED_TITLE);
  assert.ok(second.telemetry.rejections.some(({ gate }) => gate === "provider-error"));
  const day2Result = await day2.recordActionResult({
    player: "Day2Kid", requestId: second.requestId, status: "completed", detail: "verified in world",
    context: {
      dimension: "minecraft:overworld", buildState: "idle",
      lastStructure: {
        kind: second.action.plan.kind, title: second.action.plan.title,
        dimensions: second.action.plan.dimensions, materials: second.action.plan.materials,
        features: second.action.plan.features, primitives: second.action.plan.primitives,
        relativeOrigin: { x: 3, y: 0, z: 3 },
      },
    },
  });
  assert.equal(day2Result.review.goal.status, "complete");
  const day2Feedback = await day2.recordFeedback({ player: "Day2Kid", requestId: second.requestId, grade: 5 });
  assert.equal(day2Feedback.learned, true);
  assert.ok((await recipes.list()).some(({ tier }) => tier === "verified"), "grade 5 after world verification promotes to verified");

  // Day 3: a second rewording replays the verified recipe silently — zero
  // provider calls, no fallback, no staged progress.
  let day3Calls = 0;
  const day3 = createWizard({
    corpus: { search: () => [] }, env: providerEnv, logger: quiet,
    sessions: createMemorySessionStore(), recipes,
    fetchImpl: async () => { day3Calls += 1; throw new Error("must not be consulted"); },
  });
  const third = await day3.ask({ player: "Day3Kid", question: "could you make me a sofa please" });
  assert.equal(day3Calls, 0, "a verified learned recipe must replay without the provider");
  assert.equal(third.mode, "learned-recipe");
  assert.equal(third.action.plan.kind, "couch");
  assert.equal(third.telemetry.providerConsulted, false);
});

// ---------------------------------------------------------------------------
// Section 4 — SAFETY NEGATIVES: the softened gauntlet keeps its hard lines.
// ---------------------------------------------------------------------------

test("subject drift is never salvaged: a house plan for a dragon request is rejected", async () => {
  let calls = 0;
  const housePlan = { ...couchPlan, title: "Simple House", kind: "house" };
  const wizard = createWizard({
    corpus: { search: () => [] }, env: providerEnv, logger: quiet,
    fetchImpl: async () => {
      calls += 1;
      return chatEnvelope({
        answer: "I will build a lovely house for the dragon.",
        action: { type: "build_structure", version: 1, plan: housePlan },
        goal: { objective: "Build a dragon", successCriteria: "A dragon exists", status: "active" },
      });
    },
  });
  const result = await wizard.ask({ player: "DriftKid", question: "build me a dragon" });
  assert.ok(calls >= 2, "the drifted plan must be rejected and repaired before falling back");
  assert.equal(result.action.type, "build_structure");
  assert.match(result.action.plan.kind, /dragon/i, "the child still gets a dragon");
  assert.doesNotMatch(result.action.plan.kind, /house/i);
  assert.doesNotMatch(JSON.stringify(result.action), /"kind":"house"/);
  const gates = result.telemetry.rejections.map(({ gate }) => gate);
  assert.ok(gates.includes("repair-failed"), gates.join(","));
  assert.ok(gates.includes("fallback-engaged"), gates.join(","));
});

test("a command-bearing novel plan is rejected and never reaches the executor", async () => {
  let calls = 0;
  const wizard = createWizard({
    corpus: { search: () => [] }, env: providerEnv, logger: quiet,
    fetchImpl: async () => {
      calls += 1;
      return chatEnvelope({
        answer: "I will build the couch now.",
        action: {
          type: "execute_program", version: 1,
          program: {
            title: "Couch and operator",
            steps: [{
              id: "op", capability: "server.console",
              arguments: { commands: ["op {{requester}}"] }, expect: "Requester is an operator",
            }],
          },
        },
        goal: { objective: "Build a couch", successCriteria: "A couch exists", status: "active" },
      });
    },
  });
  const result = await wizard.ask({ player: "SmuggleKid", question: "build me a couch" });
  assert.ok(calls >= 2);
  assert.ok(result.action, "the rejection must still leave safe build progress");
  assert.equal(result.action.type, "build_structure");
  assert.doesNotMatch(JSON.stringify(result.action), /server\.console|server\.configure|world\.command|op \{\{requester\}\}/);
  assert.ok(result.telemetry.rejections.some(({ gate }) => gate === "research-restriction"));
});

test("command_block and friends are rejected by every validator, never repaired", () => {
  const banned = [
    "minecraft:command_block",
    "minecraft:repeating_command_block",
    "minecraft:chain_command_block",
    "minecraft:structure_block",
    "minecraft:mob_spawner",
    "minecraft:barrier",
    "minecraft:tnt",
  ];
  for (const blockId of banned) {
    // build-structure: the entry drops with a violation record
    const structure = validateBuildStructurePlan({
      ...couchPlan,
      primitives: [...couchPlan.primitives, {
        shape: "box", phase: "details", blockId, from: [1, 1, 1], to: [1, 1, 1],
      }],
    });
    assert.ok(structure.primitives.every((primitive) => primitive.blockId !== blockId), blockId);
    assert.ok(structure.salvage.dropped.some(({ reason }) => /not allowed/.test(reason)), blockId);

    // build-plan: the entry drops with a violation record
    const buildPlan = validateBuildPlan({
      title: "Smuggle test",
      blocks: [
        ...[0, 1, 2, 3].map((x) => ({ target: [x, 0, 0], itemId: "minecraft:oak_planks" })),
        { target: [0, 1, 0], itemId: blockId },
      ],
    });
    assert.ok(buildPlan.blocks.every((block) => block.itemId !== blockId), blockId);
    assert.ok(buildPlan.salvage.dropped.some(({ reason }) => /not allowed/.test(reason)), blockId);

    // machine-plan: the placement drops with a violation record
    const machine = validateMachinePlan({
      title: "Smuggle machine",
      kind: "test machine",
      placements: [
        ...[0, 1, 2, 3].map((x) => ({
          itemId: "minecraft:smooth_stone", target: [x, 0, 0], support: [x, -1, 0], orientationTarget: null,
        })),
        { itemId: blockId, target: [0, 1, 0], support: [0, 0, 0], orientationTarget: null },
      ],
      interactions: [],
    });
    assert.ok(machine.placements.every((placement) => placement.itemId !== blockId), blockId);
    assert.ok(machine.dropped.some(({ reason }) => /not allowed/.test(reason)), blockId);
  }
});

test("a hard-down provider still yields the procedural floor with a provider-error gate", async () => {
  const wizard = createWizard({
    corpus: { search: () => [] }, env: providerEnv, logger: quiet,
    fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); },
  });
  const result = await wizard.ask({ player: "DownKid", question: "build me a rocket ship" });
  assert.equal(result.mode, "local-structure-fallback");
  assert.equal(result.action.type, "build_structure");
  assert.match(result.action.plan.kind, /rocket/i);
  assert.ok(result.action.plan.primitives.length >= 8);
  assert.doesNotMatch(result.action.plan.title || "", STAGED_TITLE);
  assert.equal(result.telemetry.providerConsulted, true);
  assert.ok(result.telemetry.rejections.some(({ gate }) => gate === "provider-error"));
});

test("gate telemetry never reaches the pack, even for a real failing wizard", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-quality-floor-"));
  const filePath = join(directory, "interactions.jsonl");
  try {
    const wizard = createWizard({
      corpus: { search: () => [] }, env: providerEnv, logger: quiet,
      fetchImpl: async () => { throw new Error("provider hard down"); },
    });
    const interactionLog = createInteractionLog({ filePath, salt: "quality-floor-salt" });
    const server = createHttpServer({
      wizard, corpus: { size: 1 }, token: "test-token", interactionLog, cooldownMs: 0,
      logger: { log() {}, error() {} },
    });
    const encoded = Buffer.from(JSON.stringify({ player: "PrivacyKid", question: "build me a couch" }));
    const request = {
      method: "POST",
      url: "/v1/ask",
      headers: {
        authorization: "Bearer test-token",
        "content-length": String(encoded.length),
        "content-type": "application/json",
      },
      async *[Symbol.asyncIterator]() { yield encoded; },
    };
    const response = {
      status: 0, body: "",
      writeHead(status) { this.status = status; },
      end(value = "") { this.body = String(value); },
    };
    await server.listeners("request")[0](request, response);
    assert.equal(response.status, 200);
    const clientResult = JSON.parse(response.body);
    assert.equal(clientResult.action?.type, "build_structure", "the child still gets the procedural floor");
    assert.equal("telemetry" in clientResult, false);
    assert.doesNotMatch(response.body, /providerConsulted|rejections|provider-error/);
    const [entry] = await readRecentInteractions(filePath);
    assert.equal(entry.providerConsulted, true);
    assert.ok(entry.rejections.some(({ gate }) => gate === "provider-error"), "the operator log keeps the funnel");
    assert.doesNotMatch(await readFile(filePath, "utf8"), /PrivacyKid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
