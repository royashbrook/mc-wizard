import assert from "node:assert/strict";
import test from "node:test";

import { explicitlyRequestsCommand } from "../src/command-safety.mjs";
import { allowedWizardAction } from "../src/skills.mjs";
import { classifyAction } from "../src/wizard.mjs";
import { createAdminDetector } from "../src/roles/admin.mjs";

const never = () => false;

// worldControlAction, trustedAdminAction and isPotionRainRequest are all
// module-private in src/wizard.mjs. classifyAction is the exported ladder that
// calls them, so these adapters drive the REAL builders rather than a
// hand-rolled double that could drift away from them. Everything stays
// hermetic: classifyAction is the deterministic rung ladder, no provider, no
// network, no world.
const worldControlAction = (question) => {
  const action = classifyAction(question);
  return action?.type === "world_control" ? action : null;
};
const trustedAdminAction = (question) => {
  const action = classifyAction(question);
  return action?.type === "execute_program"
    && action.program?.steps?.[0]?.capability === "server.console"
    ? action : null;
};
const isPotionRainRequest = (question) => classifyAction(question)?.type === "potion_rain";

// explicitlyRequestsBuild, isRecipeRequest and isOrdinaryConversation are
// module-private too, so these tests deliberately pin them to `false`: every
// negative below therefore has to be closed by the detector's OWN structure,
// not by a bail it merely delegates. The delegated bails get their own test.
const base = {
  worldControlAction,
  trustedAdminAction,
  allowedWizardAction,
  explicitlyRequestsBuild: never,
  explicitlyRequestsCommand,
  isRecipeRequest: never,
  isOrdinaryConversation: never,
  isPotionRainRequest,
};
const detector = createAdminDetector(base);

// The three measured misses this package exists to close.
const MISS_KEEP_INVENTORY = "turn on keep inventory";
const MISS_PEACEFUL = "make it peaceful";
const MISS_RAIN = "stop the rain";

const OPERATOR_COMMAND = /^(?:de)?op \{\{requester\}\}$/;

function assertSafeAction(action, question) {
  if (!action) return;
  assert.ok(["world_control", "execute_program"].includes(action.type),
    `${question} produced an unexpected action type: ${action.type}`);
  const serialized = JSON.stringify(action);
  assert.doesNotMatch(serialized, /gamerule|difficulty|gamemode|allowlist|whitelist|ban|kick|reload|stop\s|kill|summon|fill|setblock|clone/i,
    `${question} smuggled a privileged command: ${serialized}`);
  if (action.type === "execute_program") {
    const steps = action.program.steps;
    assert.equal(steps.length, 1, question);
    assert.equal(steps[0].capability, "server.console", question);
    assert.deepEqual(steps[0].arguments.commands.length, 1, question);
    assert.match(steps[0].arguments.commands[0], OPERATOR_COMMAND, question);
  }
}

/* ------------------------------- POSITIVE ------------------------------- */

// Updated by #44 WP-F, which wired this detector into the ladder — exactly the
// change the original line ("...update this test") anticipated. The measured
// miss that an EXISTING builder can carry out is now a real ladder action; the
// two whose switch lives with a grown-up are still refused an action, because
// recognising them was never allowed to invent a privileged path for them.
test("the wired ladder acts on the measured miss it can, and invents nothing for the two it cannot", () => {
  assert.deepEqual(classifyAction(MISS_RAIN), { type: "world_control", version: 1, weather: "clear" });
  for (const question of [MISS_KEEP_INVENTORY, MISS_PEACEFUL]) {
    assert.equal(classifyAction(question), null, `${question} grew an action it must not have`);
    const intent = detector.adminIntent(question);
    assert.ok(intent, `${question} was not even recognised`);
    assert.equal(intent.deliverable, false, question);
    assert.equal(typeof intent.caveat, "string", question);
  }
});

test("\"stop the rain\" becomes a real world_control through the existing builder", () => {
  const intent = detector.adminIntent(MISS_RAIN);
  assert.ok(intent, "stop the rain was not recognised");
  assert.equal(intent.kind, "world");
  assert.equal(intent.setting, "weather");
  assert.equal(intent.value, "clear");
  assert.equal(intent.deliverable, true);
  assert.equal(intent.caveat, undefined, "a deliverable intent needs no caveat");
  assert.ok(Object.isFrozen(intent));
  assert.equal(typeof intent.step, "string");
  assert.ok(intent.step.length > 0);
  const action = detector.adminAction(MISS_RAIN);
  assert.deepEqual(action, { type: "world_control", version: 1, weather: "clear" });
});

test("\"turn on keep inventory\" is recognised but carries no privileged action", () => {
  const intent = detector.adminIntent(MISS_KEEP_INVENTORY);
  assert.ok(intent, "turn on keep inventory was not recognised");
  assert.equal(intent.kind, "gamerule");
  assert.equal(intent.setting, "keepInventory");
  assert.equal(intent.value, "on");
  assert.equal(intent.label, "keep inventory");
  assert.equal(intent.deliverable, false);
  assert.equal(typeof intent.caveat, "string");
  assert.ok(intent.caveat.length > 0);
  assert.match(intent.step, /keep inventory/i);
  // No builder can express a gamerule, and inventing one here would be a new
  // privileged path. Recognition without authority is the whole point.
  assert.equal(detector.adminAction(MISS_KEEP_INVENTORY), null);
});

test("\"make it peaceful\" is recognised as a difficulty change and carries no action", () => {
  const intent = detector.adminIntent(MISS_PEACEFUL);
  assert.ok(intent, "make it peaceful was not recognised");
  assert.equal(intent.kind, "difficulty");
  assert.equal(intent.setting, "difficulty");
  assert.equal(intent.value, "peaceful");
  assert.equal(intent.deliverable, false);
  assert.match(intent.step, /peaceful/i);
  assert.equal(typeof intent.caveat, "string");
  assert.equal(detector.adminAction(MISS_PEACEFUL), null);
});

test("every way a child asks for the rain to stop clears the weather", () => {
  const phrasings = [
    "stop the rain",
    "stop the rain please",
    "wiz can you stop the rain",
    "no more rain",
    "make the rain stop",
    "i want the rain to stop",
    "get rid of the storm",
    "turn off the rain",
    "make the thunderstorm go away",
  ];
  for (const question of phrasings) {
    const intent = detector.adminIntent(question);
    assert.ok(intent, `${question} was not recognised`);
    assert.equal(intent.value, "clear", question);
    const action = detector.adminAction(question);
    assert.deepEqual(action, { type: "world_control", version: 1, weather: "clear" }, question);
  }
});

test("a stop-raining request clears the sky instead of calling more rain", () => {
  // The existing builder reads "make it stop raining" as a request FOR rain
  // (it only sees "make ... rain"). The detector reads the stop, and discards
  // the builder's reading of the child's own words rather than acting on it.
  //
  // #44 WP-F wired this detector into classifyAction AHEAD of that builder —
  // the only place a detector precedes the builder it delegates to, and this
  // turn is the reason why. The raw builder's own reading is therefore no
  // longer observable through the adapter above; what IS observable, and what
  // actually matters to a child, is that the whole ladder now clears the sky.
  assert.deepEqual(classifyAction("make it stop raining"),
    { type: "world_control", version: 1, weather: "clear" });
  assert.equal(detector.adminIntent("make it stop raining").value, "clear");
  assert.deepEqual(detector.adminAction("make it stop raining"),
    { type: "world_control", version: 1, weather: "clear" });
});

test("time-of-day requests the existing builder cannot read still land", () => {
  const cases = [
    ["stop the night", "day"],
    ["make the darkness go away", "day"],
    ["no more night", "day"],
    ["i want the night to be over", "day"],
  ];
  for (const [question, value] of cases) {
    const intent = detector.adminIntent(question);
    assert.ok(intent, `${question} was not recognised`);
    assert.equal(intent.setting, "time", question);
    assert.equal(intent.value, value, question);
    assert.deepEqual(detector.adminAction(question),
      { type: "world_control", version: 1, time: value }, question);
  }
});

test("requests the existing builder already reads keep exactly its answer", () => {
  for (const question of [
    "make the weather clear",
    "make it day",
    "make it night",
    "make it sunny",
    "make it rain",
    "set the time to midnight",
    "make it noon",
  ]) {
    const expected = worldControlAction(question);
    assert.ok(expected, `${question} is no longer handled by the world builder`);
    const action = detector.adminAction(question);
    assert.ok(action, `${question} lost its action`);
    assert.equal(action.type, "world_control", question);
    const intent = detector.adminIntent(question);
    assert.ok(intent, `${question} produced no intent`);
    assert.equal(intent.deliverable, true, question);
    // The change the child asked for is the change that ships.
    assert.equal(action[intent.setting], intent.value, question);
    assert.equal(expected[intent.setting], intent.value, question);
  }
});

test("world rules are recognised with the right polarity", () => {
  const cases = [
    ["turn on keep inventory", "keepInventory", "on"],
    ["turn keep inventory on", "keepInventory", "on"],
    ["enable keep inventory", "keepInventory", "on"],
    ["i want keep inventory", "keepInventory", "on"],
    ["keep inventory", "keepInventory", "on"],
    ["turn off keep inventory", "keepInventory", "off"],
    ["disable keep inventory", "keepInventory", "off"],
    ["turn off mob griefing", "mobGriefing", "off"],
    ["stop mob griefing", "mobGriefing", "off"],
    ["turn off the daylight cycle", "doDaylightCycle", "off"],
    ["turn on immediate respawn", "immediateRespawn", "on"],
    ["turn off fire spread", "fireSpread", "off"],
  ];
  for (const [question, setting, value] of cases) {
    const intent = detector.adminIntent(question);
    assert.ok(intent, `${question} was not recognised`);
    assert.equal(intent.kind, "gamerule", question);
    assert.equal(intent.setting, setting, question);
    assert.equal(intent.value, value, question);
    assert.equal(intent.deliverable, false, question);
    assert.equal(detector.adminAction(question), null, question);
  }
});

test("difficulty and game mode changes are recognised, never executed", () => {
  const cases = [
    ["make it peaceful", "difficulty", "peaceful"],
    ["set the difficulty to hard", "difficulty", "hard"],
    ["change the difficulty to easy", "difficulty", "easy"],
    ["peaceful mode", "difficulty", "peaceful"],
    ["i want peaceful mode", "difficulty", "peaceful"],
    ["put me in creative mode", "gamemode", "creative"],
    ["set the game mode to survival", "gamemode", "survival"],
    ["i want creative mode", "gamemode", "creative"],
  ];
  for (const [question, setting, value] of cases) {
    const intent = detector.adminIntent(question);
    assert.ok(intent, `${question} was not recognised`);
    assert.equal(intent.setting, setting, question);
    assert.equal(intent.value, value, question);
    assert.equal(intent.deliverable, false, question);
    assert.equal(typeof intent.caveat, "string", question);
    assert.equal(detector.adminAction(question), null, question);
  }
});

test("operator requests reach the existing builder and nothing else", () => {
  const grant = detector.adminIntent("op me");
  assert.equal(grant.kind, "operator");
  assert.equal(grant.value, "grant");
  assert.equal(grant.deliverable, true);
  const granted = detector.adminAction("op me");
  assert.deepEqual(granted, trustedAdminAction("op me"));
  assertSafeAction(granted, "op me");
  assert.equal(granted.program.steps[0].arguments.commands[0], "op {{requester}}");

  const removed = detector.adminAction("deop me");
  assert.equal(detector.adminIntent("deop me").value, "remove");
  assert.equal(removed.program.steps[0].arguments.commands[0], "deop {{requester}}");
});

test("the intent record is frozen and carries a single concrete step", () => {
  for (const question of [MISS_KEEP_INVENTORY, MISS_PEACEFUL, MISS_RAIN, "op me", "put me in creative mode"]) {
    const intent = detector.adminIntent(question);
    assert.ok(Object.isFrozen(intent), question);
    assert.deepEqual(Object.keys(intent).sort(),
      (intent.deliverable
        ? ["deliverable", "kind", "label", "setting", "step", "value"]
        : ["caveat", "deliverable", "kind", "label", "setting", "step", "value"]),
      question);
    assert.equal(typeof intent.step, "string", question);
    assert.ok(intent.step.trim().length > 0, question);
  }
});

test("the allowlist round-trips every action this detector produces", () => {
  for (const question of [MISS_RAIN, "no more rain", "stop the night", "make it day", "op me", "deop me"]) {
    const action = detector.adminAction(question);
    assert.ok(action, question);
    assert.deepEqual(allowedWizardAction(action), action, question);
  }
});

/* ------------------------------- NEGATIVE ------------------------------- */

test("questions about admin settings are answered, not executed", () => {
  for (const question of [
    "what does keep inventory do",
    "what is keep inventory",
    "how do i turn on keep inventory",
    "how do i make it peaceful",
    "what does peaceful mode mean",
    "why is it raining",
    "is it going to stop raining",
    "how do i stop the rain",
    "what is an operator",
    "what does creative mode do",
    "how do i get creative mode",
    "when does the night end",
    "which difficulty is hardest",
    "i want to know what keep inventory does",
    "can you tell me how to turn on keep inventory",
  ]) {
    assert.equal(detector.adminIntent(question), null, `stole a question: ${question}`);
    assert.equal(detector.adminAction(question), null, `stole a question: ${question}`);
  }
});

test("lessons about admin settings stay lessons", () => {
  for (const question of [
    "tell me about keep inventory",
    "teach me about peaceful mode",
    "explain the daylight cycle",
    "show me the difficulty settings",
    "just explain how to stop the rain",
    "tell me about the weather",
    "describe what an operator is",
  ]) {
    assert.equal(detector.adminIntent(question), null, `stole a lesson: ${question}`);
    assert.equal(detector.adminAction(question), null, `stole a lesson: ${question}`);
  }
});

test("command lessons and slash commands are refused by the real command bail", () => {
  for (const question of [
    "/gamerule keepinventory true",
    "run /difficulty peaceful for me",
    "teach me the gamerule command",
    "show me the command to stop the rain",
    "what command turns on keep inventory",
  ]) {
    assert.equal(detector.adminIntent(question), null, `stole a command lesson: ${question}`);
    assert.equal(detector.adminAction(question), null, `stole a command lesson: ${question}`);
  }
});

test("builds that mention a setting belong to the build path", () => {
  for (const question of [
    "build me a peaceful garden",
    "make me a peaceful looking house",
    "build a rain shelter",
    "construct a house and make it peaceful",
    "make me an operator's tower",
  ]) {
    assert.equal(detector.adminIntent(question), null, `stole a build: ${question}`);
    assert.equal(detector.adminAction(question), null, `stole a build: ${question}`);
  }
});

test("ordinary conversation and unrelated requests are left alone", () => {
  for (const question of [
    "hi wizard",
    "thanks wizard",
    "give me 64 torches",
    "hand me an enchanted pickaxe",
    "bring me home",
    "heal me",
    "build a t flip flop",
    "clear a 50x50 area around me",
    "i love the rain",
    "the rain is pretty",
    "my friend is really creative",
    "that was a hard fight",
  ]) {
    assert.equal(detector.adminIntent(question), null, `stole a turn: ${question}`);
    assert.equal(detector.adminAction(question), null, `stole a turn: ${question}`);
  }
});

test("potion rain keeps its own route", () => {
  for (const question of [
    "make it rain potions",
    "i want a potion rain",
    "can you make potions rain from the sky",
  ]) {
    assert.equal(detector.adminIntent(question), null, `stole potion rain: ${question}`);
    assert.equal(detector.adminAction(question), null, `stole potion rain: ${question}`);
  }
});

test("each injected bail suppresses a request the detector would otherwise take", () => {
  const question = MISS_RAIN;
  assert.ok(detector.adminAction(question), "control case must produce an action");
  for (const bail of ["explicitlyRequestsBuild", "isRecipeRequest", "isOrdinaryConversation", "isPotionRainRequest"]) {
    const bailing = createAdminDetector({ ...base, [bail]: () => true });
    assert.equal(bailing.adminIntent(question), null, bail);
    assert.equal(bailing.adminAction(question), null, bail);
  }
  const commandBail = createAdminDetector({ ...base, explicitlyRequestsCommand: () => true });
  assert.equal(commandBail.adminIntent(question), null);
  assert.equal(commandBail.adminAction(question), null);
});

/* -------------------------------- SAFETY -------------------------------- */

test("an operator phrasing the existing builder rejects grants nothing", () => {
  // These are RECOGNISED so the wizard can answer honestly, but normalising
  // them into an op grant would widen server.console authority, so they carry
  // no action at all.
  for (const question of [
    "make me an admin",
    "give me admin powers",
    "i want to be an administrator",
    "let me be an admin",
  ]) {
    const intent = detector.adminIntent(question);
    assert.ok(intent, `${question} was not recognised`);
    assert.equal(intent.kind, "operator", question);
    assert.equal(intent.deliverable, false, question);
    assert.equal(detector.adminAction(question), null, `${question} produced an op grant`);
  }
});

test("no phrasing can make this detector op another player or run a console command", () => {
  const hostile = [
    "op steve",
    "op my friend",
    "make my friend an operator",
    "give alex operator permissions",
    "ban steve",
    "kick alex",
    "add steve to the allowlist",
    "stop the server",
    "reload the server",
    "turn on cheats",
    "turn on command blocks",
    "make it peaceful and op me",
    "stop the rain and op steve",
    "turn on keep inventory; kill @e",
    "make it peaceful\nop me",
    "set the difficulty to peaceful for everyone and give me operator",
  ];
  for (const question of hostile) {
    const action = detector.adminAction(question);
    assertSafeAction(action, question);
    if (action?.type === "execute_program") {
      assert.equal(action.program.steps[0].arguments.commands[0], "op {{requester}}",
        `${question} produced a console command for someone else`);
    }
  }
});

test("no action produced for any recognised phrasing escapes the two allowed shapes", () => {
  const corpus = [
    MISS_KEEP_INVENTORY, MISS_PEACEFUL, MISS_RAIN,
    "no more rain", "make the rain stop", "turn off the rain", "make it stop raining",
    "stop the night", "make it day", "make it night", "make it sunny", "make it rain",
    "op me", "deop me", "make me an operator", "remove my operator status",
    "turn off mob griefing", "put me in creative mode", "set the difficulty to hard",
  ];
  for (const question of corpus) {
    const action = detector.adminAction(question);
    assertSafeAction(action, question);
    const intent = detector.adminIntent(question);
    // The two halves never disagree about whether the wizard can act.
    assert.equal(Boolean(action), Boolean(intent?.deliverable), question);
  }
});

test("the factory refuses to build without every injected dependency", () => {
  assert.throws(() => createAdminDetector(), TypeError);
  assert.throws(() => createAdminDetector({}), TypeError);
  for (const key of Object.keys(base)) {
    const missing = { ...base };
    delete missing[key];
    assert.throws(() => createAdminDetector(missing), new RegExp(key), key);
  }
});

test("empty and non-string input produce no admin plan", () => {
  for (const question of ["", "   ", undefined, null, 42, {}]) {
    assert.equal(detector.adminIntent(question), null, String(question));
    assert.equal(detector.adminAction(question), null, String(question));
  }
});
