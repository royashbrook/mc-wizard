// #44 WP-E — the owner's invariant, as an executable property.
//
// "Never give up and never do nothing." For any turn where the child asked for
// something the wizard can actually do, ask() must return either a real action
// or a BOUND offer that a following "yes" converts into work. It must never
// return a bare refusal, an empty promise, a documentation excerpt, or silence.
//
// This file is the NON-BUILD half of that proof. test/novel-quality-floor.mjs
// already covers build turns; the live #44 session that motivated this work was
// terrain, and every recovery floor in the old code was lexically gated on
// isBuildRequest, so terrain turns had no floor at all.
//
// TWO RULES THIS FILE OBEYS, BOTH LEARNED FROM THE #44 POST-MORTEM
//
//  1. Every matcher is IMPORTED from the runtime module. The original #44 test
//     re-declared the production refusal regex inline, inherited its exact blind
//     spot ("I can't ..." never matched), and stayed green while the bug shipped
//     to a child. Nothing here re-implements a predicate that production owns.
//  2. Where a predicate is NOT exported, the property is asserted
//     BEHAVIOURALLY instead of by copying the regex. "The offer is bindable" is
//     checked by sending "yes" and requiring an action — not by re-deriving
//     isCapabilityMenuAnswer. A behavioural check cannot share a regex's blind
//     spot at all.
//
// Hermetic: memory sessions, a scripted fetchImpl, the on-disk knowledge corpus.
// No network, no .env, no Bedrock container.
import assert from "node:assert/strict";
import { before, test } from "node:test";

import { extractiveAnswer, loadCorpus } from "../src/rag.mjs";
import { allowedWizardAction } from "../src/skills.mjs";
import {
  answerOffersAction,
  answerRefusesAction,
  createWizard,
} from "../src/wizard.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const PROVIDER_ENV = Object.freeze({
  AI_BASE_URL: "http://model/v1",
  AI_MODEL: "model",
  AI_STYLE: "chat",
  AI_TIMEOUT_MS: "1000",
});

const chatResponse = (content) => new Response(JSON.stringify({
  choices: [{ message: { content } }],
}), { status: 200, headers: { "content-type": "application/json" } });
const envelope = (payload) => chatResponse(JSON.stringify(payload));

// The literal provider prose each hostile behaviour emits. Cells assert against
// these STRINGS, never against a regex, so a cell can never pass merely because
// a detector failed to recognize its own output.
const REFUSAL_FIXTURE = "I can't safely clear a 50x50 area with the available in-world action here.";
const PROMISE_FIXTURE = "Got it - I'll clear and level a 50x50 area for you.";
const INVALID_JSON_FIXTURE = "Sure thing kiddo, consider it handled, no envelope needed.";
const FIXTURES = Object.freeze([REFUSAL_FIXTURE, PROMISE_FIXTURE, INVALID_JSON_FIXTURE]);

// The five hostile provider behaviours the invariant must survive. Each is the
// whole provider for the turn: it never returns a usable action.
const BEHAVIOURS = Object.freeze({
  // The model declines work it is fully permitted to perform (the live #44 bug).
  refuses: () => async () => envelope({ answer: REFUSAL_FIXTURE }),
  // The model narrates work it never attached an action to (the live #42 bug).
  promises: () => async () => envelope({ answer: PROMISE_FIXTURE }),
  // The envelope does not parse at all.
  invalidJson: () => async () => chatResponse(INVALID_JSON_FIXTURE),
  // The transport is down.
  throws: () => async () => { throw new Error("provider hard down"); },
  // The request aborted on the provider timeout.
  timesOut: () => async () => {
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  },
});

// Blocks the executor allowlist rejects outright, checked against whatever
// action actually ships. src/skills.mjs owns the rule; this only proves that no
// newly reachable rung smuggles one past it.
const FORBIDDEN_BLOCKS = /command_block|structure_block|structure_void|mob_spawner|barrier|\btnt\b/i;

// The two verbatim turns from the reported live session, plus the phrasings a
// child actually used around them. Each of these produced action === null and a
// dead-end reply on the shipped code before #44.
const LIVE_TURNS = Object.freeze([
  "clear a 50x50 area around me, starting at the ground beneath this tree",
  "just level the ground, the mountains, and remove all blocks in a 50x50 area starting at the ground where this tree starts",
  "just level the ground, remove all blocks in a 50x50 area",
]);

// A 799-character run-on, the shape a small child types when they are excited.
const RUN_ON = `please ${"clear the ground around here and ".repeat(40)}`.slice(0, 799);

// mustAct === true means: this child asked for something the wizard can do, so
// the turn owes them a real action (or a bindable offer, or the pack-retried
// planning-deferred terminal). mustAct === false means the turn is a question,
// a greeting, or nonsense — an honest "I don't know" is a correct answer there,
// and forcing work would be the over-correction #44 explicitly warns against.
const MATRIX = Object.freeze([
  ...LIVE_TURNS.map((question) => ({ question, mustAct: true })),
  { question: "flatten this hill please", mustAct: true },
  { question: "level the ground here", mustAct: true },
  { question: "wiz can you clear the trees around here", mustAct: true },
  { question: "remove all blocks in a 50x50 area", mustAct: true },
  { question: "remove all the blocks in this area", mustAct: true },
  { question: "can you level the ground where i am standing", mustAct: true },
  { question: "smooth out the land over there", mustAct: true },
  { question: "erase the terrain around me", mustAct: true },
  { question: "wipe out this patch of dirt", mustAct: true },
  { question: "clear a 500x500 area", mustAct: true },
  { question: RUN_ON, mustAct: true },
  { question: "teleport me to the nether", mustAct: true },
  { question: "give me 64 torches", mustAct: true },
  { question: "make it rain tacos", mustAct: true },
  { question: "light up this area", mustAct: true },
  { question: "build a t flip flop", mustAct: true },
  { question: "build an automatic chicken farm", mustAct: true },
  { question: "build me a real dragon that actually flies", mustAct: true },
  { question: "make me a castle", mustAct: true },
  { question: "build me a castle out of rainbow candy", mustAct: true },
  { question: "build a spooky haunted mansion with a secret room", mustAct: true },
  { question: "build me a giant floating pirate ship made of candy canes", mustAct: true },
  // Not actionable. The floor must NOT fire on these: an honest gap, a
  // greeting, or a question the wizard should answer rather than act on.
  { question: "delete minecraft", mustAct: false },
  { question: "make the sun explode", mustAct: false },
  { question: "asdfghjkl", mustAct: false },
  { question: "\u{1F600}\u{1F600}\u{1F600}", mustAct: false },
  { question: "go", mustAct: false },
  { question: "do it", mustAct: false },
  { question: "yes", mustAct: false },
  { question: "do the thing", mustAct: false },
  { question: "hello wizard", mustAct: false },
  { question: "thanks!", mustAct: false },
  { question: "tell me a joke", mustAct: false },
  { question: "what is redstone", mustAct: false },
  { question: "what happens if i dig straight down", mustAct: false },
  { question: "how do i clear an area in minecraft", mustAct: false },
  { question: "just explain how to clear a 50x50 area", mustAct: false },
  // KNOWN LIMIT, recorded here rather than hidden. The terrain rung requires a
  // terrain VERB and a terrain NOUN in the same clause, so "hole" and "pit"
  // phrasings, and "make this flat" (whose null classification is deliberately
  // pinned by test/wizard.test.mjs), do not reach it. They still owe the child
  // a non-empty, non-refusing, non-promising reply — which is all this matrix
  // asserts for them. See README "Current limits".
  { question: "dig out a big hole here", mustAct: false },
  { question: "make this flat", mustAct: false },
]);

let corpus;
// The extractive-corpus prefix, DERIVED from the retrieval module rather than
// copied, so a doc-dump reply cannot slip past this file by being reworded.
let extractivePrefix;

before(async () => {
  corpus = await loadCorpus();
  const sample = extractiveAnswer("what is redstone", [{
    title: "Redstone",
    text: "Redstone is the wiring of Minecraft. Redstone dust carries a signal between components.",
  }]);
  assert.equal(typeof sample, "string", "extractiveAnswer produced nothing to derive a prefix from");
  extractivePrefix = `${sample.split(":")[0]}:`;
  assert.ok(extractivePrefix.length > 8, `derived a useless extractive prefix: ${extractivePrefix}`);
});

let cell = 0;
const wizardFor = (behaviour) => {
  const calls = { count: 0 };
  const wizard = createWizard({
    corpus,
    env: PROVIDER_ENV,
    logger: quiet,
    fetchImpl: async (...args) => {
      calls.count += 1;
      return BEHAVIOURS[behaviour]()(...args);
    },
  });
  return { wizard, calls };
};

// The universal half: true for EVERY cell, actionable or not.
function assertNotEmptyHanded(result, where) {
  assert.equal(typeof result.answer, "string", `no answer at all: ${where}`);
  assert.ok(result.answer.trim().length > 0, `silence: ${where}`);
  for (const fixture of FIXTURES) {
    assert.ok(
      !result.answer.includes(fixture),
      `provider prose shipped verbatim to the child: ${where}\n  ${result.answer}`,
    );
  }
  assert.equal(
    answerRefusesAction(result.answer), false,
    `bare refusal shipped: ${where}\n  ${result.answer}`,
  );
  if (result.action) {
    // Nothing bypassed the allowlist: re-running the gatekeeper over the
    // shipped action returns the shipped action unchanged.
    assert.deepEqual(
      allowedWizardAction(result.action), result.action,
      `action did not survive re-validation: ${where}`,
    );
    assert.doesNotMatch(
      JSON.stringify(result.action), FORBIDDEN_BLOCKS,
      `forbidden block reached an executable action: ${where}`,
    );
  }
}

test("the never-empty matrix: no hostile provider can empty-hand a child", async () => {
  const actionable = MATRIX.filter(({ mustAct }) => mustAct);
  assert.ok(actionable.length >= 20, "the actionable half of the matrix went missing");
  for (const behaviour of Object.keys(BEHAVIOURS)) {
    for (const { question, mustAct } of MATRIX) {
      cell += 1;
      const player = `Cell${cell}`;
      const { wizard } = wizardFor(behaviour);
      const result = await wizard.ask({ player, question });
      const where = `${behaviour} :: ${JSON.stringify(question).slice(0, 80)}`;
      // Universal half — true for every cell, actionable or not.
      assertNotEmptyHanded(result, where);
      if (!mustAct) continue;
      // A documentation excerpt is not an attempt. #42: a child asking the
      // wizard to clear ground was handed scripting docs.
      assert.ok(
        !result.answer.startsWith(extractivePrefix),
        `doc-dump instead of an attempt: ${where}\n  ${result.answer}`,
      );
      if (result.action) continue;
      if (result.mode === "planning-deferred") continue; // main.js retries this one itself
      // No action: the answer must be an offer, and — the part a regex cannot
      // fake — a bare "yes" must convert it into real work next turn.
      assert.ok(
        answerOffersAction(result.answer) && !answerRefusesAction(result.answer),
        `no action and no offer: ${where}\n  mode=${result.mode}\n  ${result.answer}`,
      );
      const bound = await wizard.ask({ player, question: "yes" });
      assert.ok(
        bound.action,
        `the offer could not be bound by "yes": ${where}\n  ${result.answer}`,
      );
    }
  }
  assert.equal(cell, Object.keys(BEHAVIOURS).length * MATRIX.length);
  assert.ok(cell >= 200, `matrix shrank to ${cell} cells`);
});

// The reported live session, pinned verbatim. Before #44, turn 1 shipped the
// refusal unchanged (mode "chat:model") and turn 2 landed in the offline catch
// (mode "offline-fallback"); both delivered action === null to a child.
test("the verbatim live turns produce validated in-world work under every provider failure", async () => {
  for (const behaviour of Object.keys(BEHAVIOURS)) {
    for (const question of LIVE_TURNS) {
      cell += 1;
      const { wizard, calls } = wizardFor(behaviour);
      const result = await wizard.ask({ player: `Live${cell}`, question });
      const where = `${behaviour} :: ${question}`;
      assert.ok(result.action, `no action on a live turn: ${where} (mode=${result.mode})`);
      assert.equal(result.action.type, "terrain_work", where);
      assert.equal(result.action.width, 50, where);
      assert.equal(result.action.depth, 50, where);
      // Deterministic rung: the turn is decided before the provider is reached,
      // so a broken provider cannot take the work away from the child.
      assert.equal(calls.count, 0, `a deterministic terrain turn consulted the provider: ${where}`);
    }
  }
});

// "Never give up" has to mean progress, not politeness: an offer that cannot be
// bound is just a refusal with better manners.
test("a bound offer converges into real work within two turns", async () => {
  const offer = "I can level the ground around you. Want me to?";
  let calls = 0;
  const wizard = createWizard({
    corpus,
    env: PROVIDER_ENV,
    logger: quiet,
    fetchImpl: async () => { calls += 1; return envelope({ answer: offer }); },
  });
  const first = await wizard.ask({ player: "OfferKid", question: "the ground here is bumpy" });
  assert.equal(first.action, null, "the setup turn was supposed to be an offer, not an action");
  assert.equal(answerOffersAction(first.answer), true, first.answer);
  assert.equal(answerRefusesAction(first.answer), false, first.answer);

  const second = await wizard.ask({ player: "OfferKid", question: "yes" });
  assert.ok(second.action, `a bare "yes" after an offer produced nothing: ${second.mode} / ${second.answer}`);
  assert.equal(second.action.type, "terrain_work");
  assert.deepEqual(allowedWizardAction(second.action), second.action);
  // Convergence, not a second clarification: the child is not asked again.
  assert.doesNotMatch(second.answer, /tell me exactly which one/i);
  assert.equal(calls, 1, "binding the offer cost an extra provider call");
});

// -------------------------------------------------------------------------
// NEGATIVE HALF — where "do something anyway" would be the wrong answer.
// -------------------------------------------------------------------------

test("an honest knowledge gap on a non-actionable question still returns no action", async () => {
  for (const question of [
    "what is the airspeed velocity of an unladen swallow",
    "who invented the piano",
    "what happens if i dig straight down",
    "just explain how to clear a 50x50 area",
  ]) {
    for (const behaviour of ["throws", "refuses"]) {
      const { wizard } = wizardFor(behaviour);
      const result = await wizard.ask({ player: `Gap${question.length}${behaviour}`, question });
      assert.equal(result.action, null, `the floor invented work for: ${question}`);
      assert.notEqual(result.mode, "local-offer-floor", question);
      assert.notEqual(result.mode, "planning-deferred", question);
      assertNotEmptyHanded(result, `honest-gap :: ${question}`);
    }
  }
});

test("a conversational turn is never handed an injected offer", async () => {
  for (const question of ["hello wizard", "thanks!", "tell me a joke", "how are you"]) {
    const { wizard, calls } = wizardFor("refuses");
    const result = await wizard.ask({ player: `Chat${question.length}`, question });
    assert.equal(result.action, null, question);
    assert.notEqual(result.mode, "local-offer-floor", question);
    assert.notEqual(result.mode, "planning-deferred", question);
    assert.equal(calls.count, 0, `a canned conversational turn consulted the provider: ${question}`);
  }
});

// The non-binding capability menu is a deliberate shape: it lists alternatives a
// bare "yes" cannot choose between. It must never be treated as a bound offer,
// and a "yes" after it must ask once rather than build something unrequested.
test("a capability menu never becomes a build, and a yes after it asks once", async () => {
  const { wizard, calls } = wizardFor("refuses");
  const menu = await wizard.ask({ player: "MenuKid", question: "what can you do" });
  assert.equal(menu.action, null);
  assert.equal(calls.count, 0);
  const yes = await wizard.ask({ player: "MenuKid", question: "yes" });
  assert.equal(yes.action, null, `an unbound "yes" built something nobody asked for: ${JSON.stringify(yes.action)}`);
  assert.match(yes.answer, /tell me exactly which one/i);
});

// Subject fidelity is a safety line, not a quality preference: a child who asks
// for a dragon must never receive a house, through ANY rung — including the
// newly reachable escalation ladder.
test("a dragon request never yields a house through any rung", async () => {
  const housePlan = {
    title: "Cozy House",
    kind: "house",
    dimensions: { width: 9, depth: 9, height: 5 },
    materials: { primary: "minecraft:oak_planks", accent: "minecraft:glass", roof: "minecraft:oak_planks" },
    features: ["rooms"],
    phases: ["foundation", "shell", "roof", "details"],
    primitives: [
      { shape: "box", phase: "foundation", blockId: "minecraft:oak_planks", from: [0, 0, 0], to: [8, 0, 8] },
      { shape: "box", phase: "shell", blockId: "minecraft:oak_planks", from: [0, 1, 0], to: [8, 3, 8] },
      { shape: "box", phase: "roof", blockId: "minecraft:oak_planks", from: [0, 4, 0], to: [8, 4, 8] },
      { shape: "box", phase: "details", blockId: "minecraft:glass", from: [2, 2, 0], to: [3, 2, 0] },
    ],
  };
  for (const question of ["build me a dragon", "build me a real dragon that actually flies"]) {
    const wizard = createWizard({
      corpus,
      env: PROVIDER_ENV,
      logger: quiet,
      fetchImpl: async () => envelope({
        answer: "Here is a lovely house for you.",
        action: { type: "build_structure", version: 1, plan: housePlan },
      }),
    });
    const result = await wizard.ask({ player: `Dragon${question.length}`, question });
    assert.ok(result.action, question);
    assert.equal(result.action.type, "build_structure", question);
    assert.notEqual(result.action.plan.kind, "house", `a house was substituted for a dragon: ${question}`);
    assert.match(result.action.plan.kind, /dragon/i, question);
    assert.doesNotMatch(result.answer, /house/i, question);
  }
});

// The command scrub must stay the LAST transform on the answer, whatever rung
// produced that answer.
test("an unsafe command answer is still scrubbed on a newly reachable turn", async () => {
  const wizard = createWizard({
    corpus,
    env: PROVIDER_ENV,
    logger: quiet,
    fetchImpl: async () => envelope({ answer: "Easy — just type /kill @e and it all disappears." }),
  });
  const result = await wizard.ask({ player: "ScrubKid", question: "how do i get rid of all the mobs" });
  assert.doesNotMatch(result.answer, /\/kill/, result.answer);
  assert.doesNotMatch(result.answer, /@e\b/, result.answer);
});

// Powerful blocks are allowed, but an unrelated provider command still cannot
// replace the exact typed terrain work the child requested.
test("an unrelated powerful command cannot steal a terrain turn", async () => {
  for (const command of [
    "setblock ~ ~ ~ command_block",
    "setblock ~ ~ ~ tnt",
    "setblock ~ ~ ~ mob_spawner",
  ]) {
    const wizard = createWizard({
      corpus,
      env: PROVIDER_ENV,
      logger: quiet,
      fetchImpl: async () => envelope({
        answer: "On it.",
        action: { type: "run_commands", version: 1, commands: [command] },
      }),
    });
    const result = await wizard.ask({ player: `Ban${command.length}`, question: "clear a 20x20 area around me" });
    assert.ok(result.action, command);
    assert.equal(result.action.type, "terrain_work", command);
  }
});

// A private preference must stay private no matter which rung wrote the answer.
// src/server.mjs keys its redaction to "[private player preference applied]"
// solely on this flag, so the flag surviving the floor IS the privacy contract.
test("a preference-applied turn still flags itself for redaction on a floor answer", async () => {
  const wizard = createWizard({ corpus, env: {}, logger: quiet });
  const saved = await wizard.ask({
    player: "PrefKid",
    playerId: "bedrock-pref",
    question: "always build with red mushroom blocks",
  });
  assert.ok(saved.preferences.length >= 1, "the preference was not saved");
  const terrain = await wizard.ask({
    player: "PrefKid",
    playerId: "bedrock-pref",
    question: "clear a 50x50 area around me, starting at the ground beneath this tree",
  });
  assert.ok(terrain.action, terrain.mode);
  assert.equal(terrain.preferenceApplied, true, "the redaction flag was lost on a floor turn");
});

// A concrete terrain order issued while a project is active must still be
// performed. Previously it became vague project feedback ("I can make a start
// on that"), and a following "yes" bound that prose into a build subject and
// sculpted a statue of "a start on" - nonsense to a child who asked for
// flat ground.
test("a terrain order mid-project is performed, not turned into a vague offer", async () => {
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: {},
    fetchImpl: async () => { throw new Error("provider offline"); },
  });
  const first = await wizard.ask({
    player: "SeqKid",
    question: "clear a 50x50 area around me, starting at the ground beneath this tree",
  });
  assert.equal(first.action?.type, "terrain_work");

  const second = await wizard.ask({
    player: "SeqKid",
    question: "just level the ground, the mountains, and remove all blocks in a 50x50 area starting at the ground where this tree starts",
  });
  assert.equal(second.action?.type, "terrain_work", `mid-project terrain order produced: ${second.answer}`);
  assert.equal(second.action.mode, "level");
});

// Negative half: genuine feedback on an active build is still feedback, and
// must not be hijacked into a terrain fill.
test("ordinary project feedback is not hijacked by the terrain rung", async () => {
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: {},
    fetchImpl: async () => { throw new Error("provider offline"); },
  });
  await wizard.ask({ player: "FeedbackKid", question: "build me a castle" });
  const feedback = await wizard.ask({ player: "FeedbackKid", question: "make it taller" });
  assert.notEqual(feedback.action?.type, "run_commands");
});
