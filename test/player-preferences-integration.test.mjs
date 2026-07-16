import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInteractionLog, readRecentInteractions } from "../src/interaction-log.mjs";
import { createMemoryPlayerPreferenceStore } from "../src/player-preferences.mjs";
import { loadCorpus } from "../src/rag.mjs";
import {
  createHttpServer,
  validateAskBody,
  validatePlayerPreferencesBody,
} from "../src/server.mjs";
import { createMemorySessionStore } from "../src/sessions.mjs";
import { createWizard, preferredMaterialAction } from "../src/wizard.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const flyingMachinePlan = {
  title: "Flying Machine",
  kind: "flying machine",
  placements: [
    { itemId: "minecraft:smooth_stone", target: [0, 0, 2], support: [0, -1, 2], orientationTarget: null },
    { itemId: "minecraft:slime_block", target: [0, 1, 2], support: [0, 0, 2], orientationTarget: null },
    { itemId: "minecraft:sticky_piston", target: [0, 1, 3], support: [0, 1, 2], orientationTarget: [0, 1, 4] },
    { itemId: "minecraft:observer", target: [0, 1, 1], support: [0, 1, 2], orientationTarget: [0, 1, 0] },
    { action: "break", target: [0, 0, 2] },
  ],
  interactions: [],
};

async function dispatch(server, { method = "GET", url = "/", body, token } = {}) {
  const encoded = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const request = {
    method,
    url,
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(body !== undefined && { "content-length": String(encoded.length), "content-type": "application/json" }),
    },
    async *[Symbol.asyncIterator]() {
      if (encoded.length) yield encoded;
    },
  };
  const response = {
    status: 0,
    body: "",
    writeHead(status) { this.status = status; },
    end(value = "") { this.body = String(value); },
  };
  await server.listeners("request")[0](request, response);
  return { status: response.status, body: JSON.parse(response.body) };
}

test("uses only the stable Bedrock actor for private preferences and honors a current-turn material override", async () => {
  const corpus = await loadCorpus();
  const preferences = createMemoryPlayerPreferenceStore();
  const sessions = createMemorySessionStore();
  const wizard = createWizard({ corpus, env: {}, preferences, sessions, logger: quiet });

  const saved = await wizard.ask({
    player: "SameDisplayName",
    playerId: "bedrock-actor-a",
    question: "from now on build my stuff with only mushroom blocks",
  });
  assert.equal(saved.mode, "player-memory");
  assert.equal(preferences.get("bedrock-actor-a")[0].blockId, "minecraft:red_mushroom_block");
  assert.deepEqual(sessions.get("bedrock:bedrock-actor-a", "wizard"), []);

  const build = await wizard.ask({
    player: "SameDisplayName",
    playerId: "bedrock-actor-a",
    question: "build a 7x7 house",
  });
  assert.equal(build.action?.type, "build_structure");
  assert.equal(build.action?.plan.materials.primary, "minecraft:red_mushroom_block");
  assert.equal(build.action?.plan.materials.roof, "minecraft:red_mushroom_block");
  assert.equal(build.preferenceApplied, true);
  assert.match(build.answer, /mushroom/i);

  const farm = await wizard.ask({
    player: "SameDisplayName",
    playerId: "bedrock-actor-a",
    question: "build me an automated chicken farm",
  });
  assert.equal(farm.action?.id, "automated_chicken_farm");
  assert.doesNotMatch(farm.answer, /following your mushroom/i);

  const otherPlayer = await wizard.ask({
    player: "SameDisplayName",
    playerId: "bedrock-actor-b",
    question: "what do you remember about me",
  });
  assert.equal(otherPlayer.mode, "player-memory");
  assert.match(otherPlayer.answer, /don.t have any lasting notes/i);

  const foreignErase = await wizard.ask({
    player: "SameDisplayName",
    playerId: "bedrock-actor-a",
    question: "forget Alex's material preference",
  });
  assert.equal(foreignErase.mode, "player-memory");
  assert.equal(preferences.get("bedrock-actor-a")[0].blockId, "minecraft:red_mushroom_block");

  const override = await wizard.ask({
    player: "SameDisplayName",
    playerId: "bedrock-actor-a",
    question: "build a new 7x7 house made of red concrete",
  });
  assert.equal(override.action?.plan.materials.primary, "minecraft:red_concrete");
  assert.equal(preferences.get("bedrock-actor-a")[0].blockId, "minecraft:red_mushroom_block");

  const forgotten = await wizard.ask({
    player: "SameDisplayName",
    playerId: "bedrock-actor-a",
    question: "forget everything",
  });
  assert.equal(forgotten.mode, "player-memory");
  assert.deepEqual(preferences.get("bedrock-actor-a"), []);
  const remainingTurns = sessions.get("bedrock:bedrock-actor-a", "wizard");
  assert.equal(remainingTurns.some((turn) => turn.preferenceDependencies?.includes("material")), true);
  assert.equal(remainingTurns.some((turn) => /chicken farm/i.test(turn.question)), true);
  assert.equal(remainingTurns.some((turn) => /red concrete/i.test(turn.question)), true);
  const freshBuild = await wizard.ask({
    player: "SameDisplayName",
    playerId: "bedrock-actor-a",
    question: "build a new 7x7 house",
  });
  assert.notEqual(freshBuild.action?.plan.materials.primary, "minecraft:red_mushroom_block");
  assert.equal(freshBuild.preferenceApplied, undefined);
});

test("rejoining clears an old goal by stable actor without erasing that actor's preferences", async () => {
  const corpus = await loadCorpus();
  const preferences = createMemoryPlayerPreferenceStore();
  const sessions = createMemorySessionStore();
  await preferences.set("bedrock-rejoin", {
    kind: "proximity", minimumDistance: 8,
  });
  const wizard = createWizard({ corpus, env: {}, preferences, sessions, logger: quiet });
  const planned = await wizard.ask({
    player: "Kid",
    playerId: "bedrock-rejoin",
    requestId: "old-goal",
    question: "build a 7x7 house",
  });
  assert.ok(planned.action);
  assert.equal(sessions.get("bedrock:bedrock-rejoin", "wizard").length, 1);
  assert.equal(await wizard.clearSession("Kid", "wizard", "bedrock-rejoin"), true);
  assert.deepEqual(sessions.get("bedrock:bedrock-rejoin", "wizard"), []);
  assert.equal(preferences.get("bedrock-rejoin")[0].minimumDistance, 8);
  const lateResult = await wizard.recordActionResult({
    player: "Kid", playerId: "bedrock-rejoin", requestId: "old-goal", status: "failed", detail: "player left",
  });
  assert.equal(lateResult.matched, false);
});

test("a deleted session cannot be recreated by an older in-flight reply", async () => {
  const sessions = createMemorySessionStore();
  const oldSequence = sessions.reserve("bedrock:race", "wizard");
  await sessions.delete("bedrock:race", "wizard");
  const newSequence = sessions.reserve("bedrock:race", "wizard");
  assert.ok(newSequence > oldSequence);
  assert.equal(await sessions.appendIfCurrent("bedrock:race", "wizard", {
    question: "old", answer: "old", requestSequence: oldSequence,
  }), false);
  assert.deepEqual(sessions.get("bedrock:race", "wizard"), []);
});

test("editing one preference preserves conversation, project, and refinement history while superseding only Wizard work in flight", async () => {
  const corpus = await loadCorpus();
  const preferences = createMemoryPlayerPreferenceStore();
  const sessions = createMemorySessionStore();
  const wizard = createWizard({ corpus, env: {}, preferences, sessions, logger: quiet });
  const player = "bedrock:bedrock-project";
  await preferences.set("bedrock-project", {
    kind: "material", blockId: "minecraft:red_mushroom_block", label: "mushroom blocks", exclusive: true,
  });
  await sessions.set(player, "wizard", [
    { question: "hello", answer: "Hello, builder!" },
    {
      question: "build a 7x7 house", answer: "I built your mushroom house.",
      action: { type: "build_structure", version: 1, plan: { kind: "house" } },
      requestId: "house-project", goalId: "house-project", status: "completed",
      goal: { objective: "Build a mushroom house", successCriteria: "The house is usable.", status: "active" },
      preferenceApplied: true, preferenceDependencies: ["material"],
    },
  ]);
  await sessions.setActionResult(player, "wizard", "house-project", { matched: true, updated: true });
  const inFlightSequence = sessions.reserve(player, "wizard");
  await sessions.append(player, "wizard", {
    question: "make it taller", answer: "I’m adding another floor.",
    action: { type: "build_structure", version: 1, plan: { kind: "house", mode: "modify" } },
    requestId: "house-refinement", goalId: "house-project", status: "pending",
    goal: { objective: "Build a mushroom house", successCriteria: "The house is usable.", status: "active" },
    preferenceApplied: true, preferenceDependencies: ["material"], requestSequence: inFlightSequence,
  });
  const before = structuredClone(sessions.get(player, "wizard"));
  const expected = structuredClone(before);
  expected[2].action = null;
  delete expected[2].status;
  delete expected[2].goal;
  const generalSequence = sessions.reserve(player, "general");
  assert.equal(sessions.isCurrent(player, "wizard", inFlightSequence), true);

  await wizard.ask({
    player: "Kid", playerId: "bedrock-project",
    question: "from now on build my stuff with only stone blocks",
  });
  assert.deepEqual(sessions.get(player, "wizard"), expected);
  assert.deepEqual(await sessions.getActionResult(player, "wizard", "house-project"), { matched: true, updated: true });
  assert.equal((await wizard.recordActionResult({
    player: "Kid", playerId: "bedrock-project", requestId: "house-project", status: "completed",
  })).replayed, true);
  assert.equal(sessions.isCurrent(player, "wizard", inFlightSequence), false);
  assert.equal(await sessions.appendIfCurrent(player, "wizard", {
    question: "stale reply", answer: "This must not be remembered.", requestSequence: inFlightSequence,
  }), false);
  assert.deepEqual(sessions.get(player, "wizard"), expected);
  assert.equal(sessions.isCurrent(player, "general", generalSequence), true);

  const removalSequence = sessions.reserve(player, "wizard");
  await wizard.ask({ player: "Kid", playerId: "bedrock-project", question: "forget my material rule" });
  assert.deepEqual(sessions.get(player, "wizard"), expected);
  assert.equal(sessions.isCurrent(player, "wizard", removalSequence), false);
});

test("invalidates stale Wizard work before a delayed real preference write settles", async () => {
  const sessions = createMemorySessionStore();
  let entries = [];
  let releaseWrite;
  let writeStarted;
  let writes = 0;
  const writeReady = new Promise((resolve) => { writeStarted = resolve; });
  const preferences = {
    get: () => structuredClone(entries),
    async set(_playerId, preference) {
      writes += 1;
      if (writes === 1) {
        writeStarted();
        await new Promise((resolve) => { releaseWrite = resolve; });
      }
      const entry = { ...preference, createdAt: 1, updatedAt: writes };
      entries = [entry];
      return { changed: true, entries: structuredClone(entries), entry };
    },
  };
  const wizard = createWizard({ corpus: { search: () => [] }, env: {}, preferences, sessions, logger: quiet });
  const player = "bedrock:bedrock-delayed-preference";
  const staleSequence = sessions.reserve(player, "wizard");
  await sessions.append(player, "wizard", {
    question: "build a house", answer: "I’m building it.",
    action: { type: "build_structure", version: 1, plan: { kind: "house" } },
    requestId: "delayed-house", goalId: "delayed-house", status: "started",
    goal: { objective: "Build a house", successCriteria: "The house is usable.", status: "active" },
    requestSequence: staleSequence,
  });
  const update = wizard.ask({
    player: "Kid", playerId: "bedrock-delayed-preference",
    question: "from now on build my stuff with only stone blocks",
  });
  await writeReady;
  assert.equal(sessions.isCurrent(player, "wizard", staleSequence), false);
  assert.equal(sessions.get(player, "wizard")[0].action, null);
  assert.equal(sessions.get(player, "wizard")[0].goal, undefined);

  releaseWrite();
  await update;
  const duplicateSequence = sessions.reserve(player, "wizard");
  await wizard.ask({
    player: "Kid", playerId: "bedrock-delayed-preference",
    question: "from now on build my stuff with only stone blocks",
  });
  assert.equal(sessions.isCurrent(player, "wizard", duplicateSequence), true);
});

test("a preference change suppresses a stale in-flight Wizard reply before it can speak or act", async () => {
  const sessions = createMemorySessionStore();
  const preferences = createMemoryPlayerPreferenceStore();
  let releaseReply;
  let replyStarted;
  const replyReady = new Promise((resolve) => { replyStarted = resolve; });
  const wizard = createWizard({
    corpus: { search: () => [] }, sessions, preferences, logger: quiet,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      replyStarted();
      await new Promise((resolve) => { releaseReply = resolve; });
      const content = JSON.stringify({ answer: "Observers notice nearby block changes.", action: null });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    },
  });
  const player = "bedrock:bedrock-stale-preference";
  await sessions.set(player, "wizard", [{ question: "hello", answer: "Hello, builder!" }]);
  const before = structuredClone(sessions.get(player, "wizard"));
  const staleRequest = wizard.ask({
    player: "Kid", playerId: "bedrock-stale-preference", question: "What does an observer do?",
  });
  await replyReady;

  await wizard.ask({
    player: "Kid", playerId: "bedrock-stale-preference",
    question: "from now on build my stuff with only stone blocks",
  });
  releaseReply();
  const staleReply = await staleRequest;

  assert.equal(staleReply.mode, "superseded");
  assert.equal(staleReply.superseded, true);
  assert.equal(staleReply.action, null);
  assert.deepEqual(sessions.get(player, "wizard"), before);
});

test("changing a non-build preference does not erase an active build project", async () => {
  const corpus = await loadCorpus();
  const sessions = createMemorySessionStore();
  const wizard = createWizard({
    corpus, env: {}, preferences: createMemoryPlayerPreferenceStore(), sessions, logger: quiet,
  });
  const build = await wizard.ask({ player: "Kid", playerId: "bedrock-space", question: "build a 7x7 house" });
  await sessions.updateAction("bedrock:bedrock-space", "wizard", {
    requestId: build.requestId, status: "completed",
  });
  await wizard.ask({ player: "Kid", playerId: "bedrock-space", question: "please give me space" });
  assert.equal(sessions.get("bedrock:bedrock-space", "wizard").length, 1);
  await wizard.ask({ player: "Kid", playerId: "bedrock-space", question: "forget my space rule" });
  assert.equal(sessions.get("bedrock:bedrock-space", "wizard").length, 1);
  assert.equal(sessions.get("bedrock:bedrock-space", "wizard")[0].action?.type, "build_structure");
});

test("a material rule does not erase a model-authored machine that cannot use it", async () => {
  const corpus = { search: () => [] };
  const sessions = createMemorySessionStore();
  const wizard = createWizard({
    corpus,
    sessions,
    preferences: createMemoryPlayerPreferenceStore(),
    logger: quiet,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      answer: "I’ll build a flying machine nearby.",
      action: {
        type: "build_machine",
        version: 1,
        plan: flyingMachinePlan,
      },
    }) } }] }), { status: 200 }),
  });
  await wizard.ask({
    player: "Kid", playerId: "bedrock-model-machine",
    question: "from now on build my stuff with only mushroom blocks",
  });
  const machine = await wizard.ask({
    player: "Kid", playerId: "bedrock-model-machine", question: "build me a flying machine",
  });
  assert.equal(machine.mode, "chat:model");
  assert.equal(sessions.get("bedrock:bedrock-model-machine", "wizard")[0].preferenceDependencies, undefined);
  await wizard.ask({
    player: "Kid", playerId: "bedrock-model-machine", question: "forget my material rule",
  });
  assert.equal(sessions.get("bedrock:bedrock-model-machine", "wizard").length, 1);
});

test("a material rule does not erase an unrelated repaired model action", async () => {
  const sessions = createMemorySessionStore();
  let calls = 0;
  const wizard = createWizard({
    corpus: { search: () => [] },
    sessions,
    preferences: createMemoryPlayerPreferenceStore(),
    logger: quiet,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      const action = calls === 1
        ? { type: "dimension_travel", version: 1, destination: "minecraft:the_nether" }
        : { type: "build_machine", version: 1, plan: flyingMachinePlan };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: calls === 1 ? "I’ll take you to the Nether." : "I’ll build a flying machine nearby.",
        action,
      }) } }] }), { status: 200 });
    },
  });
  await wizard.ask({
    player: "Kid", playerId: "bedrock-repaired-machine",
    question: "from now on build my stuff with only mushroom blocks",
  });
  const machine = await wizard.ask({
    player: "Kid", playerId: "bedrock-repaired-machine", question: "build me a flying machine",
  });
  assert.equal(calls, 2);
  assert.equal(machine.action?.type, "build_machine");
  assert.equal(sessions.get("bedrock:bedrock-repaired-machine", "wizard")[0].preferenceDependencies, undefined);
  await wizard.ask({
    player: "Kid", playerId: "bedrock-repaired-machine", question: "forget my material rule",
  });
  assert.equal(sessions.get("bedrock:bedrock-repaired-machine", "wizard").length, 1);
});

test("a material rule recolors only declared structure materials and never a functional primitive", () => {
  const action = {
    type: "build_structure",
    plan: {
      materials: {
        primary: "minecraft:stone",
        accent: "minecraft:glass",
        roof: "minecraft:stone_bricks",
      },
      primitives: [
        { blockId: "minecraft:stone" },
        { blockId: "minecraft:glass" },
        { blockId: "minecraft:redstone_lamp" },
        { blockId: "minecraft:air" },
      ],
    },
  };
  const preferences = [{
    kind: "material", blockId: "minecraft:red_mushroom_block", label: "mushroom blocks", exclusive: true,
  }];
  const recolored = preferredMaterialAction(action, preferences, "build a house");
  assert.deepEqual(recolored.plan.materials, {
    primary: "minecraft:red_mushroom_block",
    accent: "minecraft:red_mushroom_block",
    roof: "minecraft:red_mushroom_block",
  });
  assert.deepEqual(recolored.plan.primitives.map(({ blockId }) => blockId), [
    "minecraft:red_mushroom_block",
    "minecraft:red_mushroom_block",
    "minecraft:redstone_lamp",
    "minecraft:air",
  ]);
  assert.equal(preferredMaterialAction(action, preferences, "build a red concrete house").plan.materials.primary, "minecraft:stone");
});

test("bridge validates opaque player IDs, returns only the requested cache, and redacts applied preferences from history", async () => {
  assert.deepEqual(validateAskBody({ player: "Kid", playerId: "bedrock-a", question: "hello" }).playerId, "bedrock-a");
  assert.throws(() => validateAskBody({ player: "Kid", playerId: "bad id", question: "hello" }), /playerId/);
  assert.throws(() => validatePlayerPreferencesBody({ player: "Kid" }), /playerId is required/);

  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-private-bridge-"));
  const filePath = join(directory, "interactions.jsonl");
  const interactionLog = createInteractionLog({ filePath, salt: "private-bridge-test-salt-long-enough" });
  const received = [];
  const resets = [];
  const wizard = {
    provider: "Offline",
    preferenceHealth: () => ({ players: 2, preferences: 3 }),
    getPlayerPreferences(playerId) {
      return playerId === "bedrock-a" ? [{ kind: "material", blockId: "minecraft:red_mushroom_block", label: "mushroom blocks" }] : [];
    },
    async clearSession(player, mode, playerId) {
      resets.push({ player, mode, playerId });
      return true;
    },
    async ask(input) {
      received.push(input);
      return {
        answer: "I’m following your mushroom build rule.",
        mode: "local-skill",
        preferenceApplied: true,
        preferences: this.getPlayerPreferences(input.playerId),
      };
    },
  };
  const server = createHttpServer({
    wizard,
    corpus: { size: 1, graph: { revision: "kg-test", documents: 1, nodes: 2, edges: 1 } },
    token: "test-token", interactionLog, cooldownMs: 0, logger: quiet,
  });
  try {
    const ask = await dispatch(server, {
      method: "POST", url: "/v1/ask", token: "test-token",
      body: { player: "Kid", playerId: "bedrock-a", question: "build a house" },
    });
    assert.equal(ask.status, 200);
    assert.equal(received[0].playerId, "bedrock-a");
    assert.throws(() => validateAskBody({ player: "Kid", playerId: "bedrock-a", question: "hello", sessionReset: "bad token" }), /sessionReset/);
    await dispatch(server, {
      method: "POST", url: "/v1/ask", token: "test-token",
      body: { player: "Kid", playerId: "bedrock-a", question: "hello", sessionReset: "join-a" },
    });
    await dispatch(server, {
      method: "POST", url: "/v1/ask", token: "test-token",
      body: { player: "Kid", playerId: "bedrock-a", question: "hello again", sessionReset: "join-a" },
    });
    assert.deepEqual(resets.map(({ mode }) => mode), ["wizard", "general"]);
    const own = await dispatch(server, {
      method: "POST", url: "/v1/preferences", token: "test-token",
      body: { player: "Kid", playerId: "bedrock-a" },
    });
    const other = await dispatch(server, {
      method: "POST", url: "/v1/preferences", token: "test-token",
      body: { player: "Kid", playerId: "bedrock-b" },
    });
    assert.equal(own.body.preferences[0].blockId, "minecraft:red_mushroom_block");
    assert.deepEqual(other.body.preferences, []);
    const health = await dispatch(server, { method: "GET", url: "/health" });
    assert.deepEqual(health.body.preferences, { players: 2, preferences: 3 });
    assert.deepEqual(health.body.graph, { revision: "kg-test", documents: 1, nodes: 2, edges: 1 });
    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /mushroom build rule|red_mushroom_block/);
    assert.match(raw, /private player preference applied/);
    assert.equal((await readRecentInteractions(filePath)).length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bedrock derives preference identity from the event player and redacts durable-note chat", async () => {
  const pack = await readFile(new URL("../bedrock/behavior_packs/mc_wizard/scripts/main.js", import.meta.url), "utf8");
  assert.match(pack, /player: player\.name, playerId: player\.id/);
  assert.match(pack, /receivePlayerPreferences\(player, payload\.preferences\)/);
  assert.match(pack, /const generation = playerPreferenceGeneration\(player\.id\)/);
  assert.match(pack, /rememberPlayerPreferences\(current, payload\.preferences, generation\)/);
  assert.match(pack, /advancePlayerPreferenceGeneration\(event\.playerId\)/);
  assert.match(pack, /privatePreference: payload\.mode === "player-memory" \|\| payload\.preferenceApplied === true/);
  assert.match(pack, /logChat\(player, "wizard", "player", trimmed, isPrivatePreferenceMessage\(question\)\)/);
  assert.match(pack, /if \(privatePreference\) \{\s+for \(const line of splitMessage\(message\)\) player\.sendMessage/);
  assert.match(pack, /playerPreferences\.delete\(event\.playerId\)/);
  assert.match(pack, /sessionResets\.set\(playerId, `join-/);
  assert.match(pack, /RUNTIME_SESSION_NONCE/);
  assert.match(pack, /playerPreferencesPending\.add\(playerId\)/);
  assert.match(pack, /playerPreferencesPending\.has\(player\.id\)/);
  assert.match(pack, /sessionReset \? \{ sessionReset \} : \{\}/);
  assert.match(pack, /actionMovesRequester\(action\)/);
  assert.match(pack, /actionMovesOptedOutPlayer\(player, action\)/);
  assert.match(pack, /commandsMoveOptedOutPlayer\(player, args\.commands\)/);
  assert.match(pack, /spreadplayers/);
  assert.doesNotMatch(pack, /asked me not to teleport|nearby player preference/);
  assert.match(pack, /args\.subject === "requester" && needsTeleportConsent\(player\)/);
});
