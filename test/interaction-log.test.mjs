import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdminServer } from "../src/admin.mjs";
import { createInteractionLog, readRecentInteractions } from "../src/interaction-log.mjs";
import { createHttpServer } from "../src/server.mjs";

const salt = "test-interaction-log-salt";
const quiet = { log() {}, error() {} };

async function dispatch(server, { method = "GET", url = "/", body, token, headers = {} } = {}) {
  const encoded = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const request = {
    method,
    url,
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(body !== undefined && {
        "content-length": String(encoded.length),
        "content-type": "application/json",
      }),
      ...headers,
    },
    async *[Symbol.asyncIterator]() {
      if (encoded.length) yield encoded;
    },
  };
  const response = {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(value = "") {
      this.body = String(value);
    },
  };
  await server.listeners("request")[0](request, response);
  return response;
}

test("writes bounded JSONL interactions without plaintext player names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-interactions-"));
  const filePath = join(directory, "brain", "interactions.jsonl");
  try {
    const log = createInteractionLog({ filePath, salt, now: () => Date.UTC(2026, 6, 13, 12) });
    await log.recordAsk({
      player: "ActualKidGamertag",
      question: `ActualKidGamertag says hello\0\nworld ${"q".repeat(900)}`,
      mode: "wizard",
      result: {
        answer: `ActualKidGamertag, I can help.\u0007 ${"a".repeat(13_000)}`,
        requestId: "castle-request",
        goalId: "castle-goal",
        action: { type: "build_structure", plan: { title: "ActualKidGamertag Moon Castle" } },
      },
    });
    await log.recordActionResult({
      player: "ActualKidGamertag",
      requestId: "castle-request",
      status: "failed",
      detail: `ActualKidGamertag was blocked\0 ${"d".repeat(600)}`,
      result: {
        matched: true,
        updated: true,
        replan: {
          answer: "ActualKidGamertag, I spotted the gap and I am repairing it now.",
          goalId: "castle-goal",
          action: { type: "build_structure", plan: { title: "Moon Castle Repair" } },
        },
      },
    });

    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /ActualKidGamertag/);
    const entries = raw.trim().split("\n").map(JSON.parse);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].playerHash,
      createHmac("sha256", salt).update("ActualKidGamertag").digest("hex"));
    assert.ok(entries[0].input.length <= 800);
    assert.ok(entries[0].answer.length <= 12_000);
    assert.equal(entries[0].input.includes("\n"), false);
    assert.equal(entries[0].actionLabel, "[player] Moon Castle");
    assert.equal(entries[0].goalId, "castle-goal");
    assert.ok(entries[1].detail.length <= 500);
    assert.deepEqual(entries[1].outcome, {
      status: "failed", matched: true, updated: true, totalMs: 0,
    });
    assert.equal(entries[1].actionLabel, "Moon Castle Repair");
    assert.deepEqual(await readRecentInteractions(filePath, { limit: 1 }), [entries[1]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("logs successful action paths and measured acknowledgement-to-completion timing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-success-log-"));
  const filePath = join(directory, "interactions.jsonl");
  let clock = 1_000;
  try {
    const log = createInteractionLog({ filePath, salt, now: () => clock });
    await log.recordAsk({
      player: "SuccessKid",
      question: "clear my effects",
      mode: "wizard",
      result: {
        answer: "Casting it now.", requestId: "clear-effects", mode: "local-skill",
        action: { type: "run_commands", version: 1, commands: ["effect @s clear"] },
      },
    });
    clock = 1_100;
    await log.recordActionResult({
      player: "SuccessKid", requestId: "clear-effects", status: "started",
      result: { matched: true, updated: true },
    });
    clock = 1_600;
    await log.recordActionResult({
      player: "SuccessKid", requestId: "clear-effects", status: "completed",
      result: { matched: true, updated: true },
    });
    const entries = await readRecentInteractions(filePath);
    assert.equal(entries[0].responseMode, "local-skill");
    assert.equal(entries[0].actionType, "run_commands");
    assert.deepEqual(entries[2].outcome, {
      status: "completed", matched: true, updated: true, success: true,
      totalMs: 600, actionMs: 500,
    });
    await log.recordFeedback({
      player: "SuccessKid",
      requestId: "partial-build",
      grade: 2,
      feedback: "finish the missing wall",
      result: { requestId: "partial-build", status: "partial" },
    });
    assert.equal((await readRecentInteractions(filePath)).at(-1).outcome.status, "partial");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recordAsk logs rejection-funnel telemetry scrubbed and bounded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-telemetry-log-"));
  const filePath = join(directory, "interactions.jsonl");
  try {
    const log = createInteractionLog({ filePath, salt });
    await log.recordAsk({
      player: "TelemetryKid",
      question: "build me a rainbow dragon",
      mode: "wizard",
      telemetry: {
        providerConsulted: true,
        rejections: [
          { gate: "envelope-parse", reason: "TelemetryKid sent\u0000 a broken\nenvelope" },
          { gate: `intent-${"g".repeat(80)}`, reason: `r${"e".repeat(400)}` },
          ...Array.from({ length: 10 }, (unused, index) => ({ gate: "repair-failed", reason: `round ${index}` })),
        ],
      },
      result: { answer: "I will try a simpler plan.", requestId: "dragon-request" },
    });
    await log.recordAsk({
      player: "TelemetryKid",
      question: "build a t flip flop",
      mode: "wizard",
      telemetry: { providerConsulted: false },
      result: { answer: "Casting it now.", requestId: "canned-request" },
    });
    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /TelemetryKid/);
    const [funnel, canned] = raw.trim().split("\n").map(JSON.parse);
    assert.equal(funnel.providerConsulted, true);
    assert.equal(funnel.rejections.length, 8);
    assert.equal(funnel.rejections[0].gate, "envelope-parse");
    assert.equal(funnel.rejections[0].reason, "[player] sent a broken envelope");
    assert.doesNotMatch(funnel.rejections[0].reason, /[\u0000-\u001f]/);
    assert.ok(funnel.rejections[1].gate.length <= 40);
    assert.ok(funnel.rejections[1].reason.length <= 200);
    assert.equal(canned.providerConsulted, false);
    assert.equal("rejections" in canned, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recordAsk ignores malformed telemetry shapes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-telemetry-malformed-"));
  const filePath = join(directory, "interactions.jsonl");
  try {
    const log = createInteractionLog({ filePath, salt });
    await log.recordAsk({
      player: "ShapeKid",
      question: "hello",
      mode: "wizard",
      telemetry: { providerConsulted: true, rejections: "not-an-array" },
      result: { answer: "Hello!" },
    });
    await log.recordAsk({
      player: "ShapeKid",
      question: "hello again",
      mode: "wizard",
      result: { answer: "Hello again!" },
    });
    const [stringy, absent] = (await readFile(filePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(stringy.providerConsulted, true);
    assert.equal("rejections" in stringy, false);
    assert.equal("providerConsulted" in absent, false);
    assert.equal("rejections" in absent, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("interaction history retains only a bounded tail of complete records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-interaction-bound-"));
  const filePath = join(directory, "interactions.jsonl");
  try {
    const log = createInteractionLog({ filePath, salt, maxBytes: 64 * 1024 });
    for (let index = 0; index < 80; index += 1) {
      await log.recordAsk({
        player: "BoundedKid",
        question: `message ${index} ${"x".repeat(700)}`,
        mode: "wizard",
        result: { answer: `answer ${index} ${"y".repeat(700)}` },
      });
    }
    const raw = await readFile(filePath, "utf8");
    assert.ok(Buffer.byteLength(raw) <= 64 * 1024);
    const entries = raw.trim().split("\n").map(JSON.parse);
    assert.ok(entries.length > 1 && entries.length < 80);
    assert.match(entries.at(-1).input, /^message 79 /);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the brain records ask replies and action-result outcomes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-interaction-server-"));
  const filePath = join(directory, "interactions.jsonl");
  const interactionLog = createInteractionLog({ filePath, salt });
  let receivedAsk;
  let askCalls = 0;
  const wizard = {
    provider: "TestProvider",
    async ask(input) {
      askCalls += 1;
      receivedAsk = input;
      return {
        answer: "I am building it now.",
        requestId: "server-castle",
        goalId: "server-goal",
        action: { type: "build_structure", plan: { title: "Server Castle" } },
      };
    },
    async recordActionResult({ status }) {
      return { matched: true, updated: true, status };
    },
  };
  const server = createHttpServer({
    wizard, corpus: { size: 1 }, token: "test-token", interactionLog, cooldownMs: 0, logger: quiet,
  });
  try {
    const ask = await dispatch(server, {
      method: "POST", url: "/v1/ask", token: "test-token",
      body: { player: "ServerKid", question: "Build a castle", goalId: "server-goal" },
    });
    assert.equal(ask.status, 200);
    assert.deepEqual(receivedAsk.goalRetry, { goalId: "server-goal" });
    const malformed = await dispatch(server, {
      method: "POST", url: "/v1/ask", token: "test-token",
      body: { player: "ServerKid", question: "Build a castle", goalId: "not safe!" },
    });
    assert.equal(malformed.status, 400);
    assert.equal(askCalls, 1);
    const result = await dispatch(server, {
      method: "POST",
      url: "/v1/action-result",
      token: "test-token",
      body: { player: "ServerKid", requestId: "server-castle", status: "started" },
    });
    assert.equal(result.status, 200);
    assert.deepEqual((await readRecentInteractions(filePath)).map(({ event }) => event), ["ask", "action_result"]);
    assert.doesNotMatch(await readFile(filePath, "utf8"), /ServerKid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the operator desk exposes and renders the persistent interaction history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-interaction-admin-"));
  const filePath = join(directory, "interactions.jsonl");
  const log = createInteractionLog({ filePath, salt });
  await log.recordAsk({
    player: "AdminTestKid",
    question: "hello",
    mode: "general",
    result: { answer: "Hello!", requestId: "hello-request" },
  });
  const server = createAdminServer({ interactionsFile: filePath, logger: quiet });
  try {
    const page = (await dispatch(server)).body;
    assert.match(page, /Recent kid interactions/);
    assert.match(page, /setInterval\(loadInteractions,4000\)/);
    const response = await dispatch(server, { url: "/api/interactions" });
    assert.equal(response.status, 200);
    const { interactions } = JSON.parse(response.body);
    assert.equal(interactions.length, 1);
    assert.equal(interactions[0].input, "hello");
    assert.doesNotMatch(JSON.stringify(interactions), /AdminTestKid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the operator desk exposes the promoted knowledge-graph revision", async () => {
  const server = createAdminServer({
    logger: quiet,
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      provider: "Codex",
      graph: { revision: "kg-2-2-test", documents: 31703, nodes: 880, edges: 413 },
    }), { status: 200 }),
    execute: async () => ({ code: 0, output: "" }),
  });
  const page = (await dispatch(server)).body;
  assert.match(page, /id="graph"/);
  assert.match(page, /Graph: /);
  const response = await dispatch(server, { url: "/api/status" });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body).graph, {
    revision: "kg-2-2-test", documents: 31703, nodes: 880, edges: 413,
  });
  const unavailable = createAdminServer({
    logger: quiet,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, graph: { revision: "unavailable" } }), { status: 200 }),
    execute: async () => ({ code: 0, output: "" }),
  });
  const unavailablePage = (await dispatch(unavailable)).body;
  assert.match(unavailablePage, /\^kg-/);
});

test("the operator desk rejects cross-site and non-JSON writes", async () => {
  let executed = false;
  const server = createAdminServer({
    logger: quiet,
    execute: async () => {
      executed = true;
      return { code: 0, output: "" };
    },
  });
  const plain = await dispatch(server, {
    method: "POST",
    url: "/api/console",
    body: { command: "stop" },
    headers: { "content-type": "text/plain" },
  });
  assert.equal(plain.status, 415);
  const crossOrigin = await dispatch(server, {
    method: "POST",
    url: "/api/console",
    body: { command: "stop" },
    headers: {
      host: "127.0.0.1:3001",
      origin: "https://attacker.example",
    },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(executed, false);

  const sameOrigin = await dispatch(server, {
    method: "POST",
    url: "/api/console",
    body: { command: "list" },
    headers: {
      host: "127.0.0.1:3001",
      origin: "http://127.0.0.1:3001",
    },
  });
  assert.equal(sameOrigin.status, 200);
  assert.equal(executed, true);
});
