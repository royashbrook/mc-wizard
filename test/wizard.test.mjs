import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";
import { loadCorpus } from "../src/rag.mjs";
import { startServer, validateAskBody } from "../src/server.mjs";
import { classifyAction, createWizard } from "../src/wizard.mjs";
import {
  calculatorResult,
  createCalculatorBlueprint,
} from "../bedrock/behavior_packs/mc_wizard/scripts/calculator.js";
import { bookPages, bookTitle } from "../bedrock/behavior_packs/mc_wizard/scripts/book.js";
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

before(async () => {
  const [loadedCorpus, manifestText, permissionsText, scriptText, e2eText, containerText, localBridgeText] = await Promise.all([
    loadCorpus(),
    readFile(new URL("../bedrock/behavior_packs/mc_wizard/manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../bedrock/config/4e8790fe-18dc-46d1-aa31-ec78a924b717/permissions.json", import.meta.url), "utf8"),
    readFile(new URL("../bedrock/behavior_packs/mc_wizard/scripts/main.js", import.meta.url), "utf8"),
    readFile(new URL("../bedrock/behavior_packs/mc_wizard/scripts/e2e.js", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-bedrock-container.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-ai-bridge.mjs", import.meta.url), "utf8"),
  ]);
  corpus = loadedCorpus;
  packManifest = JSON.parse(manifestText);
  packPermissions = JSON.parse(permissionsText);
  packScript = scriptText;
  e2eScript = e2eText;
  containerScript = containerText;
  localBridgeScript = localBridgeText;
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
  assert.match(packScript, /if \(!placed\) throw/);
  assert.doesNotMatch(packScript, /\.setType\(/);
  assert.doesNotMatch(packScript, /tryTeleport/);
  assert.match(packScript, /isWizardPlayer\(event\.sender\)/);
  assert.match(packScript, /new ItemStack\(itemId, 1\)/);
  assert.match(packScript, /wizard\.setItem\(item, 0, true\)/);
});

test("flies into player reach for every placement and verifies scaffold removal", () => {
  assert.match(packScript, /BUILD_REACH_SQUARED/);
  assert.match(packScript, /positionWizardForBuild\(dimension, target, support\)/);
  const positioning = packScript.slice(
    packScript.indexOf("function positionWizardForBuild"),
    packScript.indexOf("function placeAsWizard"),
  );
  assert.match(positioning, /wizard\.fly\(\)/);
  assert.match(positioning, /moveToLocation/);
  assert.doesNotMatch(positioning, /tryTeleport/);
  assert.match(packScript, /stepComplete === false \? index : index \+ 1/);
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
  assert.match(packScript, /player\.dimension\.spawnItem/);
  assert.doesNotMatch(packScript, /Let me check my Bedrock notes/);
});

test("creates readable book pages and whole-word titles", () => {
  assert.equal(bookTitle("make me a guide on how to beat minecraft"), "Beat Minecraft");
  assert.equal(bookTitle("pneumonoultramicroscopicsilicovolcanoconiosis"), "AI Answer");
  const pages = bookPages("# First steps\n\n- Find wood and make tools.\n- Build a safe shelter before dark. ".repeat(20));
  assert.ok(pages.length > 1 && pages.length <= 50);
  assert.ok(pages.every((page) => page.length <= 256 && page.split("\n").length <= 8));
  assert.match(pages.join("\n"), /• Find wood/);
});

test("constrains the Claude CLI bridge to text-only ephemeral safe mode", () => {
  assert.match(localBridgeScript, /from "mtok-bridge"/);
  assert.match(localBridgeScript, /"--safe-mode"/);
  assert.match(localBridgeScript, /"--tools", ""/);
  assert.match(localBridgeScript, /"--no-session-persistence"/);
  assert.match(localBridgeScript, /host = "127\.0\.0\.1"/);
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

test("returns an offline answer with sources and a typed action", async () => {
  const result = await wizard.ask({ player: "BuilderKid", question: "Build a T flip flop for me" });
  assert.equal(result.mode, "offline");
  assert.equal(result.action.id, "copper_bulb_t_flip_flop");
  assert.match(result.answer, /copper bulb/i);
  assert.ok(result.sources.length > 0);
});

test("uses retrieved material for specific command-block questions", async () => {
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
  assert.match(result.answer, /\/clone command copies blocks/i);
  assert.doesNotMatch(result.answer, /closest verified note|from “clone Command”/i);
});

test("answers ordinary conversation as a character instead of dumping retrieval", async () => {
  const greeting = await wizard.ask({ player: "BuilderKid", question: "hi wiz" });
  assert.match(greeting.answer, /MC Wizard/i);
  assert.doesNotMatch(greeting.answer, /source|verified note/i);
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
        output: [{ content: [{ type: "output_text", text: "A model-backed answer." }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await modelWizard.ask({ player: "BuilderKid", question: "Build a T flip flop" });
  assert.equal(request.url, "https://api.example/v1/responses");
  assert.equal(request.body.store, false);
  assert.equal(request.body.max_output_tokens, 300);
  assert.equal(request.body.model, "test-model");
  assert.equal(request.options.headers.authorization, "Bearer test-key");
  assert.doesNotMatch(request.body.input, /BuilderKid/);
  assert.equal(result.answer, "A model-backed answer.");
  assert.equal(result.action.id, "copper_bulb_t_flip_flop");
});

test("supports an OpenAI-compatible chat endpoint without an API key", async () => {
  let requestUrl;
  const modelWizard = createWizard({
    corpus,
    env: { AI_BASE_URL: "http://local-model/v1", AI_MODEL: "local", AI_STYLE: "chat" },
    logger: { warn() {} },
    fetchImpl: async (url) => {
      requestUrl = url;
      return new Response(JSON.stringify({ choices: [{ message: { content: "Local model answer." } }] }), {
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
      return new Response(JSON.stringify({ choices: [{ message: { content: "A normal answer." } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await modelWizard.ask({ player: "BuilderKid", question: "Why is the sky blue?", mode: "general" });
  assert.equal(request.url, "http://127.0.0.1:8790/v1/chat/completions");
  assert.match(request.body.messages[0].content, /Do not roleplay as MC Wizard/);
  assert.doesNotMatch(request.body.messages[1].content, /Retrieved sources/);
  assert.equal(result.kind, "general");
  assert.equal(result.label, "Ollama");
  assert.equal(result.action, null);
  assert.deepEqual(result.sources, []);
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
  const built = await agentWizard.ask({ player: "Kid", question: "build a calculator" });
  const followup = await agentWizard.ask({ player: "Kid", question: "what were we doing?" });
  assert.equal(built.action.id, "binary_adder_2bit");
  assert.equal(followup.action, null);
  assert.match(requests[0].messages[0].content, /build_two_bit_calculator/);
  assert.match(requests[1].messages[1].content, /I’ll build the calculator now/);
});
