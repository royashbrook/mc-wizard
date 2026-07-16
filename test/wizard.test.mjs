import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { loadCorpus } from "../src/rag.mjs";
import {
  startServer,
  validateActionResultBody,
  validateAskBody,
} from "../src/server.mjs";
import { createFileSessionStore, createMemorySessionStore } from "../src/sessions.mjs";
import {
  explicitlyRequestsCommand,
  safeCommandRefusal,
  unsafeCommandAnswer,
} from "../src/command-safety.mjs";
import { classifyAction, createWizard, instantConversationAnswer } from "../src/wizard.mjs";
import { validateConsoleCommand } from "../src/admin.mjs";
import { readRuntimeSettings, validateRuntimeSettings, writeRuntimeSettings } from "../src/runtime-settings.mjs";
import {
  calculatorResult,
  createCalculatorBlueprint,
} from "../bedrock/behavior_packs/mc_wizard/scripts/calculator.js";
import { bookPages, bookTitle } from "../bedrock/behavior_packs/mc_wizard/scripts/book.js";
import {
  expectedPlacementStates,
  planBounds,
  validateBuildPlan,
} from "../bedrock/behavior_packs/mc_wizard/scripts/build-plan.js";
import { validateBuildStructurePlan } from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";
import { COMMAND_LESSONS } from "../bedrock/behavior_packs/mc_wizard/scripts/command-lessons.js";
import { htmlToMarkdown } from "../scripts/sync-docs.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  isTerminalE2EResultForRun,
  parseE2ELine,
} from "../scripts/wait-e2e.mjs";

let corpus;
let wizard;
let packManifest;
let packPermissions;
let packScript;
let e2eScript;
let containerScript;
let localBridgeScript;
let e2eRunnerScript;
let installPackScript;
let resourceManifest;
let syncDocsScript;
let supervisorScript;
let adminServiceScript;
let initialPropertiesScript;

before(async () => {
  const [loadedCorpus, manifestText, permissionsText, scriptText, e2eText, containerText, localBridgeText, e2eRunnerText, installPackText, resourceManifestText, syncDocsText, supervisorText, adminServiceText, initialPropertiesText] = await Promise.all([
    loadCorpus(),
    readFile(new URL("../bedrock/behavior_packs/mc_wizard/manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../bedrock/config/4e8790fe-18dc-46d1-aa31-ec78a924b717/permissions.json", import.meta.url), "utf8"),
    readFile(new URL("../bedrock/behavior_packs/mc_wizard/scripts/main.js", import.meta.url), "utf8"),
    readFile(new URL("../bedrock/behavior_packs/mc_wizard/scripts/e2e.js", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-bedrock-container.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-ai-bridge.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-e2e-container.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/install-pack.mjs", import.meta.url), "utf8"),
    readFile(new URL("../bedrock/resource_packs/mc_wizard/manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/sync-docs.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/supervisor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/admin-service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/initialize-bedrock-properties.mjs", import.meta.url), "utf8"),
  ]);
  corpus = loadedCorpus;
  packManifest = JSON.parse(manifestText);
  packPermissions = JSON.parse(permissionsText);
  packScript = scriptText;
  e2eScript = e2eText;
  containerScript = containerText;
  localBridgeScript = localBridgeText;
  e2eRunnerScript = e2eRunnerText;
  installPackScript = installPackText;
  resourceManifest = JSON.parse(resourceManifestText);
  syncDocsScript = syncDocsText;
  supervisorScript = supervisorText;
  adminServiceScript = adminServiceText;
  initialPropertiesScript = initialPropertiesText;
  wizard = createWizard({ corpus, env: {} });
});

test("drives the real wizard path with a headless test player", () => {
  assert.match(packScript, /mc_wizard_e2e/);
  assert.match(packScript, /function routeAddressedMessage\(player, message\)/);
  assert.match(packScript, /engineAddressedMessageCount:/);
  assert.match(e2eScript, /spawnSimulatedPlayer/);
  assert.match(e2eScript, /kid\.chat\(message\)/);
  assert.match(e2eScript, /chatCallbacks\.routeAddressedMessage\(kid, message\)/);
  assert.match(packScript, /\[MC Wizard\]\[chat\]/);
  assert.match(packScript, /logChat\(player, "wizard", "player", trimmed\)/);
  assert.match(packScript, /logChat\(player, "general", "player", trimmed\)/);
  assert.match(packScript, /logChat\(player, "wizard", WIZARD_NAME, message\)/);
  assert.match(packScript, /logChat\(player, "general", label, answer\)/);
  assert.match(e2eScript, /engine-event/);
  assert.match(e2eScript, /direct-harness-fallback/);
  assert.match(e2eScript, /async function setLever/);
  assert.match(e2eScript, /getState\("open_bit"\)/);
  assert.match(e2eScript, /book-delivery/);
  assert.match(e2eScript, /validated-custom-plan/);
  assert.match(e2eScript, /pillar_axis/);
  assert.match(e2eScript, /transaction-undo/);
  assert.match(e2eScript, /tickingarea add circle/);
  assert.match(e2eScript, /tickingarea remove/);
  assert.match(e2eScript, /MC_WIZARD_E2E/);
  assert.match(e2eScript, /"PASS"/);
  const result = parseE2ELine(
    'prefix MC_WIZARD_E2E {"run":"current","status":"PASS","check":"demo","detail":"ok"}',
  );
  assert.deepEqual(result, { run: "current", status: "PASS", check: "demo", detail: "ok" });
  assert.equal(isTerminalE2EResultForRun(result, "old"), false);
  assert.equal(isTerminalE2EResultForRun(result, "current"), true);
  assert.equal(DEFAULT_TIMEOUT_MS, 600_000);
});

test("bootstraps every E2E run in an isolated disposable world", () => {
  assert.match(e2eRunnerScript, /runtime\/e2e\/\$RUN_ID/);
  assert.match(e2eRunnerScript, /mc-wizard-e2e-bootstrap-\$RUN_ID/);
  assert.match(e2eRunnerScript, /enable-beta-apis\.py/);
  assert.match(e2eRunnerScript, /E2E_LOG_FILE="\$ROOT\/runtime\/e2e-last\.log"/);
  assert.match(e2eRunnerScript, /Failed E2E world retained/);
  assert.match(e2eRunnerScript, /rm -rf "\$DATA"/);
  assert.match(e2eScript, /const fixture = await preparePad\(dimension\)/);
  assert.match(e2eScript, /y: fixture\.y/);
  assert.doesNotMatch(e2eScript, /Math\.max\(-60, Math\.min\(300, spawn\.y\)\)/);
  assert.doesNotMatch(e2eRunnerScript, /DATA="\$ROOT\/runtime\/bedrock"/);
  assert.doesNotMatch(e2eRunnerScript, /container inspect mc-wizard-bedrock/);
});

test("offers a focused live machine E2E with functional world-state checks", () => {
  assert.match(e2eScript, /mc_wizard_e2e_scope/);
  assert.match(e2eScript, /child-remote-gift/);
  assert.match(e2eScript, /the remote gift was also duplicated at the requester/);
  assert.match(e2eScript, /machine-piston-door/);
  assert.match(e2eScript, /pistonDoorIsClosed/);
  assert.match(e2eScript, /chatCallbacks\.hasCommittedBuild\(kid\.id\) && pistonDoorIsOpen/);
  assert.match(e2eScript, /machine-automatic-smelter/);
  assert.match(e2eScript, /containerContains\(dimension, at\(\[0, 0, 1\]\), "minecraft:iron_ingot"\)/);
  assert.match(e2eScript, /machine-item-sorter/);
  assert.match(e2eScript, /containerContains\(dimension, at\(\[0, 1, -1\]\), "minecraft:diamond"\)/);
  assert.match(e2eScript, /containerContains\(dimension, at\(\[-1, 3, 0\]\), "minecraft:feather"\)/);
  assert.match(e2eRunnerScript, /MC_WIZARD_E2E_SCOPE/);
  assert.match(installPackScript, /mc_wizard_e2e_scope/);
});

test("embodies the guide as an official simulated player", () => {
  assert.ok(packManifest.dependencies.some((dependency) => (
    dependency.module_name === "@minecraft/server-gametest"
    && dependency.version === "1.0.0-beta"
  )));
  assert.ok(packPermissions.allowed_modules.includes("@minecraft/server-gametest"));
  assert.match(packScript, /spawnSimulatedPlayer/);
  assert.match(packScript, /navigateToLocation/);
  assert.match(packScript, /function moveWizardBeside/);
  assert.match(packScript, /\[3, 4, 5, 6, 7, 8\]\.flatMap/);
  assert.match(packScript, /for \(const yOffset of \[0, -1, 1, -2, 2\]\)/);
  assert.match(packScript, /if \(!SAFE_GROUND\.has\(arrivalGround\?\.typeId\)\) wizard\.fly\(\)/);
  assert.match(packScript, /blinked beside \$\{player\.name\}/);
  assert.match(packScript, /distance < 2\.25 \* 2\.25/);
  assert.doesNotMatch(packScript, /navigateToEntity\(player/);
  assert.match(packScript, /\.chat\(/);
  assert.match(packScript, /useItemOnBlock/);
  assert.match(packScript, /if \(!placed\)/);
  assert.match(packScript, /direct repair after \$\{attempts\} player attempts/);
  assert.match(packScript, /dimension\.setBlockType\(target/);
  assert.doesNotMatch(packScript, /\.setType\(/);
  assert.doesNotMatch(packScript, /tryTeleport/);
  assert.match(packScript, /isWizardPlayer\(event\.sender\)/);
  assert.match(packScript, /new ItemStack\(itemId, 1\)/);
  assert.match(packScript, /function moveBuildTargetEntities/);
  assert.match(packScript, /entity\.typeId !== "minecraft:item"/);
  assert.match(packScript, /entity\.typeId !== "minecraft:xp_orb"/);
  assert.match(packScript, /entity\.teleport/);
  assert.doesNotMatch(packScript, /an entity entered the build area/);
  assert.doesNotMatch(packScript, /an entity entered the scaffold/);
  assert.match(packScript, /function expectedBlockMatches/);
  assert.match(packScript, /repairPass >= 1/);
  assert.match(packScript, /placement\.expectedStates \|\| \{\}/);
  assert.match(packScript, /facingLocation/);
  assert.match(packScript, /placementLookTarget,/);
  assert.match(packScript, /correctBlockFacing\(dimension, target, orientationTarget\)/);
  assert.match(packScript, /wizard\.setItem\(item, 0, true\)/);
});

test("verifies simulated-player gifts before repairing a missing drop at the child's feet", () => {
  assert.match(packScript, /const before = nearbyGiftAmount\(target, itemId\)/);
  assert.match(packScript, /const arrived = Math\.max\(0, nearbyGiftAmount\(target, itemId\) - before\)/);
  assert.match(packScript, /if \(arrived < count\)/);
  assert.match(packScript, /target\.dimension\.spawnItem\(giftStack\(spec, missing\)/);
  assert.match(packScript, /EnchantmentTypes\.get\(id\)/);
  assert.match(packScript, /component\.addEnchantments\(enchantments\)/);
  assert.match(packScript, /candidate\.name\.trim\(\)\.toLowerCase\(\) === wanted/);
});

test("retries a busy brain instead of abandoning a child's fast follow-up", () => {
  assert.match(packScript, /for \(let attempt = 0; attempt < 4; attempt \+= 1\)/);
  assert.match(packScript, /if \(response\.status !== 429\) break/);
  assert.match(packScript, /await system\.waitTicks\(10 \* \(attempt \+ 1\)\)/);
  assert.match(packScript, /brain was busy; retrying/);
});

test("repairs a rejected player placement immediately instead of stalling on retries", () => {
  assert.equal((packScript.match(/const retryLimit = 0;/g) || []).length, 2);
  assert.match(packScript, /one failed API result is enough/);
});

test("repairs verification misses without erasing a child's useful build", () => {
  const repairStart = packScript.indexOf("function repairExpectedBlock");
  const executorEnd = packScript.indexOf("async function buildCopperBulbTFlipFlop");
  const executor = packScript.slice(repairStart, executorEnd);
  assert.ok(repairStart >= 0 && executorEnd > repairStart);
  assert.match(executor, /expectedBlocks\.filter/);
  assert.match(executor, /repairExpectedBlock\(dimension, expected\)/);
  assert.match(executor, /repairAttempt < 3/);
  assert.match(executor, /commitTransaction\(token\)/);
  assert.match(executor, /kept every good part standing instead of erasing your build/);
  assert.doesNotMatch(executor, /clearBuild\(token, true\)/);
});

test("moves entity obstructions and continues instead of rejecting the build site", () => {
  assert.doesNotMatch(packScript, /function buildTargetHasEntity/);
  assert.match(packScript, /for \(const position of occupied\) moveBuildTargetEntities/);
  assert.match(packScript, /Tiny scoot.*kept building/);
  assert.doesNotMatch(packScript, /site contains a non-wizard entity/);
});

test("automatically retries legacy builds when terrain or the Wizard body interrupts them", () => {
  assert.doesNotMatch(packScript, /stopped before placing anything/);
  assert.doesNotMatch(packScript, /player body.*unavailable.*won.t pretend/i);
  assert.doesNotMatch(packScript, /body disappeared.*stopped/i);
  assert.doesNotMatch(packScript, /Ask me once more and I.ll redraw/i);
  assert.doesNotMatch(packScript, /working redstone memory core nearby/);
  assert.match(packScript, /revising this same machine now instead of swapping in an unrelated redstone trick/);
  assert.match(packScript, /keeping your T flip-flop queued/);
  assert.match(packScript, /keeping your calculator queued/);
  assert.doesNotMatch(packScript, /switched to a sturdy local version and kept building/);
  assert.match(packScript, /instead of pretending a wooden box is what you asked for/);
  assert.match(packScript, /structure plan validation failed/);
  assert.match(packScript, /system\.runTimeout\(beginTFlipFlop, 40\)/);
  assert.match(packScript, /system\.runTimeout\(beginCalculator, 40\)/);
  assert.match(packScript, /if \(player && !wizardIsValid\(\)\) bringWizardTo\(player\)/);
});

test("ships a custom wand without covering the simulated player in costume geometry", () => {
  assert.equal(resourceManifest.header.uuid, "5dd80b07-b583-4bb3-979c-41c25ce274d8");
  assert.ok(packManifest.dependencies.some((dependency) => dependency.uuid === resourceManifest.header.uuid));
  assert.match(installPackScript, /resource_packs/);
  assert.match(installPackScript, /world_resource_packs\.json/);
  assert.match(packScript, /mcwizard:wand/);
  assert.doesNotMatch(packScript, /minecraft:blaze_rod/);
  assert.doesNotMatch(packScript, /function dressWizard/);
  assert.match(packScript, /function removeOldCostume/);
  assert.doesNotMatch(packScript, /new ItemStack\("(?:mcwizard:(?:hat|robe)|minecraft:leather_(?:helmet|chestplate))"/);
});

test("lets an operator probe Bedrock's supported simulated-player skin data", () => {
  assert.match(packScript, /import \{ getPlayerSkin,/);
  assert.match(packScript, /wizard\.setSkin\(learnedWizardSkin\)/);
  assert.match(packScript, /player\.playerPermissionLevel !== 2/);
  assert.match(packScript, /copy\|learn\|use\|wear/);
  assert.match(packScript, /Classic PNG skins cannot be copied/);
});

test("prepares fixed command-block lessons and rejects unsafe generated commands", () => {
  assert.match(packScript, /function buildCommandLesson/);
  assert.match(packScript, /minecraft:command_block/);
  assert.match(packScript, /minecraft:stone_button/);
  assert.match(packScript, /Impulse, Unconditional, Needs Redstone/);
  assert.equal(unsafeCommandAnswer("Try /say hello"), true);
  assert.equal(unsafeCommandAnswer("Command:/say hello"), true);
  assert.equal(unsafeCommandAnswer("Try /give @s minecraft:torch 16"), true);
  assert.equal(unsafeCommandAnswer("Try /say hello", "Show me the /say command"), false);
  assert.equal(unsafeCommandAnswer(
    "Try /give @p[r=5] minecraft:torch 16",
    "Teach me a command-block lesson that gives me torches",
  ), false);
  assert.equal(unsafeCommandAnswer("Try /kill @a"), true);
  assert.equal(unsafeCommandAnswer("Try /kill @p", "Explain the /kill command"), true);
  assert.equal(unsafeCommandAnswer("Use a repeating command block"), true);
  assert.equal(explicitlyRequestsCommand("I like command blocks"), false);
  assert.equal(explicitlyRequestsCommand("How do command blocks work?"), true);
  assert.equal(explicitlyRequestsCommand("Build me a command-block lesson"), true);
  assert.match(safeCommandRefusal(), /spellbook/i);
  assert.match(safeCommandRefusal(true), /wand/i);
  assert.equal(COMMAND_LESSONS.give_self.command, "/give @p[r=5] minecraft:torch 16");
  assert.match(COMMAND_LESSONS.give_self.explanation, /cannot use @s/i);
});

test("removes unsolicited provider commands without discarding typed actions", async () => {
  const envelopes = [
    { answer: "Try /say You can do it!", action: null },
    {
      answer: "Use /give @s minecraft:torch 16.",
      action: { type: "give_items", version: 1, items: [{ itemId: "minecraft:torch", amount: 16 }] },
    },
    {
      answer: "Put /say Hello, builders! in the command block.",
      action: { type: "command_lesson", id: "hello", version: 1 },
    },
    {
      answer: "Put /give @p[r=5] minecraft:torch 16 in the command block.",
      action: { type: "command_lesson", id: "give_self", version: 1 },
    },
  ];
  const providerWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(envelopes.shift()) } }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  const encouragement = await providerWizard.ask({ player: "TalkKid", question: "Can you encourage me?" });
  assert.equal(encouragement.action, null);
  assert.doesNotMatch(encouragement.answer, /\/say\b/i);
  assert.match(encouragement.answer, /spellbook/i);

  const gift = await providerWizard.ask({ player: "GiftKid", question: "Can I have something useful?" });
  assert.deepEqual(gift.action, {
    type: "give_items", version: 1, items: [{ itemId: "minecraft:torch", amount: 16 }],
  });
  assert.doesNotMatch(gift.answer, /\/give\b/i);
  assert.match(gift.answer, /16x torch.*to you/i);

  const helloLesson = await providerWizard.ask({
    player: "CommandKid",
    question: "Teach me a command-block lesson that says hello",
  });
  assert.equal(helloLesson.action.id, "hello");
  assert.match(helloLesson.answer, /\/say Hello, builders!/i);

  const giveLesson = await providerWizard.ask({
    player: "CommandKid2",
    question: "Show me the /give command for torches",
  });
  assert.equal(giveLesson.action.id, "give_self");
  assert.match(giveLesson.answer, /\/give @p\[r=5\]/i);
});

test("drops every provider world action and goal from an informational cat question", async () => {
  const castle = classifyAction("Build me a castle");
  const rogueActions = [
    { type: "world_control", version: 1, weather: "thunder" },
    { type: "dimension_travel", version: 1, destination: "nether" },
    { type: "potion_rain", version: 1, radius: 8, durationSeconds: 8 },
    { type: "give_items", version: 1, items: [{ itemId: "minecraft:diamond_pickaxe", amount: 1 }] },
    { type: "show_recipe", version: 1, itemId: "minecraft:hopper" },
    { type: "command_lesson", id: "hello", version: 1 },
    castle,
    {
      type: "build_machine", version: 1, plan: {
        title: "Flying Machine", kind: "flying machine",
        placements: [
          { itemId: "minecraft:smooth_stone", target: [0, 0, 2], support: [0, -1, 2], orientationTarget: null },
          { itemId: "minecraft:slime_block", target: [0, 1, 2], support: [0, 0, 2], orientationTarget: null },
          { itemId: "minecraft:sticky_piston", target: [0, 1, 3], support: [0, 1, 2], orientationTarget: [0, 1, 4] },
          { itemId: "minecraft:observer", target: [0, 1, 1], support: [0, 1, 2], orientationTarget: [0, 1, 0] },
          { action: "break", target: [0, 0, 2] },
        ],
        interactions: [],
      },
    },
    {
      type: "build_plan", version: 1, plan: {
        title: "Tiny arch",
        blocks: [{ target: [0, 0, 1], support: [0, -1, 1], itemId: "minecraft:oak_planks" }],
      },
    },
    { type: "place_blueprint", id: "binary_adder_2bit", version: 1 },
  ];
  let providerCall = 0;
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      const action = rogueActions[Math.floor(providerCall / 2)];
      providerCall += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "Cats can be tamed with raw cod or raw salmon.",
        goal: { objective: "Change the world", successCriteria: "Something changed", status: "active" },
        action,
      }) } }] }), { status: 200 });
    },
  });
  for (let index = 0; index < 10; index += 1) {
    const result = await wizard.ask({ player: `CatKid${index}`, question: "Tell me about cats." });
    assert.equal(result.action, null);
    assert.equal(result.goal, undefined);
    assert.doesNotMatch(result.answer, /tamed with raw cod/i);
  }
});

test("repairs a rejected informational world action with one direct provider answer", async () => {
  const responses = [
    {
      answer: "The Nether portal is ready and working. Step through it now.",
      goal: { objective: "Open a portal", successCriteria: "The portal works", status: "active" },
      action: { type: "dimension_travel", version: 1, destination: "nether" },
    },
    {
      answer: "Cats are friendly mobs. Tame one with raw cod or raw salmon, then it can follow you home.",
      action: null,
      goal: null,
    },
  ];
  const requests = [];
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: {
        content: JSON.stringify(responses.shift()),
      } }] }), { status: 200 });
    },
  });
  const result = await wizard.ask({ player: "IntentKid", question: "Tell me about cats." });
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /answer this informational question directly.*action=null and no goal/is);
  assert.equal(result.answer, "Cats are friendly mobs. Tame one with raw cod or raw salmon, then it can follow you home.");
  assert.equal(result.action, null);
  assert.equal(result.goal, undefined);
});

test("uses the truthful fallback after one invalid informational repair", async () => {
  let calls = 0;
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "The moon portal is complete and working.",
        goal: { objective: "Visit the moon", successCriteria: "The child reaches the moon", status: "active" },
        action: { type: "dimension_travel", version: 1, destination: "moon" },
      }) } }] }), { status: 200 });
    },
  });
  const result = await wizard.ask({ player: "SchemaKid", question: "Tell me about cats." });
  assert.equal(calls, 2);
  assert.equal(result.action, null);
  assert.equal(result.goal, undefined);
  assert.equal(
    result.answer,
    "That spell wandered away from your question, so I won’t pretend it was right. Ask me one specific thing, and I’ll answer it plainly.",
  );
  assert.doesNotMatch(result.answer, /portal|ready|complete|working|step through|active project|full plan|automatically/i);
});

test("uses a private per-install HMAC for provider safety identifiers", async () => {
  const [wizardSource, serverSource, envExample] = await Promise.all([
    readFile(new URL("../src/wizard.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(wizardSource, /local-spike|createHash/);
  assert.match(serverSource, /safetySalt:\s*wizardSalt/);
  assert.match(serverSource, /configuredWizardSalt\.length\s*>=\s*24/);
  assert.match(serverSource, /configuredWizardSalt !== "change-me-before-sharing"/);
  assert.match(serverSource, /randomBytes\(32\)/);
  assert.doesNotMatch(serverSource, /wizardSalt\s*=\s*env\.WIZARD_SALT\s*\|\|\s*token/);
  assert.match(envExample, /^WIZARD_SALT=\s*$/m);
  assert.doesNotMatch(envExample, /WIZARD_SALT=change-me-before-sharing/);
  assert.match(wizardSource, /mc-wizard:provider-safety-identifier:v1/);
  const identifiers = [];
  const makeWizard = (safetySalt) => createWizard({
    corpus: { search: () => [] }, safetySalt,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model" },
    fetchImpl: async (_url, options) => {
      identifiers.push(JSON.parse(options.body).safety_identifier);
      return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify({
        answer: "Cats purr and follow players who tame them.", action: null,
      }) }] }] }), { status: 200 });
    },
  });
  const first = makeWizard("private-install-a");
  await first.ask({ player: "SameKid", question: "Tell me about cats" });
  await first.ask({ player: "SameKid", question: "What do cats do?" });
  await first.ask({ player: "OtherKid", question: "Tell me about cats" });
  await makeWizard("private-install-b").ask({ player: "SameKid", question: "Tell me about cats" });
  await makeWizard().ask({ player: "SameKid", question: "Tell me about cats" });
  await makeWizard().ask({ player: "SameKid", question: "Tell me about cats" });
  assert.match(identifiers[0], /^[a-f0-9]{64}$/);
  assert.equal(identifiers[0], identifiers[1]);
  assert.notEqual(identifiers[0], identifiers[2]);
  assert.notEqual(identifiers[0], identifiers[3]);
  assert.notEqual(identifiers[4], identifiers[5]);
});

test("promotes versioned documentation only after retrieval and dialogue evaluation", () => {
  assert.match(syncDocsScript, /\.staging-/);
  assert.match(syncDocsScript, /evaluateRelease\(staging\)/);
  assert.match(syncDocsScript, /retrieval evaluation failed before promotion/);
  assert.match(syncDocsScript, /dialogue evaluation failed before promotion/);
  assert.match(syncDocsScript, /active-release\.json/);
  assert.match(syncDocsScript, /await rename\(activeTemp/);
  assert.match(syncDocsScript, /CC BY 4\.0/);
  assert.match(syncDocsScript, /channels: \["stable", "preview"\]/);
});

test("supervises Bedrock, brain, provider, and corpus without secrets in status", () => {
  assert.match(supervisorScript, /Math\.min\(30_000/);
  assert.match(supervisorScript, /function daemonPids\(\)/);
  assert.match(supervisorScript, /pgrep/);
  assert.match(supervisorScript, /container", \["exec", "mc-wizard-bedrock", "true"\]/);
  assert.match(supervisorScript, /corpusChunks/);
  assert.match(supervisorScript, /providerName/);
  assert.doesNotMatch(supervisorScript, /BRIDGE_TOKEN.*console|AI_API_KEY.*console/);
  assert.match(supervisorScript, /container", \["stop", "--time", "60"/);
});

test("navigates into player reach for every placement and verifies scaffold removal", () => {
  assert.match(packScript, /BUILD_REACH_SQUARED/);
  assert.match(packScript, /positionWizardForBuild\(dimension, target, support/);
  const positioning = packScript.slice(
    packScript.indexOf("function positionWizardForBuild"),
    packScript.indexOf("function placeAsWizard"),
  );
  assert.match(packScript, /wizard\.navigateToLocation/);
  assert.match(packScript, /wizard\.moveToLocation/);
  assert.match(packScript, /wizard\.jump\(\)/);
  assert.match(positioning, /const flightDestination = candidates\.find/);
  assert.match(positioning, /mode: "flight-takeoff"/);
  assert.match(positioning, /wizard\.fly\(\)/);
  assert.match(positioning, /blinked into build reach after the flight path stalled/);
  assert.doesNotMatch(positioning, /elevatedDestination/);
  assert.match(positioning, /const destination = forcedDestination \|\| validCandidates\[0\]/);
  assert.match(positioning, /blinked into grounded build reach after navigation stalled/);
  assert.doesNotMatch(positioning, /tryTeleport/);
  const placement = packScript.slice(
    packScript.indexOf("function placeAsWizard"),
    packScript.indexOf("function breakAsWizard"),
  );
  assert.match(
    placement,
    /const placed = wizard\.useItemOnBlock[\s\S]*if \(!placed\)[\s\S]*dimension\.setBlockType\(target, expectedTypes\[0\]\)/,
  );
  assert.match(packScript, /function playerCopyableCalculatorSupport/);
  assert.match(packScript, /function playerAccessibleCalculatorOrder/);
  assert.match(packScript, /dimension\.getBlock\(location\)\?\.isSolid/);
  assert.match(packScript, /stepComplete === false \|\| stepComplete === "placement-retry"/);
  assert.match(packScript, /placementRetries\.has\(retryKey\)/);
  assert.match(packScript, /forceMove/);
  assert.match(packScript, /preparedPlacements\.add\(retryKey\)/);
  assert.match(packScript, /stepComplete === "placement-prepare"/);
  assert.match(packScript, /scaffold did not clear/);
  assert.match(packScript, /finalBlocks\.set\(locationKey, \{ location, typeId: "minecraft:air" \}\)/);
});

test("keeps player chat visible and accepts wiz or nearby conversation", () => {
  assert.doesNotMatch(packScript, /event\.cancel\s*=\s*true/);
  assert.match(packScript, /if \(wizardSpeaking\) return/);
  assert.match(packScript, /wiz\(\?:ard\)\?/);
  assert.match(packScript, /humanPlayers\(\)\.length === 1 \|\| nearby/);
  assert.match(packScript, /12 \* 12/);
});

test("routes explicit AI chat from anywhere and delivers long answers as signed books", () => {
  assert.match(packScript, /function routeAIMessage\(player, message\)/);
  assert.match(packScript, /\^!\?ai/);
  assert.match(packScript, /askBackend\(playerId, question, "general"\)/);
  assert.match(packScript, /minecraft:writable_book/);
  assert.match(packScript, /component\.setContents/);
  assert.match(packScript, /component\.signBook/);
  assert.match(packScript, /bookTitle\(payload\.title \|\| question\)/);
  assert.match(packScript, /player\.dimension\.spawnItem/);
  assert.doesNotMatch(packScript, /Let me check my Bedrock notes/);
});

test("levels blocked builds nearby without sky teleporting and queues busy requests", () => {
  assert.match(packScript, /function prepareBuildWorkshop/);
  assert.doesNotMatch(packScript, /player\.teleport/);
  assert.match(packScript, /smooth_stone/);
  assert.doesNotMatch(packScript, /y:\s*256/);
  assert.match(packScript, /function queueBuild/);
  assert.match(packScript, /function standingBlockY/);
  assert.match(e2eScript, /action-first-workshop/);
  assert.match(e2eScript, /prepareBuildWorkshop/);
  assert.doesNotMatch(packScript, /Move to an open area and ask again/);
  assert.doesNotMatch(packScript, /Move to a flat field and ask again/);
});

test("creates readable book pages and whole-word titles", () => {
  assert.equal(bookTitle("make me a guide on how to beat minecraft"), "Beat Minecraft");
  assert.equal(bookTitle("pneumonoultramicroscopicsilicovolcanoconiosis"), "AI Answer");
  const pages = bookPages("# First steps\n\n- Find wood and make tools.\n- Build a safe shelter before dark. ".repeat(20));
  assert.ok(pages.length > 1 && pages.length <= 50);
  assert.ok(pages.every((page) => page.length <= 256 && page.split("\n").length <= 8));
  assert.match(pages.join("\n"), /• Find wood/);
});

test("constrains CLI providers to text-only ephemeral safe mode", () => {
  assert.match(localBridgeScript, /from "mtok-bridge"/);
  assert.match(localBridgeScript, /"--safe-mode"/);
  assert.match(localBridgeScript, /"--tools", ""/);
  assert.match(localBridgeScript, /"--no-session-persistence"/);
  assert.match(localBridgeScript, /provider === "grok"/);
  assert.match(localBridgeScript, /provider === "codex"/);
  assert.match(localBridgeScript, /function codexUpstream/);
  assert.match(localBridgeScript, /"--ephemeral"/);
  assert.match(localBridgeScript, /"--ignore-user-config"/);
  assert.match(localBridgeScript, /"--disable", "shell_tool"/);
  assert.match(localBridgeScript, /"--output-schema"/);
  assert.match(localBridgeScript, /model_reasoning_effort="\$\{reasoningEffort\}"/);
  assert.match(localBridgeScript, /"--no-memory"/);
  assert.match(localBridgeScript, /"--no-subagents"/);
  assert.match(localBridgeScript, /"--no-plan"/);
  assert.match(localBridgeScript, /"--disable-web-search"/);
  assert.match(localBridgeScript, /"--output-format", "plain"/);
  assert.match(localBridgeScript, /host = "127\.0\.0\.1"/);
  assert.match(localBridgeScript, /MTOK_TIMEOUT_MS/);
  assert.match(localBridgeScript, /function isolatedGrokEnvironment/);
  assert.match(localBridgeScript, /HOME: cleanHome/);
  assert.match(localBridgeScript, /symlinkSync\(sourceAuth, targetAuth\)/);
  assert.match(localBridgeScript, /createProviderScheduler/);
  assert.match(localBridgeScript, /MTOK_MAX_CONCURRENT/);
  assert.doesNotMatch(localBridgeScript, /let queue = Promise\.resolve\(\)/);
  assert.doesNotMatch(localBridgeScript, /writeHead\(429/);
  assert.doesNotMatch(localBridgeScript, /dangerously-skip|bypassPermissions/);
});

test("process discovery patterns cannot match their own pgrep commands", () => {
  assert.match(supervisorScript, /replace\("\/", "\[\/\]"\)/);
  assert.match(adminServiceScript, /replace\("\/", "\[\/\]"\)/);
  assert.match(supervisorScript, /pid > 0/);
  assert.match(adminServiceScript, /pid > 0/);
});

test("pins the Apple container launch to trusted open-LAN operator mode", () => {
  assert.match(containerScript, /sha256:45c8f292b289659c0be469b2eaaebfc1fbfefdf5c060a0df5ed53fe9e2e7c563/);
  assert.match(containerScript, /VERSION=1\.26\.33\.2/);
  assert.match(containerScript, /--platform linux\/amd64/);
  assert.doesNotMatch(containerScript, /USE_BOX64/);
  assert.match(containerScript, /trusted open-LAN mode/);
  assert.match(containerScript, /RFC1918 private address/);
  assert.match(containerScript, /initialize-bedrock-properties/);
  assert.match(initialPropertiesScript, /error\.code !== "ENOENT"/);
  assert.match(containerScript, /LEVEL_NAME=mc-wizard/);
  assert.match(containerScript, /--publish "\$\{LAN_IP\}:19132:19132\/udp"/);
  assert.doesNotMatch(containerScript, /VERSION=LATEST/);
});

test("retrieves the Bedrock T flip-flop card", () => {
  const [result] = corpus.search("How does a T flip-flop remember on and off?");
  assert.equal(result.title, "Copper bulb T flip-flop");
  assert.match(result.source, /27451789924237/);
});

test("normalizes plurals and rejects generic retrieval matches", () => {
  const [comparator] = corpus.search("How do comparators work?");
  assert.match(`${comparator.title} ${comparator.text}`, /comparator/i);
  assert.deepEqual(corpus.search("how does something work"), []);
});

test("answers cat questions from player-facing facts and carries short follow-ups", async () => {
  const [cat] = corpus.search("tell me about cats");
  assert.equal(cat.title, "Cats in Minecraft Bedrock");
  assert.match(cat.text, /raw cod or raw salmon/i);

  let providerCalled = false;
  const catWizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "slow", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalled = true;
      throw new Error("grounded quick answers must not wait for the provider");
    },
  });
  const overview = await catWizard.ask({ player: "CatKid", question: "tell me about cats" });
  const followUp = await catWizard.ask({ player: "CatKid", question: "how do I tame one" });
  assert.equal(providerCalled, false);
  assert.equal(overview.mode, "local-grounded");
  assert.equal(followUp.mode, "local-grounded");
  assert.match(followUp.answer, /raw cod or raw salmon/i);
  assert.doesNotMatch(followUp.answer, /notes|ask an adult/i);
});

test("limits quick answers to named questions and does not pollute standalone follow-ups", async () => {
  const requests = [];
  const contextWizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "slow", AI_STYLE: "chat" },
    fetchImpl: async (url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ answer: "A tailored provider answer.", action: null }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const gift = await contextWizard.ask({ player: "CuriousKid", question: "What gift can cats give?" });
  assert.equal(gift.answer, "A tailored provider answer.");
  await contextWizard.ask({ player: "CuriousKid", question: "tell me about cats" });
  await contextWizard.ask({ player: "CuriousKid", question: "what is redstone?" });
  assert.equal(requests.length, 2);
  const retrievedSources = requests.at(-1).messages.at(-1).content.split("Retrieved sources:").at(-1);
  assert.doesNotMatch(retrievedSources, /Cats in Minecraft Bedrock/);
});

test("preserves encoded command placeholders while stripping HTML", () => {
  assert.equal(htmlToMarkdown("<p><code>/give &lt;player&gt; command_block</code></p>"), "/give <player> command_block");
});

test("rejects non-object and malformed ask payloads", () => {
  for (const value of [null, [], "question", 42]) {
    assert.throws(() => validateAskBody(value), (error) => error.status === 400);
  }
  assert.throws(() => validateAskBody({ question: " " }), (error) => error.status === 400);
  assert.equal(validateAskBody({ question: "hello", mode: "general" }).mode, "general");
  assert.equal(validateAskBody({ question: "hello", mode: "anything" }).mode, "wizard");
  assert.equal(validateAskBody({ question: "continue", goalId: "goal_123-safe" }).goalId, "goal_123-safe");
  for (const goalId of ["", "bad goal", "x".repeat(65), {}, null]) {
    assert.throws(
      () => validateAskBody({ question: "continue", goalId }),
      (error) => error.status === 400 && /goalId/.test(error.message),
    );
  }
});

test("validates bounded action outcomes", () => {
  assert.deepEqual(validateActionResultBody({
    player: "Action Kid",
    requestId: "castle-123",
    status: "failed",
    detail: "blocked\nby lava",
  }), {
    player: "Action Kid",
    requestId: "castle-123",
    status: "failed",
    detail: "blocked by lava",
  });
  for (const value of [
    null,
    { player: "", requestId: "castle-123", status: "started" },
    { player: "Kid", requestId: "bad id", status: "started" },
    { player: "Kid", requestId: "castle-123", status: "pending" },
    { player: "Kid", requestId: "castle-123", status: "failed", detail: "x".repeat(501) },
  ]) {
    assert.throws(() => validateActionResultBody(value), (error) => error.status === 400);
  }
});

test("records validated action results against the generated action id", async () => {
  const sessions = createMemorySessionStore();
  const actionWizard = createWizard({
    corpus: { search: () => [] },
    env: {},
    sessions,
  });
  const ask = await actionWizard.ask({ player: "ActionKid", question: "Build me a castle" });
  assert.match(ask.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(sessions.get("ActionKid", "wizard")[0].status, "pending");
  const payload = validateActionResultBody({
    player: "ActionKid", requestId: ask.requestId, status: "started",
  });
  assert.deepEqual(await actionWizard.recordActionResult(payload), {
    matched: true, updated: true, status: "started",
  });
  assert.deepEqual(await actionWizard.recordActionResult(payload), {
    matched: true, updated: false, status: "started",
  });
  assert.deepEqual(await actionWizard.recordActionResult({
    ...payload, status: "completed", detail: "verified",
  }), { matched: true, updated: true, status: "completed", reviewDeferred: true });
  assert.equal(sessions.get("ActionKid", "wizard")[0].detail, "verified");
  assert.deepEqual(await actionWizard.recordActionResult({ ...payload, requestId: "missing" }), {
    matched: false, updated: false,
  });

  const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const endpoint = serverSource.slice(serverSource.indexOf('url.pathname === "/v1/action-result"'));
  assert.match(endpoint, /if \(!authorized\(request, token\)\)/);
  assert.match(endpoint, /const actionResult = validateActionResultBody\(await readJson\(request\)\)/);
  assert.match(endpoint, /wizard\.recordActionResult\(actionResult\)/);
});

test("refuses the development bridge token on a LAN bind", async () => {
  await assert.rejects(
    startServer({ env: { HOST: "192.168.1.20" }, logger: { log() {}, warn() {} } }),
    /Refusing a default or short bridge token/,
  );
  await assert.rejects(
    startServer({
      env: { HOST: "192.168.1.20", BRIDGE_TOKEN: "too-short" },
      logger: { log() {}, warn() {} },
    }),
    /Refusing a default or short bridge token/,
  );
});

test("only requests the allow-listed build when the player asks for a demo", () => {
  assert.equal(classifyAction("What is a T flip-flop?"), null);
  assert.equal(classifyAction("Explain it, but do not build a T flip-flop"), null);
  assert.equal(classifyAction("Never show me a T flip flop; just explain it"), null);
  assert.equal(classifyAction("Do not show me a T flip flop"), null);
  assert.deepEqual(classifyAction("Build me a switch that changes every time I press a button"), {
    type: "place_blueprint",
    id: "copper_bulb_t_flip_flop",
    version: 1,
  });
});

test("plans a bounded two-bit redstone calculator and all 16 sums", () => {
  const blueprint = createCalculatorBlueprint();
  assert.ok(blueprint.placements.length > 250);
  assert.ok(blueprint.placements.length < 400);
  for (const offset of [0, 6]) {
    for (const x of [1, 3]) {
      const torch = blueprint.placements.find((placement) => (
        placement.itemId === "minecraft:redstone_torch"
        && placement.target.join(",") === `${x + offset},1,6`
      ));
      assert.deepEqual(torch?.support, [x + offset, 1, 7]);
    }
  }
  assert.deepEqual(classifyAction("Build a working calculator using only redstone"), {
    type: "place_blueprint",
    id: "binary_adder_2bit",
    version: 1,
  });
  for (let a = 0; a <= 3; a += 1) {
    for (let b = 0; b <= 3; b += 1) {
      const result = calculatorResult(a, b);
      assert.equal(result.sum, a + b);
      assert.equal(Number.parseInt(result.bits.join(""), 2), a + b);
    }
  }
});

test("starts a complete local castle without waiting for model planning", async () => {
  let providerCalled = false;
  const castleWizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "slow", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalled = true;
      throw new Error("model unavailable");
    },
  });
  const result = await castleWizard.ask({ player: "Kid", question: "Build me a castle" });
  assert.equal(providerCalled, false);
  assert.equal(result.mode, "local-skill");
  assert.equal(result.action.type, "build_structure");
  const plan = validateBuildStructurePlan(result.action.plan);
  assert.equal(plan.kind, "castle");
  assert.deepEqual(plan.dimensions, { width: 17, depth: 17, height: 9 });
  assert.deepEqual(plan.phases, ["foundation", "shell", "roof", "details"]);
  assert.ok(plan.features.includes("walls"));
  assert.ok(plan.features.includes("towers"));
  assert.match(result.answer, /complete 17 by 17 castle/i);
});

test("uses the immediate deterministic plan for a recognized structure", async () => {
  const providerPlan = {
    ...classifyAction("Build me a castle").plan,
    title: "Moonlit Castle",
    materials: {
      primary: "minecraft:deepslate_bricks",
      accent: "minecraft:gold_block",
      roof: "minecraft:deepslate_bricks",
    },
  };
  let providerCalled = false;
  const modelWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalled = true;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "I’ll raise a moonlit castle here, with amethyst tower trim.",
        action: { type: "build_structure", version: 1, plan: providerPlan },
      }) } }] }), { status: 200 });
    },
  });

  const result = await modelWizard.ask({ player: "MoonKid", question: "Build me a castle" });
  assert.equal(providerCalled, false);
  assert.equal(result.mode, "local-skill");
  assert.equal(result.action.plan.title, "17x17 castle");
  assert.equal(result.action.plan.materials.accent, "minecraft:cobblestone");
  assert.match(result.answer, /complete 17 by 17 castle.*coming up/i);
});

test("retains model planning for custom details on otherwise recognized structures", async () => {
  for (const [question, kind] of [
    ["Build me a mansion with a swimming pool and library", "mansion"],
    ["Build me a castle with a dungeon and throne room", "castle"],
  ]) {
    let providerCalls = 0;
    const wizard = createWizard({
      corpus: { search: () => [] },
      env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
      logger: { warn() {} },
      fetchImpl: async () => {
        providerCalls += 1;
        throw new Error("planner unavailable");
      },
    });

    const result = await wizard.ask({ player: `Custom-${kind}`, question });
    assert.equal(providerCalls, 1, question);
    assert.equal(result.action.plan.kind, kind, question);
    assert.equal(result.mode, "local-structure-fallback", question);
  }
});

test("replaces every premature provider success phrase while keeping its pending action", async () => {
  const castle = classifyAction("Build me a castle");
  const torchGift = {
    type: "give_items", version: 1, items: [{ itemId: "minecraft:torch", amount: 16 }],
  };
  const cases = [
    ["The castle is complete and ready for you.", "Build me a castle", castle, /coming up|I’ll build/i],
    ["All set! Your castle awaits.", "Build me a castle", castle, /coming up|I’ll build/i],
    ["Behold your finished castle.", "Build me a castle", castle, /coming up|I’ll build/i],
    ["Your castle stands ready.", "Build me a castle", castle, /coming up|I’ll build/i],
    ["It’s finished.", "Build me a castle", castle, /coming up|I’ll build/i],
    ["The castle’s ready.", "Build me a castle", castle, /coming up|I’ll build/i],
    ["The castle has been completed.", "Build me a castle", castle, /coming up|I’ll build/i],
    ["We did it.", "Build me a castle", castle, /coming up|I’ll build/i],
    ["Done — the torches are in your inventory.", "Can I have something useful?", torchGift, /I’ll carry 16x torch/i],
  ];
  for (const [providerAnswer, question, action, truthfulAnswer] of cases) {
    const modelWizard = createWizard({
      corpus: { search: () => [] },
      env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: providerAnswer,
        goal: { objective: question, successCriteria: "The requested result is verified in the world", status: "active" },
        action,
      }) } }] }), { status: 200 }),
    });
    const result = await modelWizard.ask({ player: `HonestKid-${providerAnswer}`, question });
    assert.deepEqual(result.action, action, providerAnswer);
    assert.equal(result.goal?.status, "active", providerAnswer);
    assert.equal(result.mode, action.type === "build_structure" ? "local-skill" : "chat:model", providerAnswer);
    assert.notEqual(result.answer, providerAnswer);
    assert.match(result.answer, truthfulAnswer, providerAnswer);
  }
});

test("expands a complete castle while retaining its structure contract", async () => {
  const action = classifyAction("Make it bigger and give it four walls", [
    { question: "Build me a castle", answer: "I’ll build the complete castle." },
  ]);
  assert.equal(action.type, "build_structure");
  assert.equal(action.plan.kind, "castle");
  assert.deepEqual(action.plan.dimensions, { width: 21, depth: 21, height: 11 });
  assert.ok(action.plan.features.includes("walls"));
});

test("uses planned, active, and completed structures but never a failed structure as the prior build", () => {
  const castle = classifyAction("Build me a castle");
  for (const status of ["pending", "started", "completed", "unknown"]) {
    const action = classifyAction("make it bigger", [{
      question: "Build me a castle",
      answer: "I’ll build it.",
      action: castle,
      status,
    }]);
    assert.equal(action?.plan.mode, "modify", status);
  }
  assert.equal(classifyAction("make it bigger", [{
    question: "Build me a castle",
    answer: "I tried, but that build failed.",
    action: castle,
    status: "failed",
  }]), null);
});

test("keeps decorated castle villagers in usable rooms on both floors", () => {
  const first = classifyAction("Build me a 12x12 castle");
  const action = classifyAction(
    "add rooms, towers, second floor, decorations, and four villagers",
    [{ question: "Build me a 12x12 castle", answer: "The castle is complete.", action: first }],
  );
  assert.equal(action.plan.mode, "modify");
  assert.ok(action.plan.features.includes("decorations"));
  assert.deepEqual(action.plan.entities.map(({ location }) => location), [
    [3, 1, 3],
    [8, 1, 3],
    [3, 7, 8],
    [8, 7, 8],
  ]);
  const balcony = classifyAction("add a balcony", [{
    question: "add rooms, towers, second floor, decorations, and four villagers",
    answer: "The castle upgrade is complete.",
    action,
    status: "completed",
  }]);
  assert.deepEqual(balcony.plan.entities, action.plan.entities);
  const bigger = classifyAction("make it bigger", [{
    question: "add rooms, towers, second floor, decorations, and four villagers",
    answer: "The castle upgrade is complete.",
    action,
    status: "completed",
  }]);
  assert.equal(bigger.plan.entities.length, 4);
  assert.equal(bigger.plan.entities.every(({ location: [x, y, z] }) => (
    x > 0 && x < bigger.plan.dimensions.width - 1
      && y > 0 && y < bigger.plan.dimensions.height - 1
      && z > 0 && z < bigger.plan.dimensions.depth - 1
  )), true);
  for (const [amount, count] of [["a", 1], ["two", 2], ["eight", 8]]) {
    const populated = classifyAction(`add ${amount} villager${count === 1 ? "" : "s"}`, [{
      question: "Build me a 12x12 castle", answer: "The castle is complete.", action: first,
    }]);
    assert.equal(populated.plan.entities.length, count, amount);
  }
});

test("builds requested castle residents locally without provider repair", async () => {
  const player = "VillagerContractKid";
  const question = "add rooms, towers, second floor, decorations, and four villagers";
  const first = classifyAction("Build me a 12x12 castle");
  const history = [{
    question: "Build me a 12x12 castle",
    answer: "The castle is complete.",
    action: first,
    status: "completed",
    requestId: "castle-first",
    goalId: "castle-goal",
  }];
  const complete = classifyAction(question, history);
  const missingVillagers = {
    ...complete,
    plan: { ...complete.plan, entities: undefined },
  };
  const sessions = createMemorySessionStore();
  await sessions.set(player, "wizard", history);
  const requests = [];
  const responses = [missingVillagers, complete];
  const contractWizard = createWizard({
    corpus: { search: () => [] },
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      const action = responses.shift();
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "I’m adding the rooms, towers, upper floor, decorations, and four villagers now.",
        action,
      }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await contractWizard.ask({ player, question });
  assert.equal(requests.length, 0);
  assert.equal(result.action.plan.entities.length, 4);
  assert.equal(result.action.plan.entities.every(({ typeId }) => typeId === "minecraft:villager_v2"), true);
});

test("requires a real structure-edit request instead of inheriting conversational words", () => {
  const castle = { question: "Build me a castle", answer: "The castle is complete." };
  for (const question of [
    "What do you think looks bigger, the inside or the outside?",
    "What is inside it?",
    "Can you explain what makes it bigger?",
    "Tell me how to make it outside",
  ]) {
    assert.equal(classifyAction(question, [castle]), null, question);
  }
  const stale = [castle, { question: "tell me a joke", answer: "A joke." }];
  assert.equal(classifyAction("make it bigger", stale), null);
  assert.equal(classifyAction("add a chimney", stale), null);
  assert.equal(classifyAction("add a chimney to the castle", stale)?.plan.mode, "modify");
  const activeCastle = {
    question: "Build me a castle", answer: "The castle is complete.",
    action: classifyAction("Build me a castle"), status: "completed",
    requestId: "castle-intent", goalId: "castle-intent",
    goal: { objective: "Build a castle", successCriteria: "A castle exists nearby", status: "active" },
  };
  assert.equal(classifyAction("Can cats change color?", [activeCastle]), null);
  assert.equal(classifyAction("Can cats build houses?", [activeCastle]), null);
  assert.equal(classifyAction("Can villagers build sugar cane farms?", [activeCastle]), null);
  assert.equal(classifyAction("Add more facts about cats", [activeCastle]), null);
  assert.equal(classifyAction("How can I improve at redstone?", [activeCastle]), null);
  assert.equal(classifyAction("Show me what cats do", [activeCastle]), null);
  assert.equal(classifyAction("What happens if I set time to night?", [activeCastle]), null);
  assert.equal(classifyAction("Why does a hopper recipe use a chest?", [activeCastle]), null);
  assert.equal(classifyAction("How do I make a cat sit?", [activeCastle]), null);
  assert.equal(classifyAction("What gift can cats give me?", [activeCastle]), null);
  assert.equal(classifyAction("What is splash potion rain?", [activeCastle]), null);
});

test("keeps unnamed structure follow-ups across short acknowledgements only", () => {
  const castle = { question: "Build me a castle", answer: "The castle is complete." };
  const acknowledgements = [
    castle,
    { question: "thanks!", answer: "You’re welcome!" },
    { question: "cool", answer: "Glad you like it!" },
  ];
  assert.equal(classifyAction("add a chimney", acknowledgements)?.plan.mode, "modify");

  const interrupted = [
    castle,
    { question: "thanks!", answer: "You’re welcome!" },
    { question: "tell me a joke", answer: "A joke." },
  ];
  assert.equal(classifyAction("add a chimney", interrupted), null);
});

test("keeps explicit edit dimensions exact and represents common physical additions", () => {
  const history = [{ question: "Build me a 9x9x5 house", answer: "The house is complete." }];
  const exact = classifyAction("Make it bigger, exactly 20x14x8", history);
  assert.deepEqual(exact.plan.dimensions, { width: 20, depth: 14, height: 8 });
  assert.deepEqual(classifyAction("make it 20 blocks tall", history).plan.dimensions, {
    width: 9, depth: 9, height: 20,
  });
  assert.deepEqual(classifyAction("make it 30 blocks wide", history).plan.dimensions, {
    width: 30, depth: 9, height: 5,
  });
  assert.deepEqual(classifyAction("make it 14 blocks deep", history).plan.dimensions, {
    width: 9, depth: 14, height: 5,
  });

  const chimney = classifyAction("add a chimney", history);
  const balcony = classifyAction("add a balcony", history);
  const moat = classifyAction("add a moat", history);
  for (const action of [chimney, balcony, moat]) {
    assert.equal(action.plan.mode, "modify");
    assert.ok(validateBuildStructurePlan(action.plan).primitives.length);
  }
  assert.ok(chimney.plan.primitives.some(({ blockId, from, to }) => blockId === "minecraft:oak_log" && to[1] > from[1]));
  assert.ok(balcony.plan.primitives.length >= 6);
  assert.ok(balcony.plan.primitives.some(({ from, to }) => from[2] < 0 || to[2] < 0));
  assert.deepEqual(moat.plan.dimensions, { width: 9, depth: 9, height: 5 });
  assert.equal(moat.plan.primitives.filter(({ blockId }) => blockId === "minecraft:blue_concrete").length, 4);
  assert.equal(moat.plan.primitives.filter(({ blockId }) => blockId === "minecraft:polished_blackstone_bricks").length, 4);
  assert.ok(moat.plan.primitives.some(({ blockId, from, to }) => (
    blockId === "minecraft:blue_concrete" && from[2] === -1 && to[2] === -1
  )));

  const chimneyAndBalcony = classifyAction("add a balcony", [{
    question: "add a chimney",
    answer: "The chimney is complete.",
    action: chimney,
  }]);
  assert.ok(chimneyAndBalcony.plan.primitives.some(({ from, to }) => to[1] > from[1]));
  assert.ok(chimneyAndBalcony.plan.primitives.length > chimney.plan.primitives.length);
});

test("keeps exact requested refinement dimensions without a provider round trip", async () => {
  const player = "ExactEditContractKid";
  const first = classifyAction("Build me a 9x9x5 house");
  const history = [{
    question: "Build me a 9x9x5 house", answer: "The house is complete.", action: first,
    status: "completed", requestId: "exact-first", goalId: "exact-goal",
  }];
  const correct = classifyAction("make it bigger, exactly 20x14x8", history);
  const wrong = {
    ...correct,
    plan: { ...correct.plan, dimensions: { width: 13, depth: 13, height: 6 } },
  };
  const sessions = createMemorySessionStore();
  await sessions.set(player, "wizard", history);
  let calls = 0;
  const wizard = createWizard({
    corpus: { search: () => [] },
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "I’m resizing the same house now.", action: wrong,
      }) } }] }), { status: 200 });
    },
  });

  const result = await wizard.ask({ player, question: "make it bigger, exactly 20x14x8" });
  assert.equal(calls, 0);
  assert.deepEqual(result.action.plan.dimensions, { width: 20, depth: 14, height: 8 });
  assert.equal(result.action.plan.mode, "modify");
});

test("adds a contained exterior moat locally without a provider round trip", async () => {
  const player = "MoatContractKid";
  const first = classifyAction("Build me a 16x16 castle");
  const history = [{
    question: "Build me a 16x16 castle", answer: "The castle is complete.", action: first,
    status: "completed", requestId: "moat-first", goalId: "moat-goal",
  }];
  const correct = classifyAction("add a moat", history);
  const wrong = {
    ...correct,
    plan: {
      ...correct.plan,
      dimensions: { width: 16, depth: 16, height: correct.plan.dimensions.height },
      primitives: [
        { shape: "box", phase: "foundation", blockId: "minecraft:blue_concrete", from: [0, 0, 0], to: [15, 0, 0] },
        { shape: "box", phase: "foundation", blockId: "minecraft:blue_concrete", from: [0, 0, 15], to: [15, 0, 15] },
        { shape: "box", phase: "foundation", blockId: "minecraft:blue_concrete", from: [0, 0, 0], to: [0, 0, 15] },
        { shape: "box", phase: "foundation", blockId: "minecraft:blue_concrete", from: [15, 0, 0], to: [15, 0, 15] },
      ],
    },
  };
  const sessions = createMemorySessionStore();
  await sessions.set(player, "wizard", history);
  const requests = [];
  const wizard = createWizard({
    corpus: { search: () => [] }, sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "I’m adding the moat now.", action: wrong,
      }) } }] }), { status: 200 });
    },
  });

  const result = await wizard.ask({ player, question: "add a moat" });
  assert.equal(requests.length, 0);
  assert.deepEqual(result.action.plan.dimensions, correct.plan.dimensions);
  assert.equal(result.action.plan.primitives.filter(({ blockId }) => blockId === "minecraft:blue_concrete").length, 4);
});

test("open-ended wording cannot bypass explicit size, material, or population", async () => {
  const tiny = classifyAction("Build me a castle");
  let calls = 0;
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "Surprise! I’m building it now.", action: tiny,
      }) } }] }), { status: 200 });
    },
  });

  const result = await wizard.ask({
    player: "SurpriseContractKid",
    question: "build me a 20x20 castle out of gold with four villagers; surprise me",
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.action.plan.dimensions, { width: 20, depth: 20, height: 9 });
  assert.equal(result.action.plan.materials.primary, "minecraft:gold_block");
  assert.equal(result.action.plan.entities.length, 4);
});

test("applies common material refinements locally instead of stopping", () => {
  const house = classifyAction("Build me a 9x9x5 house");
  const history = [{
    question: "Build me a 9x9x5 house",
    answer: "The house is complete.",
    action: house,
    status: "completed",
  }];
  const bricks = classifyAction("make it out of bricks", history);
  const deepslate = classifyAction("replace the wood with deepslate", history);
  const concrete = classifyAction("make it out of red concrete", history);
  const glassRoof = classifyAction("add a glass roof", history);
  const oakRoof = classifyAction("replace the roof with oak", history);
  const brickRoof = classifyAction("replace the roof with bricks", history);

  for (const action of [bricks, deepslate, concrete, glassRoof, oakRoof, brickRoof]) {
    assert.equal(action?.type, "build_structure");
    assert.equal(action.plan.mode, "modify");
  }
  assert.equal(bricks.plan.materials.primary, "minecraft:brick_block");
  assert.equal(deepslate.plan.materials.primary, "minecraft:deepslate_bricks");
  assert.equal(concrete.plan.materials.primary, "minecraft:red_concrete");
  assert.equal(glassRoof.plan.materials.primary, house.plan.materials.primary);
  assert.equal(glassRoof.plan.materials.roof, "minecraft:glass");
  assert.equal(oakRoof.plan.materials.roof, "minecraft:oak_planks");
  assert.equal(brickRoof.plan.materials.roof, "minecraft:brick_block");

  const dragon = classifyAction("Make it bigger", [
    { question: "Build me a 13x9x7 dragon", answer: "The dragon is complete." },
  ]);
  const glassDragon = classifyAction("make the dragon out of glass", [{
    question: "Build me a dragon",
    answer: "The dragon is complete.",
    action: dragon,
    status: "completed",
  }]);
  assert.equal(glassDragon.plan.materials.primary, "minecraft:glass");
  assert.ok(glassDragon.plan.primitives.some(({ blockId }) => blockId === "minecraft:glass"));
  assert.equal(glassDragon.plan.primitives.some(({ blockId }) => [
    "minecraft:green_concrete", "minecraft:dark_prismarine", "minecraft:orange_concrete",
  ].includes(blockId)), false);
});

test("uses Bedrock's verified last structure after conversation history is gone", async () => {
  const offlineWizard = createWizard({ corpus: { search: () => [] }, env: {} });
  const result = await offlineWizard.ask({
    player: "ReturningKid",
    question: "make it bigger",
    context: {
      dimension: "minecraft:overworld",
      weather: "clear",
      timeOfDay: 6_000,
      player: { x: 10, y: 64, z: 10 },
      buildState: "idle",
      nearbyBlocks: [],
      nearbyEntities: [],
      lastStructure: {
        kind: "castle",
        title: "12x12 castle",
        dimensions: { width: 12, depth: 12, height: 9 },
        materials: {
          primary: "minecraft:brick_block",
          accent: "minecraft:stone_bricks",
          roof: "minecraft:deepslate_bricks",
        },
        features: ["floor", "walls", "door", "roof", "towers"],
        relativeOrigin: { x: 4, y: 0, z: 6 },
      },
    },
  });

  assert.equal(result.action.type, "build_structure");
  assert.equal(result.action.plan.mode, "modify");
  assert.equal(result.action.plan.kind, "castle");
  assert.deepEqual(result.action.plan.dimensions, { width: 16, depth: 16, height: 11 });
  assert.equal(result.action.plan.materials.primary, "minecraft:brick_block");
});

test("resizes Bedrock's observed authored primitives instead of replacing their design", async () => {
  const offlineWizard = createWizard({ corpus: { search: () => [] }, env: {} });
  const primitives = [
    { shape: "line", phase: "foundation", blockId: "minecraft:stone_bricks", from: [0, 0, 3], to: [11, 0, 3] },
    { shape: "box", phase: "shell", blockId: "minecraft:green_concrete", from: [1, 1, 0], to: [10, 6, 7] },
    { shape: "line", phase: "roof", blockId: "minecraft:gold_block", from: [5, 7, 3], to: [5, 9, 3] },
    { shape: "box", phase: "details", blockId: "minecraft:white_concrete", from: [11, 1, 7], to: [11, 1, 7] },
  ];
  const result = await offlineWizard.ask({
    player: "ObservedDragonKid",
    question: "make it bigger",
    context: {
      lastStructure: {
        kind: "dragon statue",
        title: "Authored dragon statue",
        dimensions: { width: 12, depth: 8, height: 10 },
        materials: {
          primary: "minecraft:green_concrete",
          accent: "minecraft:stone_bricks",
          roof: "minecraft:gold_block",
        },
        features: ["supports", "lighting", "decorations"],
        primitives,
      },
    },
  });

  assert.equal(result.action.type, "build_structure");
  assert.equal(result.action.plan.mode, "modify");
  assert.deepEqual(result.action.plan.dimensions, { width: 16, depth: 12, height: 12 });
  assert.equal(result.action.plan.primitives.length, primitives.length);
  assert.deepEqual(result.action.plan.primitives[0].from, [0, 0, 5]);
  assert.deepEqual(result.action.plan.primitives[0].to, [15, 0, 5]);
  assert.ok(result.action.plan.primitives.some(({ blockId }) => blockId === "minecraft:gold_block"));
});

test("keeps representational follow-up edits on bounded primitives", () => {
  const dragon = classifyAction("Make it bigger", [
    { question: "Build me a 13x9x7 dragon", answer: "The dragon is complete." },
  ]);
  const treehouse = classifyAction("add a balcony to the treehouse", [
    { question: "Build me a 15x11x10 treehouse", answer: "The treehouse is complete." },
  ]);
  for (const action of [dragon, treehouse]) {
    const plan = validateBuildStructurePlan(action.plan);
    assert.equal(plan.mode, "modify");
    assert.ok(plan.primitives.length >= 8);
    assert.ok(new Set(plan.primitives.map(({ phase }) => phase)).size >= 4);
  }
  assert.equal(dragon.plan.kind, "dragon");
  assert.deepEqual(dragon.plan.dimensions, { width: 17, depth: 13, height: 9 });
  assert.equal(treehouse.plan.kind, "treehouse");
});

test("decorates an exact offline tower in place instead of building a second tower", async () => {
  const offlineWizard = createWizard({ corpus: { search: () => [] }, env: {} });
  const tower = await offlineWizard.ask({
    player: "TowerKid",
    question: "build a 7x7 tower around me where i'm in the center. make it tapered and 20 blocks tall at its peak",
  });
  const decorated = await offlineWizard.ask({
    player: "TowerKid",
    question: "wow that was great. can you decorate it with some more things on the inside and outside?",
  });

  assert.equal(decorated.action.type, "build_structure");
  assert.equal(decorated.action.plan.mode, "modify");
  assert.equal(decorated.action.plan.kind, "tower");
  assert.deepEqual(decorated.action.plan.dimensions, tower.action.plan.dimensions);
  assert.ok(decorated.action.plan.features.includes("decorations"));
  assert.match(decorated.answer, /existing tower in place/i);
});

test("routes an unrepresented edit to bounded provider primitives", async () => {
  let providerCalls = 0;
  const editWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async (_url, options) => {
      providerCalls += 1;
      const providerInput = JSON.parse(options.body).messages[1].content;
      if (!/Question about Minecraft Bedrock stable:\nadd a flag\b/i.test(providerInput)) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          answer: "I’ll use my complete local structure plan for this step.",
          action: null,
        }) } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "I’ll add a gold flag to the existing house.",
        action: {
          type: "build_structure", version: 1, plan: {
            title: "House Flag", kind: "house", mode: "modify",
            dimensions: { width: 9, depth: 9, height: 5 },
            materials: { primary: "minecraft:oak_planks", accent: "minecraft:oak_log", roof: "minecraft:spruce_planks" },
            features: ["floor", "walls", "door", "windows", "roof", "lighting"],
            phases: ["foundation", "shell", "roof", "details"],
            primitives: [{
              shape: "line", phase: "details", blockId: "minecraft:gold_block",
              from: [4, 3, 4], to: [4, 4, 4],
            }],
          },
        },
      }) } }] }), { status: 200 });
    },
  });
  await editWizard.ask({ player: "FlagKid", question: "Build me a house" });
  const balcony = await editWizard.ask({ player: "FlagKid", question: "add a balcony" });
  const result = await editWizard.ask({ player: "FlagKid", question: "add a flag" });
  assert.equal(providerCalls, 1);
  assert.equal(result.action.plan.mode, "modify");
  assert.ok(result.action.plan.primitives.length > balcony.action.plan.primitives.length);
  assert.ok(result.action.plan.primitives.some(({ blockId }) => blockId === "minecraft:gold_block"));
  assert.ok(result.action.plan.primitives.some(({ blockId }) => blockId === "minecraft:oak_log"));
  assert.equal(result.mode, "chat:model");
});

test("rejects a provider edit that leaves the prior structure unchanged", async () => {
  const unchangedWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      answer: "I’ll add that flag now.",
      action: {
        type: "build_structure", version: 1, plan: {
          title: "Same House", kind: "house", mode: "modify",
          dimensions: { width: 9, depth: 9, height: 5 },
          materials: { primary: "minecraft:oak_planks", accent: "minecraft:oak_log", roof: "minecraft:spruce_planks" },
          features: ["floor", "walls", "door", "windows", "roof", "lighting"],
          phases: ["foundation", "shell", "roof", "details"],
        },
      },
    }) } }] }), { status: 200 }),
  });
  await unchangedWizard.ask({ player: "SameKid", question: "Build me a house" });
  const result = await unchangedWizard.ask({ player: "SameKid", question: "add a flag" });
  assert.equal(result.action, null);
  assert.doesNotMatch(result.answer, /i(?:’|')ll add|i will add/i);
});

test("requires real primitive changes before promising representational feature edits", async () => {
  const seedWizard = createWizard({ corpus: { search: () => [] }, env: {} });
  const seed = await seedWizard.ask({ player: "SeedDragonKid", question: "Build me a 13x9x7 dragon" });
  const seedTurn = {
    question: "Build me a 13x9x7 dragon",
    answer: "The dragon is complete.",
    action: seed.action,
    status: "completed",
  };
  const responsePlan = {
    title: "Dragon Rooms",
    kind: "dragon",
    mode: "modify",
    dimensions: { width: 13, depth: 9, height: 7 },
    materials: seed.action.plan.materials,
    features: [...seed.action.plan.features, "rooms"],
    phases: ["foundation", "shell", "roof", "details"],
  };
  const modelResponse = (plan) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    answer: "I’ll add rooms inside the dragon now.",
    action: { type: "build_structure", version: 1, plan },
  }) } }] }), { status: 200 });

  const noOpSessions = createMemorySessionStore();
  await noOpSessions.set("NoOpDragonKid", "wizard", [seedTurn]);
  const noOpWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    sessions: noOpSessions,
    fetchImpl: async () => modelResponse(responsePlan),
  });
  const noOp = await noOpWizard.ask({ player: "NoOpDragonKid", question: "add rooms inside the dragon" });
  assert.equal(noOp.action, null);
  assert.doesNotMatch(noOp.answer, /i(?:’|')ll add|i will add/i);

  const changedSessions = createMemorySessionStore();
  await changedSessions.set("ChangedDragonKid", "wizard", [seedTurn]);
  const changedWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    sessions: changedSessions,
    fetchImpl: async () => modelResponse({
      ...responsePlan,
      primitives: [{
        shape: "box", phase: "details", blockId: "minecraft:air",
        from: [5, 3, 3], to: [6, 4, 4],
      }],
    }),
  });
  const changed = await changedWizard.ask({ player: "ChangedDragonKid", question: "add rooms inside the dragon" });
  assert.equal(changed.action.type, "build_structure");
  assert.ok(changed.action.plan.primitives.length > seed.action.plan.primitives.length);
  assert.ok(changed.action.plan.primitives.some(({ blockId }) => blockId === "minecraft:air"));
});

test("keeps wool-farm corrections and confirmations on the tested automatic blueprint", async () => {
  const woolWizard = createWizard({ corpus: { search: () => [] }, env: {} });
  const questions = [
    "make me a automatic wool farm using sheep",
    "no i need a farm that makes wool. so like it would have sheep who eat grass and grow wool and automatically it would shear the sheep sometimes and pickup the wool automatically.",
  ];
  for (const question of questions) {
    const result = await woolWizard.ask({ player: "WoolKid", question });
    assert.deepEqual(result.action, {
      type: "place_blueprint", id: "automatic_wool_farm", version: 1,
    }, question);
  }
  let pending = [{
    question: "you should be able to use a dispensor with shears and collect the wool automatically",
    answer: "I'll build the complete automatic sheep wool farm beside your tower.",
    action: null,
  }];
  for (const confirmation of ["ok, go do it", "go do it", "sure, do it"]) {
    assert.deepEqual(classifyAction(confirmation, pending), {
      type: "place_blueprint", id: "automatic_wool_farm", version: 1,
    }, confirmation);
  }
  const resumeWizard = createWizard({
    corpus: { search: () => [] },
    env: {},
    sessions: {
      get: () => pending,
      set: async (_player, _mode, turns) => { pending = turns; },
      delete: async () => {},
    },
  });
  const resumed = await resumeWizard.ask({ player: "WoolKid", question: "ok do it" });
  assert.deepEqual(resumed.action, {
    type: "place_blueprint", id: "automatic_wool_farm", version: 1,
  });
});

test("does not revive an old wool build for a standalone dispenser question", () => {
  const history = [{
    question: "make me an automatic wool farm using sheep",
    answer: "The automatic wool farm is complete.",
    action: { type: "place_blueprint", id: "automatic_wool_farm", version: 1 },
  }];
  assert.equal(classifyAction("How does a dispenser work?", history), null);
  assert.equal(classifyAction("Can a dispenser shoot arrows?", history), null);
});

test("does not return a provider's false promise or a generic structure for an unsupported machine", async () => {
  const promiseWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      answer: "I’ll build the automatic glow berry farm now.",
      action: null,
    }) } }] }), { status: 200 }),
  });

  const result = await promiseWizard.ask({ player: "BerryKid", question: "Build me an automatic glow berry farm" });
  assert.notEqual(result.action?.type, "build_structure");
  assert.doesNotMatch(result.answer, /i(?:’|')ll build|i will build|i(?:’|')m building/i);

  const conversation = await promiseWizard.ask({
    player: "ChatKid",
    question: "Tell me something fun about glow berries",
  });
  assert.equal(conversation.action, null);
  assert.doesNotMatch(conversation.answer, /i(?:’|')ll build|i will build|i(?:’|')m building/i);
});

test("rejects every provider world-action promise while allowing explanation verbs", async () => {
  const futureVerbs = [
    "construct", "set up", "put", "give", "bring", "hand", "summon", "cast", "drop", "throw",
    "demonstrate", "show", "rebuild", "expand", "enlarge", "upgrade", "improve", "finish", "fix",
    "repair", "furnish", "wire", "assemble", "install", "craft", "complete", "modify", "update",
  ];
  const activeVerbs = [
    "constructing", "setting up", "putting", "giving", "bringing", "handing", "summoning", "casting",
    "dropping", "throwing", "demonstrating", "showing", "rebuilding", "expanding", "enlarging",
    "upgrading", "improving", "finishing", "fixing", "repairing", "furnishing", "wiring", "assembling",
    "installing", "crafting", "completing", "modifying", "updating",
  ];
  const promises = [
    ...futureVerbs.map((verb) => `I’ll ${verb} something in the world now.`),
    ...activeVerbs.map((verb) => `I’m ${verb} something in the world now.`),
    "I’ll explain how hoppers work.",
    "I’ll describe why comparators are useful.",
  ];
  let answerIndex = 0;
  const promiseWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      answer: promises[answerIndex++], action: null,
    }) } }] }), { status: 200 }),
  });

  for (let index = 0; index < futureVerbs.length + activeVerbs.length; index += 1) {
    const result = await promiseWizard.ask({
      player: `PromiseKid${index}`,
      question: `Tell me one fun fact about stone number ${index}`,
    });
    assert.equal(result.action, null);
    assert.notEqual(result.answer, promises[index], promises[index]);
  }
  for (const expected of promises.slice(-2)) {
    const result = await promiseWizard.ask({
      player: `ExplanationKid${answerIndex}`,
      question: "Tell me about a redstone component",
    });
    assert.equal(result.action, null);
    assert.equal(result.answer, expected);
  }
});

test("preserves a requested 7x7 house without waiting for model planning", async () => {
  let providerCalled = false;
  const fallbackWizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "slow", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => {
      providerCalled = true;
      throw new Error("model unavailable");
    },
  });
  const result = await fallbackWizard.ask({ player: "Kid", question: "Build me a 7x7 house" });
  assert.equal(providerCalled, false);
  assert.equal(result.mode, "local-skill");
  assert.equal(result.action.type, "build_structure");
  assert.deepEqual(result.action.plan.dimensions, { width: 7, depth: 7, height: 5 });
  assert.deepEqual(result.action.plan.phases, ["foundation", "shell", "roof", "details"]);
  assert.doesNotMatch(result.answer, /prototype|pad|miniature/i);
  assert.throws(() => validateBuildStructurePlan({ ...result.action.plan, phases: ["foundation"] }), /phases must be/);
});

test("replaces a mismatched provider structure with a complete local shape", async () => {
  const mismatchWizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      answer: "I’ll build a house.",
      action: {
        type: "build_structure", version: 1, plan: {
          title: "House", kind: "house", dimensions: { width: 9, depth: 9, height: 5 },
          materials: { primary: "minecraft:oak_planks", accent: "minecraft:oak_log", roof: "minecraft:spruce_planks" },
          features: ["floor", "walls", "door", "roof"], phases: ["foundation", "shell", "roof", "details"],
        },
      },
    }) } }] }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const result = await mismatchWizard.ask({ player: "Kid", question: "Build a magical maze" });
  assert.equal(result.mode, "local-structure-fallback");
  assert.equal(result.action.type, "build_structure");
  assert.equal(result.action.plan.kind, "magical maze");
  assert.deepEqual(result.action.plan.dimensions, { width: 13, depth: 13, height: 4 });
  assert.ok(result.action.plan.primitives.length > 4);
  assert.doesNotMatch(result.answer, /ask me once more|boring box|prototype|pad/i);
});

test("builds an exact recognizable dragon when the provider is offline", async () => {
  const offlineWizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "offline", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => { throw new Error("offline"); },
  });
  const result = await offlineWizard.ask({ player: "DragonKid", question: "Build me a 13x9x7 dragon" });
  const plan = validateBuildStructurePlan(result.action.plan);
  assert.equal(result.mode, "local-structure-fallback");
  assert.equal(result.action.type, "build_structure");
  assert.equal(plan.kind, "dragon");
  assert.deepEqual(plan.dimensions, { width: 13, depth: 9, height: 7 });
  assert.ok(plan.primitives.length >= 8);
  assert.deepEqual(new Set(plan.primitives.map(({ phase }) => phase)), new Set(["foundation", "shell", "roof", "details"]));
  assert.equal(plan.primitives.some(({ phase, from, to }) => phase === "foundation"
    && from[0] === 0 && to[0] === 12 && from[2] === 0 && to[2] === 8), false);
  assert.doesNotMatch(result.answer, /prototype|pad|try again|give up/i);
});

test("uses a known safe fallback and makes honest typed progress on an unknown noun", async () => {
  const invalidWizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "invalid", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ answer: "I will build it.", action: { type: "made_up" } }) } }],
    }), { status: 200 }),
  });
  const treehouse = await invalidWizard.ask({ player: "TreeKid", question: "Build a 15x11x10 treehouse" });
  const sculpture = await invalidWizard.ask({ player: "DuckKid", question: "Build me an 11x7x6 giant rubber duck" });
  assert.deepEqual(validateBuildStructurePlan(treehouse.action.plan).dimensions, { width: 15, depth: 11, height: 10 });
  assert.equal(treehouse.action.plan.kind, "treehouse");
  assert.ok(treehouse.action.plan.primitives.length >= 8);
  assert.equal(sculpture.action.type, "build_structure");
  assert.match(sculpture.action.plan.title, /^First pass giant rubber duck/);
  assert.deepEqual(sculpture.action.plan.dimensions, { width: 11, depth: 7, height: 6 });
  assert.equal(sculpture.action.plan.materials.primary, "minecraft:yellow_concrete");
  assert.ok(sculpture.action.plan.primitives.every(({ from, to }) => (
    from[1] === 0 || (from[0] === to[0] && from[2] === to[2])
  )));
  assert.equal(sculpture.goal.status, "active");
  assert.equal(sculpture.mode, "local-build-progress");
  assert.match(sculpture.answer, /first-pass corner and size guide.*not the finished shape/i);
  assert.doesNotMatch(sculpture.answer, /complete giant rubber duck|\bbuilt\b|(?:is|looks) finished/i);
  assert.doesNotMatch(`${treehouse.answer} ${sculpture.answer}`, /ask me once more|pad|give up/i);
});

test("advances a completed unknown-build layout to a full reviewed structure on the same goal", async () => {
  const sessions = createMemorySessionStore();
  let providerCalls = 0;
  const fullPlan = {
    title: "Giant Rubber Duck", kind: "giant rubber duck",
    dimensions: { width: 11, depth: 7, height: 6 },
    materials: { primary: "minecraft:yellow_concrete", accent: "minecraft:orange_concrete", roof: "minecraft:yellow_concrete" },
    features: ["supports"], phases: ["foundation", "shell", "roof", "details"],
    primitives: [
      { shape: "line", phase: "foundation", blockId: "minecraft:orange_concrete", from: [0, 0, 3], to: [10, 0, 3] },
      { shape: "box", phase: "shell", blockId: "minecraft:yellow_concrete", from: [1, 1, 0], to: [9, 3, 4] },
      { shape: "box", phase: "shell", blockId: "minecraft:yellow_concrete", from: [0, 2, 1], to: [10, 3, 3] },
      { shape: "box", phase: "roof", blockId: "minecraft:yellow_concrete", from: [3, 4, 3], to: [7, 5, 6] },
      { shape: "box", phase: "details", blockId: "minecraft:orange_concrete", from: [4, 4, 6], to: [6, 4, 6] },
    ],
  };
  const wizard = createWizard({
    corpus: { search: () => [] }, sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => {
      providerCalls += 1;
      const response = providerCalls <= 2
        ? { answer: "I will build it.", action: { type: "made_up", version: 1 } }
        : {
            answer: "The layout is marked. Now I’ll build the complete duck body, wings, head, and beak.",
            goal: { objective: "Build an 11x7x6 giant rubber duck", successCriteria: "The full duck shape is visible nearby", status: "active" },
            action: { type: "build_structure", version: 1, plan: fullPlan },
          };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }), { status: 200 });
    },
  });
  const progress = await wizard.ask({ player: "DuckGoalKid", question: "Build me an 11x7x6 giant rubber duck" });
  assert.equal(progress.action.type, "build_structure");
  assert.match(progress.action.plan.title, /^First pass\b/);
  const firstTurn = sessions.get("DuckGoalKid", "wizard").at(-1);
  const outcome = await wizard.recordActionResult({
    player: "DuckGoalKid", requestId: progress.requestId, status: "completed", detail: "layout placed",
    context: {
      dimension: "minecraft:overworld", weather: "clear", timeOfDay: 1000,
      player: { x: 0, y: 70, z: 0 }, buildState: "idle",
    },
  });
  assert.equal(providerCalls, 3);
  assert.equal(outcome.replan.action.type, "build_structure");
  assert.equal(outcome.replan.action.plan.mode, "modify");
  assert.equal(outcome.replan.action.plan.kind, "giant rubber duck");
  assert.equal(outcome.replan.goal.status, "active");
  const reviewTurn = sessions.get("DuckGoalKid", "wizard").at(-1);
  assert.equal(reviewTurn.goalId, firstTurn.goalId);
});

test("routes an automated chicken farm to its complete tested blueprint", async () => {
  const action = classifyAction("Build me an automated chicken farm");
  assert.deepEqual(action, { type: "place_blueprint", id: "automated_chicken_farm", version: 1 });
  assert.deepEqual(classifyAction("I need an automatic chicken farm"), action);
  const result = await wizard.ask({ player: "FarmerKid", question: "Build me an automated chicken farm" });
  assert.equal(result.action.id, "automated_chicken_farm");
  assert.match(result.answer, /chickens.*hopper.*egg.*chest/i);
  assert.doesNotMatch(result.answer, /cooker|breeder/i);
});

test("routes verified recipes to displays and never substitutes a generic structure", async () => {
  assert.deepEqual(classifyAction("Show me how to craft a redstone lamp"), {
    type: "show_recipe", version: 1, itemId: "minecraft:redstone_lamp",
  });
  const lamp = await wizard.ask({ player: "LampKid", question: "Show me how to craft a redstone lamp" });
  assert.equal(lamp.action.type, "show_recipe");
  assert.equal(lamp.action.itemId, "minecraft:redstone_lamp");
  assert.match(lamp.answer, /giant crafting grid.*real ingredients/i);

  const offlineUnknown = await wizard.ask({ player: "OfflineCompassKid", question: "Show me how to craft a recovery compass" });
  assert.equal(offlineUnknown.action, null);
  assert.match(offlineUnknown.answer, /verified giant-grid spellbook.*won’t build the wrong thing/i);

  const confusedWizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      answer: "I’ll build a generic structure instead.",
      action: {
        type: "build_structure", version: 1, plan: {
          title: "Wrong Structure", kind: "house", dimensions: { width: 9, depth: 9, height: 5 },
          materials: { primary: "minecraft:oak_planks", accent: "minecraft:oak_log", roof: "minecraft:spruce_planks" },
          features: ["floor", "walls", "door", "roof"], phases: ["foundation", "shell", "roof", "details"],
        },
      },
    }) } }] }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const unknown = await confusedWizard.ask({ player: "CompassKid", question: "Show me how to craft a recovery compass" });
  assert.equal(unknown.action, null);
  assert.equal(unknown.mode, "local-recipe-fallback");
  assert.match(unknown.answer, /verified giant-grid spellbook.*won’t build the wrong thing/i);
  assert.doesNotMatch(unknown.answer, /generic structure|9 by 9|block-sculpture/i);
  assert.match(e2eScript, /"wizard, show me how to craft a hopper"/);
});

test("routes common redstone machines to complete nearby blueprints", async () => {
  assert.deepEqual(classifyAction("Build me a 2x2 piston door"), {
    type: "place_blueprint", id: "two_by_two_piston_door", version: 1,
  });
  assert.deepEqual(classifyAction("Make an item sorter for diamonds"), {
    type: "place_blueprint", id: "item_sorter", version: 1, filterItem: "minecraft:diamond",
  });
  assert.deepEqual(classifyAction("Build an automatic smelter"), {
    type: "place_blueprint", id: "automatic_smelter", version: 1,
  });

  const door = await wizard.ask({ player: "MachineKid", question: "Build me a 2x2 piston door" });
  const sorter = await wizard.ask({ player: "MachineKid", question: "Make an item sorter for diamonds" });
  const smelter = await wizard.ask({ player: "MachineKid", question: "Build an automatic smelter" });
  assert.equal(door.action.id, "two_by_two_piston_door");
  assert.equal(sorter.action.filterItem, "minecraft:diamond");
  assert.equal(smelter.action.id, "automatic_smelter");
  assert.match(door.answer, /four sticky pistons.*test/i);
  assert.match(sorter.answer, /diamond.*own chest.*overflow chest/i);
  assert.match(smelter.answer, /input|things to smelt/i);
  assert.doesNotMatch(`${door.answer} ${sorter.answer} ${smelter.answer}`, /\/(?:fill|setblock|give)\b/i);

  assert.match(packScript, /createTwoByTwoPistonDoorBlueprint/);
  assert.match(packScript, /createItemSorterBlueprint\(action\.filterItem\)/);
  assert.match(packScript, /createAutomaticSmelterBlueprint/);
  assert.match(packScript, /loadContainerSlotAsWizard/);
});

test("turns natural world and inventory requests into typed actions, not commands", async () => {
  assert.deepEqual(classifyAction("Make it daytime and make it rain"), {
    type: "world_control", version: 1, time: "day", weather: "rain",
  });
  assert.deepEqual(classifyAction("I hate thunder; please make it clear"), {
    type: "world_control", version: 1, weather: "clear",
  });
  assert.deepEqual(classifyAction("It is raining; make it sunny"), {
    type: "world_control", version: 1, weather: "clear",
  });
  assert.deepEqual(classifyAction("Give me a set of iron tools"), {
    type: "give_items",
    version: 1,
    items: ["sword", "pickaxe", "axe", "shovel", "hoe"].map((tool) => ({ itemId: `minecraft:iron_${tool}`, amount: 1 })),
  });
  const worldResult = await wizard.ask({ player: "Kid", question: "Make it daytime and make it rain" });
  const toolsResult = await wizard.ask({ player: "Kid", question: "Give me a set of iron tools" });
  assert.equal(worldResult.action.type, "world_control");
  assert.equal(toolsResult.action.type, "give_items");
  assert.doesNotMatch(`${worldResult.answer} ${toolsResult.answer}`, /\/(?:time|weather|give)\b/i);
});

test("requires provider gifts to match the child's requested quantity", async () => {
  const responses = [
    { answer: "I’ll give you two ladders.", action: {
      type: "give_items", version: 1, items: [{ itemId: "minecraft:ladder", amount: 2 }],
    } },
    { answer: "I’ll give you sixteen ladders.", action: {
      type: "give_items", version: 1, items: [{ itemId: "minecraft:ladder", amount: 1 }],
    } },
    { answer: "I’ll give you twenty ladders.", action: {
      type: "give_items", version: 1, items: [{ itemId: "minecraft:ladder", amount: 20 }],
    } },
  ];
  const giftWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responses.shift()) } }] }), { status: 200 }),
  });
  const exact = await giftWizard.ask({ player: "TwoLaddersKid", question: "Give me two ladders" });
  assert.deepEqual(exact.action, {
    type: "give_items", version: 1, items: [{ itemId: "minecraft:ladder", amount: 2 }],
  });
  const short = await giftWizard.ask({ player: "LadderStackKid", question: "Give me 16 ladders" });
  assert.deepEqual(short.action, {
    type: "give_items", version: 1, items: [{ itemId: "minecraft:ladder", amount: 16 }],
  });
  assert.equal(short.goal?.status, "active");
  assert.equal(short.mode, "local-action-repair");
  assert.match(short.answer, /16x ladder.*to you/i);
  assert.doesNotMatch(short.answer, /keeping this project active/i);
  const extra = await giftWizard.ask({ player: "OverfullLadderKid", question: "Give me 16 ladders" });
  assert.deepEqual(extra.action, {
    type: "give_items", version: 1, items: [{ itemId: "minecraft:ladder", amount: 16 }],
  });
  assert.equal(extra.goal?.status, "active");
  assert.equal(extra.mode, "local-action-repair");
  assert.match(extra.answer, /16x ladder.*to you/i);
});

test("accepts a rich large delivery to an exact named connected player", async () => {
  const action = {
    type: "give_items", version: 1, recipient: "enti1ty303",
    items: [{
      itemId: "minecraft:diamond_sword", amount: 256, nameTag: "Star Cutter",
      enchantments: [{ id: "minecraft:sharpness", level: 5 }],
    }],
  };
  const wizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      answer: "I’ll carry 256 enchanted Star Cutters to enti1ty303.", action, goal: {
        objective: "Deliver the named enchanted swords",
        successCriteria: "enti1ty303 receives all 256 swords with the requested name and enchantment",
        status: "active",
      },
    }) } }] }), { status: 200 }),
  });
  const result = await wizard.ask({
    player: "alt3rname",
    question: "Give enti1ty303 256 enchanted diamond swords named Star Cutter",
  });
  assert.deepEqual(result.action, action);
  assert.match(result.answer, /enti1ty303/i);

  const punctuatedAction = {
    ...action,
    items: [{ ...action.items[0], nameTag: "Mr. Jones" }],
  };
  const punctuated = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      answer: "I’ll deliver Mr. Jones.", action: punctuatedAction,
      goal: { objective: "Deliver Mr. Jones", successCriteria: "The named sword reaches enti1ty303", status: "active" },
    }) } }] }), { status: 200 }),
  });
  assert.equal((await punctuated.ask({
    player: "alt3rname",
    question: "Give enti1ty303 256 enchanted diamond swords named \"Mr. Jones\"",
  })).action.items[0].nameTag, "Mr. Jones");
});

test("keeps the wrong gift rejected unless one bounded repair returns the requested item", async () => {
  const response = (itemId) => ({
    answer: `I’ll deliver ${itemId.replace("minecraft:", "")}.`,
    action: { type: "give_items", version: 1, items: [{ itemId, amount: 16 }] },
  });
  const makeWizard = (responses) => {
    let calls = 0;
    return {
      get calls() { return calls; },
      wizard: createWizard({
        corpus: { search: () => [] },
        env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify({ choices: [{ message: {
            content: JSON.stringify(responses.shift()),
          } }] }), { status: 200 });
        },
      }),
    };
  };

  const repaired = makeWizard([response("minecraft:diamond"), response("minecraft:ladder")]);
  const repairedResult = await repaired.wizard.ask({ player: "RepairGiftKid", question: "Give me 16 ladders" });
  assert.equal(repaired.calls, 2);
  assert.deepEqual(repairedResult.action, {
    type: "give_items", version: 1, items: [{ itemId: "minecraft:ladder", amount: 16 }],
  });
  assert.equal(repairedResult.goal?.status, "active");
  assert.match(repairedResult.answer, /16x ladder.*to you/i);

  const rejected = makeWizard([response("minecraft:diamond"), response("minecraft:diamond")]);
  const rejectedResult = await rejected.wizard.ask({ player: "WrongGiftKid", question: "Give me 16 ladders" });
  assert.equal(rejected.calls, 2);
  assert.equal(rejectedResult.action, null);
  assert.equal(rejectedResult.goal, undefined);
});

test("constructs exact safe gifts locally and never guesses unsafe item ids", async () => {
  const expected = [
    ["Give me 16 torches", { type: "give_items", version: 1, items: [{ itemId: "minecraft:torch", amount: 16 }] }],
    ["Give me torches", { type: "give_items", version: 1, items: [{ itemId: "minecraft:torch", amount: 1 }] }],
    ["Give me a diamond sword", { type: "give_items", version: 1, items: [{ itemId: "minecraft:diamond_sword", amount: 1 }] }],
    ["give me a portal blocl", { type: "give_items", version: 1, items: [
      { itemId: "minecraft:obsidian", amount: 10 },
      { itemId: "minecraft:flint_and_steel", amount: 1 },
    ] }],
    ["give me a nether portal item", { type: "give_items", version: 1, items: [
      { itemId: "minecraft:obsidian", amount: 10 },
      { itemId: "minecraft:flint_and_steel", amount: 1 },
    ] }],
  ];
  const offlineWizard = createWizard({ corpus: { search: () => [] }, env: {} });
  for (const [question, action] of expected) {
    assert.deepEqual(classifyAction(question), action);
    const result = await offlineWizard.ask({ player: `OfflineGift-${question}`, question });
    assert.deepEqual(result.action, action);
    assert.equal(result.goal?.status, "active");
    assert.equal(result.mode, "local-skill");
    assert.match(result.answer, /to you now/i);
  }

  let providerCalls = 0;
  const wrongProviderWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "I’ll give you diamonds instead.",
        action: { type: "give_items", version: 1, items: [{ itemId: "minecraft:diamond", amount: 64 }] },
      }) } }] }), { status: 200 });
    },
  });
  for (const [question, action] of expected) {
    const result = await wrongProviderWizard.ask({ player: `ProviderGift-${question}`, question });
    assert.deepEqual(result.action, action);
    assert.equal(result.goal?.status, "active");
  }
  assert.equal(providerCalls, 0);
  assert.equal(classifyAction("Give me TNT"), null);
  assert.equal(classifyAction("Give me a command block"), null);
});

test("supports large gifts and rejects negated or truly out-of-range quantities", async () => {
  for (const amount of [65, 999, 10_000]) {
    assert.deepEqual(classifyAction(`Give me ${amount} torches`), {
      type: "give_items", version: 1, items: [{ itemId: "minecraft:torch", amount }],
    });
  }
  const invalid = [
    "Give me no torches",
    "Give me 0 torches",
    "Give me 10001 torches",
    "Give me -1 torches",
  ];
  const offlineWizard = createWizard({ corpus: { search: () => [] }, env: {} });
  for (const question of invalid) {
    assert.equal(classifyAction(question), null, question);
    const result = await offlineWizard.ask({ player: `InvalidGift-${question}`, question });
    assert.equal(result.action, null, question);
    assert.equal(result.goal, undefined, question);
  }
});

test("validates bounded support-ordered custom plans and directional logs", () => {
  const plan = validateBuildPlan({
    title: "Tiny arch",
    blocks: [
      { target: [0, 0, 1], support: [0, -1, 1], itemId: "minecraft:oak_planks" },
      { target: [0, 1, 1], support: [0, 0, 1], itemId: "minecraft:oak_log" },
      { target: [1, 1, 1], support: [0, 1, 1], itemId: "minecraft:oak_log" },
    ],
  });
  assert.deepEqual(planBounds(plan), { min: [0, 0, 1], max: [1, 1, 1] });
  assert.deepEqual(expectedPlacementStates("minecraft:oak_log", [0, 0, 1], [0, 1, 1]), { pillar_axis: "y" });
  assert.deepEqual(expectedPlacementStates("minecraft:oak_log", [0, 1, 1], [1, 1, 1]), { pillar_axis: "x" });
  assert.throws(() => validateBuildPlan({
    blocks: [{ target: [0, 1, 1], support: [0, 0, 1], itemId: "minecraft:oak_planks" }],
  }), /earlier planned block/);
  assert.throws(() => validateBuildPlan({
    blocks: [{ target: [0, 0, 1], support: [0, -1, 1], itemId: "minecraft:tnt" }],
  }), /not allowed/);
  assert.throws(() => validateBuildPlan({
    blocks: [{ target: [9, 0, 1], support: [9, -1, 1], itemId: "minecraft:stone" }],
  }), /outside the build bounds/);
  assert.throws(() => validateBuildPlan({
    blocks: [
      { target: [0, 0, 1], support: [0, -1, 1], itemId: "minecraft:stone" },
      { target: [1, 0, 1], support: [0, 0, 1], itemId: "minecraft:redstone" },
    ],
  }), /requires support directly below/);
});

test("executes custom plans through player placement with journaled rollback and undo", () => {
  assert.match(packScript, /function buildValidatedPlan\(player, value\)/);
  assert.match(packScript, /validateBuildPlan\(value\)/);
  assert.match(packScript, /placeAsWizard\(/);
  assert.match(packScript, /expectedPlacementStates/);
  assert.match(packScript, /mcwizard:active_transaction/);
  assert.match(packScript, /world\.setDynamicProperty\(TRANSACTION_JOURNAL/);
  assert.match(packScript, /function rollbackTransaction/);
  assert.match(packScript, /function recoverInterruptedTransaction/);
  assert.match(packScript, /function undoLastBuild/);
  assert.match(packScript, /protected spawn area/);
  assert.doesNotMatch(packScript, /protected by a recent MC Wizard build/);
  assert.match(packScript, /action\?\.type === "build_plan"/);
  assert.doesNotMatch(packScript, /tryTeleport/);
});

test("returns a typed build action without waiting for retrieval", async () => {
  const result = await wizard.ask({ player: "BuilderKid", question: "Build a T flip flop for me" });
  assert.equal(result.mode, "local-skill");
  assert.equal(result.action.id, "copper_bulb_t_flip_flop");
  assert.match(result.answer, /copper bulb/i);
  assert.deepEqual(result.sources, []);
});

test("never dumps retrieved documentation when the model is unavailable", async () => {
  const commandWizard = createWizard({
    env: {},
    corpus: {
      search: () => [{
        title: "clone Command",
        text: "The /clone command copies blocks from a source region to a destination region.",
        source: "https://learn.microsoft.com/minecraft/clone",
        edition: "bedrock",
        channel: "stable",
        version: "current",
        score: 10,
      }],
    },
  });
  const result = await commandWizard.ask({ question: "How do I clone a building with command blocks?" });
  assert.doesNotMatch(result.answer, /\/clone command copies blocks/i);
  assert.doesNotMatch(result.answer, /notes|sources|documentation|corpus/i);
  assert.match(result.answer, /project active|concrete next move/i);
});

test("never relays a malformed provider fragment to a child", async () => {
  const fragments = ["{", "goal: null", "...", "null"];
  const malformedWizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ answer: fragments.shift(), goal: null, action: null }) } }],
    }), { status: 200 }),
  });
  for (let index = 0; index < 4; index += 1) {
    const result = await malformedWizard.ask({ player: `FragmentKid${index}`, question: "give me surgery" });
    assert.equal(result.mode, "offline-fallback");
  }
});

test("answers ordinary conversation instantly without invoking the provider", async () => {
  let providerCalled = false;
  const greetingWizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "slow", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalled = true;
      throw new Error("provider should not be called");
    },
  });
  const greeting = await greetingWizard.ask({ player: "BuilderKid", question: "hi wiz" });
  assert.match(greeting.answer, /right here/i);
  assert.equal(greeting.mode, "local-instant");
  assert.equal(providerCalled, false);
  assert.match(instantConversationAnswer("are you ready?"), /Ready!/);
  assert.match(instantConversationAnswer("what's up?"), /wand ready/i);
  assert.match(instantConversationAnswer("what do you think of the weather?"), /clear skies/i);
  assert.doesNotMatch(greeting.answer, /source|verified note/i);
});

test("uses live world state for small talk and ambient Wizard behavior", () => {
  assert.match(packScript, /function worldSmallTalk/);
  assert.match(packScript, /getWeather\(\)/);
  assert.match(packScript, /world\.getTimeOfDay\(\)/);
  assert.match(packScript, /day or night/);
  assert.match(packScript, /Minecraft time/);
  assert.match(packScript, /function idleLookAround/);
  assert.match(packScript, /minecraft:redstone_wire/);
});

test("cancels stale replies and keeps children updated while deeper work runs", () => {
  assert.match(packScript, /discarded stale/);
  assert.match(packScript, /pendingQuestions\.get\(key\) !== token/);
  assert.match(packScript, /\[80, acknowledgements/);
  assert.match(packScript, /Still working—I’m staying with it/);
  assert.doesNotMatch(packScript, /Let me think about that/);
  assert.match(packScript, /clearBackendSession/);
  assert.match(packScript, /HttpRequestMethod\.Delete/);
  assert.match(packScript, /payload\?\.mode === "planning-deferred"/);
  assert.match(packScript, /planningAttempt < 2/);
  assert.match(packScript, /trying another one now without making you repeat it/);
});

test("uses the OpenAI Responses adapter without giving the model build authority", async () => {
  let request;
  const modelWizard = createWizard({
    corpus,
    env: {
      AI_BASE_URL: "https://api.example/v1",
      AI_API_KEY: "test-key",
      AI_MODEL: "test-model",
      AI_STYLE: "responses",
      WIZARD_SALT: "test-salt",
    },
    logger: { warn() {} },
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ answer: "A model-backed answer.", action: null }) }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await modelWizard.ask({ player: "BuilderKid", question: "What powers redstone dust?" });
  assert.equal(request.url, "https://api.example/v1/responses");
  assert.equal(request.body.store, false);
  assert.equal(request.body.max_output_tokens, 260);
  assert.equal(request.body.model, "test-model");
  assert.match(request.body.instructions, /well-established, stable Minecraft gameplay facts/);
  assert.doesNotMatch(request.body.instructions, /Use only the supplied/);
  assert.equal(request.options.headers.authorization, "Bearer test-key");
  assert.doesNotMatch(request.body.input, /BuilderKid/);
  assert.equal(result.answer, "A model-backed answer.");
  assert.equal(result.action, null);
});

test("supports an OpenAI-compatible chat endpoint without an API key", async () => {
  let requestUrl;
  const modelWizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://local-model/v1", AI_MODEL: "local", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async (url) => {
      requestUrl = url;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: "Local model answer.", action: null }) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await modelWizard.ask({ question: "What is redstone?" });
  assert.equal(requestUrl, "http://local-model/v1/chat/completions");
  assert.equal(result.answer, "Local model answer.");
});

test("keeps the explicit AI route out of character and labels its provider", async () => {
  let request;
  const modelWizard = createWizard({
    corpus,
    env: {
      AI_BASE_URL: "http://127.0.0.1:8790/v1",
      AI_MODEL: "llama3.2:1b",
      AI_STYLE: "chat",
      AI_PROVIDER_LABEL: "Ollama",
    },
    logger: { warn() {} },
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: `I’ll answer clearly.${JSON.stringify({
        title: "Blue Sky",
        answer: "A normal answer with a complete final sentence.",
      })}` } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await modelWizard.ask({ player: "BuilderKid", question: "Why is the sky blue?", mode: "general" });
  assert.equal(request.url, "http://127.0.0.1:8790/v1/chat/completions");
  assert.match(request.body.messages[0].content, /Do not roleplay as MC Wizard/);
  assert.match(request.body.messages[0].content, /between 3 and 16 characters/);
  assert.match(request.body.messages[0].content, /finish the final sentence/);
  assert.doesNotMatch(request.body.messages[1].content, /Retrieved sources/);
  assert.equal(result.kind, "general");
  assert.equal(result.label, "Ollama");
  assert.equal(result.action, null);
  assert.deepEqual(result.sources, []);
  assert.equal(result.title, "Blue Sky");
  assert.equal(result.answer, "A normal answer with a complete final sentence.");
});

test("lets the model select only registered Wizard skills and carries session history", async () => {
  const requests = [];
  const agentWizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "claude", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async (url, options) => {
      requests.push(JSON.parse(options.body));
      const first = requests.length === 1;
      const content = first
        ? JSON.stringify({
            answer: "I’ll build the tiny contraption now.",
            action: { type: "build_plan", version: 1, plan: {
              title: "Tiny Contraption",
              blocks: [{ target: [0, 0, 2], support: [0, -1, 2], itemId: "minecraft:stone" }],
            } },
          })
        : JSON.stringify({
            answer: "I remember. We were talking about the contraption.",
            action: { type: "delete_world", id: "everything", version: 1 },
          });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const built = await agentWizard.ask({ player: "Kid", question: "build a tiny strange contraption" });
  const followup = await agentWizard.ask({ player: "Kid", question: "what were we doing?" });
  assert.equal(built.action.type, "build_plan");
  assert.equal(followup.action, null);
  assert.match(requests[0].messages[0].content, /build_two_bit_calculator/);
  assert.match(requests[1].messages[1].content, /I’ll build Tiny Contraption nearby/);
});

test("lets the model compose and retain a novel executable capability program", async () => {
  const requests = [];
  const program = {
    title: "Cake Horse Staircase",
    steps: [
      {
        id: "place_cakes",
        capability: "player.place-blocks",
        arguments: { blocks: [
          { itemId: "minecraft:cake", target: [0, 0, 2], support: [0, -1, 2], expectedType: "minecraft:cake", expectedStates: {} },
          { itemId: "minecraft:cake", target: [0, 1, 3], support: [0, 0, 3], expectedType: "minecraft:cake", expectedStates: {} },
        ] },
        expect: "A cake staircase exists nearby.",
        onFailure: "replan",
      },
      {
        id: "verify_cakes",
        capability: "verify.blocks",
        arguments: { blocks: [
          { target: [0, 0, 2], typeId: "minecraft:cake" },
          { target: [0, 1, 3], typeId: "minecraft:cake" },
        ] },
        expect: "Both cake blocks remain in place.",
        onFailure: "replan",
      },
      {
        id: "spawn_horse",
        capability: "script.spawn-entity",
        arguments: { typeId: "minecraft:horse", location: [2, 0, 1], count: 1 },
        expect: "A horse is available for testing.",
        onFailure: "replan",
      },
      {
        id: "verify_horse",
        capability: "verify.entities",
        arguments: { typeId: "minecraft:horse", location: [2, 0, 1], minimum: 1, maxDistance: 4 },
        expect: "The test horse remains nearby.",
        onFailure: "replan",
      },
    ],
  };
  const programWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async (url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "I’ll build the cake staircase, bring over a horse, and test the result.",
        goal: {
          objective: "Build a cake staircase for a horse",
          successCriteria: "The cake staircase exists and a horse can test it",
          status: "active",
        },
        action: { type: "execute_program", version: 1, program },
      }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await programWizard.ask({
    player: "HorseKid",
    question: "build a weird cake staircase that a horse can run up",
  });
  assert.equal(result.action.type, "execute_program");
  assert.deepEqual(result.action.program, program);
  assert.equal(result.goal.status, "active");
  assert.match(requests[0].messages[0].content, /Runtime capability manifest/);
  assert.match(requests[0].messages[0].content, /player\.place-blocks/);
});

test("binds model-authored furniture revisions to the existing project", async () => {
  const sessions = createMemorySessionStore();
  const blocks = Array.from({ length: 8 }, (_, index) => ({
    itemId: "minecraft:oak_planks",
    target: [index % 4, 1, Math.floor(index / 4)],
    support: [index % 4, 0, Math.floor(index / 4)],
    expectedType: "minecraft:oak_planks",
  }));
  let request;
  const wizard = createWizard({
    corpus: { search: () => [] }, sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async (url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "I’ll furnish the same mansion with couches and beds now.",
        goal: { objective: "Furnish the mansion", successCriteria: "Couches and beds are inside it", status: "active" },
        action: { type: "execute_program", version: 1, program: {
          title: "Mansion couches and beds",
          steps: [{
            id: "place_furniture", capability: "player.place-blocks", arguments: { blocks },
            expect: "Couches and beds are arranged inside the mansion.",
          }, {
            id: "verify_furniture", capability: "verify.blocks",
            arguments: { blocks: blocks.map(({ target, expectedType: typeId }) => ({ target, typeId })) },
            expect: "Every furniture block remains in place.",
          }],
        } },
      }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const mansion = await wizard.ask({ player: "FurnitureKid", question: "Build a mansion" });
  await sessions.updateAction("FurnitureKid", "wizard", {
    requestId: mansion.requestId, status: "completed", detail: "mansion verified",
  });
  const furnished = await wizard.ask({
    player: "FurnitureKid", question: "build couches and beds in my mansion",
  });
  assert.equal(furnished.action.type, "execute_program");
  assert.equal(furnished.action.program.site, "active_project");
  assert.equal(request.max_tokens, 3000);

  await sessions.updateAction("FurnitureKid", "wizard", {
    requestId: furnished.requestId, status: "completed", detail: "furniture verified",
  });
  const windowBlock = {
    itemId: "minecraft:glass_pane", target: [2, 2, 0], support: [2, 1, 0], expectedType: "minecraft:glass_pane",
  };
  const detailWizard = createWizard({
    corpus: { search: () => [] }, sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "planner", AI_STYLE: "chat" },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      answer: "I’ll add that one window to the mansion.",
      goal: { objective: "Add one window", successCriteria: "One glass pane is verified in the mansion", status: "active" },
      action: { type: "execute_program", version: 1, program: {
        title: "Mansion window",
        steps: [{
          id: "place_window", capability: "player.place-blocks", arguments: { blocks: [windowBlock] },
          expect: "One mansion window is in place.",
        }, {
          id: "verify_window", capability: "verify.blocks",
          arguments: { blocks: [{ target: windowBlock.target, typeId: windowBlock.expectedType }] },
          expect: "The mansion window remains in place.",
        }],
      } },
    }) } }] }), { status: 200 }),
  });
  const window = await detailWizard.ask({ player: "FurnitureKid", question: "add one window to my mansion" });
  assert.equal(window.action.type, "execute_program");
  assert.equal(window.action.program.site, "active_project");
  assert.equal(window.action.program.steps[0].arguments.blocks.length, 1);
});

test("keeps short child continuations and nearby playground requests actionable", async () => {
  const house = classifyAction("Build a house");
  const history = [{
    question: "Build a house", answer: "Done.", action: house, status: "completed",
    goal: { objective: "Build a house", successCriteria: "A house exists", status: "active" },
    requestId: "house", goalId: "house",
  }];
  const decorated = classifyAction("decorations!", history);
  assert.equal(decorated.type, "build_structure");
  assert.equal(decorated.plan.mode, "modify");
  assert.equal(classifyAction("build a playground next to the school", history), null);
  assert.equal(classifyAction("yes,", [...history, {
    question: "Want another detail?",
    answer: "I can place a chest nearby. Want that?",
  }]).type, "execute_program");
  const chest = classifyAction("place a chest here");
  assert.equal(chest.type, "execute_program");
  assert.equal(chest.program.steps[0].arguments.blocks[0].itemId, "minecraft:chest");
  assert.equal(classifyAction("Place a Crafting Table").program.steps[0].arguments.blocks[0].itemId, "minecraft:crafting_table");
});

test("tells the model whether prior actions are planned, active, completed, failed, or unknown", async () => {
  const sessions = createMemorySessionStore();
  const castle = classifyAction("Build me a castle");
  await sessions.set("StatusKid", "wizard", [
    ["pending", "plan-1"],
    ["started", "plan-2"],
    ["completed", "plan-3"],
    ["failed", "plan-4"],
    ["unknown", "plan-5"],
  ].map(([status, requestId]) => ({
    question: `Castle ${status}`,
    answer: `The castle is ${status}.`,
    action: castle,
    requestId,
    status,
    ...(status === "failed" && { detail: "site was obstructed" }),
  })));
  let request;
  const statusWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    sessions,
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: "A purple roof would look magical.", action: null,
      }) } }] }), { status: 200 });
    },
  });

  await statusWizard.ask({ player: "StatusKid", question: "What color should the workshop roof be?" });
  const dialogue = request.messages[1].content;
  assert.match(dialogue, /Planned action:/);
  assert.match(dialogue, /Active action:/);
  assert.match(dialogue, /Completed action:/);
  assert.match(dialogue, /Failed action:/);
  assert.match(dialogue, /Action outcome unknown:/);
  assert.match(dialogue, /Outcome detail: site was obstructed/);
  assert.doesNotMatch(dialogue, /Executed action/i);
});

test("suppresses a stale concurrent provider reply without losing the newer outcome", async () => {
  const sessions = createMemorySessionStore();
  let releaseFirst;
  let firstSeen;
  const firstStarted = new Promise((resolve) => { firstSeen = resolve; });
  const orderedWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    sessions,
    fetchImpl: async (_url, options) => {
      const input = JSON.parse(options.body).messages[1].content;
      const first = input.includes("scene alpha");
      if (first) {
        firstSeen();
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
      const content = JSON.stringify({
        answer: "A dramatic scene is ready.",
        action: { type: "command_lesson", id: "hello", version: 1 },
      });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    },
  });

  const firstPromise = orderedWizard.ask({
    player: "OrderKid", question: "Teach me a command-block lesson that says hello for scene alpha", requestId: "scene-a",
  });
  await firstStarted;
  const second = await orderedWizard.ask({
    player: "OrderKid", question: "Teach me a command-block lesson that says hello for scene beta", requestId: "scene-b",
  });
  assert.equal(second.action.id, "hello");
  await orderedWizard.recordActionResult({
    player: "OrderKid", requestId: "scene-b", status: "completed", detail: "clear applied",
  });
  releaseFirst();
  const first = await firstPromise;
  assert.equal(first.action, null);
  assert.equal(first.superseded, true);

  const turns = sessions.get("OrderKid", "wizard");
  assert.deepEqual(turns.map(({ question }) => question), [
    "Teach me a command-block lesson that says hello for scene beta",
  ]);
  assert.deepEqual(turns.map(({ requestSequence }) => requestSequence), [2]);
  assert.equal(turns.at(-1).requestId, "scene-b");
  assert.deepEqual(Object.fromEntries(turns.map(({ requestId, status }) => [requestId, status])), {
    "scene-b": "completed",
  });
});

test("bounds provider history while retaining full stored answers and action plans", async () => {
  const sessions = createMemorySessionStore();
  const longAnswer = `${"wizard detail ".repeat(1_000)}FULL-ANSWER-END`;
  const primitives = Array.from({ length: 100 }, (_, index) => ({
    shape: "box", blockId: `minecraft:primitive-marker-${index}`, from: [0, 0, 0], to: [1, 1, 1],
  }));
  const placements = Array.from({ length: 50 }, (_, index) => ({
    itemId: `minecraft:placement-marker-${index}`, target: [index, 0, 0],
  }));
  await sessions.set("BoundKid", "general", [{
    question: "Describe the enormous project",
    answer: longAnswer,
    requestId: "huge-1",
    status: "completed",
    action: {
      type: "build_structure",
      version: 1,
      plan: {
        title: "Enormous Castle",
        kind: "castle",
        mode: "modify",
        dimensions: { width: 64, depth: 64, height: 32 },
        materials: { primary: "minecraft:stone_bricks", accent: "minecraft:gold_block" },
        features: Array.from({ length: 40 }, (_, index) => `feature-${index}`),
        phases: ["foundation", "shell", "roof", "details"],
        primitives,
        placements,
      },
    },
  }]);
  let request;
  const boundedWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    sessions,
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "Project Recap", answer: "The project remains safely stored.",
      }) } }] }), { status: 200 });
    },
  });

  await boundedWizard.ask({ player: "BoundKid", mode: "general", question: "Summarize the project" });
  const prompt = request.messages[1].content;
  assert.ok(prompt.length < 4_000, `provider history was ${prompt.length} characters`);
  assert.match(prompt, /Completed action: \{"type":"build_structure","version":1,"plan":\{/);
  assert.match(prompt, /"kind":"castle"/);
  assert.match(prompt, /"dimensions":\{"width":64,"depth":64,"height":32\}/);
  assert.match(prompt, /"steps":150/);
  assert.doesNotMatch(prompt, /"primitives"\s*:/);
  assert.doesNotMatch(prompt, /"placements"\s*:/);
  assert.doesNotMatch(prompt, /primitive-marker-99|placement-marker-49|FULL-ANSWER-END/);
  assert.equal(sessions.get("BoundKid", "general")[0].answer, longAnswer);
  assert.equal(sessions.get("BoundKid", "general")[0].action.plan.primitives.length, 100);
});

test("caps total provider history while retaining the latest turn and project action", async () => {
  const sessions = createMemorySessionStore();
  const turns = [{
    question: "OLD-PROJECT build the castle",
    answer: "The project began.",
    status: "completed",
    action: {
      type: "build_structure",
      version: 1,
      plan: {
        title: "Remembered Castle",
        kind: "castle",
        dimensions: { width: 20, depth: 20, height: 9 },
        materials: { primary: "minecraft:stone_bricks" },
        features: ["walls", "towers"],
        phases: ["foundation", "shell", "roof", "details"],
      },
    },
  }, ...Array.from({ length: 10 }, (_, index) => ({
    question: `${index === 9 ? "LATEST-TURN" : `CHAT-${index}`} ${"question ".repeat(100)}`,
    answer: `answer-${index} ${"detail ".repeat(200)}`,
  }))];
  await sessions.set("BudgetKid", "general", turns);
  let request;
  const boundedWizard = createWizard({
    corpus: { search: () => [] },
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "model", AI_STYLE: "chat" },
    sessions,
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "Recap", answer: "Still with you.",
      }) } }] }), { status: 200 });
    },
  });

  await boundedWizard.ask({ player: "BudgetKid", mode: "general", question: "What now?" });
  const prompt = request.messages[1].content;
  const history = prompt.match(/Recent conversation:\n([\s\S]*?)\n\nPlayer question:/)?.[1] || "";
  assert.ok(history.length <= 4_000, `provider history was ${history.length} characters`);
  assert.match(history, /OLD-PROJECT/);
  assert.match(history, /Completed action: \{"type":"build_structure"/);
  assert.match(history, /LATEST-TURN/);
  assert.doesNotMatch(history, /CHAT-0/);
});

test("persists bounded separate sessions without plaintext player identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-session-"));
  const filePath = join(directory, "sessions.json");
  let clock = 1_000_000;
  try {
    const store = await createFileSessionStore({
      filePath,
      salt: "test-session-salt-long-enough",
      maxTurns: 2,
      ttlMs: 1_000,
      now: () => clock,
    });
    await store.set("SecretGamertag", "wizard", [
      { question: "one", answer: "1" },
      { question: "two", answer: "2" },
      { question: "three", answer: "3" },
    ]);
    await store.set("SecretGamertag", "general", [{ question: "hello", answer: "hi" }]);
    assert.deepEqual(store.get("SecretGamertag", "wizard").map((turn) => turn.question), ["two", "three"]);
    assert.equal(store.get("SecretGamertag", "general")[0].answer, "hi");
    assert.doesNotMatch(await readFile(filePath, "utf8"), /SecretGamertag/);

    const reloaded = await createFileSessionStore({
      filePath,
      salt: "test-session-salt-long-enough",
      maxTurns: 2,
      ttlMs: 1_000,
      now: () => clock,
    });
    assert.equal(reloaded.get("SecretGamertag", "wizard").length, 2);
    assert.equal(await reloaded.delete("SecretGamertag", "wizard"), true);
    assert.deepEqual(reloaded.get("SecretGamertag", "wizard"), []);
    clock += 2_000;
    assert.deepEqual(reloaded.get("SecretGamertag", "general"), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hot-loads validated operator tuning into the next model request", async () => {
  const requests = [];
  const tunedWizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "claude", AI_STYLE: "chat" },
    settings: async () => ({
      aiEnabled: true,
      wizardPromptAddendum: "Call redstone dust sparkle wire.",
      generalPromptAddendum: "Use tiny section headings.",
      wizardMaxOutputTokens: 222,
      generalMaxOutputTokens: 333,
    }),
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      const general = request.messages[0].content.includes("general-purpose AI");
      const content = general
        ? JSON.stringify({ title: "Night Guide", answer: "A complete guide." })
        : JSON.stringify({ answer: "Hello, builder!", action: null });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    },
  });
  await tunedWizard.ask({ player: "Admin", question: "What is redstone dust?" });
  await tunedWizard.ask({ player: "Admin", question: "write a guide", mode: "general" });
  assert.equal(requests[0].max_tokens, 222);
  assert.match(requests[0].messages[0].content, /sparkle wire/);
  assert.equal(requests[1].max_tokens, 333);
  assert.match(requests[1].messages[0].content, /tiny section headings/);
});

test("validates and atomically persists runtime settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-settings-"));
  const filePath = join(directory, "settings.json");
  const value = {
    aiEnabled: false,
    wizardPromptAddendum: "Be concise.",
    generalPromptAddendum: "Use headings.",
    wizardMaxOutputTokens: 256,
    generalMaxOutputTokens: null,
  };
  try {
    assert.deepEqual(await writeRuntimeSettings(filePath, value), validateRuntimeSettings(value));
    assert.deepEqual(await readRuntimeSettings(filePath), value);
    assert.throws(() => validateRuntimeSettings({ ...value, wizardMaxOutputTokens: 12 }), /64 to 3,000/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serves a loopback admin desk and sends console text without a shell", async () => {
  assert.equal(validateConsoleCommand("/say hello builders"), "say hello builders");
  assert.throws(() => validateConsoleCommand("say hi\nstop"), /one line/);
  const adminScript = await readFile(new URL("../src/admin.mjs", import.meta.url), "utf8");
  const consoleScript = await readFile(new URL("../src/bedrock-console.mjs", import.meta.url), "utf8");
  assert.match(adminScript, /MC Wizard Operator Desk/);
  assert.match(adminScript, /import \{ runProcess as run, sendBedrockCommand, validateMinecraftCommand \} from "\.\/bedrock-console\.mjs"/);
  assert.match(consoleScript, /\["exec", "mc-wizard-bedrock", "send-command", command\]/);
  assert.match(consoleScript, /ROSETTA_SEND_SCRIPT/);
  assert.match(adminScript, /Admin panel is loopback-only/);
  assert.match(adminScript, /setInterval\(loadLogs,4000\)/);
  assert.match(adminScript, /scrollTop=panel\.scrollHeight/);
  assert.match(adminScript, /Hidden.*routine Bedrock database-compaction messages/);
  assert.match(adminScript, /0 AI requests, 0 AI tokens/);
  assert.match(adminScript, /content-type must be application\/json/);
  assert.match(localBridgeScript, /browser-originated requests are not allowed/);
  assert.match(installPackScript, /chmod\(secretsFile, 0o600\)/);
  assert.match(await readFile(new URL("../scripts/admin-service.mjs", import.meta.url), "utf8"), /function adminPids\(\)/);
});
