// WP-C — tiered Critic unit suite.
//
// Fully hermetic: no network, no .env, no Bedrock container, no provider. Every
// wizard-owned predicate is injected as a stub so the tier ORDER and the
// verdict SHAPE are what is under test; the two genuinely safety-critical
// checks (the action allowlist and child-content policy) are driven with
// the REAL src/skills.mjs and src/learned-recipes.mjs implementations, so the
// forbidden-block and world.command cases are not stubbed into passing.
import assert from "node:assert/strict";
import test from "node:test";

import { safeNovelAction } from "../src/learned-recipes.mjs";
import {
  ACTION_ALLOWLIST_REASON,
  CONTENT_POLICY_REASON,
  CRITIC_SEVERITIES,
  INTENT_MISMATCH_REASON,
  REVIEW_VERDICT_REASON,
  createCritic,
} from "../src/roles/critic.mjs";
import { allowedWizardAction } from "../src/skills.mjs";

const explode = (name) => () => {
  throw new Error(`${name} must not be consulted here`);
};

const stubs = (overrides = {}) => ({
  allowedWizardAction: (action) => action,
  safeNovelAction: () => true,
  providerActionMatchesRequest: () => true,
  actionCompletesBuildRequest: () => true,
  actionAdvancesBuildRequest: () => true,
  correctiveActionContinuesGoal: () => true,
  unusableWizardAnswer: () => false,
  answerPromisesAction: () => false,
  answerRefusesAction: () => false,
  plannerRepairDetail: (question, action) => `repair hint for ${action ? action.type : "no action"}`,
  ...overrides,
});

// Real gates for the safety tiers; everything else stays stubbed so a safety
// test can never be rescued by a lenient fidelity or contract stub.
const safetyCritic = (overrides = {}) => createCritic(stubs({
  allowedWizardAction, safeNovelAction, ...overrides,
}));

const travelAction = { type: "dimension_travel", version: 1, destination: "nether" };
const fillAction = {
  type: "run_commands", version: 1,
  commands: ["fill ~-25 ~ ~-25 ~25 ~11 ~25 air"],
};

const POWERFUL_BLOCKS = [
  "minecraft:command_block",
  "minecraft:repeating_command_block",
  "minecraft:chain_command_block",
  "minecraft:structure_block",
  "minecraft:structure_void",
  "minecraft:mob_spawner",
  "minecraft:barrier",
  "minecraft:tnt",
];

const bannedStructure = (blockId) => ({
  type: "build_structure", version: 1,
  plan: {
    title: "Smuggled shell", kind: "couch",
    dimensions: { width: 3, depth: 3, height: 3 },
    materials: { primary: blockId, accent: blockId, roof: blockId },
    features: ["decorations"], phases: ["foundation", "shell", "roof", "details"],
  },
});

const bannedBuildPlan = (itemId) => ({
  type: "build_plan", version: 1,
  plan: { title: "Smuggled plan", blocks: [0, 1, 2, 3].map((x) => ({ target: [x, 0, 0], itemId })) },
});

const bannedMachine = (itemId) => ({
  type: "build_machine", version: 1,
  plan: {
    title: "Smuggled machine", kind: "probe machine",
    placements: [0, 1, 2, 3].map((x) => ({
      itemId, target: [x, 0, 2], support: [x, -1, 2], orientationTarget: null,
    })),
    interactions: [],
  },
});

const researchedProgram = (capability) => ({
  type: "execute_program", version: 1,
  program: {
    title: "Researched helper",
    steps: [{
      id: "run", capability,
      arguments: { commands: capability === "server.console" ? ["op {{requester}}"] : ["fill ~-5 ~ ~-5 ~5 ~5 ~5 air"] },
      expect: "The command ran",
    }],
  },
});

// ---------------------------------------------------------------------------
// POSITIVE — the three round trips, the tri-state, and the C1 live-session case
// ---------------------------------------------------------------------------

test("an accepted candidate round-trips as severity none with no tier, gate, warning, or repair hint", () => {
  const critic = createCritic(stubs());
  const result = critic.critique(
    { action: travelAction, answer: "Off to the Nether we go." },
    { question: "take me to the nether", actionableIntent: true },
  );
  assert.equal(result.severity, "none");
  assert.equal(result.ok, true);
  assert.equal(result.tier, null);
  assert.equal(result.gate, null);
  assert.equal("warning" in result, false);
  assert.equal("repairDetail" in result, false);
  assert.ok(CRITIC_SEVERITIES.includes(result.severity));
  assert.ok(Object.isFrozen(result));
});

test("a {complete:false, warning} contract round-trips as severity warning with the warning preserved", () => {
  const warning = "the authored geometry looks rough for its declared bounds";
  let advancesCalls = 0;
  const critic = createCritic(stubs({
    actionCompletesBuildRequest: () => ({ complete: false, warning }),
    actionAdvancesBuildRequest: () => {
      advancesCalls += 1;
      return true;
    },
    plannerRepairDetail: explode("plannerRepairDetail"),
  }));
  const result = critic.critique(
    { action: { type: "build_structure", version: 1, plan: { kind: "couch" } }, answer: "Building your couch." },
    { question: "build me a couch", buildRequest: true, actionableIntent: true },
  );
  assert.equal(result.severity, "warning");
  assert.equal(result.tier, "C3");
  assert.equal(result.gate, "build-contract");
  assert.equal(result.warning, warning);
  assert.equal(result.advances, true);
  // Accept-with-warning SHIPS. It must not be repaired, and it must not be
  // flattened into the same bucket as a false contract.
  assert.equal(result.ok, true);
  assert.equal("repairDetail" in result, false);
  assert.equal(advancesCalls, 0);
});

test("a rejected build contract round-trips as severity contract on tier C3 with a repair hint", () => {
  const critic = createCritic(stubs({
    actionCompletesBuildRequest: () => false,
    actionAdvancesBuildRequest: () => false,
  }));
  const result = critic.critique(
    { action: { type: "build_structure", version: 1, plan: { kind: "pad" } }, answer: "Here is a pad." },
    { question: "build me a castle", buildRequest: true, actionableIntent: true },
  );
  assert.equal(result.severity, "contract");
  assert.equal(result.ok, false);
  assert.equal(result.tier, "C3");
  assert.equal(result.gate, "build-contract");
  assert.equal(result.advances, false);
  assert.match(result.repairDetail, /repair hint for build_structure/);
});

test("a fidelity miss round-trips as severity contract on tier C2 with the verbatim intent-mismatch reason", () => {
  const calls = [];
  const critic = createCritic(stubs({
    providerActionMatchesRequest: (...args) => {
      calls.push(args);
      return false;
    },
  }));
  const result = critic.critique(
    { action: { type: "build_structure", version: 1, plan: { kind: "house" } }, answer: "A house it is." },
    {
      question: "build me a dragon", actionHistory: [{ question: "hi" }],
      buildRequest: true, projectFeedback: false, reviewRequest: false, actionableIntent: true,
    },
  );
  assert.equal(result.severity, "contract");
  assert.equal(result.tier, "C2");
  assert.equal(result.gate, "intent-match");
  assert.equal(result.reason, INTENT_MISMATCH_REASON);
  assert.equal(result.subGate, "build-contract");
  // C2 calls providerActionMatchesRequest WHOLE, exactly once, with the whole
  // flag object — it is never split into a safety half and a phrasing half.
  assert.equal(calls.length, 1);
  const [action, question, history, flags] = calls[0];
  assert.equal(action.type, "build_structure");
  assert.equal(question, "build me a dragon");
  assert.deepEqual(history, [{ question: "hi" }]);
  assert.deepEqual(flags, { buildRequest: true, projectFeedback: false, reviewRequest: false });
});

test("C1 fires on an actionable request with no action even when neither prose regex trips", () => {
  // The live terrain session: neutral prose, no action, actionable request.
  // The regexes are injected as landmines — if the Critic consulted them the
  // test would throw, which is the whole structural point of C1's first
  // disjunct being intent.actionableIntent.
  const critic = createCritic(stubs({
    answerPromisesAction: explode("answerPromisesAction"),
    answerRefusesAction: explode("answerRefusesAction"),
    plannerRepairDetail: (question, action) => {
      assert.equal(action, null);
      return "No executable action was returned. Replan the full request as one allowed action.";
    },
  }));
  const result = critic.critique(
    { action: null, answer: "Clearing large areas takes a while in Bedrock, and the ground here is uneven." },
    { question: "clear a 50x50 area around me", actionableIntent: true, buildRequest: false },
  );
  assert.equal(result.severity, "contract");
  assert.equal(result.tier, "C1");
  assert.equal(result.gate, "action-existence");
  assert.equal(result.subGate, "actionable-intent");
  assert.match(result.repairDetail, /No executable action was returned/);
});

test("C1 still fires through the prose disjuncts when the request was not classified actionable", () => {
  const promising = createCritic(stubs({ answerPromisesAction: () => true }));
  const promised = promising.critique(
    { action: null, answer: "I'll clear that out for you." },
    { question: "could you tidy this up", actionableIntent: false },
  );
  assert.equal(promised.tier, "C1");
  assert.equal(promised.subGate, "answer-promise");

  const refusing = createCritic(stubs({ answerRefusesAction: () => true }));
  const refused = refusing.critique(
    { action: null, answer: "I can't do that in this world." },
    { question: "could you tidy this up", actionableIntent: false },
  );
  assert.equal(refused.tier, "C1");
  assert.equal(refused.subGate, "answer-refusal");
  assert.equal(refused.severity, "contract");
});

test("a bare null candidate on an actionable turn is a C1 verdict, not a crash", () => {
  const critic = createCritic(stubs());
  const result = critic.critique(null, { question: "level the ground here", actionableIntent: true });
  assert.equal(result.tier, "C1");
  assert.equal(result.severity, "contract");
});

test("a completed review with no action passes every tier", () => {
  const critic = createCritic(stubs());
  const result = critic.critique(
    { action: null, answer: "The tower matches the goal.", goal: { status: "complete" } },
    { question: "goal review", reviewRequest: true, projectFeedback: true, actionableIntent: true },
  );
  assert.equal(result.severity, "none");
  assert.equal(result.ok, true);
});

test("each C2 sub-gate label is derived from the action type for telemetry only", () => {
  const critic = createCritic(stubs({ providerActionMatchesRequest: () => false }));
  const labels = [
    [{ type: "execute_program", version: 1 }, "provider-power-match"],
    [{ type: "build_machine", version: 1 }, "build-contract"],
    [{ type: "run_commands", version: 1 }, "command-intent-match"],
    [{ type: "give_items", version: 1 }, "gift-match"],
    [{ type: "show_recipe", version: 1 }, "recipe-match"],
    [{ type: "command_lesson", version: 1 }, "command-lesson-match"],
    [{ type: "dimension_travel", version: 1 }, "deterministic-equality"],
  ];
  for (const [action, subGate] of labels) {
    const result = critic.critique({ action, answer: "ok" }, { question: "do it", actionableIntent: true });
    assert.equal(result.tier, "C2", action.type);
    assert.equal(result.subGate, subGate, action.type);
  }
});

// ---------------------------------------------------------------------------
// NEGATIVE — ordering, the no-hint-on-safety invariant, and the real gates
// ---------------------------------------------------------------------------

test("a candidate failing both C0 and C3 reports C0 and never reaches the build contract", () => {
  let contractCalls = 0;
  const critic = createCritic(stubs({
    allowedWizardAction: () => null,
    actionCompletesBuildRequest: () => {
      contractCalls += 1;
      return false;
    },
    providerActionMatchesRequest: explode("providerActionMatchesRequest"),
  }));
  const result = critic.critique(
    { action: { type: "build_structure", version: 1, plan: {} }, answer: "Building." },
    { question: "build me a castle", buildRequest: true, actionableIntent: true },
  );
  assert.equal(result.tier, "C0");
  assert.equal(result.severity, "fatal");
  assert.equal(result.gate, "action-allowlist");
  assert.equal(result.reason, ACTION_ALLOWLIST_REASON);
  assert.equal(contractCalls, 0);
});

test("no C0 verdict ever carries a repair hint", () => {
  const detail = explode("plannerRepairDetail");
  const cases = [
    ["action-allowlist", createCritic(stubs({ allowedWizardAction: () => null, plannerRepairDetail: detail })), {
      candidate: { action: { type: "build_structure", version: 1, plan: {} }, answer: "Building." },
      intent: { question: "build me a castle", buildRequest: true, actionableIntent: true },
    }],
    ["content-policy", createCritic(stubs({ safeNovelAction: () => false, plannerRepairDetail: detail })), {
      candidate: { action: { type: "execute_program", version: 1, program: {} }, answer: "Working." },
      intent: { question: "build me a spiral tower", buildRequest: true, researchRequired: true, actionableIntent: true },
    }],
    ["unusable-answer", createCritic(stubs({ unusableWizardAnswer: () => true, plannerRepairDetail: detail })), {
      candidate: { action: null, answer: "Ask an adult." },
      intent: { question: "how do pistons work", actionableIntent: true },
    }],
  ];
  for (const [gate, critic, { candidate, intent }] of cases) {
    const result = critic.critique(candidate, intent);
    assert.equal(result.severity, "fatal", gate);
    assert.equal(result.gate, gate);
    assert.equal("repairDetail" in result, false, gate);
    assert.equal("warning" in result, false, gate);
    assert.equal(result.ok, false, gate);
  }
});

test("powerful blocks pass the real allowlist on actionable turns", () => {
  const critic = safetyCritic();
  // buildRequest is false on purpose: this is the newly reachable path (a
  // terrain/administrative turn that escalated into an authored plan), and the
  const intent = { question: "clear a 50x50 area around me", actionableIntent: true, buildRequest: false };
  for (const blockId of POWERFUL_BLOCKS) {
    for (const candidate of [bannedStructure(blockId), bannedBuildPlan(blockId), bannedMachine(blockId)]) {
      const result = critic.critique({ action: candidate, answer: "On it." }, intent);
      assert.equal(result.severity, "none", `${blockId} / ${candidate.type}`);
    }
  }
});

test("a researchRequired program may carry world.command or server.console", () => {
  const critic = safetyCritic();
  for (const capability of ["world.command", "server.console"]) {
    const action = researchedProgram(capability);
    // Sanity: these DO pass the action allowlist, so the research restriction —
    // not the allowlist — is what must stop them.
    assert.ok(allowedWizardAction(action), capability);
    const result = critic.critique(
      { action, answer: "Researching that build now." },
      { question: "build me a medieval siege tower", buildRequest: true, researchRequired: true, actionableIntent: true },
    );
    assert.equal(result.severity, "none", capability);
  }
});

test("kid-inappropriate generated content is rejected regardless of mechanism", () => {
  const critic = safetyCritic();
  const action = researchedProgram("world.command");
  action.program.title = "Nude body statue";
  const result = critic.critique(
    { action, answer: "Working." },
    { question: "build a statue", buildRequest: true, researchRequired: true, actionableIntent: true },
  );
  assert.equal(result.severity, "fatal");
  assert.equal(result.gate, "content-policy");
  assert.equal(result.reason, CONTENT_POLICY_REASON);
  assert.equal("repairDetail" in result, false);
});

test("the same program is accepted when the turn does not require research", () => {
  const critic = safetyCritic();
  const result = critic.critique(
    { action: researchedProgram("world.command"), answer: "Clearing that out." },
    { question: "clear a 50x50 area around me", actionableIntent: true, researchRequired: false },
  );
  assert.equal(result.severity, "none");
});

test("C1 does NOT fire when the request is not actionable and the prose neither promises nor refuses", () => {
  const critic = createCritic(stubs());
  const result = critic.critique(
    { action: null, answer: "I don’t know that one yet — I’d rather not guess." },
    { question: "what is the rarest mob in bedrock", actionableIntent: false },
  );
  assert.equal(result.severity, "none");
  assert.equal(result.ok, true);
  assert.equal(result.tier, null);
});

test("C1 does NOT fire on an answer-only refinement even when the prose promises action", () => {
  const critic = createCritic(stubs({ answerPromisesAction: () => true }));
  const result = critic.critique(
    { action: null, answer: "I'll build that for you." },
    { question: "make it taller", answerOnlyRequest: true, actionableIntent: false },
  );
  assert.equal(result.severity, "none");
});

test("a review verdict that neither completes nor corrects rejects", () => {
  const critic = createCritic(stubs({ correctiveActionContinuesGoal: () => false }));
  const drifting = critic.critique(
    {
      action: { type: "build_structure", version: 1, plan: { kind: "house" } },
      answer: "I replaced it with a house.", goal: { status: "active" },
    },
    { question: "goal review", reviewRequest: true, projectFeedback: true, actionableIntent: true },
  );
  assert.equal(drifting.severity, "contract");
  assert.equal(drifting.tier, "C1");
  assert.equal(drifting.gate, "review-verdict");
  assert.equal(drifting.reason, REVIEW_VERDICT_REASON);

  const neither = critic.critique(
    { action: null, answer: "Still thinking about it.", goal: { status: "active" } },
    { question: "goal review", reviewRequest: true, actionableIntent: true },
  );
  assert.equal(neither.tier, "C1");
  assert.equal(neither.gate, "review-verdict");

  const stagedCompletion = createCritic(stubs()).critique(
    { action: null, answer: "Looks done to me.", goal: { status: "complete" } },
    { question: "goal review", reviewRequest: true, reviewingStagedProgress: true, actionableIntent: true },
  );
  assert.equal(stagedCompletion.tier, "C1");
  assert.equal(stagedCompletion.gate, "review-verdict");
});

test("a corrective review that continues the same goal is accepted", () => {
  const critic = createCritic(stubs({ correctiveActionContinuesGoal: () => true }));
  const result = critic.critique(
    {
      action: { type: "build_structure", version: 1, plan: { kind: "castle" } },
      answer: "Adding the missing tower.", goal: { status: "active" },
    },
    { question: "goal review", reviewRequest: true, projectFeedback: true, actionableIntent: true },
  );
  assert.equal(result.severity, "none");
});

test("a review turn never runs the build contract, so a corrective action is not re-litigated", () => {
  const critic = createCritic(stubs({
    actionCompletesBuildRequest: explode("actionCompletesBuildRequest"),
  }));
  const result = critic.critique(
    {
      action: { type: "build_structure", version: 1, plan: { kind: "castle" } },
      answer: "Adding the missing tower.", goal: { status: "active" },
    },
    { question: "goal review", reviewRequest: true, projectFeedback: true, buildRequest: false },
  );
  assert.equal(result.severity, "none");
});

test("createCritic refuses to build without every injected dependency", () => {
  assert.throws(() => createCritic(), /createCritic requires injected functions/);
  const { plannerRepairDetail, providerActionMatchesRequest, ...partial } = stubs();
  assert.throws(
    () => createCritic(partial),
    (error) => error instanceof TypeError
      && /providerActionMatchesRequest/.test(error.message)
      && /plannerRepairDetail/.test(error.message),
  );
});

test("critique mutates neither the candidate nor the intent", () => {
  const critic = createCritic(stubs({ actionCompletesBuildRequest: () => false, actionAdvancesBuildRequest: () => false }));
  const candidate = { action: { ...fillAction }, answer: "On it." };
  const intent = { question: "build me a castle", buildRequest: true, actionableIntent: true };
  const candidateSnapshot = JSON.parse(JSON.stringify(candidate));
  const intentSnapshot = JSON.parse(JSON.stringify(intent));
  critic.critique(candidate, intent);
  assert.deepEqual(candidate, candidateSnapshot);
  assert.deepEqual(intent, intentSnapshot);
});

test("an allowlist throw is treated as a fatal rejection, never as a pass", () => {
  const critic = createCritic(stubs({
    allowedWizardAction: () => {
      throw new Error("validator exploded");
    },
  }));
  const result = critic.critique({ action: fillAction, answer: "On it." }, { question: "clear the area", actionableIntent: true });
  assert.equal(result.severity, "fatal");
  assert.equal(result.tier, "C0");
});
