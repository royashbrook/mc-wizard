// #44 WP-E — the cost gate, measured rather than asserted by inspection.
//
// The never-empty work made more turns reach a floor. The danger of "never give
// up" is that it quietly turns every child sentence into a paid model call. This
// file counts fetchImpl invocations, which is the only place a provider call can
// come from, and pins three numbers:
//
//   0    for canned and deterministic turns (greetings, thanks, jokes, the two
//        canned blueprints, a teleport, a gift, and the whole terrain rung).
//   1    for a turn that genuinely needs the model — proving the counter is a
//        real net and the zeros above are not simply a broken harness.
//   <= 1 + MC_WIZARD_REPAIR_ROUNDS  for a hostile build turn, from ONE shared
//        budget. The bound is exercised, not merely satisfied: at least one
//        hostile case reaches the ceiling exactly, and raising the setting
//        raises the ceiling instead of uncapping it.
//
// Hermetic: memory stores, a counting fetchImpl, no network, no .env, no
// Bedrock container.
import assert from "node:assert/strict";
import { before, test } from "node:test";

import { loadCorpus } from "../src/rag.mjs";
import { createWizard } from "../src/wizard.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const providerEnv = (extra = {}) => ({
  AI_BASE_URL: "http://model/v1",
  AI_MODEL: "model",
  AI_STYLE: "chat",
  AI_TIMEOUT_MS: "1000",
  ...extra,
});
const chatResponse = (content) => new Response(JSON.stringify({
  choices: [{ message: { content } }],
}), { status: 200, headers: { "content-type": "application/json" } });
const envelope = (payload) => chatResponse(JSON.stringify(payload));

let corpus;
before(async () => { corpus = await loadCorpus(); });

// One counting wizard. The provider is fully configured and fully willing — so
// a zero below means the turn never needed it, never that it was unavailable.
function countingWizard({ answer = "The model was consulted.", action, env = providerEnv(), settings } = {}) {
  const calls = { count: 0 };
  const wizard = createWizard({
    corpus,
    env,
    logger: quiet,
    ...(settings && { settings }),
    fetchImpl: async () => {
      calls.count += 1;
      return envelope({ answer, ...(action && { action }) });
    },
  });
  return { wizard, calls };
}

// The seven turns the owner named. Each is answered by a canned or deterministic
// path, so each must cost exactly nothing — and must still do its job, which is
// what stops "zero calls" from being satisfied by doing nothing at all.
const CANNED = Object.freeze([
  { question: "hello wizard", action: null },
  { question: "thanks!", action: null },
  { question: "tell me a joke", action: null },
  { question: "build a t flip flop", action: "place_blueprint" },
  { question: "build an automatic chicken farm", action: "place_blueprint" },
  { question: "teleport me to the nether", action: "dimension_travel" },
  { question: "give me 64 torches", action: "give_items" },
]);

test("the seven canned turns cost zero provider calls and still do their job", async () => {
  for (const { question, action } of CANNED) {
    const { wizard, calls } = countingWizard();
    const result = await wizard.ask({ player: `Canned${question.length}`, question });
    assert.equal(calls.count, 0, `"${question}" consulted the provider ${calls.count} time(s)`);
    if (action === null) {
      assert.equal(result.action, null, question);
      // Zero calls must not mean an empty turn: a real canned answer shipped.
      assert.ok(result.answer.trim().length > 10, `"${question}" answered with nothing: ${result.answer}`);
    } else {
      assert.equal(result.action?.type, action, `"${question}" lost its deterministic action`);
    }
    // And nothing the model said reached the child, because it was never asked.
    assert.doesNotMatch(result.answer, /The model was consulted/, question);
  }
});

// The whole point of the deterministic terrain rung: the live turns that used to
// burn a provider call and still ship nothing now cost nothing and ship work.
test("terrain work orders are answered for free", async () => {
  for (const question of [
    "clear a 50x50 area around me, starting at the ground beneath this tree",
    "just level the ground, the mountains, and remove all blocks in a 50x50 area starting at the ground where this tree starts",
    "flatten this hill please",
    "wiz can you clear the trees around here",
    "level the ground here",
  ]) {
    const { wizard, calls } = countingWizard();
    const result = await wizard.ask({ player: `Terrain${question.length}`, question });
    assert.equal(calls.count, 0, `"${question}" consulted the provider`);
    assert.equal(result.action?.type, "terrain_work", question);
  }
});

// The counter is a real net: a turn that genuinely needs the model DOES pay,
// exactly once. Without this, every zero above could be a broken harness.
test("a turn that genuinely needs the model consults it exactly once", async () => {
  for (const question of [
    "what is redstone",
    "why do creepers explode",
    "tell me something interesting about villagers",
  ]) {
    const { wizard, calls } = countingWizard();
    await wizard.ask({ player: `Need${question.length}`, question });
    assert.equal(calls.count, 1, `"${question}" cost ${calls.count} provider calls`);
  }
});

// One shared budget, one hard ceiling. A hostile build turn may repair, but the
// total consultations for the turn never exceed 1 + MC_WIZARD_REPAIR_ROUNDS.
test("a hostile turn stays within 1 + MC_WIZARD_REPAIR_ROUNDS consultations", async () => {
  // Passes the allowlist, cannot satisfy the request — so it is rejected and
  // the bounded repair loop engages.
  const wrongPlan = {
    title: "First pass",
    kind: "house",
    dimensions: { width: 9, depth: 9, height: 5 },
    materials: { primary: "minecraft:oak_planks", accent: "minecraft:glass" },
    features: [],
    phases: ["foundation"],
    primitives: [
      { shape: "box", phase: "foundation", blockId: "minecraft:oak_planks", from: [0, 0, 0], to: [8, 0, 8] },
    ],
  };
  const questions = [
    "build me a giant floating pirate ship made of candy canes",
    "make me a huge underwater dome with a secret lab inside",
    "build me a castle out of rainbow candy",
    "build a spooky haunted mansion with a secret room",
    "clear a 50x50 area around me, starting at the ground beneath this tree",
  ];
  const behaviours = {
    wrongAction: { answer: "Here you go.", action: { type: "build_structure", version: 1, plan: wrongPlan } },
    noAction: { answer: "Sure, coming right up." },
  };
  const observed = [];
  for (const rounds of ["2", "4"]) {
    const ceiling = 1 + Number(rounds);
    let worst = 0;
    for (const question of questions) {
      for (const [name, reply] of Object.entries(behaviours)) {
        const { wizard, calls } = countingWizard({
          ...reply,
          env: providerEnv({ MC_WIZARD_REPAIR_ROUNDS: rounds }),
        });
        const result = await wizard.ask({ player: `Hostile${rounds}${name}${question.length}`, question });
        assert.ok(
          calls.count <= ceiling,
          `${name} "${question}" cost ${calls.count} calls with MC_WIZARD_REPAIR_ROUNDS=${rounds}`,
        );
        // Bounded cost is only acceptable because the turn still ships work.
        assert.ok(result.action, `${name} "${question}" bought ${calls.count} calls and shipped nothing`);
        worst = Math.max(worst, calls.count);
      }
    }
    observed.push({ rounds: Number(rounds), ceiling, worst });
  }
  // The bound is exercised, not merely respected: the worst hostile case
  // actually reaches the ceiling, and raising the setting raises the ceiling
  // rather than removing it.
  for (const { ceiling, worst } of observed) {
    assert.equal(worst, ceiling, `the repair ceiling ${ceiling} was never reached (worst was ${worst})`);
  }
  assert.ok(observed[1].worst > observed[0].worst, "MC_WIZARD_REPAIR_ROUNDS no longer controls the budget");
});

// Negative half: with the provider switched off at runtime, no rung tries to
// reach it — the floors are local by construction, not by luck.
test("an admin-disabled turn never reaches the provider and still ships work", async () => {
  for (const question of [
    "clear a 50x50 area around me, starting at the ground beneath this tree",
    "build me a castle out of rainbow candy",
    "hello wizard",
  ]) {
    const { wizard, calls } = countingWizard({ settings: async () => ({ aiEnabled: false }) });
    const result = await wizard.ask({ player: `Off${question.length}`, question });
    assert.equal(calls.count, 0, `"${question}" consulted a disabled provider`);
    assert.ok(result.answer.trim().length > 0, question);
  }
});

// Negative half: a wizard with no provider configured at all is still free and
// still useful — the offline path is the same path, not a degraded copy.
test("an offline wizard costs nothing and still ships the live terrain turns", async () => {
  const wizard = createWizard({
    corpus,
    env: {},
    logger: quiet,
    fetchImpl: async () => { throw new Error("an offline wizard must never call a provider"); },
  });
  for (const question of [
    "clear a 50x50 area around me, starting at the ground beneath this tree",
    "just level the ground, remove all blocks in a 50x50 area",
  ]) {
    const result = await wizard.ask({ player: `Offline${question.length}`, question });
    assert.equal(result.action?.type, "terrain_work", question);
  }
});
