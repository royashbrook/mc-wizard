// #35/#44 WP-D — unit suite for the four pure role modules: TurnState,
// TurnIntent, the Escalator and the Orchestrator state machine.
//
// Everything here is driven by INJECTED fakes. No module under test imports
// src/wizard.mjs, so this suite is hermetic by construction: no network, no
// .env, no Bedrock container, no provider, no clock dependence beyond an
// injected now().
//
// The two properties this file exists to pin:
//   1. COST — when intent.consultModel is false the provider planner is never
//      called, for every permutation of every other intent flag.
//   2. TOTALITY — the state machine terminates in FINALIZE with a non-empty,
//      useful outcome even when every injected role is missing, null-returning,
//      throwing, or adversarial.
import assert from "node:assert/strict";
import test from "node:test";

import { RUNG, createEscalator, createStandardEscalator } from "../src/roles/escalation.mjs";
import { createIntent } from "../src/roles/intent.mjs";
import {
  MAX_ESCALATIONS,
  PHASE,
  createOrchestrator,
  createTurnBudget,
} from "../src/roles/orchestrator.mjs";
import { createTurnState } from "../src/roles/turn-state.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const ACTION = Object.freeze({ type: "build_structure", plan: { title: "Tower" } });
const OTHER_ACTION = Object.freeze({ type: "run_commands", version: 1, commands: ["fill ~ ~ ~ ~ ~ ~ air"] });
const DEFERRED = "I’m keeping this as our active project, but I don’t have a safe executable change yet.";

// A fake "offer" shape, so the suite never re-declares a production regex.
const OFFER = "OFFER: I can level the ground around you—say yes and I’ll start.";
const offersAction = (answer) => String(answer || "").startsWith("OFFER:");
const isMenuShape = (answer) => /ask me one of those/i.test(String(answer || ""));

const intentOf = (over = {}) => Object.freeze({
  question: "do the thing",
  general: false,
  answerOnlyRequest: false,
  reviewRequest: false,
  recipeRequest: false,
  conversational: false,
  satisfied: false,
  buildRequest: false,
  projectFeedback: false,
  terrainIntent: null,
  actionableIntent: false,
  consultModel: false,
  ...over,
});

const stateOf = (over = {}) => createTurnState({
  answer: "baseline local answer",
  action: null,
  responseMode: "offline",
  ...over,
});

const orchestratorOf = (over = {}) => createOrchestrator({
  logger: quiet,
  assertions: { offersAction, isMenuShape, boundOffer: () => ({ answer: OFFER }) },
  ...over,
});

// ── TurnState ───────────────────────────────────────────────────────────────

test("TurnState adopt() writes action and responseMode together", () => {
  const state = stateOf();
  state.adopt({ action: ACTION, responseMode: "local-skill", answer: "here you go" });
  assert.equal(state.action, ACTION);
  assert.equal(state.responseMode, "local-skill");
  assert.equal(state.answer, "here you go");
  const snapshot = state.snapshot();
  assert.equal(snapshot.action, ACTION);
  assert.equal(Object.isFrozen(snapshot), true);
});

test("TurnState refuses any write that could drift action from responseMode", () => {
  const state = stateOf();
  assert.throws(() => { state.action = ACTION; }, /adopt/);
  assert.throws(() => { state.responseMode = "local-skill"; }, /adopt/);
  assert.throws(() => state.adopt({ action: ACTION }), /BOTH/);
  assert.throws(() => state.adopt({ responseMode: "local-skill" }), /BOTH/);
  assert.throws(() => state.adopt(), /adopt\(\)/);
  assert.equal(state.action, null);
  assert.equal(state.responseMode, "offline");
});

test("TurnState escalation bookkeeping is monotonic and append-only", () => {
  const state = stateOf();
  state.recordEscalation("planner", 0);
  state.recordEscalation("classify", 1);
  state.recordEscalation("classify", 1);
  assert.equal(state.escalationIndex, 3);
  assert.deepEqual(state.rejectedRungs, ["planner", "classify"]);
  assert.throws(() => { state.escalationIndex = 0; }, /recordEscalation/);
  assert.throws(() => { state.rejectedRungs = []; }, /append-only/);
});

test("TurnState records bounded rejection reasons and traceable gate errors", () => {
  const state = stateOf();
  state.recordRejection("intent-match", `  ${"x".repeat(400)}  `);
  assert.equal(state.gateTrace[0].reason.length, 200);
  const error = state.gateError("envelope-parse", "invalid Wizard response");
  assert.equal(error.gateRecorded, true);
  assert.equal(state.gateTrace.at(-1).gate, "envelope-parse");
});

// ── TurnIntent ──────────────────────────────────────────────────────────────

const intentDeps = (over = {}) => createIntent({
  isBuildRequest: () => false,
  isProjectFeedback: () => false,
  isRecipeRequest: () => false,
  isGoalSatisfaction: () => false,
  isOrdinaryConversation: () => false,
  instantConversationAnswer: () => undefined,
  groundedQuickAnswer: () => undefined,
  retrievalQuestion: (question) => question,
  wantsModelAuthoredStructure: () => false,
  hasUnmatchedDescriptors: () => false,
  historyWithObservedStructure: (history) => history,
  ...over,
});

test("TurnIntent generalizes actionableIntent past buildRequest", () => {
  const intent = intentDeps({ terrainIntent: () => ({ width: 50, depth: 50, mode: "clear" }) })
    .describe({ question: "clear a 50x50 area around me", history: [] });
  assert.equal(intent.buildRequest, false);
  assert.equal(intent.projectFeedback, false);
  assert.equal(intent.actionableIntent, true);
  assert.equal(intent.intentClass, "terrain");
  assert.deepEqual(intent.terrainIntent, { width: 50, depth: 50, mode: "clear" });
  assert.equal(Object.isFrozen(intent), true);
});

test("TurnIntent consults the model on an actionable turn with no local plan", () => {
  const intent = intentDeps({ isBuildRequest: () => true })
    .describe({
      question: "build a rainbow candy castle",
      history: [],
      flags: { providerEnabled: true, aiEnabled: true, action: null },
    });
  assert.equal(intent.consultModel, true);
  assert.equal(intent.actionableIntent, true);
  assert.equal(intent.researchRequired, true);
});

test("TurnIntent keeps canned and deterministic turns free of provider calls", () => {
  const canned = intentDeps({ instantConversationAnswer: () => "Hello there!" })
    .describe({
      question: "hello wizard",
      history: [],
      flags: { providerEnabled: true, aiEnabled: true, action: null },
    });
  assert.equal(canned.consultModel, false, "a greeting must not consult");
  assert.equal(canned.actionableIntent, false);

  const blueprint = intentDeps({ isBuildRequest: () => true })
    .describe({
      question: "build a t flip flop",
      history: [],
      flags: {
        providerEnabled: true,
        aiEnabled: true,
        action: { type: "build_interactive_blueprint", id: "t-flip-flop" },
      },
    });
  assert.equal(blueprint.consultModel, false, "a canned blueprint must not consult");

  const gift = intentDeps().describe({
    question: "give me 64 torches",
    history: [],
    flags: { providerEnabled: true, aiEnabled: true, action: { type: "give_items" } },
  });
  assert.equal(gift.consultModel, false, "a deterministic gift must not consult");

  const learned = intentDeps({ isBuildRequest: () => true }).describe({
    question: "build an automatic chicken farm",
    history: [],
    flags: { providerEnabled: true, aiEnabled: true, action: null, learnedAction: { type: "build_structure" } },
  });
  assert.equal(learned.consultModel, false, "a verified learned recipe suppresses the provider");
});

test("TurnIntent keeps review, answer-only, recipe and conversation turns non-actionable", () => {
  const detectors = {
    terrainIntent: () => ({ width: 8, depth: 8, mode: "clear" }),
    adminIntent: () => ({ kind: "weather" }),
    travelIntent: () => ({ kind: "nether" }),
    giftIntent: () => ({ item: "torch" }),
    effectIntent: () => ({ effect: "speed" }),
  };
  const review = intentDeps({ ...detectors, isProjectFeedback: () => true })
    .describe({ question: "is it done?", history: [], flags: { goalReview: { goalId: "g1" } } });
  assert.equal(review.reviewRequest, true);
  assert.equal(review.projectFeedback, true, "review turns keep today's projectFeedback semantics");
  assert.equal(review.actionableIntent, false, "a review must never fall down the ladder into a build");

  const answerOnly = intentDeps(detectors)
    .describe({ question: "why did that fail?", history: [], flags: { answerOnly: { originalQuestion: "q" } } });
  assert.equal(answerOnly.actionableIntent, false);

  const recipe = intentDeps({ ...detectors, isRecipeRequest: () => true })
    .describe({ question: "how do I craft a lantern?", history: [] });
  assert.equal(recipe.actionableIntent, false);

  const chat = intentDeps({ ...detectors, isOrdinaryConversation: () => true })
    .describe({ question: "what is your favorite color?", history: [] });
  assert.equal(chat.actionableIntent, false);
});

// ── Escalator ───────────────────────────────────────────────────────────────

const ladderFor = (over = {}) => createStandardEscalator({
  classifyAction: () => null,
  provisionalRecipeAction: () => null,
  localStructureFallback: () => null,
  terrainAction: () => null,
  boundOffer: () => null,
  planningDeferred: () => ({ action: null, answer: DEFERRED }),
  ...over,
});

test("Escalator keeps the provisional recipe ahead of the local structure floor", () => {
  const order = [];
  const escalator = ladderFor({
    provisionalRecipeAction: () => { order.push("provisional"); return null; },
    localStructureFallback: () => { order.push("local"); return ACTION; },
  });
  const intent = intentOf({ buildRequest: true, actionableIntent: true });
  const first = escalator.next(0, intent, {}, []);
  assert.equal(first.rung.name, RUNG.CLASSIFY);
  const second = escalator.next(first.index + 1, intent, {}, [first.rung.name]);
  assert.equal(second.rung.name, RUNG.PROVISIONAL_RECIPE);
  const third = escalator.next(second.index + 1, intent, {}, [first.rung.name, second.rung.name]);
  assert.equal(third.rung.name, RUNG.LOCAL_STRUCTURE);
  assert.equal(third.candidate.action, ACTION);
  assert.deepEqual(order, ["provisional", "local"]);
});

test("Escalator skips build-only and terrain rungs that do not apply", () => {
  const escalator = ladderFor({
    provisionalRecipeAction: () => ACTION,
    localStructureFallback: () => ACTION,
    terrainAction: () => OTHER_ACTION,
  });
  const terrain = intentOf({ actionableIntent: true, terrainIntent: { width: 50, depth: 50, mode: "clear" } });
  const step = escalator.next(1, terrain, {}, [RUNG.CLASSIFY]);
  assert.equal(step.rung.name, RUNG.TERRAIN, "build-only rungs must not fire on a terrain turn");
  assert.equal(step.candidate.action, OTHER_ACTION);

  const build = intentOf({ actionableIntent: true, buildRequest: true });
  const buildStep = escalator.next(4, build, {}, []);
  assert.equal(buildStep.rung.name, RUNG.BOUND_OFFER, "the terrain rung must not fire without a terrain intent");
});

test("Escalator never re-produces a rejected rung and survives a throwing rung", () => {
  let classifyCalls = 0;
  const escalator = ladderFor({
    classifyAction: () => { classifyCalls += 1; throw new Error("classifier exploded"); },
  });
  const intent = intentOf({ actionableIntent: true });
  const rejections = [];
  const ctx = { recordRejection: (gate, reason) => rejections.push({ gate, reason }) };
  const first = escalator.next(0, intent, ctx, []);
  assert.equal(first.rung.name, RUNG.CLASSIFY);
  assert.equal(first.candidate, null, "a throwing rung yields nothing instead of taking the turn down");
  assert.equal(rejections[0].gate, `rung:${RUNG.CLASSIFY}`);
  const second = escalator.next(first.index + 1, intent, ctx, [RUNG.CLASSIFY]);
  assert.notEqual(second.rung.name, RUNG.CLASSIFY);
  assert.equal(classifyCalls, 1);
});

test("Escalator rejects a malformed ladder rather than silently dropping a rung", () => {
  assert.throws(() => createEscalator([{ produce: () => null }]), /name/);
  assert.throws(() => createEscalator([{ name: "a" }]), /produce/);
  assert.throws(() => createEscalator([
    { name: "a", produce: () => null },
    { name: "a", produce: () => null },
  ]), /duplicate/);
  assert.throws(() => createStandardEscalator({}), /planningDeferred/);
});

// ── Orchestrator: positive paths ────────────────────────────────────────────

test("a non-consulting turn runs START -> SHORTCUT -> FINALIZE with zero role calls", async () => {
  const calls = [];
  const orchestrator = orchestratorOf({
    planners: {
      consult: () => { calls.push("consult"); return {}; },
      repair: () => { calls.push("repair"); return { accepted: false }; },
    },
    critic: { critique: () => { calls.push("critique"); return { severity: "none" }; } },
    escalator: { next: () => { calls.push("escalate"); return null; } },
  });
  const state = stateOf();
  const intent = intentOf({ consultModel: false, actionableIntent: false });
  await orchestrator.runTurn(intent, state);
  assert.deepEqual(state.transitions, [PHASE.START, PHASE.SHORTCUT, PHASE.FINALIZE]);
  assert.deepEqual(calls, [], "the deterministic planner already ran; nothing else may be called");
  assert.equal(orchestrator.budget.providerCalls, 0);
  assert.equal(state.answer, "baseline local answer");
});

test("an accepted provider action runs START -> CONSULT -> CRITIQUE -> FINALIZE", async () => {
  const orchestrator = orchestratorOf({
    planners: {
      consult: () => ({ action: ACTION, responseMode: "model", answer: "Raising it now.", goal: { status: "active" } }),
    },
    critic: { critique: () => ({ ok: true, severity: "none" }) },
  });
  const state = stateOf();
  await orchestrator.runTurn(intentOf({ consultModel: true, actionableIntent: true, buildRequest: true }), state);
  assert.deepEqual(state.transitions, [PHASE.START, PHASE.CONSULT, PHASE.CRITIQUE, PHASE.FINALIZE]);
  assert.equal(state.action, ACTION);
  assert.equal(state.responseMode, "model");
  assert.equal(state.providerConsulted, true);
  assert.equal(orchestrator.budget.providerCalls, 1);
});

test("a repaired action is re-critiqued, never trusted", async () => {
  let critiques = 0;
  const orchestrator = orchestratorOf({
    planners: {
      consult: () => ({ action: ACTION, responseMode: "model" }),
      repair: () => ({ accepted: true, action: OTHER_ACTION, answer: "Fixed.", goal: { status: "active" } }),
    },
    critic: {
      critique: (candidate) => {
        critiques += 1;
        return candidate === OTHER_ACTION
          ? { severity: "none" }
          : { severity: "contract", tier: "C2", gate: "intent-match", reason: "wrong subject" };
      },
    },
  });
  const state = stateOf();
  await orchestrator.runTurn(intentOf({ consultModel: true, actionableIntent: true, buildRequest: true }), state);
  assert.deepEqual(state.transitions, [
    PHASE.START, PHASE.CONSULT, PHASE.CRITIQUE, PHASE.REPAIR, PHASE.CRITIQUE, PHASE.FINALIZE,
  ]);
  assert.equal(critiques, 2, "the repaired action must go back through the critic");
  assert.equal(state.action, OTHER_ACTION);
  assert.equal(state.providerActionAccepted, true);
});

test("repair exhaustion escalates instead of shipping nothing", async () => {
  const orchestrator = orchestratorOf({
    planners: {
      consult: () => ({ action: ACTION, responseMode: "model" }),
      repair: () => ({ accepted: false, finalDetail: "still the wrong subject" }),
    },
    critic: {
      critique: (candidate) => (candidate === OTHER_ACTION
        ? { severity: "none" }
        : { severity: "contract", gate: "build-contract", reason: "incomplete" }),
    },
    escalator: ladderFor({ localStructureFallback: () => OTHER_ACTION }),
  });
  const state = stateOf();
  await orchestrator.runTurn(intentOf({ consultModel: true, actionableIntent: true, buildRequest: true }), state);
  assert.deepEqual(state.transitions, [
    PHASE.START, PHASE.CONSULT, PHASE.CRITIQUE, PHASE.REPAIR, PHASE.ESCALATE, PHASE.ESCALATE,
    PHASE.ESCALATE, PHASE.CRITIQUE, PHASE.FINALIZE,
  ]);
  assert.equal(state.action, OTHER_ACTION);
  assert.equal(state.responseMode, "local-structure-fallback");
  assert.ok(state.gateTrace.some((entry) => entry.gate === "repair-failed"));
});

test("a C3 warning verdict ships the plan with a caveat and an active goal", async () => {
  const orchestrator = orchestratorOf({
    planners: {
      consult: () => ({ action: ACTION, responseMode: "model", goal: { status: "complete", summary: "done" } }),
      repair: () => { throw new Error("repair must not run on a warning"); },
    },
    critic: { critique: () => ({ severity: "warning", tier: "C3", warning: "raised to the minimum size" }) },
  });
  const state = stateOf();
  await orchestrator.runTurn(intentOf({ consultModel: true, actionableIntent: true, buildRequest: true }), state);
  assert.equal(state.action, ACTION);
  assert.equal(state.contractCaveat, "raised to the minimum size");
  assert.deepEqual(state.providerGoal, { status: "active", summary: "done" });
  assert.equal(orchestrator.budget.repairRoundsUsed, 0, "accept-with-warning must not cost a repair round");
});

test("the shared budget decrements exactly once per provider call", async () => {
  let consults = 0;
  let repairs = 0;
  const budget = createTurnBudget({ repairRounds: 2, budgetMs: 60_000 });
  const orchestrator = orchestratorOf({
    budget,
    planners: {
      consult: (intent, state, sharedBudget) => {
        consults += 1;
        assert.equal(sharedBudget, budget, "the planner receives the shared budget object by reference");
        return { action: ACTION, responseMode: "model" };
      },
      repair: (intent, state, sharedBudget) => {
        repairs += 1;
        assert.equal(sharedBudget, budget, "repair receives the SAME budget object, not a copy");
        return { accepted: false, finalDetail: "no" };
      },
    },
    critic: { critique: () => ({ severity: "contract", gate: "build-contract", reason: "incomplete" }) },
    escalator: ladderFor({ localStructureFallback: () => OTHER_ACTION }),
  });
  const state = stateOf();
  await orchestrator.runTurn(intentOf({ consultModel: true, actionableIntent: true, buildRequest: true }), state);
  assert.equal(consults, 1);
  assert.equal(repairs, 1);
  assert.equal(budget.providerCalls, consults + repairs);
  assert.equal(budget.consults, 1);
  assert.equal(budget.repairRoundsUsed, 1);
});

test("the turn budget clamps rounds and wall clock exactly like the repair loop", () => {
  assert.equal(createTurnBudget({ env: { MC_WIZARD_REPAIR_ROUNDS: "9" } }).repairRounds, 4);
  assert.equal(createTurnBudget({ env: { MC_WIZARD_REPAIR_ROUNDS: "0" } }).repairRounds, 2);
  assert.equal(createTurnBudget({ env: { MC_WIZARD_REPAIR_ROUNDS: "-3" } }).repairRounds, 1);
  assert.equal(createTurnBudget({ env: {} }).budgetMs, 90_000);
  assert.equal(createTurnBudget({ env: { MC_WIZARD_REPAIR_BUDGET_MS: "999999999" } }).budgetMs, 600_000);
  let clock = 0;
  const budget = createTurnBudget({ repairRounds: 4, budgetMs: 1_000, now: () => clock });
  assert.equal(budget.canRepair(), true);
  clock = 1_000;
  assert.equal(budget.canRepair(), false, "the wall clock stops repair even with rounds left");
});

test("a review that neither completes nor corrects fails closed with no action", async () => {
  const orchestrator = orchestratorOf({
    planners: {
      consult: () => ({ action: null, responseMode: "model", answer: "Looks unfinished." }),
      reviewVerdict: () => ({ complete: false, corrective: false }),
    },
    critic: { critique: () => ({ severity: "none" }) },
    escalator: ladderFor({ localStructureFallback: () => ACTION }),
  });
  const state = stateOf();
  // projectFeedback is true on review turns today; actionableIntent is not.
  await orchestrator.runTurn(
    intentOf({ consultModel: true, reviewRequest: true, projectFeedback: true, actionableIntent: false }),
    state,
  );
  assert.equal(state.action, null, "a review must never be rescued into an unrequested build");
  assert.ok(state.gateTrace.some((entry) => entry.gate === "review-verdict"));
  assert.deepEqual(state.transitions, [
    PHASE.START, PHASE.CONSULT, PHASE.REVIEW, PHASE.ESCALATE, PHASE.FINALIZE,
  ]);
});

// ── Orchestrator: negative paths ────────────────────────────────────────────

test("the provider planner is NEVER called when consultModel is false", async () => {
  const permutations = [];
  for (const actionableIntent of [true, false]) {
    for (const buildRequest of [true, false]) {
      for (const projectFeedback of [true, false]) {
        for (const reviewRequest of [true, false]) {
          for (const answerOnlyRequest of [true, false]) {
            for (const seededAction of [ACTION, null]) {
              permutations.push({
                actionableIntent, buildRequest, projectFeedback, reviewRequest, answerOnlyRequest, seededAction,
              });
            }
          }
        }
      }
    }
  }
  assert.equal(permutations.length, 64);
  for (const permutation of permutations) {
    const { seededAction, ...flags } = permutation;
    let providerCalls = 0;
    const budget = createTurnBudget();
    const orchestrator = orchestratorOf({
      budget,
      planners: {
        consult: () => { providerCalls += 1; return {}; },
        repair: () => { providerCalls += 1; return { accepted: false }; },
      },
      critic: { critique: () => ({ severity: "contract", gate: "existence", reason: "no action" }) },
      escalator: ladderFor({ boundOffer: () => ({ action: null, answer: OFFER }) }),
    });
    const state = stateOf({
      action: seededAction,
      responseMode: seededAction ? "local-skill" : "offline",
    });
    await orchestrator.runTurn(intentOf({ ...flags, consultModel: false }), state);
    assert.equal(providerCalls, 0, `provider called for ${JSON.stringify(flags)}`);
    assert.equal(budget.providerCalls, 0);
    assert.equal(budget.repairRoundsUsed, 0);
    assert.ok(state.answer, "every permutation still ships prose");
  }
});

test("an escalator whose every rung returns null still terminates non-empty", async () => {
  const orchestrator = orchestratorOf({
    critic: { critique: () => ({ severity: "contract", gate: "existence", reason: "no action at all" }) },
    escalator: createEscalator([
      { name: "a", produce: () => null },
      { name: "b", produce: () => null },
      { name: "c", produce: () => null },
    ]),
  });
  const state = stateOf();
  await orchestrator.runTurn(intentOf({ actionableIntent: true, buildRequest: true }), state);
  assert.equal(state.action, null);
  assert.equal(state.responseMode, "local-offer-floor");
  assert.equal(state.answer, OFFER);
  assert.equal(offersAction(state.answer) && !isMenuShape(state.answer), true);
  assert.ok(state.gateTrace.some((entry) => entry.gate === "offer-floor"));
  assert.deepEqual(state.rejectedRungs, ["a", "b", "c"]);
});

test("a floor with no injected offer builder still refuses to ship an empty turn", async () => {
  const orchestrator = createOrchestrator({
    logger: quiet,
    assertions: { offersAction, isMenuShape },
    critic: { critique: () => ({ severity: "fatal", gate: "safety", reason: "forbidden block" }) },
  });
  const state = stateOf({ action: ACTION, responseMode: "local-skill" });
  await orchestrator.runTurn(intentOf({ actionableIntent: true, buildRequest: true }), state);
  assert.equal(state.action, null, "a C0 safety verdict drops the action unconditionally");
  assert.equal(state.responseMode, "local-offer-floor");
  assert.ok(state.answer.length > 0);
  assert.notEqual(state.answer, "baseline local answer");
});

test("a provider that always throws still reaches the terminal deferred rung", async () => {
  let attempts = 0;
  const orchestrator = orchestratorOf({
    planners: {
      consult: () => { attempts += 1; throw new Error("connect ECONNREFUSED"); },
      repair: () => { throw new Error("connect ECONNREFUSED"); },
    },
    critic: { critique: () => ({ severity: "contract", gate: "existence", reason: "no action" }) },
    escalator: ladderFor(),
  });
  const state = stateOf();
  await orchestrator.runTurn(
    intentOf({ consultModel: true, actionableIntent: true, buildRequest: true }),
    state,
  );
  assert.equal(attempts, 1);
  assert.equal(state.responseMode, "planning-deferred");
  assert.equal(state.answer, DEFERRED);
  assert.ok(state.gateTrace.some((entry) => entry.gate === "provider-error"));
  assert.equal(state.rejectedRungs.at(-1), RUNG.PLANNING_DEFERRED);
  assert.ok(state.escalationIndex <= MAX_ESCALATIONS);
});

test("a consult failure never erases the deterministic action the turn already had", async () => {
  const orchestrator = orchestratorOf({
    planners: {
      consult: () => { throw new Error("timeout"); },
      onConsultError: () => ({ answer: "offline answer" }),
    },
    critic: { critique: () => ({ severity: "none" }) },
    escalator: ladderFor(),
  });
  const state = stateOf({ action: OTHER_ACTION, responseMode: "local-skill" });
  await orchestrator.runTurn(
    intentOf({ consultModel: true, actionableIntent: true, terrainIntent: { width: 50, depth: 50, mode: "clear" } }),
    state,
  );
  assert.equal(state.action, OTHER_ACTION, "the offline catch must not launder a working action into nothing");
  assert.equal(state.answer, "offline answer");
});

test("an adversarial provider terminates with a strictly increasing, non-repeating ladder", async () => {
  let served = 0;
  const budget = createTurnBudget({ repairRounds: 2 });
  const indexes = [];
  const base = ladderFor({ classifyAction: () => null, boundOffer: () => ({ action: null, answer: OFFER }) });
  const orchestrator = orchestratorOf({
    budget,
    planners: {
      // Every call returns a brand-new, always-invalid action.
      consult: () => ({ action: { type: "build_structure", plan: { title: `bogus ${served += 1}` } }, responseMode: "model" }),
      repair: () => ({ accepted: true, action: { type: "build_structure", plan: { title: `bogus ${served += 1}` } } }),
    },
    critic: { critique: () => ({ severity: "contract", gate: "intent-match", reason: "never matches" }) },
    escalator: {
      next(escalationIndex, intent, ctx, rejectedRungs) {
        const step = base.next(escalationIndex, intent, ctx, rejectedRungs);
        if (step) indexes.push(step.index);
        return step;
      },
    },
  });
  const state = stateOf();
  await orchestrator.runTurn(intentOf({ consultModel: true, actionableIntent: true, buildRequest: true }), state);
  for (let i = 1; i < indexes.length; i += 1) {
    assert.ok(indexes[i] > indexes[i - 1], "escalation indexes must strictly increase");
  }
  assert.equal(new Set(state.rejectedRungs).size, state.rejectedRungs.length, "no rung is re-litigated");
  assert.ok(state.escalationIndex <= MAX_ESCALATIONS);
  assert.ok(budget.repairRoundsUsed <= budget.repairRounds, "repair rounds stay inside the budget");
  assert.ok(state.answer);
  assert.ok(state.action || offersAction(state.answer) || state.responseMode === "planning-deferred");
});

test("the FINALIZE -> ESCALATE back edge fires at most once", async () => {
  const orchestrator = orchestratorOf({
    critic: { critique: () => ({ severity: "none" }) },
    planners: {
      // Always says the final action no longer advances the request.
      stillAdvances: () => false,
      emptyAnswer: () => "that plan stopped helping",
    },
    escalator: createEscalator([
      { name: "first", produce: () => ACTION, responseMode: "local-structure-fallback" },
      { name: "second", produce: () => OTHER_ACTION, responseMode: "local-structure-fallback" },
      { name: "third", produce: () => OTHER_ACTION, responseMode: "local-structure-fallback" },
    ]),
  });
  const state = stateOf({ action: ACTION, responseMode: "local-skill" });
  await orchestrator.runTurn(intentOf({ actionableIntent: true, buildRequest: true }), state);
  const finalizes = state.transitions.filter((phase) => phase === PHASE.FINALIZE);
  const escalations = state.transitions.filter((phase) => phase === PHASE.ESCALATE);
  assert.equal(finalizes.length, 2, "FINALIZE is re-entered exactly once after the single back edge");
  assert.equal(escalations.length, 1, "the back edge must not cycle");
  assert.equal(state.transitions.at(-1), PHASE.FINALIZE);
  assert.ok(state.answer);
});

// A tiny deterministic PRNG so the randomized matrix is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("500 randomized role outcomes all terminate inside the ladder bound and never ship nothing", async () => {
  const severities = ["none", "warning", "contract", "fatal"];
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = mulberry32(seed);
    const pick = (list) => list[Math.floor(random() * list.length) % list.length];
    const maybeAction = () => (random() < 0.4
      ? { type: "build_structure", plan: { title: `plan ${seed}` } } : null);
    const actionableIntent = random() < 0.7;
    const intent = intentOf({
      consultModel: random() < 0.5,
      actionableIntent,
      buildRequest: actionableIntent && random() < 0.6,
      projectFeedback: actionableIntent && random() < 0.2,
      reviewRequest: false,
      terrainIntent: actionableIntent && random() < 0.3 ? { width: 16, depth: 16, mode: "clear" } : null,
    });
    const budget = createTurnBudget({ repairRounds: 2 });
    const orchestrator = orchestratorOf({
      budget,
      planners: {
        consult: () => {
          if (random() < 0.3) throw new Error("provider unavailable");
          return { action: maybeAction(), responseMode: "model", answer: "model prose" };
        },
        repair: () => {
          if (random() < 0.2) throw new Error("repair transport failed");
          return random() < 0.5
            ? { accepted: true, action: maybeAction() }
            : { accepted: false, finalDetail: "exhausted" };
        },
        reviewVerdict: () => ({ complete: random() < 0.5, corrective: random() < 0.5 }),
        canonicalize: (action) => action,
        stillAdvances: () => random() < 0.7,
      },
      critic: { critique: () => ({ severity: pick(severities), warning: "rough", gate: "fake", reason: "fake" }) },
      escalator: ladderFor({
        classifyAction: () => (random() < 0.3 ? maybeAction() : null),
        provisionalRecipeAction: () => (random() < 0.3 ? maybeAction() : null),
        localStructureFallback: () => (random() < 0.4 ? maybeAction() : null),
        terrainAction: () => (random() < 0.5 ? OTHER_ACTION : null),
        boundOffer: () => (random() < 0.5 ? { action: null, answer: OFFER } : null),
      }),
    });
    const state = stateOf({ action: maybeAction(), responseMode: "local-skill" });
    await orchestrator.runTurn(intent, state);
    const escalations = state.transitions.filter((phase) => phase === PHASE.ESCALATE).length;
    assert.ok(escalations <= MAX_ESCALATIONS, `seed ${seed}: ${escalations} escalations`);
    assert.ok(state.escalationIndex <= MAX_ESCALATIONS, `seed ${seed}: index ${state.escalationIndex}`);
    assert.equal(state.transitions.at(-1), PHASE.FINALIZE, `seed ${seed}: did not terminate in FINALIZE`);
    assert.equal(new Set(state.rejectedRungs).size, state.rejectedRungs.length, `seed ${seed}: rung re-litigated`);
    assert.ok(budget.repairRoundsUsed <= budget.repairRounds, `seed ${seed}: repair budget overrun`);
    if (!intent.consultModel) assert.equal(budget.providerCalls, 0, `seed ${seed}: consulted a model it must not`);
    assert.ok(String(state.answer || "").length > 0, `seed ${seed}: empty answer`);
    if (intent.actionableIntent) {
      assert.ok(
        state.action
          || (offersAction(state.answer) && !isMenuShape(state.answer))
          || state.responseMode === "planning-deferred",
        `seed ${seed}: actionable turn shipped nothing`,
      );
    }
  }
});
