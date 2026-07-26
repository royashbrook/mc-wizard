import assert from "node:assert/strict";
import test from "node:test";

import { explicitlyRequestsCommand } from "../src/command-safety.mjs";
import { allowedWizardAction } from "../src/skills.mjs";
import { classifyAction } from "../src/wizard.mjs";
import { createTravelDetector } from "../src/roles/travel.mjs";

const never = () => false;

// localTravelAction and dimensionTravelAction are module-private in
// src/wizard.mjs, so these tests drive the REAL ones through the exported
// classifyAction: nothing else in the ladder emits a local_travel or a
// dimension_travel action, so a result of that type IS the corresponding
// builder's result. The one thing classifyAction hides is the
// INVALID_LOCAL_TRAVEL sentinel (it converts it to null at wizard.mjs:1952), so
// the stub re-raises it for exactly the set wizard.mjs:1588 refuses.
const SENTINEL = Symbol("invalid-local-travel");
const UNLOCATABLE = /\b(?:desert|jungle)\s+temple\b|\bwitch\s+hut\b|\bigloo\b/i;
const localCalls = [];
const dimensionCalls = [];

// #44 WP-F wiring: classifyAction now routes travel phrasings through THIS
// detector, so on its own it can no longer stand in for the RAW builder — it
// would answer phrasings the raw builder cannot read and the rewrite path would
// never be exercised. The raw builder only recognises a structure when the
// request says "nearest"/"closest", and only recognises an escape when it says
// "surface" (src/wizard.mjs localTravelAction), so only those questions are
// forwarded to the ladder. Everything else is the raw builder's own null.
const RAW_LOCAL_TRAVEL_READS = /\b(?:nearest|closest|surface)\b/i;

function localTravelAction(question) {
  localCalls.push(question);
  if (/\b(?:nearest|closest)\b/i.test(question) && UNLOCATABLE.test(question)) return SENTINEL;
  if (!RAW_LOCAL_TRAVEL_READS.test(question)) return null;
  const action = classifyAction(question);
  return action?.type === "local_travel" ? action : null;
}

function dimensionTravelAction(question) {
  dimensionCalls.push(question);
  const action = classifyAction(question);
  return action?.type === "dimension_travel" ? action : null;
}

// explicitlyRequestsBuild, isRecipeRequest and isOrdinaryConversation are also
// module-private, so they are deliberately pinned to `false`: every negative
// below therefore has to be closed by the detector's OWN structure, not by a
// bail it merely delegates. The delegated bails get their own test.
function makeDetector(overrides = {}) {
  return createTravelDetector({
    localTravelAction,
    dimensionTravelAction,
    allowedWizardAction,
    explicitlyRequestsBuild: never,
    explicitlyRequestsCommand,
    isRecipeRequest: never,
    isOrdinaryConversation: never,
    ...overrides,
  });
}

const detector = makeDetector();

// The four phrasings measured as misses: every one returned action null and
// "my spellbook has nothing on that yet" end to end.
const MEASURED_MISSES = [
  "bring me home",
  "send me to spawn",
  "teleport me to the village",
  "get me out of this cave",
];

/* ------------------------------- POSITIVE ------------------------------- */

test("every measured miss is now recognised as travel", () => {
  for (const question of MEASURED_MISSES) {
    const intent = detector.travelIntent(question);
    assert.ok(intent, `${question} produced no travel intent`);
    assert.ok(Object.isFrozen(intent), question);
    assert.equal(typeof intent.label, "string");
    assert.ok(intent.label.length > 0, question);
    assert.equal(typeof intent.step, "string");
    assert.ok(intent.step.length > 0, `${question} named no concrete step`);
    // #44 WP-F (the wiring): the two misses an existing builder CAN express are
    // now real ladder actions, and the two with no builder behind them are
    // still never quietly substituted with a different destination.
    const action = classifyAction(question);
    if (intent.supported) {
      assert.ok(action, `${question} is recognised but the wired ladder still answers nothing`);
      assert.match(action.type, /^(?:local|dimension)_travel$/, question);
    } else {
      assert.equal(action, null, `${question} was substituted with another destination`);
    }
  }
});

test("\"teleport me to the village\" reaches the real nearest-village action", () => {
  const action = detector.travelAction("teleport me to the village");
  assert.deepEqual(action, { type: "local_travel", version: 1, destination: "nearest_village" });
  const intent = detector.travelIntent("teleport me to the village");
  assert.equal(intent.mode, "structure");
  assert.equal(intent.destination, "village");
  assert.equal(intent.supported, true);
  assert.equal(intent.caveat, undefined);
});

test("\"get me out of this cave\" reaches the real surface action", () => {
  const action = detector.travelAction("get me out of this cave");
  assert.deepEqual(action, { type: "local_travel", version: 1, destination: "surface" });
  const intent = detector.travelIntent("get me out of this cave");
  assert.equal(intent.mode, "surface");
  assert.equal(intent.destination, "surface");
  assert.equal(intent.supported, true);
});

test("spawn and home are recognised, named, and never substituted", () => {
  for (const [question, mode] of [["send me to spawn", "spawn"], ["bring me home", "home"]]) {
    const intent = detector.travelIntent(question);
    assert.equal(intent.mode, mode, question);
    assert.equal(intent.supported, false, question);
    assert.equal(typeof intent.caveat, "string", question);
    assert.ok(intent.caveat.length > 0, question);
    // Recognising the intent must NOT quietly move the child somewhere else.
    assert.equal(detector.travelAction(question), null, question);
  }
});

test("ordinary child travel phrasings reach a real travel action", () => {
  const expected = [
    ["teleport me to the village", "local_travel"],
    ["take me to the village", "local_travel"],
    ["send me to the nearest village", "local_travel"],
    ["bring us to the stronghold", "local_travel"],
    ["teleport me to the ocean monument", "local_travel"],
    ["wiz can you take me to the woodland mansion", "local_travel"],
    ["get me out of this cave", "local_travel"],
    ["get me out of the mines", "local_travel"],
    ["take me up to the surface", "local_travel"],
    ["help me get out of this cave", "local_travel"],
    ["i want to go to the village", "local_travel"],
    ["take me to the nether", "dimension_travel"],
    ["send me to the end", "dimension_travel"],
    ["get me out of the nether", "dimension_travel"],
    ["let's go to the overworld", "dimension_travel"],
    ["please teleport us to the nether", "dimension_travel"],
  ];
  for (const [question, type] of expected) {
    const action = detector.travelAction(question);
    assert.ok(action && typeof action === "object", `${question} produced no action`);
    assert.equal(action.type, type, question);
    assert.equal(action.version, 1, question);
    assert.equal(detector.travelIntent(question).supported, true, question);
  }
});

test("the allowlist round-trips every travel action unchanged", () => {
  for (const question of [
    "teleport me to the village",
    "get me out of this cave",
    "take me to the nether",
    "bring us to the stronghold",
  ]) {
    const action = detector.travelAction(question);
    assert.deepEqual(allowedWizardAction(action), action, question);
  }
});

test("the canonical phrases handed to the builders are the ones the real ladder accepts", () => {
  // Each canonical phrase this module can emit, verified against the REAL
  // exported ladder so the normalisation can never drift away from the
  // builders it targets.
  const canonical = [
    ["take me to the nearest village", "local_travel", "nearest_village"],
    ["take me to the surface", "local_travel", "surface"],
    ["take me to the nearest stronghold", "local_travel", "nearest_structure"],
    ["take me to the nearest ocean monument", "local_travel", "nearest_structure"],
    ["take me to the nether", "dimension_travel", "nether"],
    ["take me to the end", "dimension_travel", "the_end"],
    ["take me to the overworld", "dimension_travel", "overworld"],
  ];
  for (const [phrase, type, destination] of canonical) {
    const action = classifyAction(phrase);
    assert.ok(action, `${phrase} is no longer accepted by the ladder`);
    assert.equal(action.type, type, phrase);
    assert.equal(action.destination, destination, phrase);
  }
});

test("the child's own wording is offered to the builder before any rewrite", () => {
  localCalls.length = 0;
  const action = detector.travelAction("take me to the nearest fortress in the nether");
  assert.equal(localCalls[0], "take me to the nearest fortress in the nether");
  // The original carried a dimension qualifier the canonical phrase would drop.
  assert.equal(action.structure, "fortress");
  assert.equal(action.dimension, "nether");
});

test("a rewrite only happens when the builder could not read the original", () => {
  localCalls.length = 0;
  detector.travelAction("teleport me to the village");
  assert.deepEqual(localCalls, ["teleport me to the village", "take me to the nearest village"]);
  localCalls.length = 0;
  detector.travelAction("get me out of this cave");
  assert.deepEqual(localCalls, ["get me out of this cave", "take me to the surface"]);
  dimensionCalls.length = 0;
  detector.travelAction("take me to the nether");
  assert.deepEqual(dimensionCalls, ["take me to the nether"]);
});

/* ------------------------------- NEGATIVE ------------------------------- */

test("only the two travel action types can ever leave this rung", () => {
  const questions = [
    ...MEASURED_MISSES,
    "take me to the nether", "send me to the end", "bring us to the stronghold",
    "take me up to the surface", "let's go to the overworld",
  ];
  for (const question of questions) {
    const action = detector.travelAction(question);
    if (!action) continue;
    assert.ok(["local_travel", "dimension_travel"].includes(action.type), question);
    // No command surface, no program, no entity selector, nothing to smuggle.
    assert.equal(action.commands, undefined, question);
    assert.equal(action.program, undefined, question);
    assert.doesNotMatch(JSON.stringify(action), /@[aeprs]\b|kill|summon|command_block|tnt|\bop\b|gamerule/i, question);
  }
});

test("moving somebody else is refused outright, never routed around consent", () => {
  for (const question of [
    "teleport my friend to spawn",
    "send him to the village",
    "bring them home",
    "take everyone else to the surface",
    "teleport my brother to the nether",
    "move the other players to the village",
  ]) {
    assert.equal(detector.travelIntent(question), null, question);
    assert.equal(detector.travelAction(question), null, question);
  }
});

test("questions and lessons about travel are answered, not executed", () => {
  for (const question of [
    "how do i get to the nether",
    "how do you get to the village",
    "how do i get out of a cave",
    "how to get to spawn",
    "just explain how to get to the nether",
    "what is the nether like",
    "where is the nearest village",
    "why is spawn so far away",
    "what does a stronghold look like",
    "tell me how to get home",
  ]) {
    assert.equal(detector.travelIntent(question), null, `travel stole: ${question}`);
    assert.equal(detector.travelAction(question), null, `travel stole: ${question}`);
  }
});

test("gifts, builds, recipes and chatter are not stolen by the travel rung", () => {
  for (const question of [
    // Gift phrasings that share a verb with travel.
    "send me some food",
    "bring me 64 blocks of stone",
    "hand me an enchanted pickaxe",
    "give me a bow",
    "get me some torches",
    // Builds, including travel-flavoured ones.
    "build me a nether portal",
    "build a road to the village",
    "make me a house at spawn",
    "build a bridge over this cave",
    // Recipes and lessons.
    "how do i craft a hopper",
    "what does night vision do",
    // Ordinary conversation that mentions places.
    "i love the nether",
    "my home is so cool",
    "the village near me has a library",
    "spawn is really pretty",
    // Travel verbs with no destination at all.
    "take me through how redstone works",
    "get me out of here",
    "send me a message",
  ]) {
    assert.equal(detector.travelIntent(question), null, `travel stole: ${question}`);
    assert.equal(detector.travelAction(question), null, `travel stole: ${question}`);
  }
});

test("spawn and home words that are not destinations stay unrecognised", () => {
  for (const question of [
    "bring me a spawn egg",
    "send me a spawner",
    "take me to spawn a zombie",
    "build me a new home",
  ]) {
    assert.equal(detector.travelAction(question), null, question);
  }
});

test("the builder's hard-stop sentinel is preserved, and suppresses the offer", () => {
  for (const question of [
    "teleport me to the desert temple",
    "take me to the nearest igloo",
    "bring me to the closest witch hut",
  ]) {
    assert.equal(typeof detector.travelAction(question), "symbol", `${question} lost the hard stop`);
    assert.equal(detector.travelIntent(question), null, `${question} offered a trip it cannot make`);
  }
});

test("each injected bail suppresses a request the detector would otherwise take", () => {
  const question = "teleport me to the village";
  assert.ok(detector.travelAction(question), "control case must produce an action");
  for (const bail of ["explicitlyRequestsBuild", "isRecipeRequest", "isOrdinaryConversation"]) {
    const bailing = makeDetector({ [bail]: () => true });
    assert.equal(bailing.travelIntent(question), null, bail);
    assert.equal(bailing.travelAction(question), null, bail);
  }
  const commandBail = makeDetector({ explicitlyRequestsCommand: () => true });
  assert.equal(commandBail.travelIntent(question), null);
  assert.equal(commandBail.travelAction(question), null);
});

test("the factory refuses to build without every injected dependency", () => {
  const complete = {
    localTravelAction,
    dimensionTravelAction,
    allowedWizardAction,
    explicitlyRequestsBuild: never,
    explicitlyRequestsCommand,
    isRecipeRequest: never,
    isOrdinaryConversation: never,
  };
  assert.throws(() => createTravelDetector(), TypeError);
  assert.throws(() => createTravelDetector({}), TypeError);
  for (const key of Object.keys(complete)) {
    const missing = { ...complete };
    delete missing[key];
    assert.throws(() => createTravelDetector(missing), new RegExp(key), key);
  }
});

test("empty and non-string input produce no travel plan", () => {
  for (const question of ["", "   ", undefined, null, 42, {}]) {
    assert.equal(detector.travelIntent(question), null, String(question));
    assert.equal(detector.travelAction(question), null, String(question));
  }
});

test("the detector is pure: the same question answers the same way every time", () => {
  for (const question of [...MEASURED_MISSES, "take me to the nether", "how do i get to the nether"]) {
    const first = detector.travelAction(question);
    const second = detector.travelAction(question);
    assert.deepEqual(second, first, question);
    assert.deepEqual(detector.travelIntent(question), detector.travelIntent(question), question);
  }
});
