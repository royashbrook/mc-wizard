import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { loadCorpus } from "../src/rag.mjs";
import { startServer, validateAskBody } from "../src/server.mjs";
import { createFileSessionStore } from "../src/sessions.mjs";
import { safeCommandRefusal, unsafeCommandAnswer } from "../src/command-safety.mjs";
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

before(async () => {
  const [loadedCorpus, manifestText, permissionsText, scriptText, e2eText, containerText, localBridgeText, e2eRunnerText, installPackText, resourceManifestText, syncDocsText, supervisorText] = await Promise.all([
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
  wizard = createWizard({ corpus, env: {} });
});

test("drives the real wizard path with a headless test player", () => {
  assert.match(packScript, /mc_wizard_e2e/);
  assert.match(packScript, /function routeAddressedMessage\(player, message\)/);
  assert.match(packScript, /engineAddressedMessageCount:/);
  assert.match(e2eScript, /spawnSimulatedPlayer/);
  assert.match(e2eScript, /kid\.chat\(message\)/);
  assert.match(e2eScript, /chatCallbacks\.routeAddressedMessage\(kid, message\)/);
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
  assert.doesNotMatch(e2eRunnerScript, /DATA="\$ROOT\/runtime\/bedrock"/);
  assert.doesNotMatch(e2eRunnerScript, /container inspect mc-wizard-bedrock/);
});

test("embodies the guide as an official simulated player", () => {
  assert.ok(packManifest.dependencies.some((dependency) => (
    dependency.module_name === "@minecraft/server-gametest"
    && dependency.version === "1.0.0-beta"
  )));
  assert.ok(packPermissions.allowed_modules.includes("@minecraft/server-gametest"));
  assert.match(packScript, /spawnSimulatedPlayer/);
  assert.match(packScript, /navigateToEntity/);
  assert.match(packScript, /\.chat\(/);
  assert.match(packScript, /useItemOnBlock/);
  assert.match(packScript, /if \(!placed\)/);
  assert.match(packScript, /after \$\{attempts\} attempts/);
  assert.doesNotMatch(packScript, /\.setType\(/);
  assert.doesNotMatch(packScript, /tryTeleport/);
  assert.match(packScript, /isWizardPlayer\(event\.sender\)/);
  assert.match(packScript, /new ItemStack\(itemId, 1\)/);
  assert.match(packScript, /wizard\.setItem\(item, 0, true\)/);
});

test("ships and equips a visible wizard costume with a vanilla fallback", () => {
  assert.equal(resourceManifest.header.uuid, "5dd80b07-b583-4bb3-979c-41c25ce274d8");
  assert.ok(packManifest.dependencies.some((dependency) => dependency.uuid === resourceManifest.header.uuid));
  assert.match(installPackScript, /resource_packs/);
  assert.match(installPackScript, /world_resource_packs\.json/);
  assert.match(packScript, /EquipmentSlot\.Head/);
  assert.match(packScript, /EquipmentSlot\.Chest/);
  assert.match(packScript, /mcwizard:hat/);
  assert.match(packScript, /mcwizard:robe/);
  assert.match(packScript, /mcwizard:wand/);
  assert.doesNotMatch(packScript, /minecraft:blaze_rod/);
  assert.match(packScript, /minecraft:leather_helmet/);
  assert.match(packScript, /minecraft:leather_chestplate/);
});

test("prepares fixed command-block lessons and rejects unsafe generated commands", () => {
  assert.match(packScript, /function buildCommandLesson/);
  assert.match(packScript, /minecraft:command_block/);
  assert.match(packScript, /minecraft:stone_button/);
  assert.match(packScript, /Impulse, Unconditional, Needs Redstone/);
  assert.equal(unsafeCommandAnswer("Try /say hello"), false);
  assert.equal(unsafeCommandAnswer("Try /kill @a"), true);
  assert.equal(unsafeCommandAnswer("Use a repeating command block"), true);
  assert.match(safeCommandRefusal(), /shared world/i);
  assert.equal(COMMAND_LESSONS.give_self.command, "/give @p[r=5] minecraft:torch 16");
  assert.match(COMMAND_LESSONS.give_self.explanation, /cannot use @s/i);
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
  assert.doesNotMatch(positioning, /tryTeleport/);
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

test("moves blocked builds to a fresh workshop and queues busy requests", () => {
  assert.match(packScript, /function prepareBuildWorkshop/);
  assert.match(packScript, /player\.teleport/);
  assert.match(packScript, /grass_block/);
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
  assert.match(localBridgeScript, /"--no-memory"/);
  assert.match(localBridgeScript, /"--no-subagents"/);
  assert.match(localBridgeScript, /"--disable-web-search"/);
  assert.match(localBridgeScript, /"--output-format", "plain"/);
  assert.match(localBridgeScript, /host = "127\.0\.0\.1"/);
  assert.match(localBridgeScript, /MTOK_TIMEOUT_MS/);
  assert.match(localBridgeScript, /inFlight >= 1/);
  assert.doesNotMatch(localBridgeScript, /dangerously-skip|bypassPermissions/);
});

test("pins and confines the Apple container launch to an explicit private-LAN mode", () => {
  assert.match(containerScript, /sha256:45c8f292b289659c0be469b2eaaebfc1fbfefdf5c060a0df5ed53fe9e2e7c563/);
  assert.match(containerScript, /VERSION=1\.26\.33\.2/);
  assert.match(containerScript, /--platform linux\/amd64/);
  assert.doesNotMatch(containerScript, /USE_BOX64/);
  assert.match(containerScript, /MC_WIZARD_ALLOW_LIST_USERS/);
  assert.match(containerScript, /MC_WIZARD_OPEN_LAN/);
  assert.match(containerScript, /RFC1918 private address/);
  assert.match(containerScript, /ONLINE_MODE=true/);
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

test("starts a bounded castle gate locally without waiting for a provider", async () => {
  let providerCalled = false;
  const castleWizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "slow", AI_STYLE: "chat" },
    fetchImpl: async () => {
      providerCalled = true;
      throw new Error("provider should not be called for a local skill");
    },
  });
  const result = await castleWizard.ask({ player: "Kid", question: "Build me a castle" });
  assert.equal(providerCalled, false);
  assert.equal(result.mode, "local-skill");
  assert.equal(result.action.type, "build_plan");
  assert.equal(validateBuildPlan(result.action.plan).blocks.length, 25);
  assert.match(result.answer, /strong gate/i);
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
  assert.match(packScript, /protected by a recent MC Wizard build/);
  assert.match(packScript, /action\?\.type === "build_plan"/);
  assert.doesNotMatch(packScript, /tryTeleport/);
});

test("returns an offline answer with sources and a typed action", async () => {
  const result = await wizard.ask({ player: "BuilderKid", question: "Build a T flip flop for me" });
  assert.equal(result.mode, "local-skill");
  assert.equal(result.action.id, "copper_bulb_t_flip_flop");
  assert.match(result.answer, /copper bulb/i);
  assert.ok(result.sources.length > 0);
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
  assert.match(result.answer, /won’t read raw documentation/i);
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
  assert.doesNotMatch(greeting.answer, /source|verified note/i);
});

test("cancels stale replies and keeps children updated while deeper work runs", () => {
  assert.match(packScript, /discarded stale/);
  assert.match(packScript, /pendingQuestions\.get\(key\) !== token/);
  assert.match(packScript, /I’m still thinking/);
  assert.match(packScript, /clearBackendSession/);
  assert.match(packScript, /HttpRequestMethod\.Delete/);
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
  assert.equal(request.body.max_output_tokens, 300);
  assert.equal(request.body.model, "test-model");
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
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "Blue Sky",
        answer: "A normal answer with a complete final sentence.",
      }) } }] }), {
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
            answer: "I’ll build the calculator now.",
            action: { type: "place_blueprint", id: "binary_adder_2bit", version: 1 },
          })
        : JSON.stringify({
            answer: "I remember. We were talking about the calculator.",
            action: { type: "delete_world", id: "everything", version: 1 },
          });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const built = await agentWizard.ask({ player: "Kid", question: "build a strange monument" });
  const followup = await agentWizard.ask({ player: "Kid", question: "what were we doing?" });
  assert.equal(built.action.id, "binary_adder_2bit");
  assert.equal(followup.action, null);
  assert.match(requests[0].messages[0].content, /build_two_bit_calculator/);
  assert.match(requests[1].messages[1].content, /I’ll build the calculator now/);
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
  assert.match(adminScript, /MC Wizard Operator Desk/);
  assert.match(adminScript, /\["exec", "mc-wizard-bedrock", "send-command", command\]/);
  assert.match(adminScript, /ROSETTA_SEND_SCRIPT/);
  assert.match(adminScript, /Admin panel is loopback-only/);
  assert.match(adminScript, /setInterval\(loadLogs,4000\)/);
  assert.match(adminScript, /scrollTop=panel\.scrollHeight/);
  assert.match(adminScript, /Hidden.*routine Bedrock database-compaction messages/);
  assert.match(adminScript, /0 AI requests, 0 AI tokens/);
  assert.match(await readFile(new URL("../scripts/admin-service.mjs", import.meta.url), "utf8"), /function adminPids\(\)/);
});
