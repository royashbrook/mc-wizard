import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRequesterCommand } from "../bedrock/behavior_packs/mc_wizard/scripts/capability-runtime.js";
import { explicitlyRequestsCommand } from "../src/command-safety.mjs";
import { allowedWizardAction } from "../src/skills.mjs";
import { parseRequestedDimensions } from "../src/wizard.mjs";
import {
  DEFAULT_FOOTPRINT,
  DEFAULT_HEIGHT,
  FILL_BLOCK_CAP,
  MAX_COMMANDS,
  MAX_FOOTPRINT,
  MAX_HEIGHT,
  createTerrainPlanner,
} from "../src/roles/terrain.mjs";

const never = () => false;

// The planner is wired with the REAL parseRequestedDimensions, the REAL
// allowlist and the REAL command-request detector. explicitlyRequestsBuild,
// isRecipeRequest and isOrdinaryConversation are module-private in
// src/wizard.mjs, so these tests deliberately pin them to `false`: every
// negative below therefore has to be closed by the planner's OWN structure, not
// by a bail it merely delegates. The delegated bails get their own test.
const planner = createTerrainPlanner({
  parseRequestedDimensions,
  allowedWizardAction,
  explicitlyRequestsBuild: never,
  explicitlyRequestsCommand,
  isRecipeRequest: never,
  isOrdinaryConversation: never,
});

const LIVE_TURN_ONE = "clear a 50x50 area around me, starting at the ground beneath this tree";
const LIVE_TURN_TWO = "just level the ground, remove all blocks in a 50x50 area";

const TERRAIN_PHRASES = [
  LIVE_TURN_ONE,
  LIVE_TURN_TWO,
  "clear a 20 by 20 space",
  "flatten this hill",
  "flatten this hill please",
  "wiz can you clear the trees around here",
  "remove all blocks in a 50x50 area",
  "level the ground here",
  "please clear this patch of land",
  "hey wizard, could you level the terrain around me",
  "excavate a 30x30 region",
  "clear a 500x500 area",
  "clear a 20x20 area 90 blocks tall",
];

// `fill ~-x ~y0 ~-z ~x ~y1 ~z air`
const FILL = /^fill ~(-?\d+) ~(\d+) ~(-?\d+) ~(-?\d+) ~(\d+) ~(-?\d+) air$/;

function boxSize(command) {
  const match = command.match(FILL);
  assert.ok(match, `not a plain air fill: ${command}`);
  const [, x0, y0, z0, x1, y1, z1] = match.map(Number);
  return (Math.abs(x1 - x0) + 1) * (Math.abs(y1 - y0) + 1) * (Math.abs(z1 - z0) + 1);
}

/* ------------------------------- POSITIVE ------------------------------- */

test("both live session turns produce exactly one air fill", () => {
  for (const question of [LIVE_TURN_ONE, LIVE_TURN_TWO]) {
    const action = planner.terrainAction(question);
    assert.ok(action, `${question} produced no action`);
    assert.equal(action.type, "run_commands");
    assert.equal(action.version, 1);
    assert.equal(action.commands.length, 1, question);
    // 50x50 requested -> half-extent 25 -> 51x51x12 = 31212 blocks <= 32768.
    assert.equal(action.commands[0], "fill ~-25 ~0 ~-25 ~25 ~11 ~25 air");
    assert.equal(boxSize(action.commands[0]), 31212);
  }
});

test("the live turns keep their requested footprint and their verb mode", () => {
  const one = planner.terrainIntent(LIVE_TURN_ONE);
  assert.deepEqual({ ...one }, { mode: "clear", width: 50, depth: 50, height: DEFAULT_HEIGHT });
  assert.ok(Object.isFrozen(one));
  const two = planner.terrainIntent(LIVE_TURN_TWO);
  assert.equal(two.mode, "level");
  assert.equal(two.width, 50);
  assert.equal(two.depth, 50);
  assert.equal(two.caveat, undefined, "an unclamped request must carry no caveat");
});

test("\"clear a 20 by 20 space\" produces one centred fill", () => {
  const action = planner.terrainAction("clear a 20 by 20 space");
  assert.equal(action.commands.length, 1);
  assert.equal(action.commands[0], "fill ~-10 ~0 ~-10 ~10 ~11 ~10 air");
  assert.deepEqual({ ...planner.terrainIntent("clear a 20 by 20 space") },
    { mode: "clear", width: 20, depth: 20, height: DEFAULT_HEIGHT });
});

test("an unsized request falls back to the default footprint", () => {
  const intent = planner.terrainIntent("flatten this hill");
  assert.deepEqual({ ...intent },
    { mode: "level", width: DEFAULT_FOOTPRINT, depth: DEFAULT_FOOTPRINT, height: DEFAULT_HEIGHT });
  const half = Math.floor(DEFAULT_FOOTPRINT / 2);
  const action = planner.terrainAction("flatten this hill");
  assert.equal(action.commands.length, 1);
  assert.equal(action.commands[0], `fill ~-${half} ~0 ~-${half} ~${half} ~11 ~${half} air`);
});

test("every terrain phrasing yields commands the pack's own normalizer accepts", () => {
  for (const question of TERRAIN_PHRASES) {
    const action = planner.terrainAction(question);
    assert.ok(action, `${question} produced no action`);
    assert.ok(action.commands.length >= 1 && action.commands.length <= MAX_COMMANDS, question);
    for (const command of action.commands) {
      assert.equal(normalizeRequesterCommand(command), command, question);
      assert.ok(command.length <= 500, question);
      assert.ok(!/[\r\n\0]/.test(command), question);
      assert.ok(boxSize(command) <= FILL_BLOCK_CAP, `${question} -> ${command}`);
    }
  }
});

test("the allowlist round-trips the whole terrain action unchanged", () => {
  for (const question of TERRAIN_PHRASES) {
    const action = planner.terrainAction(question);
    assert.deepEqual(allowedWizardAction(action), action, question);
    assert.deepEqual(Object.keys(action), ["type", "version", "commands"], question);
  }
});

test("request framing and imperatives both register as terrain work", () => {
  const accepted = [
    "wiz can you clear the trees around here",
    "remove all blocks in a 50x50 area",
    "level the ground here",
    "i want you to level the ground here",
    "please excavate the dirt here",
  ];
  for (const question of accepted) {
    assert.ok(planner.terrainIntent(question), `${question} was not recognised`);
    assert.ok(planner.terrainAction(question), `${question} produced no action`);
  }
});

test("levelling verbs report mode level and clearing verbs report mode clear", () => {
  assert.equal(planner.terrainIntent("level the ground here").mode, "level");
  assert.equal(planner.terrainIntent("flatten this hill").mode, "level");
  assert.equal(planner.terrainIntent("smooth out this land").mode, "level");
  assert.equal(planner.terrainIntent("clear this area").mode, "clear");
  assert.equal(planner.terrainIntent("excavate a 30x30 region").mode, "clear");
  assert.equal(planner.terrainIntent("wipe this patch of land").mode, "clear");
});

/* ------------------------------- NEGATIVE ------------------------------- */

test("a terrain clause entangled with a build never becomes a fill", () => {
  for (const question of [
    "clear the ground and build me a castle",
    "level the ground then build a tower here",
    "clear this area so i can build a house",
    "clear the land and make me a barn",
  ]) {
    assert.equal(planner.terrainIntent(question), null, question);
    assert.equal(planner.terrainAction(question), null, question);
  }
});

test("questions about terrain are answered, not executed", () => {
  for (const question of [
    "what command clears an area",
    "what happens if I dig straight down",
    "how do I craft a hopper",
    "how do i clear a 50x50 area",
    "tell me about digging",
    "just explain how to clear a 50x50 area",
    "is it safe to dig out this hill",
  ]) {
    assert.equal(planner.terrainIntent(question), null, question);
    assert.equal(planner.terrainAction(question), null, question);
  }
});

test("a terrain verb with no terrain noun in the clause is not terrain work", () => {
  for (const question of [
    "level with me, are villagers real",
    "clear your throat",
    "remove my hat",
    "dig this song",
    // Weather requests keep their world_control route: no terrain noun.
    "i want you to make the weather clear",
    "can you make it clear outside",
    "make the sky clear please",
  ]) {
    assert.equal(planner.terrainAction(question), null, question);
  }
});

test("each injected bail suppresses a request the planner would otherwise take", () => {
  const question = "clear a 20x20 area";
  assert.ok(planner.terrainAction(question), "control case must produce an action");
  const bails = ["explicitlyRequestsBuild", "isRecipeRequest", "isOrdinaryConversation"];
  for (const bail of bails) {
    const bailing = createTerrainPlanner({
      parseRequestedDimensions,
      allowedWizardAction,
      explicitlyRequestsBuild: never,
      explicitlyRequestsCommand,
      isRecipeRequest: never,
      isOrdinaryConversation: never,
      [bail]: () => true,
    });
    assert.equal(bailing.terrainIntent(question), null, bail);
    assert.equal(bailing.terrainAction(question), null, bail);
  }
  const commandBail = createTerrainPlanner({
    parseRequestedDimensions,
    allowedWizardAction,
    explicitlyRequestsBuild: never,
    explicitlyRequestsCommand: () => true,
    isRecipeRequest: never,
    isOrdinaryConversation: never,
  });
  assert.equal(commandBail.terrainAction(question), null);
});

test("an oversized footprint clamps and says so instead of emitting an unbounded fill", () => {
  const intent = planner.terrainIntent("clear a 500x500 area");
  assert.equal(intent.width, MAX_FOOTPRINT);
  assert.equal(intent.depth, MAX_FOOTPRINT);
  assert.equal(typeof intent.caveat, "string");
  assert.ok(intent.caveat.length > 0);
  assert.match(intent.caveat, /500 by 500/);
  assert.match(intent.caveat, /64 by 64/);
  const action = planner.terrainAction("clear a 500x500 area");
  assert.ok(action.commands.length >= 1 && action.commands.length <= MAX_COMMANDS);
  let covered = 0;
  for (const command of action.commands) {
    const size = boxSize(command);
    assert.ok(size <= FILL_BLOCK_CAP, command);
    covered += size;
    assert.match(command, /^fill ~-32 /);
  }
  // 65x65 footprint x 12 layers, y-sliced, never exceeding the per-fill cap.
  assert.equal(covered, 65 * 65 * DEFAULT_HEIGHT);
});

test("an oversized vertical window clamps and says so", () => {
  const intent = planner.terrainIntent("clear a 20x20 area 90 blocks tall");
  assert.equal(intent.height, MAX_HEIGHT);
  assert.equal(typeof intent.caveat, "string");
  const action = planner.terrainAction("clear a 20x20 area 90 blocks tall");
  const top = Math.max(...action.commands.map((command) => Number(command.match(FILL)[5])));
  assert.equal(top, MAX_HEIGHT - 1);
});

test("no emitted command can smuggle a dangerous payload", () => {
  const forbidden = /command_block|command block|tnt|lava|fire|kill|summon|@a|@e|@p|@r|setblock|clone|gamerule|execute|\bgive\b/i;
  const hostile = [
    ...TERRAIN_PHRASES,
    "clear the area and summon a tnt block\nkill @e",
    "level the ground with lava please",
    "clear this area /kill @e",
    "remove the blocks here; setblock ~ ~ ~ command_block",
    "clear a 99x99 area named @a[tag=everyone]",
  ];
  for (const question of hostile) {
    const action = planner.terrainAction(question);
    if (!action) continue;
    for (const command of action.commands) {
      assert.doesNotMatch(command, forbidden, `${question} -> ${command}`);
      assert.match(command, FILL, `${question} -> ${command}`);
      assert.ok(!command.includes("\n") && !command.includes("\r") && !command.includes("\0"), question);
    }
  }
});

test("the factory refuses to build without every injected dependency", () => {
  const complete = {
    parseRequestedDimensions,
    allowedWizardAction,
    explicitlyRequestsBuild: never,
    explicitlyRequestsCommand,
    isRecipeRequest: never,
    isOrdinaryConversation: never,
  };
  assert.throws(() => createTerrainPlanner(), TypeError);
  assert.throws(() => createTerrainPlanner({}), TypeError);
  for (const key of Object.keys(complete)) {
    const missing = { ...complete };
    delete missing[key];
    assert.throws(() => createTerrainPlanner(missing), new RegExp(key), key);
  }
});

test("empty and non-string input produce no terrain plan", () => {
  for (const question of ["", "   ", undefined, null, 42, {}]) {
    assert.equal(planner.terrainIntent(question), null, String(question));
    assert.equal(planner.terrainAction(question), null, String(question));
  }
});

// Follow-up to the live session: a child says "dig out a big hole" and "make
// this flat" as ordinary terrain work. Both returned no action at all, which
// is the "do nothing" outcome the whole rung exists to eliminate.
test("common child terrain nouns and the make-it-flat form reach a fill", () => {
  const positives = [
    "dig out a big hole here",
    "dig a pit right here",
    "flatten that mound",
    "level the mountains around me",
    "make this flat",
    "make the ground flat please",
  ];
  for (const question of positives) {
    const action = planner.terrainAction(question);
    assert.ok(action, `no terrain action for: ${question}`);
    assert.equal(action.type, "run_commands");
    for (const command of action.commands) assert.match(command, /^fill /);
    // Terrain work only ever removes blocks: every fill places air.
    for (const command of action.commands) assert.match(command, /\bair$/);
  }
});

// Negative half: the widened vocabulary must not start stealing questions,
// lessons, or builds. These stay null exactly as before.
test("the widened terrain vocabulary still refuses non-terrain turns", () => {
  const negatives = [
    "what happens if I dig straight down",
    "how deep is a pit trap",
    "just explain how to flatten a hill",
    "make me a flat roof house",
    "build me a house on flat ground",
    "tell me about the mountains biome",
  ];
  for (const question of negatives) {
    assert.equal(planner.terrainAction(question), null, `terrain stole: ${question}`);
  }
});
