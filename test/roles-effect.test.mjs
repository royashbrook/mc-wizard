import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRequesterCommand } from "../bedrock/behavior_packs/mc_wizard/scripts/capability-runtime.js";
import { explicitlyRequestsCommand } from "../src/command-safety.mjs";
import { allowedWizardAction } from "../src/skills.mjs";
import { classifyAction } from "../src/wizard.mjs";
import {
  ALLOWED_EFFECTS,
  FLY_CAVEAT,
  createEffectDetector,
  effectCommand,
} from "../src/roles/effect.mjs";

const never = () => false;

// The detector is wired with the REAL allowlist and the REAL command-request
// detector. explicitlyRequestsBuild, isRecipeRequest and isOrdinaryConversation
// are module-private in src/wizard.mjs, so they are deliberately pinned to
// `false`: every negative below therefore has to be closed by the detector's
// OWN structure, not by a bail it merely delegates. The delegated bails get
// their own test.
//
// commandAction is pinned to `null` on purpose too, so the composed fallback
// path — the one this module authors itself — is what every command assertion
// below is checking, re-validated by the real allowedWizardAction.
const detector = createEffectDetector({
  commandAction: () => null,
  allowedWizardAction,
  explicitlyRequestsBuild: never,
  explicitlyRequestsCommand,
  isRecipeRequest: never,
  isOrdinaryConversation: never,
});

// The same detector wired to the REAL ladder in src/wizard.mjs, which owns the
// existing effect builder (commandAction). This proves the normalised requests
// this module hands over are ones the shipped builder already accepts.
const wired = createEffectDetector({
  commandAction: (question) => classifyAction(question),
  allowedWizardAction,
  explicitlyRequestsBuild: never,
  explicitlyRequestsCommand,
  isRecipeRequest: never,
  isOrdinaryConversation: never,
});

// The three measured misses: today each of these returns no action at all and
// the child hears "my spellbook has nothing on that yet".
const MEASURED_MISSES = ["make me fly", "i want to be fast", "heal me"];

const EFFECT_PHRASES = [
  ...MEASURED_MISSES,
  "give me night vision",
  "can i have night vision",
  "wiz can you make me strong",
  "make me invisible",
  "i want to breathe underwater",
  "let me jump really high",
  "make me fireproof",
  "help me mine faster",
  "night vision",
  "speed please",
  "i need slow falling",
  "cast fire resistance on me",
  "make me tougher",
  "apply regeneration to me",
  "conduit power",
  "make me faster",
  "i wanna be invisible",
];

// `effect @s <id> 999999 0 true` and nothing else.
const EFFECT_LINE = /^effect @s ([a-z_]+) 999999 0 true$/;

/* ------------------------------- POSITIVE ------------------------------- */

test("the three measured misses now reach a real effect action", () => {
  for (const question of MEASURED_MISSES) {
    const intent = detector.effectIntent(question);
    assert.ok(intent, `${question} was not recognised`);
    assert.equal(intent.mode, "grant");
    assert.ok(intent.effects.length >= 1, question);
    const action = detector.effectAction(question);
    assert.ok(action, `${question} produced no action`);
    assert.equal(action.type, "run_commands");
    assert.equal(action.version, 1);
    for (const command of action.commands) assert.match(command, EFFECT_LINE, question);
  }
});

test("ordinary child words map to the effect the wizard already emits", () => {
  const expected = [
    ["i want to be fast", ["speed"]],
    ["make me faster", ["speed"]],
    ["heal me", ["regeneration"]],
    ["make me strong", ["strength"]],
    ["make me invisible", ["invisibility"]],
    ["make me fireproof", ["fire_resistance"]],
    ["i want to breathe underwater", ["water_breathing"]],
    ["let me jump really high", ["jump_boost"]],
    ["help me mine faster", ["haste"]],
    ["make me tougher", ["resistance"]],
    ["i need slow falling", ["slow_falling"]],
    ["give me night vision", ["night_vision"]],
    ["conduit power", ["conduit_power"]],
  ];
  for (const [question, effects] of expected) {
    const intent = detector.effectIntent(question);
    assert.ok(intent, `${question} was not recognised`);
    assert.deepEqual([...intent.effects], effects, question);
    assert.deepEqual(detector.effectAction(question).commands, effects.map(effectCommand), question);
  }
});

test("the intent record is frozen and names one concrete step", () => {
  const intent = detector.effectIntent("i want to be fast");
  assert.ok(Object.isFrozen(intent));
  assert.ok(Object.isFrozen(intent.effects));
  assert.deepEqual({ ...intent }, {
    mode: "grant",
    effects: ["speed"],
    label: "speed",
    request: "give me speed",
  });
  // An unsubstituted grant carries no caveat, exactly like the terrain planner.
  assert.equal(intent.caveat, undefined);
});

test("every effect phrasing yields commands the pack's own normalizer accepts", () => {
  for (const question of EFFECT_PHRASES) {
    const action = detector.effectAction(question);
    assert.ok(action, `${question} produced no action`);
    assert.ok(action.commands.length >= 1 && action.commands.length <= 2, question);
    for (const command of action.commands) {
      assert.equal(normalizeRequesterCommand(command), command, question);
      assert.ok(command.length <= 500, question);
      assert.ok(!/[\r\n\0]/.test(command), question);
    }
  }
});

test("the allowlist round-trips the whole effect action unchanged", () => {
  for (const question of EFFECT_PHRASES) {
    const action = detector.effectAction(question);
    assert.deepEqual(allowedWizardAction(action), action, question);
    assert.deepEqual(Object.keys(action), ["type", "version", "commands"], question);
  }
});

test("the normalised request is one the shipped wizard builder already accepts", () => {
  // Every id in the allowlist round-trips through the REAL ladder, so handing
  // it `give me <effect>` reuses today's validated builder rather than a new
  // privileged path.
  for (const id of ALLOWED_EFFECTS) {
    const request = `give me ${id.replace(/_/g, " ")}`;
    assert.deepEqual(classifyAction(request), {
      type: "run_commands", version: 1, commands: [effectCommand(id)],
    }, request);
  }
  // And the wired detector produces exactly what the composed fallback does.
  for (const question of EFFECT_PHRASES) {
    assert.deepEqual(wired.effectAction(question), detector.effectAction(question), question);
  }
});

test("every emitted effect id belongs to the closed allowlist", () => {
  const allowed = new Set(ALLOWED_EFFECTS);
  assert.equal(allowed.size, 12);
  for (const question of EFFECT_PHRASES) {
    for (const command of detector.effectAction(question).commands) {
      const id = command.match(EFFECT_LINE)?.[1];
      assert.ok(allowed.has(id), `${question} emitted un-allowlisted effect ${id}`);
    }
    for (const id of detector.effectIntent(question).effects) {
      assert.ok(allowed.has(id), `${question} claimed un-allowlisted effect ${id}`);
    }
  }
});

test("the fly substitution is never silent", () => {
  const intent = detector.effectIntent("make me fly");
  assert.deepEqual([...intent.effects], ["jump_boost", "slow_falling"]);
  assert.equal(intent.caveat, FLY_CAVEAT);
  assert.match(intent.caveat, /jump boost/i);
  assert.match(intent.caveat, /slow falling/i);
  // No single-effect builder request is claimed for the composed substitution.
  assert.equal(intent.request, null);
  assert.deepEqual(detector.effectAction("make me fly").commands, [
    effectCommand("jump_boost"), effectCommand("slow_falling"),
  ]);
});

/* ------------------------------- NEGATIVE ------------------------------- */

test("questions about effects are answered, not cast", () => {
  for (const question of [
    "what does night vision do",
    "how do i get speed",
    "how do i fly in minecraft",
    "what is the fastest way to travel",
    "is night vision better than a torch",
    "why am i so slow",
    "what effect makes you jump higher",
    "tell me about the speed effect",
    "can you explain regeneration",
    "does strength work on arrows",
  ]) {
    assert.equal(detector.effectIntent(question), null, question);
    assert.equal(detector.effectAction(question), null, question);
  }
});

test("recipes and command lessons keep their own routes", () => {
  for (const question of [
    "how do you make a potion of healing",
    "what command gives night vision",
    "how do i craft a potion of swiftness",
    "teach me the effect command",
    "what is the syntax for /effect",
  ]) {
    assert.equal(detector.effectIntent(question), null, question);
    assert.equal(detector.effectAction(question), null, question);
  }
});

test("builds and gifts are never stolen by the effect detector", () => {
  for (const question of [
    "build me a fast minecart track",
    "make me a house",
    "build a tower and make me strong",
    "give me a speed potion",
    "hand me an enchanted pickaxe",
    "give me 64 blocks of stone",
    "i need some boots with speed",
    "make me 3 golden apples",
    "construct a fast rail line",
  ]) {
    assert.equal(detector.effectIntent(question), null, question);
    assert.equal(detector.effectAction(question), null, question);
  }
});

test("travel requests keep their own route", () => {
  for (const question of [
    "teleport me to the village",
    "bring me home",
    "send me to spawn",
    "get me out of this cave",
    "make me fly to spawn",
    "tp me up to the surface",
  ]) {
    assert.equal(detector.effectIntent(question), null, question);
    assert.equal(detector.effectAction(question), null, question);
  }
});

test("an effect aimed at anyone but the requester is refused, never retargeted", () => {
  for (const question of [
    "make my friend fast",
    "give everyone speed",
    "give us all night vision",
    "make my brother invisible",
    "heal them",
    "give her strength",
    "make the whole server fireproof",
  ]) {
    assert.equal(detector.effectIntent(question), null, question);
    assert.equal(detector.effectAction(question), null, question);
  }
});

test("ordinary conversation with an effect word is not a work order", () => {
  for (const question of [
    "that was fast",
    "fast",
    "strong",
    "tough",
    "the zombie was strong",
    "i fell and i am hurt",
    "help me find diamonds",
    "help me build a house",
  ]) {
    assert.equal(detector.effectIntent(question), null, question);
    assert.equal(detector.effectAction(question), null, question);
  }
});

test("each injected bail suppresses a request the detector would otherwise take", () => {
  const question = "make me fast";
  assert.ok(detector.effectAction(question), "control case must produce an action");
  const base = {
    commandAction: () => null,
    allowedWizardAction,
    explicitlyRequestsBuild: never,
    explicitlyRequestsCommand,
    isRecipeRequest: never,
    isOrdinaryConversation: never,
  };
  for (const bail of ["explicitlyRequestsBuild", "isRecipeRequest", "isOrdinaryConversation"]) {
    const bailing = createEffectDetector({ ...base, [bail]: () => true });
    assert.equal(bailing.effectIntent(question), null, bail);
    assert.equal(bailing.effectAction(question), null, bail);
  }
  const commandBail = createEffectDetector({ ...base, explicitlyRequestsCommand: () => true });
  assert.equal(commandBail.effectIntent(question), null);
  assert.equal(commandBail.effectAction(question), null);
});

test("no emitted command can smuggle a dangerous payload", () => {
  const forbidden = /command_block|command block|tnt|lava|kill|summon|@a|@e|@p|@r|\[tag=|setblock|clone|fill|gamerule|execute|\bop\b|\bgive\b|\btp\b/i;
  const hostile = [
    ...EFFECT_PHRASES,
    "make me fast\nkill @e",
    "heal me; op me",
    "make me strong and summon a tnt block",
    "give me night vision /gamerule keepInventory true",
    "make me fast effect @a[tag=everyone] speed 999999 255 true",
    "make me fly instant_damage",
    "give me speed 255",
    "heal me with instant health 100",
  ];
  for (const question of hostile) {
    const action = detector.effectAction(question);
    if (!action) continue;
    for (const command of action.commands) {
      assert.doesNotMatch(command, forbidden, `${question} -> ${command}`);
      assert.match(command, EFFECT_LINE, `${question} -> ${command}`);
      // Always the requester, never a selector that reaches another player.
      assert.ok(command.startsWith("effect @s "), `${question} -> ${command}`);
      assert.ok(!command.includes("\n") && !command.includes("\r") && !command.includes("\0"), question);
    }
  }
});

test("the detector never returns a raw candidate the allowlist rejects", () => {
  const rejecting = createEffectDetector({
    commandAction: () => null,
    allowedWizardAction: () => null,
    explicitlyRequestsBuild: never,
    explicitlyRequestsCommand,
    isRecipeRequest: never,
    isOrdinaryConversation: never,
  });
  for (const question of EFFECT_PHRASES) {
    assert.equal(rejecting.effectAction(question), null, question);
    // The intent still stands, so the never-empty floor can still make an offer.
    assert.ok(rejecting.effectIntent(question), question);
  }
});

test("the factory refuses to build without every injected dependency", () => {
  const complete = {
    commandAction: () => null,
    allowedWizardAction,
    explicitlyRequestsBuild: never,
    explicitlyRequestsCommand,
    isRecipeRequest: never,
    isOrdinaryConversation: never,
  };
  assert.throws(() => createEffectDetector(), TypeError);
  assert.throws(() => createEffectDetector({}), TypeError);
  for (const key of Object.keys(complete)) {
    const missing = { ...complete };
    delete missing[key];
    assert.throws(() => createEffectDetector(missing), new RegExp(key), key);
  }
});

test("empty and non-string input produce no effect plan", () => {
  for (const question of ["", "   ", undefined, null, 42, {}]) {
    assert.equal(detector.effectIntent(question), null, String(question));
    assert.equal(detector.effectAction(question), null, String(question));
  }
});
