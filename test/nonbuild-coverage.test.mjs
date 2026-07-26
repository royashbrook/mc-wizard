// #44 — the non-build coverage proof.
//
// THE MEASUREMENT THIS FILE EXISTS TO PIN. Twenty-four ordinary child phrasings
// were run through the shipped classifier before the non-build detectors were
// wired. Ten produced an action; FOURTEEN produced action === null and the
// canned dead end ("my spellbook has nothing on that yet"), even though the
// Wizard demonstrably owns the powers behind them — world_control already knew
// clear/rain/thunder and the time of day, giveItemsAction already delivered
// items, dimensionTravelAction/localTravelAction already moved the requester,
// and commandAction already cast twelve status effects. The gap was recognition,
// never capability. That is the bimodal failure the whole effort targets, and
// this file is its executable receipt.
//
//   GIFT   2/6 hit — missed: "i need 64 blocks of stone", "hand me an enchanted
//                    pickaxe", "gimme some food", "can you give my friend a bow"
//   TRAVEL 2/6 hit — missed: "bring me home", "send me to spawn",
//                    "teleport me to the village", "get me out of this cave"
//   EFFECT 3/6 hit — missed: "make me fly", "i want to be fast", "heal me"
//   ADMIN  3/6 hit — missed: "turn on keep inventory", "make it peaceful",
//                    "stop the rain"
//
// WHAT IS ASSERTED, AND WHY IN THIS SHAPE
//   1. COVERAGE. Every one of the twenty-four ends in a real executable action
//      or a bound offer that names a concrete step — never the dead end, never
//      silence, never a bare refusal.
//   2. ROUND TRIP. Where a cell ends in an offer, the offer is exercised: a bare
//      "yes" is sent and the result is asserted. Behavioural, never by copying a
//      production regex — an offer that cannot be bound is a refusal with better
//      manners.
//   3. NEGATIVE HALVES, which matter exactly as much. Detecting more intent must
//      not steal turns that belong elsewhere (questions, lessons, recipes,
//      builds) and must not deliver anything the item allowlist refuses.
//   4. AUTHORITY UNCHANGED. Recognising more phrasings grants no new privileged
//      surface: the only server.console program still reachable is the existing
//      op/deop of the REQUESTER, nothing reaches server.configure, and no
//      gamerule / difficulty / gamemode command exists anywhere.
//   5. COST. The detectors are pure recognition, so they buy no provider calls:
//      the canned turns still cost zero, and so does every turn the
//      deterministic ladder can answer by itself.
//
// TWO RULES INHERITED FROM test/never-empty.test.mjs, BOTH LEARNED THE HARD WAY
//   * Every matcher is IMPORTED from the runtime (answerOffersAction,
//     answerRefusesAction, ALLOWED_EFFECTS, effectCommand, FLY_CAVEAT,
//     allowedWizardAction). The dead-end sentence, which is NOT exported, is
//     extracted from src/wizard.mjs at load time rather than retyped, so this
//     file cannot quietly pass by disagreeing with production about its wording.
//   * Anything a regex could fake is asserted behaviourally instead.
//
// Hermetic: memory sessions, a scripted fetchImpl, the on-disk corpus. No
// network, no .env, no Bedrock container.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";

import { loadCorpus } from "../src/rag.mjs";
import { ALLOWED_EFFECTS, FLY_CAVEAT, effectCommand } from "../src/roles/effect.mjs";
import { allowedWizardAction } from "../src/skills.mjs";
import {
  answerOffersAction,
  answerRefusesAction,
  classifyAction,
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

// The literal prose the hostile provider emits. Cells assert against this
// STRING, so a cell can never pass merely because a detector failed to
// recognise the model's own output.
const MODEL_PROSE = "I can't safely do that with the available in-world action here.";

// Two worlds, because a child's turn must land the same way in both: with no
// provider configured at all, and with a provider that is reachable and useless.
const WORLDS = Object.freeze({
  offline: () => ({ env: {}, reply: null }),
  // A fresh Response per call: a body may only be read once.
  hostileProvider: () => ({ env: PROVIDER_ENV, reply: () => envelope({ answer: MODEL_PROSE }) }),
});

let corpus;
// The canned dead end, DERIVED from src/wizard.mjs rather than retyped. If the
// sentence is reworded, the extraction fails loudly instead of this file
// silently asserting against a string production no longer emits.
let deadEnd;

let seat = 0;
// A fresh wizard per turn, with a call counter. The provider is fully
// configured in the hostileProvider world, so a zero there means the turn never
// needed the model — never that it could not reach one.
function seatFor(world = "offline") {
  const { env, reply } = WORLDS[world]();
  const calls = { count: 0 };
  const wizard = createWizard({
    corpus,
    env,
    logger: quiet,
    fetchImpl: async () => {
      calls.count += 1;
      if (!reply) throw new Error("no provider is configured in this world");
      return reply();
    },
  });
  seat += 1;
  return { wizard, calls, player: `Seat${seat}` };
}

before(async () => {
  corpus = await loadCorpus();
  const source = await readFile(new URL("../src/wizard.mjs", import.meta.url), "utf8");
  const found = source.match(/"([^"]*spellbook has nothing[^"]*)"/);
  assert.ok(
    found,
    "the canned dead-end sentence could not be found in src/wizard.mjs — it was reworded, so update this file rather than deleting the assertion",
  );
  // The first sentence is the identifying half; the tail is a capability menu
  // that legitimately appears elsewhere.
  [deadEnd] = found[1].split(".");
  assert.ok(deadEnd.length > 20, `derived a useless dead-end fragment: ${deadEnd}`);
});

/* --------------------------- the measured matrix -------------------------- */

// `expect.action` — this cell owes the child real in-world work.
// `expect.offer`  — this cell owes the child a bound offer naming a concrete
//                   step, because no existing builder can carry the intent out.
//                   `names` are the words that make the offer concrete rather
//                   than a polite nothing.
const MATRIX = Object.freeze([
  /* ------------------------------- GIFT ------------------------------- */
  {
    category: "gift",
    question: "i need 64 blocks of stone",
    previously: "miss",
    expect: { action: { type: "give_items", items: [{ itemId: "minecraft:stone", amount: 64 }] } },
  },
  {
    category: "gift",
    question: "hand me an enchanted pickaxe",
    previously: "miss",
    // The substitution is delivered AND announced: iron pickaxe, plainly said,
    // with the enchanting limit said out loud rather than silently dropped.
    expect: {
      action: { type: "give_items", items: [{ itemId: "minecraft:iron_pickaxe", amount: 1 }] },
      names: [/iron pickaxe/i, /enchant/i],
    },
  },
  {
    category: "gift",
    question: "gimme some food",
    previously: "miss",
    expect: {
      action: { type: "give_items", items: [{ itemId: "minecraft:bread", amount: 1 }] },
      names: [/bread/i, /food/i],
    },
  },
  {
    category: "gift",
    question: "can you give my friend a bow",
    previously: "miss",
    // A bow is NOT in the item allowlist and a "friend" is not a player name.
    // The turn owes the child honesty plus a concrete alternative — and must
    // never substitute a different item behind their back.
    expect: { offer: true, names: [/bow/i], noAction: true },
  },
  {
    category: "gift",
    question: "give me 64 torches",
    previously: "hit",
    expect: { action: { type: "give_items", items: [{ itemId: "minecraft:torch", amount: 64 }] } },
  },
  {
    category: "gift",
    question: "can i have 10 diamonds",
    previously: "hit",
    expect: { action: { type: "give_items", items: [{ itemId: "minecraft:diamond", amount: 10 }] } },
  },
  /* ------------------------------ TRAVEL ------------------------------ */
  {
    category: "travel",
    question: "bring me home",
    previously: "miss",
    // No builder knows where "home" is, and guessing would be worse than
    // asking. The offer names the one place the wizard CAN aim at.
    expect: { offer: true, names: [/home/i, /village/i], binds: { type: "local_travel", destination: "nearest_village" } },
  },
  {
    category: "travel",
    question: "send me to spawn",
    previously: "miss",
    expect: { offer: true, names: [/spawn/i, /surface/i], binds: { type: "local_travel", destination: "surface" } },
  },
  {
    category: "travel",
    question: "teleport me to the village",
    previously: "miss",
    expect: { action: { type: "local_travel", destination: "nearest_village" } },
  },
  {
    category: "travel",
    question: "get me out of this cave",
    previously: "miss",
    expect: { action: { type: "local_travel", destination: "surface" } },
  },
  {
    category: "travel",
    question: "take me to the nether",
    previously: "hit",
    expect: { action: { type: "dimension_travel", destination: "nether" } },
  },
  {
    category: "travel",
    question: "take me to the nearest village",
    previously: "hit",
    expect: { action: { type: "local_travel", destination: "nearest_village" } },
  },
  /* ------------------------------ EFFECT ------------------------------ */
  {
    category: "effect",
    question: "make me fly",
    previously: "miss",
    // No status effect grants flight, so the substitution is announced with the
    // runtime's own caveat — asserted by IMPORTING it, never by retyping it.
    expect: {
      action: { type: "run_commands", commands: [effectCommand("jump_boost"), effectCommand("slow_falling")] },
      includes: [FLY_CAVEAT],
    },
  },
  {
    category: "effect",
    question: "i want to be fast",
    previously: "miss",
    expect: { action: { type: "run_commands", commands: [effectCommand("speed")] } },
  },
  {
    category: "effect",
    question: "heal me",
    previously: "miss",
    expect: { action: { type: "run_commands", commands: [effectCommand("regeneration")] } },
  },
  {
    category: "effect",
    question: "give me night vision",
    previously: "hit",
    expect: { action: { type: "run_commands", commands: [effectCommand("night_vision")] } },
  },
  {
    category: "effect",
    question: "can i have fire resistance",
    previously: "hit",
    expect: { action: { type: "run_commands", commands: [effectCommand("fire_resistance")] } },
  },
  {
    category: "effect",
    question: "apply speed to me",
    previously: "hit",
    expect: { action: { type: "run_commands", commands: [effectCommand("speed")] } },
  },
  /* ------------------------------- ADMIN ------------------------------ */
  {
    category: "admin",
    question: "turn on keep inventory",
    previously: "miss",
    // A gamerule has NO local builder, and writing one would be exactly the new
    // privileged path the brief forbids. So the turn owes the child a named,
    // honest step instead of silence — and no action at all.
    expect: { offer: true, names: [/keep inventory/i], noAction: true },
  },
  {
    category: "admin",
    question: "make it peaceful",
    previously: "miss",
    expect: { offer: true, names: [/peaceful/i, /difficulty/i], noAction: true },
  },
  {
    category: "admin",
    question: "stop the rain",
    previously: "miss",
    // The inversion trap: the builder's keyword scan reads "rain" here, and the
    // child asked for it to STOP. Clear, never rain.
    expect: { action: { type: "world_control", weather: "clear" } },
  },
  {
    category: "admin",
    question: "make it night",
    previously: "hit",
    expect: { action: { type: "world_control", time: "night" } },
  },
  {
    category: "admin",
    question: "set the weather to rain",
    previously: "hit",
    expect: { action: { type: "world_control", weather: "rain" } },
  },
  {
    category: "admin",
    question: "make it day",
    previously: "hit",
    expect: { action: { type: "world_control", time: "day" } },
  },
]);

// Blocks and ids the executor allowlist rejects outright. Nothing newly
// reachable may smuggle one through.
const FORBIDDEN = /command_block|structure_block|structure_void|mob_spawner|barrier|\btnt\b|bedrock|dragon_egg|spawn_egg/i;

function assertShippable(result, where) {
  assert.equal(typeof result.answer, "string", `no answer at all: ${where}`);
  assert.ok(result.answer.trim().length > 0, `silence: ${where}`);
  assert.ok(
    !result.answer.includes(deadEnd),
    `the dead end shipped to a child: ${where}\n  ${result.answer}`,
  );
  assert.ok(
    !result.answer.includes(MODEL_PROSE),
    `provider prose shipped verbatim: ${where}\n  ${result.answer}`,
  );
  assert.equal(
    answerRefusesAction(result.answer), false,
    `bare refusal shipped: ${where}\n  ${result.answer}`,
  );
  if (result.action) {
    assert.deepEqual(
      allowedWizardAction(result.action), result.action,
      `action did not survive re-validation: ${where}`,
    );
    assert.doesNotMatch(
      JSON.stringify(result.action), FORBIDDEN,
      `a forbidden id reached an executable action: ${where}`,
    );
  }
}

/* ------------------------------- 1. COVERAGE ------------------------------ */

test("the matrix is the measured one: 24 phrasings, 14 of them previously dead", () => {
  assert.equal(MATRIX.length, 24, "the measured matrix changed size");
  assert.equal(MATRIX.filter(({ previously }) => previously === "miss").length, 14);
  assert.equal(MATRIX.filter(({ previously }) => previously === "hit").length, 10);
  for (const category of ["gift", "travel", "effect", "admin"]) {
    assert.equal(MATRIX.filter((cell) => cell.category === category).length, 6, category);
  }
});

test("every measured phrasing ends in real work or a bound offer, never the dead end", async () => {
  let cells = 0;
  for (const world of Object.keys(WORLDS)) {
    for (const cell of MATRIX) {
      cells += 1;
      const { wizard, player } = seatFor(world);
      const where = `${world} :: ${cell.category} :: ${cell.question}`;
      const result = await wizard.ask({ player, question: cell.question });
      assertShippable(result, where);
      if (cell.expect.action) {
        assert.ok(result.action, `no action where one was owed: ${where}\n  ${result.answer}`);
        assert.equal(result.action.type, cell.expect.action.type, where);
      } else {
        // No builder can carry this one out, so the turn owes an OFFER — and
        // one that names a concrete step, not a polite nothing.
        assert.equal(result.action, null, `an unrequested action shipped: ${where}`);
        assert.equal(
          answerOffersAction(result.answer), true,
          `no action and no offer: ${where}\n  mode=${result.mode}\n  ${result.answer}`,
        );
        for (const name of cell.expect.names || []) {
          assert.match(result.answer, name, `the offer named no concrete step: ${where}`);
        }
      }
    }
  }
  assert.equal(cells, 2 * MATRIX.length);
});

/* -------------------------- 2. ACTION FIDELITY ---------------------------- */
//
// "A real executable action" is only worth asserting if it is the RIGHT one: a
// coverage matrix that accepts any action at all would be satisfied by handing
// every child a torch.

test("each delivered action is the one the child actually asked for", async () => {
  for (const cell of MATRIX.filter(({ expect }) => expect.action)) {
    const { wizard, player } = seatFor();
    const result = await wizard.ask({ player, question: cell.question });
    const where = `${cell.category} :: ${cell.question}`;
    const { action } = result;
    assert.ok(action, where);
    for (const [key, value] of Object.entries(cell.expect.action)) {
      if (key === "items" || key === "commands") continue;
      assert.equal(action[key], value, `${key} mismatch: ${where}`);
    }
    if (cell.expect.action.items) {
      assert.deepEqual(action.items, cell.expect.action.items, where);
    }
    if (cell.expect.action.commands) {
      assert.deepEqual(action.commands, cell.expect.action.commands, where);
    }
    for (const literal of cell.expect.includes || []) {
      assert.ok(result.answer.includes(literal), `the caveat was dropped: ${where}\n  ${result.answer}`);
    }
    for (const name of cell.expect.names || []) {
      assert.match(result.answer, name, `the substitution was not announced: ${where}`);
    }
  }
});

test("every effect that ships is an allowlisted effect aimed at the requester alone", async () => {
  for (const cell of MATRIX.filter(({ category }) => category === "effect")) {
    const { wizard, player } = seatFor();
    const { action } = await wizard.ask({ player, question: cell.question });
    assert.equal(action?.type, "run_commands", cell.question);
    for (const command of action.commands) {
      const id = command.match(/^effect @s ([a-z_]+) /)?.[1];
      assert.ok(id, `not an effect command: ${command}`);
      assert.ok(ALLOWED_EFFECTS.includes(id), `effect outside the allowlist: ${id}`);
      // Byte for byte the shape already shipped — no new command surface.
      assert.equal(command, effectCommand(id), cell.question);
      assert.doesNotMatch(command, /@[aeprn]\b/, `a broader selector than @s: ${command}`);
    }
  }
});

test("every travel action stays one of the two requester-scoped types the consent path knows", async () => {
  // main.js actionMovesRequester() covers exactly dimension_travel and
  // local_travel (plus teleport commands), so needsTeleportConsent still gates
  // every one of these. A NEW travel type would slip that gate.
  for (const cell of MATRIX.filter(({ category }) => category === "travel")) {
    const { wizard, player } = seatFor();
    const first = await wizard.ask({ player, question: cell.question });
    const action = first.action || (await wizard.ask({ player, question: "yes" })).action;
    assert.ok(action, cell.question);
    assert.ok(["local_travel", "dimension_travel"].includes(action.type), `${cell.question} -> ${action.type}`);
    assert.doesNotMatch(JSON.stringify(action), /teleport|\btp\b|@[aeprs]\b/i, cell.question);
  }
});

/* ------------------------- 3. THE OFFER ROUND TRIP ------------------------ */

test("a travel offer converts into real, correct work on a bare yes", async () => {
  const bindable = MATRIX.filter(({ expect }) => expect.binds);
  assert.equal(bindable.length, 2, "the bindable offer cells went missing");
  for (const world of Object.keys(WORLDS)) {
    for (const cell of bindable) {
      const { wizard, player } = seatFor(world);
      const where = `${world} :: ${cell.question}`;
      const offer = await wizard.ask({ player, question: cell.question });
      assert.equal(offer.action, null, where);
      assert.equal(answerOffersAction(offer.answer), true, `${where}\n  ${offer.answer}`);

      const bound = await wizard.ask({ player, question: "yes" });
      assert.ok(bound.action, `the offer could not be bound by "yes": ${where}\n  ${offer.answer}`);
      // The part a regex cannot fake: not a statue, not a menu, not another
      // offer — the exact step the offer named.
      assert.equal(bound.action.type, cell.expect.binds.type, where);
      assert.equal(bound.action.destination, cell.expect.binds.destination, where);
      assert.deepEqual(allowedWizardAction(bound.action), bound.action, where);
      assert.doesNotMatch(bound.answer, /tell me exactly which one/i, `the child was asked twice: ${where}`);
      assertShippable(bound, `${where} :: yes`);
    }
  }
});

// KNOWN LIMIT, recorded rather than hidden. Three offers name a step no builder
// can execute — a gamerule, a difficulty, and an item outside the allowlist.
// Writing an action for the first two would be exactly the new privileged path
// the brief forbids, and substituting an item for the third is precisely what
// "refused, never substituted" rules out. So a bare "yes" after them CANNOT
// produce work, and today it lands on the generic clarification. What this test
// pins is the half that is a safety property: a "yes" there never invents an
// action nobody asked for, and the offer itself still named the real step.
test("an offer with no builder behind it never turns a yes into unrequested work", async () => {
  const unbindable = MATRIX.filter(({ expect }) => expect.noAction);
  assert.equal(unbindable.length, 3, "the non-deliverable offer cells went missing");
  for (const cell of unbindable) {
    const { wizard, player } = seatFor();
    const offer = await wizard.ask({ player, question: cell.question });
    assert.equal(offer.action, null, cell.question);
    for (const name of cell.expect.names) assert.match(offer.answer, name, cell.question);

    const yes = await wizard.ask({ player, question: "yes" });
    assert.equal(
      yes.action, null,
      `a bare "yes" conjured work nobody asked for: ${cell.question} -> ${JSON.stringify(yes.action)}`,
    );
    assertShippable(yes, `unbindable :: ${cell.question} :: yes`);
  }
});

/* --------------------------- 4. NEGATIVE HALVES --------------------------- */

const INTERROGATIVES = Object.freeze([
  ["effect", "what does night vision do"],
  ["effect", "how do i heal in minecraft"],
  ["travel", "how do i get to the nether"],
  ["travel", "how do i teleport in minecraft"],
  ["admin", "what is keep inventory"],
  ["admin", "what does peaceful mode change"],
  ["admin", "why does it rain in minecraft"],
  ["gift", "what is a diamond pickaxe"],
]);

test("a question in any of the four categories is answered, never executed", async () => {
  for (const world of Object.keys(WORLDS)) {
    for (const [category, question] of INTERROGATIVES) {
      const { wizard, player } = seatFor(world);
      const result = await wizard.ask({ player, question });
      const where = `${world} :: ${category} :: ${question}`;
      assert.equal(classifyAction(question, []), null, `the ladder acted on a question: ${where}`);
      assert.equal(result.action, null, `a question was executed: ${where} -> ${JSON.stringify(result.action)}`);
      assert.ok(result.answer.trim().length > 0, `a question got silence: ${where}`);
    }
  }
});

test("lessons and recipes are not stolen by the non-build detectors", async () => {
  for (const question of [
    "just explain how to get to the nether",
    "tell me how to keep my items when i die",
    "explain how speed potions work",
    "how do i craft a bow",
    "what is the recipe for a cake",
    "how do you make a diamond pickaxe",
  ]) {
    const { wizard, player } = seatFor();
    const result = await wizard.ask({ player, question });
    assert.equal(result.action, null, `a lesson or recipe became work: ${question} -> ${JSON.stringify(result.action)}`);
    assert.ok(result.answer.trim().length > 0, question);
  }
});

test("build turns still reach the build route they own", async () => {
  for (const [question, type, kind] of [
    ["build me a castle", "build_structure", "castle"],
    ["make me a house", "build_structure", "house"],
    ["build a t flip flop", "place_blueprint", undefined],
    ["build an automatic chicken farm", "place_blueprint", undefined],
  ]) {
    const { wizard, player } = seatFor();
    const result = await wizard.ask({ player, question });
    assert.equal(result.action?.type, type, `${question} -> ${JSON.stringify(result.action)}`);
    if (kind) assert.equal(result.action.plan.kind, kind, question);
  }
});

test("an item outside the gift allowlist is refused, never substituted", async () => {
  for (const question of [
    "give me a dragon egg",
    "give me a command block",
    "give me 64 bedrock",
    "give me a nether star",
    "give me a spawn egg",
    "give me a bow",
  ]) {
    for (const world of Object.keys(WORLDS)) {
      const { wizard, player } = seatFor(world);
      const result = await wizard.ask({ player, question });
      const where = `${world} :: ${question}`;
      // The refusal is honest: nothing at all is delivered, and in particular
      // no other item is quietly put in the child's hands.
      assert.notEqual(result.action?.type, "give_items", `an unstocked item was substituted: ${where}`);
      assert.doesNotMatch(JSON.stringify(result.action ?? null), FORBIDDEN, where);
      assert.ok(result.answer.trim().length > 0, where);
    }
  }
});

test("the gift quantity bounds did not move", async () => {
  for (const question of [
    "give me 10001 torches",
    "give me -1 torches",
    "give me 0 torches",
    "i need 99999 blocks of stone",
  ]) {
    assert.equal(classifyAction(question, []), null, `an impossible amount reached the ladder: ${question}`);
    const { wizard, player } = seatFor();
    const result = await wizard.ask({ player, question });
    if (result.action?.type === "give_items") {
      for (const item of result.action.items) {
        assert.ok(item.amount >= 1 && item.amount <= 10_000, `${question} -> ${item.amount}`);
      }
    }
  }
});

test("nothing here moves or buffs another player outside the existing consent path", async () => {
  for (const question of [
    "teleport my friend to spawn",
    "give everyone night vision",
    "make my brother fast",
    "heal my friend",
  ]) {
    const { wizard, player } = seatFor();
    const result = await wizard.ask({ player, question });
    const json = JSON.stringify(result.action ?? null);
    assert.doesNotMatch(json, /"local_travel"|"dimension_travel"/, `a third party was moved: ${question} -> ${json}`);
    assert.doesNotMatch(json, /effect @[aepr]\b/, `a third party was buffed: ${question} -> ${json}`);
    if (result.action?.type === "run_commands") {
      for (const command of result.action.commands) {
        assert.doesNotMatch(command, /@[aepr]\b/, `${question} -> ${command}`);
      }
    }
  }
});

/* ------------------------- 5. AUTHORITY UNCHANGED ------------------------- */

// Everything the admin detector newly RECOGNISES, plus the phrasings that
// already reached the operator builder, plus the near misses that must stay
// misses. Recognition is allowed to widen; authority is not.
const ADMIN_SURFACE = Object.freeze([
  "turn on keep inventory",
  "turn off mob griefing",
  "make it peaceful",
  "set the difficulty to hard",
  "put me in creative mode",
  "make it survival mode",
  "turn off the daylight cycle",
  "make me an admin",
  "make me an administrator",
  "i want to be an admin",
  "give me admin powers",
  "op steve",
  "give my friend operator",
  "make me an operator",
  "op me",
  "deop me",
  "stop the rain",
  "make it night",
]);

test("no admin phrasing reaches server.configure, and server.console still only ops the requester", async () => {
  for (const question of ADMIN_SURFACE) {
    for (const action of [classifyAction(question, []), (await (async () => {
      const { wizard, player } = seatFor();
      return (await wizard.ask({ player, question })).action;
    })())]) {
      if (!action) continue;
      const json = JSON.stringify(action);
      assert.doesNotMatch(json, /server\.configure/, `a new privileged surface: ${question} -> ${json}`);
      // No settings command exists anywhere, through any rung.
      assert.doesNotMatch(json, /gamerule|difficulty|gamemode|whitelist|allowlist|\bban\b|\bkick\b/i,
        `a settings command was authored: ${question} -> ${json}`);
      const steps = action.type === "execute_program" ? action.program.steps : [];
      for (const step of steps) {
        if (step.capability !== "server.console") continue;
        // The existing builder's exact program, unchanged: one step, one
        // command, and it can only ever name the requester.
        assert.equal(steps.length, 1, `${question} -> ${json}`);
        assert.deepEqual(step.arguments.commands.length, 1, question);
        assert.ok(
          ["op {{requester}}", "deop {{requester}}"].includes(step.arguments.commands[0]),
          `a new server.console command: ${question} -> ${step.arguments.commands[0]}`,
        );
      }
    }
  }
});

test("recognising more operator phrasings granted none of them an operator badge", async () => {
  // Newly RECOGNISED by the admin detector, and deliberately carrying no
  // action: widening which utterances trigger an op grant would be widening
  // server.console authority.
  for (const question of [
    "make me an admin",
    "make me an administrator",
    "i want to be an admin",
    "give me admin powers",
    "op steve",
    "give my friend operator",
  ]) {
    assert.equal(classifyAction(question, []), null, `a new phrasing reached the op builder: ${question}`);
    const { wizard, player } = seatFor();
    const result = await wizard.ask({ player, question });
    assert.notEqual(result.action?.type, "execute_program", `${question} -> ${JSON.stringify(result.action)}`);
  }
  // And the phrasings that DID reach it before still do — authority unchanged
  // means unchanged in both directions.
  for (const question of ["make me an operator", "op me"]) {
    const action = classifyAction(question, []);
    assert.equal(action?.type, "execute_program", question);
    assert.equal(action.program.steps[0].arguments.commands[0], "op {{requester}}", question);
  }
});

/* -------------------------------- 6. COST -------------------------------- */

test("the canned turns still cost zero provider calls", async () => {
  for (const question of [
    "hello wizard",
    "thanks!",
    "tell me a joke",
    "build a t flip flop",
    "give me 64 torches",
  ]) {
    const { wizard, calls, player } = seatFor("hostileProvider");
    const result = await wizard.ask({ player, question });
    assert.equal(calls.count, 0, `"${question}" consulted the provider ${calls.count} time(s)`);
    assert.ok(result.answer.trim().length > 10, `"${question}" answered with nothing`);
    assert.ok(!result.answer.includes(MODEL_PROSE), question);
  }
});

test("a turn the deterministic ladder can answer never pays for the model", async () => {
  let free = 0;
  for (const { question } of MATRIX) {
    if (!classifyAction(question, [])) continue; // an offer turn legitimately consults
    free += 1;
    const { wizard, calls, player } = seatFor("hostileProvider");
    const result = await wizard.ask({ player, question });
    assert.equal(calls.count, 0, `"${question}" consulted the provider ${calls.count} time(s)`);
    assert.ok(result.action, `"${question}" cost nothing and shipped nothing`);
    assert.ok(!result.answer.includes(MODEL_PROSE), question);
  }
  // Zero calls must not be achievable by the ladder answering nothing at all.
  assert.ok(free >= 16, `only ${free} of the measured turns are answered deterministically`);
});

test("the counter is a real net: a turn that needs the model still pays exactly once", async () => {
  for (const question of ["what is redstone", "why do creepers explode"]) {
    const { wizard, calls, player } = seatFor("hostileProvider");
    await wizard.ask({ player, question });
    assert.equal(calls.count, 1, `"${question}" cost ${calls.count} provider calls`);
  }
});
