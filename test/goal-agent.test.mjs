import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemorySessionStore } from "../src/sessions.mjs";
import { classifyAction, createWizard } from "../src/wizard.mjs";
import { validateBuildStructurePlan } from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";

const corpus = { search: () => [] };

function cityPlan({ mode, height = 18 } = {}) {
  return {
    title: mode ? "NYC City Revision" : "Small NYC City",
    kind: "city",
    ...(mode ? { mode: "modify" } : {}),
    dimensions: { width: 31, depth: 31, height },
    materials: {
      primary: "minecraft:stone_bricks",
      accent: "minecraft:gray_concrete",
      roof: "minecraft:deepslate_bricks",
    },
    features: ["floor", "walls", "door", "windows", "roof", "lighting", "towers"],
    phases: ["foundation", "shell", "roof", "details"],
    primitives: [
      { shape: "box", phase: "foundation", blockId: "minecraft:stone_bricks", from: [0, 0, 14], to: [30, 0, 16] },
      { shape: "box", phase: "foundation", blockId: "minecraft:stone_bricks", from: [14, 0, 0], to: [16, 0, 30] },
      { shape: "hollow_box", phase: "shell", blockId: "minecraft:gray_concrete", from: [2, 1, 2], to: [13, 10, 13] },
      { shape: "hollow_box", phase: "shell", blockId: "minecraft:gray_concrete", from: [17, 1, 2], to: [28, height - 2, 13] },
      { shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks", from: [2, 1, 17], to: [13, 13, 28] },
      { shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks", from: [17, 1, 17], to: [28, 8, 28] },
      { shape: "box", phase: "roof", blockId: "minecraft:deepslate_bricks", from: [2, 11, 2], to: [13, 11, 13] },
      { shape: "box", phase: "roof", blockId: "minecraft:deepslate_bricks", from: [17, height - 1, 2], to: [28, height - 1, 13] },
      { shape: "box", phase: "details", blockId: "minecraft:air", from: [7, 2, 13], to: [7, 3, 13] },
      { shape: "box", phase: "details", blockId: "minecraft:air", from: [22, 2, 13], to: [22, 3, 13] },
      { shape: "box", phase: "details", blockId: "minecraft:air", from: [7, 2, 17], to: [7, 3, 17] },
      { shape: "box", phase: "details", blockId: "minecraft:air", from: [22, 2, 17], to: [22, 3, 17] },
      { shape: "line", phase: "details", blockId: "minecraft:glowstone", from: [15, 1, 0], to: [15, 1, 30] },
    ],
  };
}

const modelResponse = (answer, action, goal) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ answer, action, goal }) } }],
}), { status: 200 });

const liveContext = {
  dimension: "minecraft:overworld",
  weather: "clear",
  timeOfDay: 1_000,
  player: { x: 0, y: 70, z: 0 },
  buildState: "idle",
};

test("routes dimension travel as an immediate typed capability", () => {
  assert.deepEqual(classifyAction("Teleport us to the Nether"), {
    type: "dimension_travel", version: 1, destination: "nether",
  });
  for (const question of [
    "Do ghasts go to the Overworld?",
    "Can villagers move in the End?",
    "Bring me some Nether wart",
  ]) assert.equal(classifyAction(question), null, question);
  for (const [question, destination] of [
    ["Can we go to the Nether?", "nether"],
    ["Can I go to the End?", "the_end"],
    ["Let us go to the Nether", "nether"],
    ["Could we travel back to Overworld?", "overworld"],
    ["Tell me about cats, then take us to Nether", "nether"],
    ["Take us to Nether to see a piglin", "nether"],
    ["Do not build a portal; just teleport us to Nether", "nether"],
  ]) assert.equal(classifyAction(question)?.destination, destination, question);
  for (const question of [
    "How can we go to the Nether?",
    "Can an item go through a Nether portal?",
    "Can I get a Nether wart item?",
  ]) assert.equal(classifyAction(question), null, question);
  const portal = classifyAction("Build me a portal so I can go to the Nether");
  assert.equal(portal.type, "build_machine");
  assert.equal(portal.plan.kind, "nether portal");
  assert.equal(portal.plan.placements.length, 14);
  assert.equal(portal.plan.interactions.length, 0);
});

test("portal intent controls ignition and can switch the same frame off", () => {
  for (const question of [
    "Build another Nether portal",
    "Build an unlit Nether portal",
    "Build a Nether portal but do not light it",
  ]) {
    const portal = classifyAction(question);
    assert.equal(portal.plan.placements.length, 14, question);
    assert.equal(portal.plan.interactions.length, 0, question);
  }
  const lit = classifyAction("Build and light a Nether portal");
  assert.equal(lit.plan.interactions.length, 1);
  const history = [{
    question: "Build and light a Nether portal", answer: "Done.", action: lit, status: "completed",
    goal: { objective: "Build a portal", successCriteria: "The portal is active", status: "complete" },
  }];
  assert.equal(classifyAction("light it up with night vision", history)?.type, "run_commands");
  for (const question of [
    "turn off the portal",
    "turn it off",
    "switch off the portal",
    "switch it off",
    "make it unlit",
    "deactivate it",
    "ok, so you can break one block for me",
  ]) {
    const off = classifyAction(question, history);
    assert.equal(off.plan.mode, "modify", question);
    assert.equal(off.plan.interactions.length, 0, question);
    assert.equal(off.plan.placements.length, 16, question);
    assert.deepEqual(off.plan.placements.at(-1), { action: "break", target: [1, 1, 0] });
  }
  const unlitHistory = [{ ...history[0], action: classifyAction("Build an unlit Nether portal") }];
  for (const question of ["light it", "light it up", "light the portal", "light up the portal", "activate it"]) {
    const activated = classifyAction(question, unlitHistory);
    assert.equal(activated.plan.mode, "modify", question);
    assert.equal(activated.plan.interactions.length, 1, question);
  }
  const newerCastleHistory = [...unlitHistory, {
    question: "build a castle", answer: "Built.", action: classifyAction("build a castle"), status: "completed",
    goal: { objective: "Build a castle", successCriteria: "The castle exists", status: "complete" },
  }];
  for (const question of ["light the portal", "light up the nether portal", "activate my portal"]) {
    const activated = classifyAction(question, newerCastleHistory);
    assert.equal(activated?.plan.kind, "nether portal", question);
    assert.equal(activated?.plan.mode, "modify", question);
    assert.equal(activated?.plan.interactions.length, 1, question);
  }
  assert.equal(classifyAction("Build and light another Nether portal", unlitHistory).plan.mode, undefined);
  for (const question of ["light up the nether portal area", "place torches around the portal"]) {
    assert.equal(classifyAction(question, unlitHistory)?.type, "place_area_torches", question);
  }
  assert.equal(
    classifyAction("well we need to get back. so take us back to the overworld").destination,
    "overworld",
  );
});

test("natural child phrasing routes effects, area lighting, and furniture builds locally", async () => {
  for (const question of [
    "cast night vision on me",
    "can you cast speed on me",
    "make me invisible",
    "night vision please",
    "can you use night vision on me",
    "can I get night vision?",
    "put night vision on me",
    "can you light this area up with night vision",
  ]) {
    assert.equal(classifyAction(question)?.type, "run_commands", question);
  }
  assert.equal(classifyAction("build and light a Nether portal with strength")?.type, "build_machine");
  assert.equal(classifyAction("make me a speed bridge")?.plan?.kind, "bridge");
  assert.notEqual(classifyAction("give me an invisibility potion")?.type, "run_commands");
  for (const question of [
    "light it up",
    "can you light this place up",
    "make it brighter",
    "put torches around me",
    "put some torches down around me",
    "place torches around me",
  ]) {
    assert.equal(classifyAction(question)?.type, "place_area_torches", question);
  }
  for (const question of ["can you make a sofa?", "make a chair", "I want a desk"]) {
    const result = await createWizard({ corpus, env: {} }).ask({ player: question, question });
    assert.ok(result.action, question);
  }
  const castle = classifyAction("build a castle");
  const castleHistory = [{
    question: "build a castle", answer: "Built.", action: castle, status: "completed",
    goal: { objective: "Build a castle", successCriteria: "The castle exists", status: "active" },
    requestId: "castle-request", goalId: "castle-goal",
  }];
  for (const question of ["light up this area", "put torches around me", "can you light this place up"]) {
    assert.equal(classifyAction(question, castleHistory)?.type, "place_area_torches", question);
  }
  for (const question of ["light up the castle", "can you light up the castle", "light up my castle", "light the castle up"]) {
    const action = classifyAction(question, castleHistory);
    assert.equal(action?.type, "build_structure", question);
    assert.equal(action?.plan.mode, "modify", question);
    assert.ok(action?.plan.primitives.some(({ blockId }) => blockId === "minecraft:sea_lantern"), question);
  }
  const torches = classifyAction("add torches to the castle", castleHistory);
  assert.equal(torches?.type, "execute_program");
  assert.equal(torches?.program.site, "active_project");
  assert.equal(torches?.program.targetKind, "castle");
  assert.ok(torches?.program.steps[0].arguments.blocks.every(({ itemId }) => itemId === "minecraft:torch"));
  for (const question of [
    "light up this area near the portal",
    "can you light this place up near my portal",
    "put torches around the portal",
  ]) {
    assert.equal(classifyAction(question, castleHistory)?.type, "place_area_torches", question);
  }
  const existingPortalHistory = [...castleHistory, {
    question: "build a nether portal", answer: "Built.", action: classifyAction("build a nether portal"), status: "completed",
  }];
  for (const question of [
    "light up this area near the nether portal",
    "can you light this place up near my nether portal",
    "brighten the area by the nether portal",
  ]) {
    assert.equal(classifyAction(question, existingPortalHistory)?.type, "place_area_torches", question);
  }

  for (const question of ["make the castle brighter", "make my castle brighter", "brighten the castle"]) {
    const action = classifyAction(question, castleHistory);
    assert.equal(action?.type, "build_structure", question);
    assert.equal(action?.plan.kind, "castle", question);
    assert.equal(action?.plan.mode, "modify", question);
    assert.ok(action?.plan.primitives.some(({ blockId }) => blockId === "minecraft:sea_lantern"), question);
  }

  const portalHistory = [...castleHistory, {
    question: "build a nether portal", answer: "Built.",
    action: classifyAction("build a nether portal"), status: "completed",
    goal: { objective: "Build a portal", successCriteria: "The portal exists", status: "active" },
    requestId: "portal-request", goalId: "portal-goal",
  }];
  const houseHistory = [...castleHistory, {
    question: "build a house", answer: "Built.",
    action: classifyAction("build a house"), status: "completed",
    goal: { objective: "Build a house", successCriteria: "The house exists", status: "active" },
    requestId: "house-request", goalId: "house-goal",
  }];
  for (const history of [portalHistory, houseHistory]) {
    const action = classifyAction("light up the castle", history);
    assert.equal(action?.type, "build_structure");
    assert.equal(action?.plan.kind, "castle");
    assert.equal(action?.plan.mode, "modify");
  }
  const bridgeHistory = [...castleHistory, {
    question: "build a bridge", answer: "Built.",
    action: classifyAction("build a bridge"), status: "completed",
    goal: { objective: "Build a bridge", successCriteria: "The bridge exists", status: "active" },
    requestId: "bridge-request", goalId: "bridge-goal",
  }];
  for (const question of [
    "add a powered bridge to the castle",
    "add a redstone-powered bridge to the castle",
    "add a redstone bridge to the castle",
  ]) {
    const action = classifyAction(question, bridgeHistory);
    assert.equal(action?.type, "build_structure", question);
    assert.equal(action?.plan.kind, "castle", question);
    assert.equal(action?.plan.mode, "modify", question);
    assert.ok(action?.plan.primitives.some(({ blockId }) => blockId === "minecraft:redstone_lamp"), question);
  }
  for (const question of [
    "repair the bridge to the castle",
    "make the bridge from the castle wider",
    "add lights to the bridge from the castle",
  ]) {
    const action = classifyAction(question, bridgeHistory);
    assert.equal(action?.type, "build_structure", question);
    assert.equal(action?.plan.kind, "bridge", question);
    assert.equal(action?.plan.mode, "modify", question);
  }
  assert.notEqual(classifyAction("replace the bridge from the castle", bridgeHistory)?.plan?.kind, "castle");
  const sessions = createMemorySessionStore();
  await sessions.set("NamedCastleKid", "wizard", portalHistory);
  const resumed = await createWizard({ corpus, sessions, env: {} }).ask({
    player: "NamedCastleKid", question: "light up the castle",
  });
  assert.equal(resumed.action?.type, "build_structure");
  assert.equal(resumed.action?.plan.kind, "castle");
  assert.equal(resumed.goal?.objective, "Build a castle");
  assert.equal(resumed.goalId, "castle-goal");
  assert.notEqual(resumed.mode, "planning-deferred");
});

test("a repaired model plan keeps an explicitly named older project target", async () => {
  const sessions = createMemorySessionStore();
  const player = "BridgeMoveKid";
  const completed = (question, requestId) => ({
    question,
    answer: "Done.",
    action: classifyAction(question),
    status: "completed",
    requestId,
    goalId: `${requestId}-goal`,
    goal: { objective: question, successCriteria: `${question} exists`, status: "complete" },
  });
  await sessions.set(player, "wizard", [
    completed("build a bridge", "bridge"),
    completed("build a castle", "castle"),
    completed("build a house", "house"),
  ]);
  const blocks = [{
    itemId: "minecraft:stone_bricks",
    target: [0, 0, 0],
    support: [0, -1, 0],
    expectedType: "minecraft:stone_bricks",
  }];
  let calls = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return modelResponse("I’m working out the move.", null, {
          objective: "Move the bridge",
          successCriteria: "The bridge is moved and verified",
          status: "active",
        });
      }
      return modelResponse("I’ll move that same bridge now.", {
        type: "execute_program",
        version: 1,
        program: {
          title: "Move the bridge",
          steps: [{
            id: "move_bridge",
            capability: "player.place-blocks",
            arguments: { blocks },
            expect: "The bridge has moved.",
          }, {
            id: "verify_bridge",
            capability: "verify.blocks",
            arguments: { blocks: [{ target: [0, 0, 0], typeId: "minecraft:stone_bricks" }] },
            expect: "The moved bridge is present.",
          }],
        },
      }, {
        objective: "Move the bridge",
        successCriteria: "The bridge is moved and verified",
        status: "active",
      });
    },
  });

  const result = await wizard.ask({ player, question: "move the bridge from the castle" });
  assert.equal(calls, 2);
  assert.equal(result.action?.type, "execute_program");
  assert.equal(result.action?.program.site, "active_project");
  assert.equal(result.action?.program.targetKind, "bridge");
});

test("a universal program refinement keeps the named older program project and goal", async () => {
  const sessions = createMemorySessionStore();
  const player = "StableProgramKid";
  const completedProgram = (title, requestId) => ({
    question: `build a ${title.toLowerCase()}`,
    answer: "Done.",
    action: {
      type: "execute_program", version: 1, program: {
        title, site: "nearby", steps: [{
          id: "place", capability: "player.place-blocks",
          arguments: { blocks: [{
            itemId: "minecraft:stone", target: [0, 0, 0], support: [0, -1, 0],
            expectedType: "minecraft:stone",
          }] },
          expect: "The project block is placed.",
        }, {
          id: "verify", capability: "verify.blocks",
          arguments: { blocks: [{ target: [0, 0, 0], typeId: "minecraft:stone" }] },
          expect: "The project block remains.",
        }],
      },
    },
    status: "completed",
    requestId,
    goalId: `${requestId}-goal`,
    goal: { objective: `Build ${title}`, successCriteria: `${title} exists`, status: "complete" },
  });
  await sessions.set(player, "wizard", [
    completedProgram("Horse Stable", "stable"),
    completedProgram("Gazebo", "gazebo"),
  ]);
  const roof = [{
    itemId: "minecraft:oak_planks", target: [0, 3, 0], support: [0, 2, 0],
    expectedType: "minecraft:oak_planks",
  }, {
    itemId: "minecraft:oak_planks", target: [1, 3, 0], support: [0, 3, 0],
    expectedType: "minecraft:oak_planks",
  }];
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I’ll roof that stable now.", {
      type: "execute_program", version: 1, program: {
        title: "Roof Horse Stable", steps: [{
          id: "place_roof", capability: "player.place-blocks", arguments: { blocks: roof },
          expect: "The stable roof is placed.",
        }, {
          id: "verify_roof", capability: "verify.blocks",
          arguments: { blocks: roof.map(({ target, expectedType }) => ({ target, typeId: expectedType })) },
          expect: "The stable roof remains.",
        }],
      },
    }, {
      objective: "Roof the horse stable", successCriteria: "The horse stable has a roof", status: "active",
    }),
  });

  const result = await wizard.ask({ player, question: "add a roof to the horse stable" });
  assert.equal(result.action?.program.site, "active_project");
  assert.equal(result.action?.program.targetKind, "horse stable");
  assert.equal(result.goalId, "stable-goal");
  assert.equal(result.goal.objective, "Build Horse Stable");
});

test("a named older fixed blueprint binds its exact persisted project id", async () => {
  const sessions = createMemorySessionStore();
  const player = "OlderFarmKid";
  const completed = (question, id, requestId) => ({
    question, answer: "Done.", action: { type: "place_blueprint", id, version: 1 },
    status: "completed", requestId, goalId: `${requestId}-goal`,
    goal: { objective: question, successCriteria: `${question} works`, status: "complete" },
  });
  await sessions.set(player, "wizard", [
    completed("build a wool farm", "automatic_wool_farm", "wool"),
    completed("build a chicken farm", "automated_chicken_farm", "chicken"),
  ]);
  const torch = {
    itemId: "minecraft:torch", target: [1, 1, 1], support: [1, 0, 1],
    expectedType: "minecraft:torch",
  };
  const wizard = createWizard({
    corpus, sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I’ll light the wool farm.", {
      type: "execute_program", version: 1, program: {
        title: "Light Wool Farm", steps: [{
          id: "place_light", capability: "player.place-blocks", arguments: { blocks: [torch] },
          expect: "The wool farm is lit.",
        }, {
          id: "verify_light", capability: "verify.blocks",
          arguments: { blocks: [{ target: torch.target, typeId: torch.expectedType }] },
          expect: "The torch remains.",
        }],
      },
    }, null),
  });

  const result = await wizard.ask({ player, question: "add lighting to the wool farm" });
  assert.equal(result.action?.program.targetKind, "automatic_wool_farm");
  assert.equal(result.goalId, "wool-goal");
  assert.equal(result.goal.objective, "build a wool farm");
});

test("provider server commands must match the requested administration operation", async () => {
  const resultFor = async (question, action) => createWizard({
      corpus,
      env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
      fetchImpl: async () => modelResponse("I’ll change it now.", action, {
        objective: question, successCriteria: "The requested server operation is complete", status: "active",
      }),
    }).ask({ player: "AdminIntentKid", question });
  const wrongAllowlist = {
      type: "execute_program", version: 1, program: {
        title: "Change server difficulty", steps: [{
          id: "wrong_server_change", capability: "server.console",
          arguments: { commands: ["allowlist remove Alice"] },
          expect: "The server is updated.",
        }],
      },
    };
  assert.equal((await resultFor("change the server difficulty to peaceful", wrongAllowlist)).action, null);
  assert.equal((await resultFor("change the server difficulty to peaceful", {
    type: "execute_program", version: 1, program: {
      title: "Wrong difficulty", steps: [{
        id: "wrong_difficulty", capability: "server.console", arguments: { commands: ["difficulty hard"] },
        expect: "The difficulty is changed.",
      }],
    },
  })).action, null);
  assert.equal((await resultFor("enable education features", {
    type: "execute_program", version: 1, program: {
      title: "Wrong configuration", steps: [{
        id: "wrong_config", capability: "server.configure",
        arguments: { properties: { difficulty: "hard" } }, expect: "The server is configured.",
      }],
    },
  })).action, null);
  const education = await resultFor("enable education features", {
    type: "execute_program", version: 1, program: {
      title: "Enable education", steps: [{
        id: "enable_education", capability: "server.configure",
        arguments: { worldOptions: { educationFeaturesEnabled: true, eduOffer: 1 } },
        expect: "Education features are enabled after restart.",
      }],
    },
  });
  assert.equal(education.action?.program.steps[0].capability, "server.configure");
  assert.equal((await resultFor("make the chickens stay put", {
    type: "run_commands", version: 1, commands: ["gamemode creative @s"],
  })).action, null);
});

test("a terminal result interrupted before replay persistence recovers instead of hard-stopping", async () => {
  const sessions = createMemorySessionStore();
  const player = "RestartRecoveryKid";
  const requestId = "recover-program";
  await sessions.set(player, "wizard", [{
    question: "build a marker",
    answer: "I’ll build it.",
    action: {
      type: "execute_program", version: 1, program: {
        title: "Marker", steps: [{
          id: "place", capability: "player.place-blocks",
          arguments: { blocks: [{
            itemId: "minecraft:stone", target: [0, 0, 0], support: [0, -1, 0],
            expectedType: "minecraft:stone",
          }] },
          expect: "The marker is placed.",
        }, {
          id: "verify", capability: "verify.blocks",
          arguments: { blocks: [{ target: [0, 0, 0], typeId: "minecraft:stone" }] },
          expect: "The marker remains.",
        }],
      },
    },
    status: "pending",
    requestId,
    goalId: "marker-goal",
    goal: { objective: "Build a marker", successCriteria: "The marker exists", status: "active" },
  }]);
  await sessions.updateAction(player, "wizard", { requestId, status: "completed", detail: "verified" });
  const restarted = createWizard({ corpus, sessions, env: {} });

  const recovered = await restarted.recordActionResult({ player, requestId, status: "completed", detail: "verified" });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.updated, true);
  assert.equal(recovered.reviewDeferred, true);
  const replayed = await restarted.recordActionResult({ player, requestId, status: "completed", detail: "verified" });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.reviewDeferred, true);

  await restarted.clearSession(player);
  await sessions.set(player, "wizard", [{
    question: "take me to the Nether",
    answer: "Off we go.",
    action: { type: "dimension_travel", version: 1, destination: "nether" },
    status: "pending",
    requestId,
    goalId: "travel-goal",
    goal: { objective: "Travel to the Nether", successCriteria: "The player arrives", status: "active" },
  }]);
  const afterClear = await restarted.recordActionResult({
    player, requestId, status: "completed", detail: "arrived",
  });
  assert.equal(afterClear.replayed, undefined);
  assert.equal(afterClear.review?.goal.status, "complete");
});

test("a transient replan write failure releases its sequence so terminal recovery can retry", async () => {
  const baseSessions = createMemorySessionStore();
  let failNextAppend = false;
  const sessions = {
    ...baseSessions,
    async appendIfCurrent(...args) {
      if (failNextAppend) {
        failNextAppend = false;
        throw new Error("transient persistence failure");
      }
      return baseSessions.appendIfCurrent(...args);
    },
  };
  const wizard = createWizard({ corpus, sessions, env: {} });
  const first = await wizard.ask({
    player: "PersistenceKid", question: "give me night vision", requestId: "night-vision-recovery",
  });
  failNextAppend = true;
  await assert.rejects(wizard.recordActionResult({
    player: "PersistenceKid", requestId: first.requestId, status: "failed", detail: "effect command failed",
  }), /transient persistence failure/);

  const recovered = await wizard.recordActionResult({
    player: "PersistenceKid", requestId: first.requestId, status: "failed", detail: "effect command failed",
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.superseded, undefined);
  assert.ok(recovered.replan?.action || recovered.retry, "terminal recovery must make another attempt");
});

test("a terminal replay write failure recovers an already-persisted completion review", async () => {
  const baseSessions = createMemorySessionStore();
  let failNextResultWrite = true;
  const sessions = {
    ...baseSessions,
    async setActionResult(...args) {
      if (failNextResultWrite) {
        failNextResultWrite = false;
        throw new Error("disk full");
      }
      return baseSessions.setActionResult(...args);
    },
  };
  const firstWizard = createWizard({ corpus, sessions, env: {} });
  const first = await firstWizard.ask({
    player: "ReplayPersistenceKid", question: "give me night vision", requestId: "effect-completion",
  });
  await assert.rejects(firstWizard.recordActionResult({
    player: "ReplayPersistenceKid", requestId: first.requestId,
    status: "completed", detail: "effect applied",
  }), /disk full/);

  const restarted = createWizard({ corpus, sessions, env: {} });
  const recovered = await restarted.recordActionResult({
    player: "ReplayPersistenceKid", requestId: first.requestId,
    status: "completed", detail: "effect applied",
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.superseded, undefined);
  assert.equal(recovered.review?.goal.status, "complete");
  assert.equal(baseSessions.getActionResult("ReplayPersistenceKid", "wizard", first.requestId)?.review?.goal.status, "complete");
});

test("a terminal replay write failure returns its already-persisted automatic replan", async () => {
  const baseSessions = createMemorySessionStore();
  let failNextResultWrite = true;
  const sessions = {
    ...baseSessions,
    async setActionResult(...args) {
      if (failNextResultWrite) {
        failNextResultWrite = false;
        throw new Error("disk full");
      }
      return baseSessions.setActionResult(...args);
    },
  };
  const firstWizard = createWizard({ corpus, sessions, env: {} });
  const first = await firstWizard.ask({
    player: "FailedReplayKid", question: "give me night vision", requestId: "failed-effect",
  });
  await assert.rejects(firstWizard.recordActionResult({
    player: "FailedReplayKid", requestId: first.requestId,
    status: "failed", detail: "effect command failed",
  }), /disk full/);

  const restarted = createWizard({ corpus, sessions, env: {} });
  const recovered = await restarted.recordActionResult({
    player: "FailedReplayKid", requestId: first.requestId,
    status: "failed", detail: "effect command failed",
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.superseded, undefined);
  assert.ok(recovered.replan?.action, "the child must receive the replan that was already saved");
  assert.equal(recovered.replan.requestId, baseSessions.get("FailedReplayKid", "wizard").at(-1).requestId);
});

test("provider power intent scans nested execute commands instead of only the first verb", async () => {
  const actions = [{
    type: "run_commands", version: 1,
    commands: ["execute as @e run kill @e[type=chicken]"],
  }, {
    type: "run_commands", version: 1,
    commands: ["kill @e[type=!chicken]"],
  }, {
    type: "execute_program", version: 1, program: {
      title: "Make the mess vanish",
      steps: [{
        id: "nested_kill", capability: "world.command",
        arguments: { commands: ["execute as @s run kill @e"] },
        expect: "The mess is gone.",
      }],
    },
  }, {
    type: "execute_program", version: 1, program: {
      title: "Freeze the chickens",
      steps: [{
        id: "nested_damage", capability: "world.command",
        arguments: { commands: ["execute as @s run damage @e[type=chicken] 100000 entity_attack"] },
        expect: "The chickens stay put.",
      }],
    },
  }, {
    type: "execute_program", version: 1, program: {
      title: "Remove the floor",
      steps: [{
        id: "nested_fill_air", capability: "world.command",
        arguments: { commands: ["execute as @s at @s run fill ~-32 ~-32 ~-32 ~32 ~32 ~32 air"] },
        expect: "The chickens stay put.",
      }],
    },
  }, ...[
    "execute as @s run tp @a ~ ~-100 ~",
    "execute as @s run effect @a fatal_poison 999999 255 true",
    "execute as @s run summon wither ~ ~ ~",
    "execute as @s run scoreboard players set @a pwned 1",
  ].map((command, index) => ({
    type: "execute_program", version: 1, program: {
      title: `Unrelated power ${index}`,
      steps: [{
        id: `unrelated_${index}`, capability: "world.command",
        arguments: { commands: [command] }, expect: "The chickens stay put.",
      }],
    },
  })), {
    type: "execute_program", version: 1, program: {
      title: "Move the kid instead", steps: [{
        id: "move_kid", capability: "script.teleport",
        arguments: { subject: "requester", target: [100, 0, 0] },
        expect: "The chickens stay put.",
      }],
    },
  }, {
    type: "execute_program", version: 1, program: {
      title: "Remove the floor instead", steps: [{
        id: "break_floor", capability: "player.break-blocks",
        arguments: { targets: [[0, 0, 0], [1, 0, 0]] },
        expect: "The chickens stay put.",
      }],
    },
  }, {
    type: "execute_program", version: 1, program: {
      title: "Slow the chickens",
      steps: [{
        id: "slow_chickens", capability: "world.command",
        arguments: { commands: ["effect @e[type=chicken] slowness 20 10 true"] },
        expect: "The chickens stay put.",
      }],
    },
  }];
  for (const [index, action] of actions.slice(0, -1).entries()) {
    const wizard = createWizard({
      corpus,
      env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
      fetchImpl: async () => modelResponse("I’ll make that happen.", action, null),
    });
    const result = await wizard.ask({
      player: `PowerIntentKid${index}`, question: "make the chickens stay put",
    });
    assert.equal(result.action, null);
  }
  const relevant = actions.at(-1);
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I’ll slow the chickens.", relevant, null),
  });
  assert.equal((await wizard.ask({ player: "RelevantPowerKid", question: "make the chickens stay put" }))
    .action?.program.steps[0].id, "slow_chickens");
});

test("common fused chat words still route to local travel and portal actions", () => {
  assert.equal(classifyAction("takeme to the overworld").destination, "overworld");
  const portal = classifyAction("build and light a netherportal");
  assert.equal(portal.type, "build_machine");
  assert.equal(portal.plan.kind, "nether portal");
  assert.equal(portal.plan.interactions[0].itemId, "minecraft:flint_and_steel");
});

test("portal pronoun follow-ups stay local instead of waiting for the planner", async () => {
  const sessions = createMemorySessionStore();
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("portal follow-ups must stay local");
    },
  });
  const player = "PortalKid";
  let result = await wizard.ask({ player, question: "build an unlit Nether portal" });
  await sessions.updateAction(player, "wizard", { requestId: result.requestId, status: "completed", detail: "built" });
  result = await wizard.ask({ player, question: "light it" });
  assert.equal(result.action.plan.mode, "modify");
  assert.equal(result.action.plan.interactions.length, 1);
  assert.match(result.answer, /light this same portal frame/i);
  await sessions.updateAction(player, "wizard", { requestId: result.requestId, status: "completed", detail: "lit" });
  result = await wizard.ask({ player, question: "switch it off" });
  assert.equal(result.action.plan.mode, "modify");
  assert.equal(result.action.plan.interactions.length, 0);
  assert.equal(providerCalls, 0);
});

test("compiles a planner-selected portal into the exact safe player-action contract", async () => {
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I’ll build and light the portal.", {
      type: "build_machine", version: 1, plan: {
        title: "Nether Portal", kind: "Nether portal",
        placements: [{
          itemId: "minecraft:obsidian", target: [0, 0, 0], support: [0, -1, 0], orientationTarget: null,
        }],
        interactions: [{
          itemId: "minecraft:flint_and_steel", target: [0, 0, 0], faceTarget: [1, 1, 0],
        }],
      },
    }, {
      objective: "Build and light a Nether portal",
      successCriteria: ["A complete obsidian frame exists", "Purple portal blocks are visible"],
      status: "active",
    }),
  });
  const result = await wizard.ask({ player: "PortalKid", question: "Build and light a Nether portal here" });
  assert.equal(result.action.type, "build_machine");
  assert.equal(result.action.plan.placements.length, 14);
  assert.deepEqual(result.action.plan.interactions[0], {
    action: "use_item_on_block", itemId: "minecraft:flint_and_steel",
    block: [1, 0, 0], faceTarget: [1, 1, 0],
  });
  assert.match(result.goal.successCriteria, /exact request/i);
});

test("replays the live rainbow castle refinements immediately without a planner wait", async () => {
  const sessions = createMemorySessionStore();
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("ordinary castle changes must stay local");
    },
  });
  const player = "RainbowKid";
  const initialQuestion = "build a 17x26 rainbow castle with 3 villagers and a goat in it";
  const initial = await wizard.ask({ player, question: initialQuestion });
  // #35: "rainbow" is descriptor residue, so the fresh build consults the
  // model once; the provider is down here, and the offline fallback still
  // delivers the full deterministic rainbow castle immediately.
  assert.equal(providerCalls, 1);
  assert.equal(initial.action.type, "build_structure");
  assert.deepEqual(initial.action.plan.dimensions, { width: 17, depth: 26, height: 9 });
  assert.ok(initial.action.plan.features.includes("rainbow"));
  assert.equal(initial.action.plan.entities.filter(({ typeId }) => typeId === "minecraft:villager_v2").length, 3);
  assert.equal(initial.action.plan.entities.filter(({ typeId }) => typeId === "minecraft:goat").length, 1);
  assert.equal(initial.action.plan.entities.every(({ location }) => location[1] === 1), true);
  await sessions.updateAction(player, "wizard", { requestId: initial.requestId, status: "completed", detail: "built" });

  const afterCompletedReview = classifyAction("the colors are wrong. fix the colors", [
    {
      question: initialQuestion,
      answer: initial.answer,
      action: initial.action,
      status: "completed",
      requestId: initial.requestId,
      goalId: initial.requestId,
      goal: { ...initial.goal, status: "active" },
    },
    {
      question: "Review the completed in-world attempt using the fresh live-world snapshot.",
      answer: "Goal complete.",
      goalId: initial.requestId,
      goal: { ...initial.goal, status: "complete" },
    },
  ]);
  assert.equal(afterCompletedReview?.type, "build_structure");
  assert.equal(afterCompletedReview?.plan.mode, "modify");

  const repaint = await wizard.ask({ player, question: "the colors are wrong. fix the colors" });
  // #35: refinements of the same project stay planner-free (count unchanged)
  assert.equal(providerCalls, 1);
  assert.equal(repaint.action.type, "build_structure");
  assert.equal(repaint.action.plan.mode, "modify");
  assert.equal(new Set(repaint.action.plan.primitives
    .filter(({ phase }) => phase === "shell")
    .map(({ blockId }) => blockId)).size, 7);
  await sessions.updateAction(player, "wizard", { requestId: repaint.requestId, status: "completed", detail: "repainted" });

  const correctionQuestion = "but it's not rainbow colored. make it taller, add stairs so we can get to another floor and add some rooms, a moat filled with lava, a redstone powered bridge, and several iron golem guards around.";
  const correction = await wizard.ask({ player, question: correctionQuestion });
  assert.equal(providerCalls, 1); // #35: still no planner wait for refinements
  assert.equal(correction.action.type, "build_structure");
  assert.equal(correction.action.plan.mode, "modify");
  assert.deepEqual(correction.action.plan.dimensions, { width: 17, depth: 26, height: 13 });
  assert.ok(correction.action.plan.features.includes("rooms"));
  assert.ok(correction.action.plan.features.includes("second_floor"));
  assert.ok(correction.action.plan.primitives.some(({ blockId }) => blockId === "minecraft:lava"));
  assert.ok(correction.action.plan.primitives.some(({ blockId, from, to }) => (
    blockId === "minecraft:polished_blackstone_bricks" && from[2] === -2 && to[2] === -2
  )));
  assert.ok(correction.action.plan.primitives.some(({ blockId }) => blockId === "minecraft:redstone_lamp"));
  assert.ok(correction.action.plan.primitives.some(({ blockId, from, to }) => (
    blockId === "minecraft:redstone_lamp" && from[2] === -2 && to[2] === 2
  )));
  assert.equal(correction.action.plan.primitives.filter(({ blockId }) => blockId === "minecraft:redstone_block").length, 2);
  assert.ok(correction.action.plan.primitives
    .filter(({ blockId }) => blockId === "minecraft:redstone_block")
    .every(({ from, to }) => from[2] === -2 && to[2] === 2));
  assert.equal(correction.action.plan.entities.filter(({ typeId }) => typeId === "minecraft:iron_golem").length, 4);
  assert.notEqual(correction.action.type, "place_blueprint");
  await sessions.updateAction(player, "wizard", { requestId: correction.requestId, status: "completed", detail: "upgraded" });

  const lighting = await wizard.ask({ player, question: "it's too dark in the castle. light it up" });
  assert.equal(providerCalls, 1); // #35: still no planner wait for refinements
  assert.equal(lighting.action.plan.mode, "modify");
  assert.ok(lighting.action.plan.primitives.filter(({ blockId }) => blockId === "minecraft:sea_lantern").length >= 8);
});

test("removes each supported castle inhabitant locally and preserves the others", async () => {
  const sessions = createMemorySessionStore();
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("inhabitant removal must stay local");
    },
  });
  const player = "CastleKeeper";
  const initial = await wizard.ask({
    player,
    question: "build a castle with two villagers, a goat, and two iron golems",
  });
  await sessions.updateAction(player, "wizard", { requestId: initial.requestId, status: "completed", detail: "built" });

  const removals = [
    ["remove the villagers", "minecraft:villager_v2"],
    ["remove the goat", "minecraft:goat"],
    ["remove the iron golems", "minecraft:iron_golem"],
  ];
  for (const [question, removedType] of removals) {
    const result = await wizard.ask({ player, question });
    assert.equal(providerCalls, 0, question);
    assert.equal(result.action.plan.mode, "modify", question);
    assert.equal((result.action.plan.entities || []).some(({ typeId }) => typeId === removedType), false, question);
    await sessions.updateAction(player, "wizard", { requestId: result.requestId, status: "completed", detail: "updated" });
  }
});

test("keeps a child-owned city goal and revises that same project", async () => {
  const sessions = createMemorySessionStore();
  const requests = [];
  let call = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body).messages[1].content);
      call += 1;
      if (call === 1) {
        return modelResponse("I’ll build a small city with streets and a varied skyline.", {
            type: "build_structure", version: 1, plan: cityPlan(),
          }, {
            objective: "Build a small city inspired by New York City",
            successCriteria: "Several distinct buildings, connected streets, and a recognizable varied skyline exist nearby",
            status: "active",
          });
      }
      const modelRevision = cityPlan({ mode: true, height: 24 });
      modelRevision.dimensions.width = 29;
      modelRevision.dimensions.depth = 29;
      return modelResponse("I’ll revise this same city with taller towers and a stronger skyline.", {
        type: "build_structure", version: 1, plan: modelRevision,
      }, {
        objective: "Improve the existing city so it feels more like New York City",
        successCriteria: "The same site has streets, several buildings, and visibly taller varied towers",
        status: "active",
      });
    },
  });

  const first = await wizard.ask({ player: "CityKid", question: "Build a small city that reminds me of NYC" });
  assert.equal(first.action.plan.kind, "city");
  assert.equal(first.goal.status, "active");
  await wizard.recordActionResult({
    player: "CityKid", requestId: first.requestId, status: "completed", detail: "all planned blocks placed",
  });
  const revision = await wizard.ask({ player: "CityKid", question: "Make it more like NYC with taller towers" });
  assert.equal(revision.action.plan.mode, "modify");
  assert.equal(revision.action.plan.kind, "city");
  assert.deepEqual(revision.action.plan.dimensions, { width: 31, depth: 31, height: 24 });
  assert.match(requests[1], /Goal \(active\): Build a small city that reminds me of NYC/);
  assert.match(requests[1], /Completed action:/);
  await wizard.recordActionResult({
    player: "CityKid", requestId: revision.requestId, status: "completed", detail: "revised city verified",
  });

  const satisfied = await wizard.ask({ player: "CityKid", question: "Looks good!" });
  assert.equal(satisfied.action, null);
  assert.equal(satisfied.goal.status, "complete");
  assert.equal(call, 2);
});

test("compiles an incomplete city declaration into a complete executable city in one turn", async () => {
  const requests = [];
  let call = 0;
  const sessions = createMemorySessionStore();
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body).messages[1].content);
      call += 1;
      const plan = cityPlan();
      delete plan.primitives;
      delete plan.entities;
      return modelResponse(
        "I’ll build the city.",
        { type: "build_structure", version: 1, plan },
        {
          objective: "Build a small working city",
          successCriteria: "Several buildings and connected streets exist nearby",
          status: "active",
        },
      );
    },
  });

  const result = await wizard.ask({
    player: "RepairCityKid",
    question: "Build a 31x31x18 city with crossed streets, four buildings, lights, and exactly four villagers",
  });
  assert.equal(call, 1);
  assert.equal(result.action.type, "build_structure");
  assert.equal(result.action.plan.kind, "city");
  assert.deepEqual(result.action.plan.dimensions, { width: 31, depth: 31, height: 18 });
  assert.equal(result.action.plan.primitives.filter(({ shape }) => shape === "hollow_box").length, 4);
  assert.equal(result.action.plan.primitives.filter(({ blockId }) => blockId === "minecraft:air").length, 4);
  assert.ok(result.action.plan.primitives.filter(({ blockId }) => blockId === "minecraft:sea_lantern").length >= 4);
  assert.equal(result.action.plan.entities.filter(({ typeId }) => typeId === "minecraft:villager_v2").length, 4);

  await wizard.recordActionResult({
    player: "RepairCityKid", requestId: result.requestId, status: "completed", detail: "city verified",
  });
  const revisionQuestion = "Make this same city more like New York by adding two taller skyscrapers and at least four more streetlights";
  const revision = await wizard.ask({ player: "RepairCityKid", question: revisionQuestion });
  const originalTallest = Math.max(...result.action.plan.primitives
    .filter(({ shape }) => shape === "hollow_box")
    .map(({ from, to }) => to[1] - from[1] + 1));
  const taller = revision.action.plan.primitives
    .filter(({ shape }) => shape === "hollow_box")
    .filter(({ from, to }) => to[1] - from[1] + 1 > originalTallest).length;
  const countLights = (plan) => plan.primitives.filter(({ blockId }) => (
    /(?:sea_lantern|glowstone|shroomlight|froglight|light_block|torch)$/.test(blockId)
  )).length;
  assert.equal(call, 2);
  assert.equal(revision.action.plan.mode, "modify");
  assert.ok(taller >= 2);
  assert.ok(countLights(revision.action.plan) >= countLights(result.action.plan) + 4);
  assert.equal(revision.action.plan.entities.filter(({ typeId }) => typeId === "minecraft:villager_v2").length, 4);
  assert.doesNotThrow(() => validateBuildStructurePlan({ ...revision.action.plan, mode: undefined }));
  assert.match(revision.goal.successCriteria, /exactly four villagers/i);
  const turns = sessions.get("RepairCityKid", "wizard");
  assert.equal(turns[0].goalId, turns.at(-1).goalId);
});

// #35: accept-with-warning replaced wholesale replacement. A compact but
// subject-shaped city is now accepted with an in-character caveat and an
// active goal so the review loop refines it, instead of being thrown away.
test("accepts a model's compact one-room city with a caveat and keeps the goal active", async () => {
  let calls = 0;
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      return modelResponse("I’ll build the city.", {
        type: "build_structure", version: 1, plan: {
          title: "Tiny City Room", kind: "city",
          dimensions: { width: 31, depth: 31, height: 18 },
          materials: {
            primary: "minecraft:stone_bricks",
            accent: "minecraft:brick_block",
            roof: "minecraft:deepslate_bricks",
          },
          features: ["floor", "walls", "roof", "lighting"],
          phases: ["foundation", "shell", "roof", "details"],
          primitives: [
            { shape: "box", phase: "foundation", blockId: "minecraft:stone_bricks", from: [0, 0, 0], to: [8, 0, 8] },
            { shape: "hollow_box", phase: "shell", blockId: "minecraft:stone_bricks", from: [0, 0, 0], to: [8, 4, 8] },
            { shape: "box", phase: "roof", blockId: "minecraft:deepslate_bricks", from: [0, 4, 0], to: [8, 4, 8] },
            { shape: "box", phase: "details", blockId: "minecraft:sea_lantern", from: [4, 1, 4], to: [4, 1, 4] },
          ],
        },
      }, {
        objective: "Build a city",
        successCriteria: "A complete city exists nearby",
        status: "active",
      });
    },
  });

  const result = await wizard.ask({ player: "CompactCityKid", question: "Build a city" });
  assert.equal(calls, 1);
  // salvage renormalized the declared bounds to the authored 9x9x5 room
  assert.deepEqual(result.action.plan.dimensions, { width: 9, depth: 9, height: 5 });
  assert.equal(result.goal.status, "active");
  assert.match(result.answer, /rough|sculpting/i);
  assert.doesNotThrow(() => validateBuildStructurePlan(result.action.plan));
});

test("turns label-only city room, window, and furnishing feedback into real in-place geometry", async () => {
  const sessions = createMemorySessionStore();
  let call = 0;
  const initial = cityPlan();
  initial.entities = [
    [7, 2, 7], [22, 2, 7], [7, 2, 22], [22, 2, 22],
  ].map((location) => ({ typeId: "minecraft:villager_v2", location }));
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      call += 1;
      if (call === 1) {
        return modelResponse("I’ll build the complete city.", {
          type: "build_structure", version: 1, plan: initial,
        }, {
          objective: "Build a city with four villagers",
          successCriteria: "The city and exactly four villagers exist nearby",
          status: "active",
        });
      }
      return modelResponse("I’ll add rooms, windows, and furnishings to this city.", {
        type: "build_structure", version: 1, plan: {
          ...cityPlan({ mode: true }),
          features: [...initial.features, "rooms", "decorations"],
          primitives: [{
            shape: "box", phase: "details", blockId: "minecraft:sea_lantern",
            from: [15, 1, 15], to: [15, 1, 15],
          }],
        },
      }, {
        objective: "Improve the same city",
        successCriteria: "The city has rooms, glass windows, and furnishings",
        status: "active",
      });
    },
  });

  const first = await wizard.ask({
    player: "FeatureCityKid",
    question: "Build a 31x31x18 city with exactly four villagers",
  });
  await wizard.recordActionResult({
    player: "FeatureCityKid", requestId: first.requestId, status: "completed", detail: "city placed",
  });
  const revision = await wizard.ask({
    player: "FeatureCityKid",
    question: "Add rooms, windows, and furnishings to this city",
  });
  const plan = revision.action.plan;
  const buildings = plan.primitives.filter(({ shape }) => shape === "hollow_box");
  const inside = (entry, building) => entry.from[0] > building.from[0]
    && entry.to[0] < building.to[0]
    && entry.from[2] > building.from[2]
    && entry.to[2] < building.to[2]
    && entry.from[1] > building.from[1]
    && entry.to[1] < building.to[1];
  const details = plan.primitives.filter(({ phase }) => phase === "details");
  const roomWalls = details.filter((entry) => entry.blockId !== "minecraft:air"
    && entry.blockId !== "minecraft:glass"
    && entry.to[1] > entry.from[1]
    && buildings.some((building) => inside(entry, building)));
  const furnishings = details.filter((entry) => entry.blockId !== "minecraft:air"
    && entry.blockId !== "minecraft:glass"
    && entry.from[1] === entry.to[1]
    && buildings.some((building) => inside(entry, building)));
  assert.equal(call, 2);
  assert.equal(plan.mode, "modify");
  assert.ok(roomWalls.length >= 4);
  assert.ok(details.filter(({ blockId }) => blockId === "minecraft:glass").length >= 4);
  assert.ok(furnishings.length >= 4);
  assert.equal(plan.entities.filter(({ typeId }) => typeId === "minecraft:villager_v2").length, 4);
  assert.doesNotThrow(() => validateBuildStructurePlan({ ...plan, mode: undefined }));
  assert.equal(sessions.get("FeatureCityKid", "wizard")[0].goalId,
    sessions.get("FeatureCityKid", "wizard").at(-1).goalId);
});

test("normalizes common model structure aliases and phase ordering before validation", async () => {
  const plan = cityPlan();
  plan.materials.accent = "minecraft:bricks";
  plan.features = ["foundation", "walls", "roof", "lighting"];
  plan.primitives = plan.primitives.toReversed().map((primitive) => ({
    ...primitive,
    ...(primitive.blockId === "minecraft:brick_block" ? { blockId: "minecraft:bricks" } : {}),
    phase: primitive.phase === "shell" ? "walls" : primitive.phase,
    ...(primitive.phase === "roof" && primitive.from[0] === 17
      ? { blockId: "minecraft:deepslate_brick", to: [28, 18, 13] } : {}),
  }));
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I’ll build the complete city.", {
      type: "build_structure", version: 1, plan,
    }, {
      objective: "Build a city",
      successCriteria: "Several buildings and connected streets exist",
      status: "active",
    }),
  });
  const result = await wizard.ask({ player: "AliasCityKid", question: "Build a city" });
  assert.equal(result.action.plan.kind, "city");
  assert.deepEqual(result.action.plan.phases, ["foundation", "shell", "roof", "details"]);
  assert.equal(result.action.plan.features[0], "floor");
  assert.deepEqual([...new Set(result.action.plan.primitives.map(({ phase }) => phase))],
    ["foundation", "shell", "roof", "details"]);
  assert.equal(result.action.plan.materials.accent, "minecraft:brick_block");
  assert.ok(result.action.plan.primitives.every(({ blockId }) => blockId !== "minecraft:bricks"));
});

test("city compiler canonicalizes kind, fills partial dimensions, and replaces invalid materials", async () => {
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I’ll build the complete city.", {
      type: "build_structure", version: 1, plan: {
        title: "Kid City", kind: "City",
        dimensions: { width: 31 },
        materials: {
          primary: "minecraft:calcite", accent: "minecraft:calcite", roof: "minecraft:calcite",
        },
        features: ["streetlights"], phases: ["foundation", "shell", "roof", "details"],
      },
    }, {
      objective: "Build a city",
      successCriteria: "A complete city exists nearby",
      status: "active",
    }),
  });
  const result = await wizard.ask({
    player: "PartialCityKid",
    question: "Build a city 31 blocks wide with streetlights and exactly four villagers",
  });
  assert.equal(result.action.plan.kind, "city");
  assert.deepEqual(result.action.plan.dimensions, { width: 31, depth: 31, height: 18 });
  assert.ok(Object.values(result.action.plan.materials).every((blockId) => blockId !== "minecraft:calcite"));
  assert.equal(result.action.plan.entities.length, 4);
  assert.ok(result.action.plan.primitives.filter(({ blockId }) => blockId === "minecraft:sea_lantern").length >= 4);
});

test("fits non-exact model bounds and compiles exact requested city dimensions", async () => {
  const oversized = cityPlan();
  oversized.dimensions = { width: 40, depth: 40, height: 25 };
  const response = () => modelResponse("I’ll build the complete city inside its real footprint.", {
    type: "build_structure", version: 1, plan: oversized,
  }, {
    objective: "Build a city",
    successCriteria: "The streets and buildings are complete",
    status: "active",
  });
  const flexible = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => response(),
  });
  const fitted = await flexible.ask({ player: "FittedCityKid", question: "Build a small city" });
  assert.deepEqual(fitted.action.plan.dimensions, { width: 31, depth: 31, height: 18 });

  const exact = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => response(),
  });
  const compiled = await exact.ask({ player: "ExactCityKid", question: "Build a 40x40x25 city" });
  assert.deepEqual(compiled.action.plan.dimensions, { width: 40, depth: 40, height: 25 });
  assert.equal(compiled.action.plan.primitives.filter(({ shape }) => shape === "hollow_box").length, 4);
  assert.equal(compiled.goal.status, "active");
});

test("city resizing recompiles the whole project and vague resident feedback preserves every villager", () => {
  const initial = classifyAction("Build a 31x31x18 city with exactly four villagers");
  const history = [{
    question: "Build a 31x31x18 city with exactly four villagers",
    answer: "I built the city.",
    action: initial,
    goal: { objective: "Build a city", successCriteria: "Four villagers live there", status: "active" },
    goalId: "city-contract",
    requestId: "city-first",
    status: "completed",
  }];
  const resized = classifyAction("Make it 50x50x30 with taller skyscrapers", history);
  assert.deepEqual(resized.plan.dimensions, { width: 50, depth: 50, height: 30 });
  assert.equal(resized.plan.mode, "modify");
  assert.equal(resized.plan.primitives.filter(({ shape }) => shape === "hollow_box").length, 4);
  assert.equal(resized.plan.entities.length, 4);

  const residentUpgrade = classifyAction("Add four more streetlights for the villagers", history);
  assert.equal(residentUpgrade.plan.mode, "modify");
  assert.equal(residentUpgrade.plan.entities.length, 4);
});

test("explicit resident removal produces a valid zero-resident refinement", () => {
  const initial = classifyAction("Build a castle with four villagers");
  const removal = classifyAction("Remove all villagers from this castle", [{
    question: "Build a castle with four villagers",
    answer: "The castle is ready.",
    action: initial,
    goal: { objective: "Build a castle", successCriteria: "The castle is ready", status: "active" },
    goalId: "castle-residents",
    requestId: "castle-first",
    status: "completed",
  }]);
  assert.equal(removal.plan.mode, "modify");
  assert.equal(removal.plan.entities, undefined);
});

test("rejects a destructive whole-city air patch instead of pretending it is a park", async () => {
  const sessions = createMemorySessionStore();
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => {
      providerCalls += 1;
      return modelResponse("I’ll add the park in place.", {
        type: "build_structure", version: 1, plan: {
          title: "City Park", kind: "city", mode: "modify",
          dimensions: { width: 31, depth: 31, height: 18 },
          materials: {
            primary: "minecraft:stone_bricks", accent: "minecraft:brick_block", roof: "minecraft:deepslate_bricks",
          },
          features: ["floor", "walls", "door", "roof", "lighting", "walkway"],
          phases: ["foundation", "shell", "roof", "details"],
          primitives: [{
            shape: "box", phase: "details", blockId: "minecraft:air",
            from: [0, 0, 0], to: [30, 17, 30],
          }],
        },
      }, {
        objective: "Add a park to the existing city",
        successCriteria: "The existing city remains and has a park",
        status: "active",
      });
    },
  });
  const initial = await wizard.ask({ player: "ParkKid", question: "Build a city" });
  await wizard.recordActionResult({
    player: "ParkKid", requestId: initial.requestId, status: "completed", detail: "city verified",
  });
  const result = await wizard.ask({ player: "ParkKid", question: "Add a park to this city" });
  // #35: the first turn now adopts the deterministic city instead of spending
  // a provider repair round on the destructive plan, so one call is saved. The
  // air patch itself is still rejected and no action is executed.
  assert.equal(providerCalls, 2);
  assert.equal(result.action, null);
  assert.equal(result.goal.status, "active");
});

test("machine feedback invokes the planner and targets the active project", async () => {
  const sessions = createMemorySessionStore();
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalls += 1;
      return modelResponse("I’ll rebuild this same enclosure with a taller glass wall.", {
        type: "build_machine", version: 1, plan: {
          title: "Contained Chicken Farm", kind: "automatic chicken farm", mode: "modify",
          placements: providerCalls === 1 ? [
            { itemId: "minecraft:smooth_stone", target: [0, 0, 0], support: [0, -1, 0], orientationTarget: null },
            { itemId: "minecraft:glass", target: [0, 1, 0], support: [0, 0, 0], orientationTarget: null },
          ] : [[0, 0], [2, 0], [0, 2], [2, 2]].flatMap(([x, z]) => [
            { itemId: "minecraft:smooth_stone", target: [x, 0, z], support: [x, -1, z], orientationTarget: null },
            { itemId: "minecraft:glass", target: [x, 1, z], support: [x, 0, z], orientationTarget: null },
            { itemId: "minecraft:glass", target: [x, 2, z], support: [x, 1, z], orientationTarget: null },
          ]),
          interactions: [],
        },
      }, {
        objective: "Keep the chickens contained in the existing automatic chicken farm",
        successCriteria: "Chickens cannot walk out and eggs still reach the collection chest",
        status: "active",
      });
    },
  });

  const initial = await wizard.ask({ player: "FarmKid", question: "Build me an automatic chicken farm" });
  assert.equal(initial.action.id, "automated_chicken_farm");
  assert.equal(providerCalls, 0);
  await wizard.recordActionResult({
    player: "FarmKid", requestId: initial.requestId, status: "completed", detail: "blueprint placed",
  });
  const repair = await wizard.ask({
    player: "FarmKid", question: "It is too short and the chickens can walk out. Refine it.",
  });
  assert.equal(providerCalls, 2);
  assert.equal(repair.action.type, "build_machine");
  assert.equal(repair.action.plan.mode, "modify");
  assert.equal(repair.goal.objective, "Build me an automatic chicken farm");
  assert.match(repair.goal.successCriteria, /chickens can walk out/i);
});

test("rejects an unrelated replacement action for corrective feedback", async () => {
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => {
      providerCalls += 1;
      return modelResponse("I’ll replace it with a calculator.", {
        type: "place_blueprint", id: "binary_adder_2bit", version: 1,
      }, {
        objective: "Build a calculator instead",
        successCriteria: "A calculator exists",
        status: "active",
      });
    },
  });
  const first = await wizard.ask({ player: "CorrectionKid", question: "Build an automatic chicken farm" });
  await wizard.recordActionResult({
    player: "CorrectionKid", requestId: first.requestId, status: "completed", detail: "farm placed",
  });
  let correction;
  for (let planningAttempt = 0; planningAttempt < 3; planningAttempt += 1) {
    correction = await wizard.ask({
      player: "CorrectionKid", question: "The chicken farm is wrong. Fix it and keep working on that farm.",
    });
    assert.equal(correction.action, null);
    assert.equal(correction.mode, "planning-deferred");
    assert.notEqual(correction.goal?.objective, "Build a calculator instead");
  }
  // #35: each attempt now runs the bounded two-round repair loop
  // (MC_WIZARD_REPAIR_ROUNDS default 2), so every attempt costs three calls.
  assert.equal(providerCalls, 9);
  assert.match(correction.answer, /don’t have a safe executable change yet/i);
  assert.doesNotMatch(correction.answer, /automatic|retry|trying another|you do not need to ask/i);
});

test("the three-attempt planning loop repairs chicken containment before its terminal attempt", async () => {
  const sessions = createMemorySessionStore();
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => {
      providerCalls += 1;
      return modelResponse("I replaced the farm with a binary adder.", {
        type: "place_blueprint", id: "binary_adder_2bit", version: 1,
      }, {
        objective: "Build a binary adder",
        successCriteria: "The adder works",
        status: "active",
      });
    },
  });
  const first = await wizard.ask({ player: "ActionlessReviewKid", question: "Build an automatic chicken farm" });
  const goalId = sessions.get("ActionlessReviewKid", "wizard")[0].goalId;
  const completed = await wizard.recordActionResult({
    player: "ActionlessReviewKid",
    requestId: first.requestId,
    status: "completed",
    detail: "farm placed, but containment still needs checking",
    context: liveContext,
  });
  assert.equal(completed.review.action, null);
  assert.equal(completed.review.goal.status, "active");

  const attempts = [];
  for (let planningAttempt = 0; planningAttempt < 3; planningAttempt += 1) {
    const response = await wizard.ask({
      player: "ActionlessReviewKid", question: "The chickens walk out. Fix it.",
    });
    attempts.push(response);
    if (response.action) break;
  }

  const correction = attempts.at(-1);
  assert.equal(attempts.length, 1);
  // #35: review (1) + planner consult (1) + two bounded repair rounds (2)
  assert.equal(providerCalls, 4);
  assert.equal(correction.action.type, "build_machine");
  assert.equal(correction.action.plan.mode, "modify");
  assert.equal(correction.action.plan.kind, "automatic chicken farm");
  assert.ok(correction.action.plan.placements.some(({ itemId, target }) => (
    itemId === "minecraft:glass" && target[0] === 0 && target[1] === 3 && target[2] === 2
  )));
  assert.match(correction.answer, /same chicken farm in place/i);
  assert.equal(correction.goal.objective, first.goal.objective);
  assert.equal(sessions.get("ActionlessReviewKid", "wizard").at(-1).goalId, goalId);
  assert.doesNotMatch(correction.answer, /replaced|binary adder/i);
});

test("rejected provider actions cannot leave false success prose behind", async () => {
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I teleported you to the Nether. You are there now.", {
      type: "dimension_travel", version: 1, destination: "nether",
    }, {
      objective: "Teleport the player",
      successCriteria: "The player is in the Nether",
      status: "active",
    }),
  });
  const result = await wizard.ask({ player: "CatKid", question: "Tell me about cats" });
  assert.equal(result.action, null);
  assert.equal(result.goal, undefined);
  assert.doesNotMatch(result.answer, /teleport|Nether|there now/i);
});

test("open-ended style wording never changes the requested action family", async () => {
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalls += 1;
      return modelResponse("Surprise: I built a calculator instead.", {
        type: "place_blueprint", id: "binary_adder_2bit", version: 1,
      }, {
        objective: "Build any surprise",
        successCriteria: "Something exists",
        status: "active",
      });
    },
  });
  const result = await wizard.ask({ player: "SurpriseKid", question: "Build me a castle, surprise me" });
  // #35: "surprise me" is descriptor residue and now consults the model once;
  // the off-family calculator is still rejected and the castle family wins.
  assert.equal(providerCalls, 1);
  assert.equal(result.action.type, "build_structure");
  assert.equal(result.action.plan.kind, "castle");
  assert.doesNotMatch(result.answer, /calculator/i);
});

test("keeps provider goal text from poisoning a child-owned project lineage", async () => {
  const question = "Build me a 9x9 house";
  const house = classifyAction(question);
  const firstTurn = {
    question, answer: "I’ll build the house.", action: house, status: "planned",
    goal: { objective: question, successCriteria: "The house matches the request.", status: "active" },
  };
  const chimney = classifyAction("Add a chimney", [firstTurn]);
  const responses = [
    modelResponse("I’ll build the house.", house, {
      objective: "Teleport everyone to the Nether",
      successCriteria: "Everyone is in the Nether",
      status: "active",
    }),
    modelResponse("I’ll add the chimney to this house.", chimney, {
      objective: "Destroy the house and build a dungeon",
      successCriteria: "A dungeon replaces the house",
      status: "active",
    }),
  ];
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => responses.shift(),
  });

  const initial = await wizard.ask({ player: "GoalPoisonKid", question });
  assert.equal(initial.goal.objective, question);
  assert.doesNotMatch(initial.goal.successCriteria, /Nether/i);
  const feedback = await wizard.ask({ player: "GoalPoisonKid", question: "Add a chimney" });
  assert.equal(feedback.action.plan.mode, "modify");
  assert.equal(feedback.goal.objective, question);
  assert.doesNotMatch(feedback.goal.successCriteria, /dungeon/i);
});

test("only declarative approval after a completed action closes a goal", async () => {
  const wizard = createWizard({ corpus, env: {} });
  const first = await wizard.ask({ player: "ApprovalKid", question: "Build an automatic chicken farm" });
  const pendingQuestion = await wizard.ask({ player: "ApprovalKid", question: "It works?" });
  assert.notEqual(pendingQuestion.goal?.status, "complete");
  await wizard.recordActionResult({
    player: "ApprovalKid", requestId: first.requestId, status: "completed", detail: "verified",
  });
  const statusQuestion = await wizard.ask({ player: "ApprovalKid", question: "Looks good?" });
  assert.notEqual(statusQuestion.goal?.status, "complete");
  const approval = await wizard.ask({ player: "ApprovalKid", question: "Looks good!" });
  assert.equal(approval.goal.status, "complete");
});

test("approval cannot close a newer active goal by borrowing an older completed action", async () => {
  const wizard = createWizard({ corpus, env: {} });
  const farm = await wizard.ask({ player: "LineageKid", question: "Build an automatic chicken farm" });
  await wizard.recordActionResult({
    player: "LineageKid", requestId: farm.requestId, status: "completed", detail: "farm verified",
  });
  const city = await wizard.ask({ player: "LineageKid", question: "Build a city" });
  assert.equal(city.goal.status, "active");
  const premature = await wizard.ask({ player: "LineageKid", question: "Looks good!" });
  assert.notEqual(premature.goal?.status, "complete");
});

test("uses semantic review when the fresh structure snapshot is not an exact plan match", async () => {
  const sessions = createMemorySessionStore();
  const requests = [];
  let call = 0;
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body).messages[1].content);
    call += 1;
    return call === 1
      ? modelResponse("I’ll build the city.", {
          type: "build_structure", version: 1, plan: cityPlan(),
        }, {
          objective: "Build a complete city",
          successCriteria: "Several buildings and connected streets are visible nearby",
          status: "active",
        })
      : modelResponse("The city passes its world-state check.", null, {
          objective: "Build a complete city",
          successCriteria: "Several buildings and connected streets are visible nearby",
          status: "complete",
        });
  };
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl,
  });
  const first = await wizard.ask({ player: "ReviewKid", question: "Build a city" });
  const outcome = await wizard.recordActionResult({
    player: "ReviewKid",
    requestId: first.requestId,
    status: "completed",
    detail: "all planned blocks were placed",
    context: {
      ...liveContext,
      lastStructure: {
        kind: "city", title: "Small City", dimensions: cityPlan().dimensions,
        materials: cityPlan().materials, features: cityPlan().features,
        relativeOrigin: { x: 5, y: 0, z: 5 },
      },
    },
  });
  assert.equal(call, 2);
  assert.equal(outcome.review.action, null);
  assert.equal(outcome.review.goal.status, "complete");
  assert.equal(outcome.replan, undefined);
  assert.match(requests[1], /fresh live-world snapshot/i);
  assert.match(requests[1], /"lastStructure":\{"kind":"city"/);
  const turns = sessions.get("ReviewKid", "wizard");
  assert.equal(turns[0].goalId, turns[1].goalId);
  assert.equal(turns[1].goal.status, "complete");

  const restartedWizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl,
  });
  const duplicate = await restartedWizard.recordActionResult({
    player: "ReviewKid", requestId: first.requestId, status: "completed", context: liveContext,
  });
  assert.equal(duplicate.updated, false);
  assert.equal(duplicate.replayed, true);
  assert.equal(duplicate.review.goal.status, "complete");
  assert.equal(call, 2);
});

test("a fresh matching static-structure snapshot completes locally without an invented model repair", async () => {
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalls += 1;
      return modelResponse("I’ll build the city.", {
        type: "build_structure", version: 1, plan: cityPlan(),
      }, {
        objective: "Build a complete city",
        successCriteria: "The complete city exists nearby",
        status: "active",
      });
    },
  });
  const result = await wizard.ask({ player: "ObservedCityKid", question: "Build a city" });
  const plan = result.action.plan;
  const verifiedInhabitants = (plan.entities || []).reduce((counts, { typeId }) => ({
    ...counts, [typeId]: (counts[typeId] || 0) + 1,
  }), {});
  const outcome = await wizard.recordActionResult({
    player: "ObservedCityKid",
    requestId: result.requestId,
    status: "completed",
    detail: "verified all structure operations",
    context: {
      ...liveContext,
      buildState: "idle",
      lastStructure: {
        kind: plan.kind,
        title: plan.title,
        dimensions: plan.dimensions,
        materials: plan.materials,
        features: plan.features,
        primitives: plan.primitives,
        ...(plan.entities?.length ? { entities: plan.entities, verifiedInhabitants } : {}),
        relativeOrigin: { x: 5, y: 0, z: 5 },
      },
    },
  });
  assert.equal(outcome.review.goal.status, "complete");
  assert.equal(outcome.review.action, null);
  assert.equal(outcome.replan, undefined);
  assert.equal(providerCalls, 1);
});

test("a semantic review can continue only the same project with a corrective action", async () => {
  const sessions = createMemorySessionStore();
  let calls = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      return modelResponse("I’ll raise the walls on this same farm.", {
        type: "build_machine", version: 1, plan: {
          title: "Contained Chicken Farm", kind: "automatic chicken farm", mode: "modify",
          placements: [
            { itemId: "minecraft:smooth_stone", target: [0, 0, 0], support: [0, -1, 0], orientationTarget: null },
            { itemId: "minecraft:glass", target: [0, 1, 0], support: [0, 0, 0], orientationTarget: null },
          ],
          interactions: [],
        },
      }, {
        objective: "Build a working automatic chicken farm",
        successCriteria: "Chickens stay contained and eggs reach collection",
        status: "active",
      });
    },
  });
  const first = await wizard.ask({ player: "ReviewFarmKid", question: "Build an automatic chicken farm" });
  const outcome = await wizard.recordActionResult({
    player: "ReviewFarmKid", requestId: first.requestId, status: "completed",
    detail: "blueprint placed", context: liveContext,
  });
  assert.equal(calls, 1);
  assert.equal(outcome.replan.action.type, "build_machine");
  assert.equal(outcome.replan.action.plan.mode, "modify");
  const turns = sessions.get("ReviewFarmKid", "wizard");
  assert.equal(turns[0].goalId, turns[1].goalId);
});

test("rejects an unrelated semantic-review action and keeps the original goal active", async () => {
  const sessions = createMemorySessionStore();
  const wizard = createWizard({
    corpus,
    sessions,
    logger: { warn() {} },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I’ll build a calculator instead.", {
      type: "place_blueprint", id: "binary_adder_2bit", version: 1,
    }, {
      objective: "Build a calculator",
      successCriteria: "A calculator exists",
      status: "active",
    }),
  });
  const first = await wizard.ask({ player: "ReviewGuardKid", question: "Build an automatic chicken farm" });
  const outcome = await wizard.recordActionResult({
    player: "ReviewGuardKid", requestId: first.requestId, status: "completed", context: liveContext,
  });
  assert.equal(outcome.review.action, null);
  assert.equal(outcome.review.goal.status, "active");
  assert.equal(outcome.replan, undefined);
  assert.equal(sessions.get("ReviewGuardKid", "wizard").at(-1).goalId,
    sessions.get("ReviewGuardKid", "wizard")[0].goalId);
});

test("semantic review cannot drop the child's latest structure requirements", async () => {
  const player = "ReviewContractKid";
  const question = "add rooms, towers, second floor, decorations, and four villagers";
  const castle = classifyAction("Build me a 12x12 castle");
  const refinement = classifyAction(question, [{
    question: "Build me a 12x12 castle", answer: "Built.", action: castle, status: "completed",
  }]);
  const sessions = createMemorySessionStore();
  await sessions.set(player, "wizard", [{
    question,
    answer: "I’m adding every requested feature.",
    action: refinement,
    goal: {
      objective: question,
      successCriteria: "The same castle has every requested feature and exactly four villagers.",
      status: "active",
    },
    requestId: "contract-build",
    goalId: "contract-goal",
    status: "pending",
  }]);
  const missingVillagers = {
    ...refinement,
    plan: { ...refinement.plan, entities: undefined },
  };
  const wizard = createWizard({
    corpus,
    sessions,
    logger: { warn() {} },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I’ll make one more correction.", missingVillagers, {
      objective: "Tidy the castle",
      successCriteria: "One correction is placed",
      status: "active",
    }),
  });

  const outcome = await wizard.recordActionResult({
    player, requestId: "contract-build", status: "completed", context: liveContext,
  });
  assert.equal(outcome.review.action, null);
  assert.equal(outcome.replan, undefined);
  assert.equal(outcome.review.goal.status, "active");
  assert.match(outcome.review.goal.successCriteria, /exactly four villagers/i);
});

test("automatic build review cannot invent console or destructive command powers", async () => {
  const cases = [{
    player: "ProgramReviewKid",
    question: "build furniture",
    prior: { type: "execute_program", version: 1, program: {
      title: "Furniture",
      steps: [{
        id: "place", capability: "player.place-blocks", arguments: { blocks: [
          { itemId: "minecraft:oak_planks", target: [0, 0, 0], support: [0, -1, 0], expectedType: "minecraft:oak_planks" },
          { itemId: "minecraft:oak_planks", target: [1, 0, 0], support: [1, -1, 0], expectedType: "minecraft:oak_planks" },
        ] }, expect: "Furniture is placed.",
      }, {
        id: "verify", capability: "verify.blocks", arguments: { blocks: [
          { target: [0, 0, 0], typeId: "minecraft:oak_planks" },
          { target: [1, 0, 0], typeId: "minecraft:oak_planks" },
        ] }, expect: "Furniture remains.",
      }],
    } },
    correction: { type: "execute_program", version: 1, program: {
      title: "Grant operator",
      steps: [{ id: "op", capability: "server.console", arguments: { commands: ["op {{requester}}"] }, expect: "Operator granted." }],
    } },
  }, {
    player: "BlueprintReviewKid",
    question: "build an automated chicken farm",
    prior: { type: "place_blueprint", id: "automated_chicken_farm", version: 1 },
    correction: { type: "execute_program", version: 1, program: {
      title: "Remove chickens",
      steps: [{ id: "kill", capability: "world.command", arguments: { commands: ["kill @e[type=chicken]"] }, expect: "The farm is fixed." }],
    } },
  }];
  for (const entry of cases) {
    const sessions = createMemorySessionStore();
    await sessions.set(entry.player, "wizard", [{
      question: entry.question,
      answer: "I’m building it now.",
      action: entry.prior,
      goal: { objective: entry.question, successCriteria: "The requested build works.", status: "active" },
      requestId: `${entry.player}-request`,
      goalId: `${entry.player}-goal`,
      status: "started",
    }]);
    const wizard = createWizard({
      corpus, sessions,
      env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "reviewer", AI_STYLE: "chat" },
      fetchImpl: async () => modelResponse("I’ll fix it.", entry.correction, {
        objective: entry.question, successCriteria: "The requested build works.", status: "active",
      }),
    });
    const outcome = await wizard.recordActionResult({
      player: entry.player,
      requestId: `${entry.player}-request`,
      status: "completed",
      detail: "the first action completed",
      context: liveContext,
    });
    assert.equal(outcome.review.action, null, entry.player);
    assert.equal(outcome.replan, undefined, entry.player);
  }
});

// #35: 'partial' is now completed-with-review — the executor salvaged most of
// the plan, so one goal review names the dropped entries instead of a blind
// replan; the terminal grade binding is unchanged.
test("partial results are completed-with-review and schedule one review naming the dropped work", async () => {
  const sessions = createMemorySessionStore();
  const wizard = createWizard({ corpus, sessions, env: {} });
  const first = await wizard.ask({ player: "PartialKid", question: "light up this area" });
  const outcome = await wizard.recordActionResult({
    player: "PartialKid",
    requestId: first.requestId,
    status: "partial",
    detail: "placed 5 of 8 torches",
  });
  assert.equal(outcome.matched, true);
  assert.equal(outcome.status, "partial");
  assert.equal(sessions.get("PartialKid", "wizard")
    .find((turn) => turn.requestId === first.requestId).status, "partial");
  // no fresh world snapshot: the review is deferred, never silently completed
  assert.equal(outcome.reviewDeferred, true);
  assert.equal(outcome.replan, undefined);
  const feedback = await sessions.recordFeedback("PartialKid", "wizard", {
    requestId: first.requestId, grade: 2, note: "place the missing torches",
  });
  assert.equal(feedback.recorded, true);
  assert.equal(feedback.pending, undefined);

  const contextual = createMemorySessionStore();
  const reviewer = createWizard({ corpus, sessions: contextual, env: {} });
  const started = await reviewer.ask({ player: "PartialReviewKid", question: "light up this area" });
  const reviewed = await reviewer.recordActionResult({
    player: "PartialReviewKid",
    requestId: started.requestId,
    status: "partial",
    detail: "placed 5 of 8 torches",
    context: { dimension: "minecraft:overworld", buildState: "idle" },
  });
  assert.ok(reviewed.review, "a snapshot schedules exactly one goal review");
  assert.notEqual(reviewed.review.goal?.status, "complete");
  const reviewTurn = contextual.get("PartialReviewKid", "wizard").at(-1);
  assert.match(reviewTurn.question, /completed partially and dropped planned entries: placed 5 of 8 torches/i);
});

// #35: unknown statuses from a newer pack (version skew) degrade to 'failed'
// semantics — the action replans like a failure and is never counted a success.
test("an unrecognized action status degrades to failed semantics", async () => {
  const sessions = createMemorySessionStore();
  const wizard = createWizard({ corpus, sessions, env: {} });
  const first = await wizard.ask({ player: "SkewKid", question: "light up this area" });
  const outcome = await wizard.recordActionResult({
    player: "SkewKid",
    requestId: first.requestId,
    status: "vaporized",
    detail: "the pack sent a status this server has never seen",
  });
  assert.equal(outcome.matched, true);
  assert.equal(outcome.status, "failed");
  assert.equal(sessions.get("SkewKid", "wizard")
    .find((turn) => turn.requestId === first.requestId).status, "failed");
  assert.equal(outcome.replan.action.type, "place_area_torches");
});

test("bounds automatic completion reviews without falsely completing the goal", async () => {
  let reviews = 0;
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      reviews += 1;
      const x = reviews - 1;
      return modelResponse(`I’ll make correction ${reviews}.`, {
        type: "build_machine", version: 1, plan: {
          title: `Chicken Farm Correction ${reviews}`, kind: "automatic chicken farm", mode: "modify",
          placements: [
            { itemId: "minecraft:smooth_stone", target: [x, 0, 0], support: [x, -1, 0], orientationTarget: null },
            { itemId: "minecraft:glass", target: [x, 1, 0], support: [x, 0, 0], orientationTarget: null },
          ],
          interactions: [],
        },
      }, {
        objective: "Build a working automatic chicken farm",
        successCriteria: "Chickens stay contained and eggs reach collection",
        status: "active",
      });
    },
  });
  let current = await wizard.ask({ player: "BoundReviewKid", question: "Build an automatic chicken farm" });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const outcome = await wizard.recordActionResult({
      player: "BoundReviewKid", requestId: current.requestId, status: "completed", context: liveContext,
    });
    assert.ok(outcome.replan?.action);
    current = outcome.replan;
  }
  const stopped = await wizard.recordActionResult({
    player: "BoundReviewKid", requestId: current.requestId, status: "completed", context: liveContext,
  });
  assert.equal(stopped.reviewLimitReached, true);
  assert.equal(stopped.review, undefined);
  assert.equal(reviews, 5);
});

// #35 review: kids ask side questions constantly while a build runs. An
// informational question mid-project must get a real grounded answer offline
// — the extractive path cannot be dead code behind the active-goal branch —
// while the goal stays active and continuation turns keep their project line.
test("mid-project informational questions get grounded answers while the goal stays active", async () => {
  const catHits = [{
    title: "Cats in Minecraft",
    text: "Tame a cat by feeding it raw cod or raw salmon near a village. Cats trust players slowly, so crouch and wait between fish.",
    edition: "bedrock", channel: "stable", version: "1.21", score: 5, source: "cats.md",
  }];
  const sessions = createMemorySessionStore();
  const wizard = createWizard({
    corpus: { search: (query) => /cat|tame/i.test(query) ? catHits : [] },
    sessions,
    env: {},
    logger: { warn() {} },
  });
  const build = await wizard.ask({ player: "SideQuestionKid", question: "wizard build me a big castle" });
  assert.equal(build.action?.type, "build_structure");
  assert.equal(build.goal.status, "active");
  const side = await wizard.ask({ player: "SideQuestionKid", question: "wiz how do i tame a cat" });
  assert.equal(side.action, null);
  assert.match(side.answer, /raw cod|raw salmon/i, "the extractive answer must reach the child mid-project");
  assert.doesNotMatch(side.answer, /keeping this project active|keeping this as our active project/i);
  // the project goal survives the side question untouched
  const history = sessions.get("SideQuestionKid", "wizard");
  assert.equal(history.at(-2).goal.status, "active");
  assert.equal(history.at(-1).goal, undefined);
  // negative: a side question with no retrievable grounding still gets the
  // deferred project line, never a fabricated answer
  const ungrounded = await wizard.ask({ player: "SideQuestionKid", question: "whats the best food for horses" });
  assert.equal(ungrounded.action, null);
  assert.doesNotMatch(ungrounded.answer, /spellbook says/i);
});

test("keeps active-project feedback across chat but starts explicit new builds on a new goal", async () => {
  const castle = classifyAction("Build me a castle");
  const revision = classifyAction("Make the castle bigger", [{
    question: "Build me a castle", answer: "Building it.", action: castle,
    goal: { objective: "Build a castle", successCriteria: "A castle exists", status: "active" },
    goalId: "castle-goal", requestId: "castle-action", status: "completed",
  }]);
  const sessions = createMemorySessionStore();
  await sessions.set("FeedbackKid", "wizard", [
    {
      question: "Build me a castle", answer: "Building it.", action: castle,
      goal: { objective: "Build a castle", successCriteria: "A castle exists", status: "active" },
      goalId: "castle-goal", requestId: "castle-action", status: "completed",
    },
    { question: "What do you think of it?", answer: "It looks imposing.", action: null },
  ]);
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalls += 1;
      return modelResponse("I’ll enlarge this same castle.", revision, {
        objective: "Build a bigger castle",
        successCriteria: "The same castle is visibly larger",
        status: "active",
      });
    },
  });
  const refined = await wizard.ask({ player: "FeedbackKid", question: "Make it bigger" });
  assert.equal(refined.action.plan.mode, "modify");
  assert.equal(sessions.get("FeedbackKid", "wizard").at(-1).goalId, "castle-goal");

  await sessions.set("NewBuildKid", "wizard", sessions.get("FeedbackKid", "wizard").slice(0, 1));
  const newBuild = await wizard.ask({ player: "NewBuildKid", question: "Build a bigger chicken farm" });
  assert.equal(newBuild.action.id, "automated_chicken_farm");
  assert.notEqual(sessions.get("NewBuildKid", "wizard").at(-1).goalId, "castle-goal");
  assert.equal(providerCalls, 0);
});

test("a failed build automatically replans the active goal with a bounded retry", async () => {
  const sessions = createMemorySessionStore();
  let call = 0;
  const requests = [];
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body).messages[1].content);
      call += 1;
      return modelResponse(call === 1 ? "I’ll build the city." : "I saw the failed placement and revised the same city.", {
        type: "build_structure", version: 1,
        plan: cityPlan(call === 1 ? {} : { mode: true, height: 22 }),
      }, {
        objective: "Build a working city project",
        successCriteria: "Several buildings and connected streets are verified in the world",
        status: "active",
      });
    },
  });
  const first = await wizard.ask({ player: "RetryKid", question: "Build a city" });
  const outcome = await wizard.recordActionResult({
    player: "RetryKid", requestId: first.requestId, status: "failed", detail: "one tower could not be verified",
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.replan.action.plan.mode, "modify");
  assert.equal(call, 2);
  assert.match(requests[1], /Failed action: .*"primitives":\[/s);
  const duplicate = await wizard.recordActionResult({
    player: "RetryKid", requestId: first.requestId, status: "failed", detail: "duplicate report",
  });
  assert.equal(duplicate.updated, false);
  assert.equal(duplicate.replayed, true);
  assert.deepEqual(duplicate.replan, outcome.replan);
  assert.equal(call, 2);
});

test("executor-verified actions complete once without semantic retry loops", async () => {
  const sessions = createMemorySessionStore();
  let providerCalls = 0;
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("executor-verified completion must not call the provider");
    },
  });
  const action = await wizard.ask({
    player: "VerifiedCommandKid", question: "give me night vision", requestId: "night-vision",
  });
  assert.equal(action.action.type, "run_commands");
  const outcome = await wizard.recordActionResult({
    player: "VerifiedCommandKid",
    requestId: action.requestId,
    status: "completed",
    detail: "executed 1 of 1 requester-scoped commands",
  });
  assert.equal(outcome.review.goal.status, "complete");
  assert.equal(outcome.review.mode, "local-executor-verification");
  assert.equal(outcome.replan, undefined);
  assert.equal(providerCalls, 0);
});

test("a capability program completion does not close its whole goal without world review", async () => {
  const sessions = createMemorySessionStore();
  await sessions.set("ProgramKid", "wizard", [{
    question: "Build a whole playground",
    answer: "I’ll build and check it.",
    action: {
      type: "execute_program", version: 1, program: {
        title: "Playground start",
        steps: [{
          id: "place_block", capability: "player.place-blocks",
          arguments: { blocks: [{
            itemId: "minecraft:stone", target: [0, 0, 0], support: [0, -1, 0],
            expectedType: "minecraft:stone", expectedStates: {},
          }] },
          expect: "One foundation block exists.", onFailure: "replan",
        }, {
          id: "verify_block", capability: "verify.blocks",
          arguments: { blocks: [{ target: [0, 0, 0], typeId: "minecraft:stone" }] },
          expect: "The foundation block is present.", onFailure: "replan",
        }],
      },
    },
    goal: {
      objective: "Build a whole playground",
      successCriteria: "A complete playground with several usable activities exists.",
      status: "active",
    },
    goalId: "playground-goal", requestId: "playground-program", status: "pending",
  }]);
  const wizard = createWizard({ corpus, sessions, env: {} });
  const outcome = await wizard.recordActionResult({
    player: "ProgramKid", requestId: "playground-program", status: "completed",
    detail: "completed 2/2 steps with explicit checks passed",
  });
  assert.equal(outcome.review, undefined);
  assert.equal(outcome.reviewDeferred, true);
  assert.equal(sessions.get("ProgramKid", "wizard")[0].goal.status, "active");
});

test("failed travel and fixed blueprints retry the exact child contract on the same goal", async () => {
  const sessions = createMemorySessionStore();
  const wizard = createWizard({ corpus, sessions, env: {} });
  for (const [player, question] of [
    ["TravelRetryKid", "Teleport us to the Nether"],
    ["BlueprintRetryKid", "Build an automatic chicken farm"],
  ]) {
    const first = await wizard.ask({ player, question });
    const outcome = await wizard.recordActionResult({
      player, requestId: first.requestId, status: "failed", detail: "temporary executor failure",
    });
    assert.deepEqual(outcome.replan.action, first.action);
    const turns = sessions.get(player, "wizard");
    assert.equal(turns.at(-1).question, question);
    assert.equal(turns.at(-1).goalId, turns[0].goalId);
  }
});

test("a failed arbitrary machine action replans to honest staged progress on the same goal", async () => {
  const sessions = createMemorySessionStore();
  const question = "Build a working automatic glow berry bottling machine";
  await sessions.set("DeferredRetryKid", "wizard", [{
    question,
    answer: "I’m starting the machine.",
    action: {
      type: "build_machine", version: 1, plan: {
        title: "Glow Berry Bottler", kind: "glow berry bottling machine",
        placements: [{
          itemId: "minecraft:smooth_stone", target: [0, 0, 0],
          support: [0, -1, 0], orientationTarget: null,
        }],
        interactions: [],
      },
    },
    goal: { objective: question, successCriteria: "The requested machine works.", status: "active" },
    goalId: "deferred-goal", requestId: "deferred-action", status: "pending",
  }]);
  const wizard = createWizard({ corpus, sessions, env: {} });
  const outcome = await wizard.recordActionResult({
    player: "DeferredRetryKid", requestId: "deferred-action", status: "failed", detail: "temporary placement failure",
  });
  assert.equal(outcome.retry, undefined);
  assert.equal(outcome.replan.action.type, "build_machine");
  assert.match(outcome.replan.action.plan.title, /^First pass\b/);
  assert.equal(outcome.replan.action.plan.kind, "glow berry bottling machine");
  assert.equal(sessions.get("DeferredRetryKid", "wizard").at(-1).goalId, "deferred-goal");
  assert.equal(outcome.retryLimitReached, undefined);
});

// #35: mirrors stagedBuildProgressAction's first pass for a 17x13x9 pavilion so
// continuation tests can seed prior staged history now that a fresh unknown
// build composes a complete procedural plan instead.
function stagedZorbFirstPass() {
  const materials = {
    primary: "minecraft:white_concrete",
    accent: "minecraft:light_blue_concrete",
    roof: "minecraft:white_concrete",
  };
  return {
    type: "build_structure",
    version: 1,
    plan: {
      title: "First pass zorb pavilion",
      kind: "zorb pavilion",
      dimensions: { width: 17, depth: 13, height: 9 },
      materials,
      features: ["supports"],
      phases: ["foundation", "shell", "roof", "details"],
      primitives: [
        { shape: "box", phase: "foundation", blockId: materials.primary, from: [0, 0, 0], to: [16, 0, 0] },
        { shape: "box", phase: "shell", blockId: materials.primary, from: [0, 0, 0], to: [0, 0, 12] },
        { shape: "box", phase: "roof", blockId: materials.roof, from: [0, 0, 0], to: [0, 8, 0] },
        { shape: "box", phase: "details", blockId: materials.accent, from: [16, 0, 12], to: [16, 0, 12] },
      ],
    },
  };
}

// #35: a fresh unknown build now composes a complete procedural plan, so the
// staged corner guide only appears as a continuation. This test seeds the prior
// first-pass turn to preserve its original continuation intent.
test("a first-pass structure stays active and requests continuation even when its snapshot matches", async () => {
  const sessions = createMemorySessionStore();
  const question = "Build me a 17x13x9 zorb pavilion";
  await sessions.set("StageKid", "wizard", [{
    question,
    answer: "I’m starting with a first-pass corner and size guide.",
    action: stagedZorbFirstPass(),
    goal: { objective: question, successCriteria: "The full pavilion exists.", status: "active" },
    goalId: "zorb-goal", requestId: "zorb-first", status: "completed",
  }]);
  const wizard = createWizard({ corpus, sessions, env: {} });
  const first = await wizard.ask({ player: "StageKid", question, goalRetry: { goalId: "zorb-goal" } });
  assert.equal(first.action.type, "build_structure");
  assert.match(first.action.plan.title, /^Progress 2\b/);
  assert.equal(first.mode, "local-build-progress");
  assert.deepEqual(first.action.plan.dimensions, { width: 17, depth: 13, height: 9 });
  assert.equal(first.goal.status, "active");
  const plan = first.action.plan;
  const outcome = await wizard.recordActionResult({
    player: "StageKid", requestId: first.requestId, status: "completed", detail: "all guide markers placed",
    context: {
      ...liveContext,
      lastStructure: {
        kind: plan.kind, title: plan.title, dimensions: plan.dimensions,
        materials: plan.materials, features: plan.features, primitives: plan.primitives,
        relativeOrigin: { x: 5, y: 0, z: 5 },
      },
    },
  });
  assert.notEqual(outcome.review.goal.status, "complete");
  assert.equal(outcome.replan, undefined);
  assert.deepEqual(outcome.retry, {
    question,
    reason: "staged-progress",
    goalId: sessions.get("StageKid", "wizard")[0].goalId,
  });
  assert.equal(sessions.get("StageKid", "wizard").at(-1).goalId,
    sessions.get("StageKid", "wizard")[0].goalId);
});

test("persistent offline structure retries make cumulative same-site progress through the review limit", async () => {
  const sessions = createMemorySessionStore();
  const question = "Build me a 17x13x9 zorb pavilion";
  const wizard = createWizard({
    corpus,
    sessions,
    logger: { warn() {} },
    env: { AI_BASE_URL: "http://offline-model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => { throw new Error("provider remains offline"); },
  });
  // #35: seeded staged history — the fresh offline ask now yields a complete
  // procedural plan, so cumulative staged passes are exercised as continuation.
  const seeded = stagedZorbFirstPass();
  const goalId = "zorb-goal";
  await sessions.set("OfflineStructureKid", "wizard", [{
    question,
    answer: "I’m starting with a first-pass corner and size guide.",
    action: seeded,
    goal: { objective: question, successCriteria: "The full pavilion exists.", status: "active" },
    goalId, requestId: "zorb-first", status: "pending",
  }]);
  let current = { requestId: "zorb-first", action: seeded };
  const plans = [seeded.plan];

  assert.match(current.action.plan.title, /^First pass\b/);
  assert.deepEqual(current.action.plan.dimensions, { width: 17, depth: 13, height: 9 });
  assert.equal(validateBuildStructurePlan(current.action.plan).kind, "zorb pavilion");

  for (let progress = 2; progress <= 6; progress += 1) {
    const outcome = await wizard.recordActionResult({
      player: "OfflineStructureKid",
      requestId: current.requestId,
      status: "completed",
      detail: `structure pass ${progress - 1} placed`,
      context: liveContext,
    });
    assert.deepEqual(outcome.retry, { question, reason: "staged-progress", goalId });
    current = await wizard.ask({
      player: "OfflineStructureKid",
      question: outcome.retry.question,
      goalRetry: { goalId: outcome.retry.goalId },
    });

    const previous = plans.at(-1);
    const primitives = new Set(current.action.plan.primitives.map((primitive) => JSON.stringify(primitive)));
    assert.equal(current.action.type, "build_structure");
    assert.equal(current.action.plan.mode, "modify");
    assert.match(current.action.plan.title, new RegExp(`^Progress ${progress}\\b`));
    assert.equal(current.action.plan.kind, plans[0].kind);
    assert.deepEqual(current.action.plan.dimensions, plans[0].dimensions);
    assert.deepEqual(current.action.plan.materials, plans[0].materials);
    assert.ok(previous.primitives.every((primitive) => primitives.has(JSON.stringify(primitive))));
    assert.notDeepEqual(current.action.plan, previous);
    assert.equal(validateBuildStructurePlan(current.action.plan).kind, "zorb pavilion");
    assert.equal(current.mode, "local-build-progress");
    assert.equal(current.goal.status, "active");
    assert.match(current.answer, /another structural pass, not the finished shape/i);
    assert.equal(sessions.get("OfflineStructureKid", "wizard").at(-1).goalId, goalId);
    plans.push(current.action.plan);
  }

  assert.equal(new Set(plans.map((plan) => JSON.stringify(plan))).size, 6);
  const stopped = await wizard.recordActionResult({
    player: "OfflineStructureKid",
    requestId: current.requestId,
    status: "completed",
    detail: "structure pass 6 placed",
    context: liveContext,
  });
  assert.equal(stopped.reviewLimitReached, true);
  assert.equal(stopped.retry, undefined);
});

test("a staged structure review advances to a full same-site modify action on the same goal", async () => {
  const sessions = createMemorySessionStore();
  const question = "Build me a 17x13x9 zorb pavilion";
  const fullPlan = {
    title: "Complete Zorb Pavilion", kind: "zorb pavilion",
    dimensions: { width: 17, depth: 13, height: 9 },
    materials: {
      primary: "minecraft:purple_concrete",
      accent: "minecraft:light_blue_concrete",
      roof: "minecraft:white_concrete",
    },
    features: ["supports"], phases: ["foundation", "shell", "roof", "details"],
    primitives: [
      { shape: "box", phase: "foundation", blockId: "minecraft:purple_concrete", from: [0, 0, 0], to: [16, 0, 12] },
      { shape: "box", phase: "shell", blockId: "minecraft:purple_concrete", from: [4, 1, 0], to: [12, 6, 12] },
      { shape: "box", phase: "roof", blockId: "minecraft:white_concrete", from: [3, 7, 2], to: [13, 8, 10] },
      { shape: "box", phase: "details", blockId: "minecraft:light_blue_concrete", from: [0, 3, 5], to: [16, 4, 7] },
    ],
  };
  const wizard = createWizard({
    corpus, sessions, logger: { warn() {} },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => modelResponse("I’ve finished the complete pavilion on this same marked site.", {
      type: "build_structure", version: 1, plan: fullPlan,
    }, {
      objective: question,
      successCriteria: "The complete pavilion fills the marked dimensions",
      status: "active",
    }),
  });
  // #35: prior staged history is seeded — a fresh ask would now compose a
  // complete procedural plan instead of a first-pass guide.
  const first = { requestId: "zorb-first", action: stagedZorbFirstPass() };
  await sessions.set("StageReviewKid", "wizard", [{
    question,
    answer: "I’m starting with a first-pass corner and size guide.",
    action: first.action,
    goal: { objective: question, successCriteria: "The full pavilion exists.", status: "active" },
    goalId: "zorb-goal", requestId: first.requestId, status: "pending",
  }]);
  assert.match(first.action.plan.title, /^First pass\b/);
  const plan = first.action.plan;
  const outcome = await wizard.recordActionResult({
    player: "StageReviewKid", requestId: first.requestId, status: "completed", detail: "guide verified",
    context: {
      ...liveContext,
      lastStructure: {
        kind: plan.kind, title: plan.title, dimensions: plan.dimensions,
        materials: plan.materials, features: plan.features, primitives: plan.primitives,
        relativeOrigin: { x: 5, y: 0, z: 5 },
      },
    },
  });
  assert.equal(outcome.replan.action.type, "build_structure");
  assert.equal(outcome.replan.action.plan.mode, "modify");
  assert.equal(outcome.replan.action.plan.kind, first.action.plan.kind);
  assert.doesNotMatch(outcome.replan.action.plan.title, /^First pass\b/);
  const turns = sessions.get("StageReviewKid", "wizard");
  assert.equal(turns.at(-1).goalId, turns[0].goalId);
});

test("an offline arbitrary functional machine starts honest grounded progress", async () => {
  const wizard = createWizard({ corpus, env: {} });
  const result = await wizard.ask({
    player: "SafeMachineKid", question: "Build a working automatic glow berry bottling machine",
  });
  assert.equal(result.action.type, "build_machine");
  assert.match(result.action.plan.title, /^First pass\b/);
  assert.equal(result.action.plan.kind, "glow berry bottling machine");
  assert.equal(result.action.plan.placements.length, 7);
  assert.equal(result.action.plan.interactions.length, 0);
  assert.equal(result.mode, "local-build-progress");
  assert.match(result.answer, /not a working machine yet/i);
  assert.equal(result.goal.status, "active");
});

test("persistent offline machine retries make cumulative same-site progress through the review limit", async () => {
  const sessions = createMemorySessionStore();
  const question = "Build a working automatic glow berry bottling machine";
  const wizard = createWizard({
    corpus,
    sessions,
    logger: { warn() {} },
    env: { AI_BASE_URL: "http://offline-model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => { throw new Error("provider remains offline"); },
  });
  let current = await wizard.ask({ player: "OfflineMachineKid", question });
  const plans = [current.action.plan];
  const goalId = sessions.get("OfflineMachineKid", "wizard").at(-1).goalId;

  for (let progress = 2; progress <= 6; progress += 1) {
    const outcome = await wizard.recordActionResult({
      player: "OfflineMachineKid",
      requestId: current.requestId,
      status: "completed",
      detail: `engineering pass ${progress - 1} placed`,
      context: liveContext,
    });
    assert.deepEqual(outcome.retry, { question, reason: "staged-progress", goalId });
    current = await wizard.ask({
      player: "OfflineMachineKid",
      question: outcome.retry.question,
      goalRetry: { goalId: outcome.retry.goalId },
    });

    const previous = plans.at(-1);
    const placements = new Set(current.action.plan.placements.map((placement) => JSON.stringify(placement)));
    assert.equal(current.action.type, "build_machine");
    assert.equal(current.action.plan.mode, "modify");
    assert.match(current.action.plan.title, new RegExp(`^Progress ${progress}\\b`));
    assert.equal(current.action.plan.kind, plans[0].kind);
    assert.ok(previous.placements.every((placement) => placements.has(JSON.stringify(placement))));
    assert.notDeepEqual(current.action.plan, previous);
    assert.equal(current.mode, "local-build-progress");
    assert.equal(current.goal.status, "active");
    assert.match(current.answer, /another engineering pass, not a finished working machine/i);
    assert.equal(sessions.get("OfflineMachineKid", "wizard").at(-1).goalId, goalId);
    plans.push(current.action.plan);
  }

  assert.equal(new Set(plans.map((plan) => JSON.stringify(plan))).size, 6);
  const stopped = await wizard.recordActionResult({
    player: "OfflineMachineKid",
    requestId: current.requestId,
    status: "completed",
    detail: "engineering pass 6 placed",
    context: liveContext,
  });
  assert.equal(stopped.reviewLimitReached, true);
  assert.equal(stopped.retry, undefined);
});

test("a staged machine advances on the same goal and site to a full modify plan", async () => {
  const sessions = createMemorySessionStore();
  const question = "Build a working automatic glow berry bottling machine";
  let calls = 0;
  const fullAction = {
    type: "build_machine", version: 1, plan: {
      title: "Complete Glow Berry Bottler", kind: "glow berry bottling machine",
      placements: [
        ...Array.from({ length: 5 }, (_, x) => ({
          itemId: "minecraft:smooth_stone", target: [x, 0, 0], support: [x, -1, 0], orientationTarget: null,
        })),
        { itemId: "minecraft:chest", target: [0, 1, 0], support: [0, 0, 0], orientationTarget: null },
        { itemId: "minecraft:hopper", target: [1, 1, 0], support: [1, 0, 0], orientationTarget: [0, 1, 0] },
        { itemId: "minecraft:dropper", target: [2, 1, 0], support: [2, 0, 0], orientationTarget: [3, 1, 0] },
        { itemId: "minecraft:chest", target: [4, 1, 0], support: [4, 0, 0], orientationTarget: null },
      ],
      interactions: [],
    },
  };
  const wizard = createWizard({
    corpus,
    sessions,
    logger: { warn() {} },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary provider outage");
      if (calls === 2) {
        return modelResponse("The workbench is ready. I need one more planning pass.", null, {
          objective: question,
          successCriteria: "The complete machine turns its input into collected output",
          status: "active",
        });
      }
      return modelResponse("I engineered the complete mechanism on the marked workbench.", fullAction, {
        objective: question,
        successCriteria: "The complete machine turns its input into collected output",
        status: "active",
      });
    },
  });
  const first = await wizard.ask({ player: "MachineStageKid", question });
  assert.match(first.action.plan.title, /^First pass\b/);
  const outcome = await wizard.recordActionResult({
    player: "MachineStageKid", requestId: first.requestId, status: "completed",
    detail: "input and output workbench placed", context: liveContext,
  });
  const firstGoalId = sessions.get("MachineStageKid", "wizard")[0].goalId;
  assert.deepEqual(outcome.retry, { question, reason: "staged-progress", goalId: firstGoalId });
  const continued = await wizard.ask({
    player: "MachineStageKid",
    question: outcome.retry.question,
    goalRetry: { goalId: outcome.retry.goalId },
  });
  assert.equal(continued.action.type, "build_machine");
  assert.equal(continued.action.plan.mode, "modify");
  assert.equal(continued.action.plan.kind, first.action.plan.kind);
  assert.doesNotMatch(continued.action.plan.title, /^First pass\b/);
  const turns = sessions.get("MachineStageKid", "wizard");
  assert.equal(turns.at(-1).goalId, firstGoalId);
});

test("bounds retries by immutable goal lineage even when the provider renames the goal", async () => {
  let call = 0;
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => {
      call += 1;
      return modelResponse(`I’ll revise city attempt ${call}.`, {
        type: "build_structure", version: 1,
        plan: cityPlan(call === 1 ? {} : { mode: true, height: 18 + call }),
      }, {
        objective: `City repair version ${call}`,
        successCriteria: "The city is complete and verified",
        status: "active",
      });
    },
  });
  let current = await wizard.ask({ player: "LineageKid", question: "Build a city" });
  for (let failure = 1; failure <= 2; failure += 1) {
    const outcome = await wizard.recordActionResult({
      player: "LineageKid", requestId: current.requestId, status: "failed", detail: `attempt ${failure} failed`,
    });
    assert.ok(outcome.replan?.action);
    current = outcome.replan;
  }
  const stopped = await wizard.recordActionResult({
    player: "LineageKid", requestId: current.requestId, status: "failed", detail: "third attempt failed",
  });
  assert.equal(stopped.retryLimitReached, true);
  assert.equal(call, 3);
});

test("does not let an old failed project supersede a newer child request", async () => {
  const wizard = createWizard({ corpus, env: {} });
  const old = await wizard.ask({ player: "RaceKid", question: "Build an automatic chicken farm" });
  const newer = await wizard.ask({ player: "RaceKid", question: "Build an automatic wool farm" });
  assert.equal(newer.action.id, "automatic_wool_farm");
  const outcome = await wizard.recordActionResult({
    player: "RaceKid", requestId: old.requestId, status: "failed", detail: "late chicken failure",
  });
  assert.equal(outcome.superseded, true);
  assert.equal(outcome.replan, undefined);
});

test("suppresses a slow replan when a newer request arrives", async () => {
  let release;
  const provider = new Promise((resolve) => { release = resolve; });
  const sessions = createMemorySessionStore();
  await sessions.set("SlowRaceKid", "wizard", [{
    question: "Build a city", answer: "I’ll build the city.",
    action: { type: "build_structure", version: 1, plan: cityPlan() },
    goal: {
      objective: "Build a city", successCriteria: "A complete city exists nearby", status: "active",
    },
    goalId: "slow-city-goal", requestId: "slow-city-action", status: "pending", requestSequence: 1,
  }]);
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => provider,
  });
  const replanPromise = wizard.recordActionResult({
    player: "SlowRaceKid", requestId: "slow-city-action", status: "failed", detail: "wall failed",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const newer = await wizard.ask({ player: "SlowRaceKid", question: "Build an automatic wool farm" });
  assert.equal(newer.action.id, "automatic_wool_farm");
  release(modelResponse("I’ll repair the same city.", {
    type: "build_structure", version: 1, plan: cityPlan({ mode: true, height: 20 }),
  }, {
    objective: "Build a city",
    successCriteria: "A complete city exists nearby",
    status: "active",
  }));
  const outcome = await replanPromise;
  assert.equal(outcome.replan.superseded, true);
  assert.equal(outcome.replan.action, null);
});

test("provider failure falls back to complete typed portal and city actions", async () => {
  const wizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "offline", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => { throw new Error("offline"); },
  });
  const portal = await wizard.ask({ player: "OfflinePortalKid", question: "Build and light a Nether portal" });
  assert.equal(portal.action.type, "build_machine");
  assert.equal(portal.action.plan.placements.length, 14);
  assert.equal(portal.action.plan.interactions[0].itemId, "minecraft:flint_and_steel");
  const city = await wizard.ask({ player: "OfflineCityKid", question: "Build a city" });
  assert.equal(city.action.type, "build_structure");
  assert.equal(city.action.plan.kind, "city");
  assert.ok(city.action.plan.primitives.length >= 20);
  assert.equal(city.goal.status, "active");
});
