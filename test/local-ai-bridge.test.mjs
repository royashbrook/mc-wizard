import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_REQUEST_BODY_BYTES,
  codexArguments,
  createProviderScheduler,
  decodeCodexProviderEnvelope,
  readBridgeJson,
  runCliProcess,
  serveBridgeChat,
  validateBridgeRequest,
} from "../scripts/local-ai-bridge.mjs";

const schema = JSON.parse(await readFile(
  new URL("../schemas/codex-provider-envelope.schema.json", import.meta.url),
  "utf8",
));
const actionSchema = JSON.parse(await readFile(
  new URL("../schemas/codex-provider-action-envelope.schema.json", import.meta.url),
  "utf8",
));

function streamedRequest(buffer, declaredLength = buffer.length) {
  return {
    headers: { "content-length": String(declaredLength) },
    async *[Symbol.asyncIterator]() {
      for (let offset = 0; offset < buffer.length; offset += 4_093) {
        yield buffer.subarray(offset, offset + 4_093);
      }
    },
  };
}

function fakeCliProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    queueMicrotask(() => {
      child.signalCode = signal;
      child.emit("close", null, signal);
    });
    return true;
  };
  return child;
}

test("Codex uses a strict transport envelope and native web search only", () => {
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["answer", "action_json", "goal_json"]);
  assert.deepEqual(schema.properties.action_json.type, ["string", "null"]);
  assert.deepEqual(schema.properties.goal_json.type, ["string", "null"]);

  const args = codexArguments({ modelName: "test-model", schema: "/tmp/envelope.json" });
  assert.deepEqual(args.slice(0, 2), ["--search", "exec"]);
  assert.ok(args.includes("read-only"));
  for (const disabled of ["shell_tool", "apps", "multi_agent"]) {
    const index = args.indexOf(disabled);
    assert.equal(args[index - 1], "--disable");
  }
  assert.equal(args[args.indexOf("--output-schema") + 1], "/tmp/envelope.json");
  assert.equal(args[args.indexOf("--model") + 1], "test-model");
  const actionArgs = codexArguments({ reasoningEffort: "low" });
  assert.ok(actionArgs.includes('model_reasoning_effort="low"'));
  assert.equal(actionSchema.properties.action_json.type, "string");
  assert.equal(actionSchema.properties.goal_json.type, "string");
});

test("Codex provider envelopes decode serialized actions and goals", () => {
  const content = decodeCodexProviderEnvelope(JSON.stringify({
    answer: "I’ll build and inspect it.",
    action_json: JSON.stringify({ type: "build_structure", version: 1 }),
    goal_json: JSON.stringify({ objective: "Build a city", status: "active" }),
  }));
  assert.deepEqual(JSON.parse(content), {
    answer: "I’ll build and inspect it.",
    action: { type: "build_structure", version: 1 },
    goal: { objective: "Build a city", status: "active" },
  });
  assert.deepEqual(JSON.parse(decodeCodexProviderEnvelope(JSON.stringify({
    answer: "Hello!",
    action_json: null,
    goal_json: null,
  }))), { answer: "Hello!", action: null, goal: null });
});

test("Codex provider envelope rejects malformed serialized fields", () => {
  assert.throws(() => decodeCodexProviderEnvelope("not json"), /not valid JSON/);
  assert.throws(() => decodeCodexProviderEnvelope(JSON.stringify({
    answer: "No action",
    action_json: "{",
    goal_json: null,
  })), /action_json was not valid/);
  assert.throws(() => decodeCodexProviderEnvelope(JSON.stringify({
    answer: "No goal",
    action_json: null,
    goal_json: {},
  })), /goal_json must be a JSON string or null/);
  assert.throws(() => decodeCodexProviderEnvelope(JSON.stringify({
    answer: "I forgot the build.",
    action_json: "null",
    goal_json: JSON.stringify({ objective: "Build a city" }),
  }), { actionRequired: true }), /had no action/);
});

test("provider scheduler runs three requests and bounds or cancels queue waits", async () => {
  const schedule = createProviderScheduler({ waitMs: 1_000 });
  let active = 0;
  let maximum = 0;
  let started = 0;
  let release;
  let firstBatchStarted;
  const blocker = new Promise((resolve) => { release = resolve; });
  const firstBatch = new Promise((resolve) => { firstBatchStarted = resolve; });
  const jobs = Array.from({ length: 5 }, (_, index) => schedule(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    started += 1;
    if (started === 3) firstBatchStarted();
    await blocker;
    active -= 1;
    return index;
  }));

  await firstBatch;
  assert.equal(maximum, 3);
  release();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4]);
  assert.equal(started, 5);
  assert.equal(maximum, 3);

  const congested = createProviderScheduler({ concurrency: 2, waitMs: 20 });
  let unblock;
  const occupied = new Promise((resolve) => { unblock = resolve; });
  const first = congested(() => occupied);
  const second = congested(() => occupied);
  let timedOutRan = false;
  await assert.rejects(
    congested(() => { timedOutRan = true; }),
    (error) => error.status === 503 && /queue wait exceeded 20ms/.test(error.message),
  );
  const controller = new AbortController();
  let canceledRan = false;
  const canceled = congested(() => { canceledRan = true; }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(canceled, (error) => error.code === "ABORT_ERR");
  unblock();
  await Promise.all([first, second]);
  assert.equal(timedOutRan, false);
  assert.equal(canceledRan, false);
});

test("active request cancellation reaches the CLI and promptly frees provider capacity", async () => {
  const schedule = createProviderScheduler({ concurrency: 2, waitMs: 1_000 });
  const controller = new AbortController();
  let child;
  const first = schedule(() => serveBridgeChat({
    body: { model: "test-model", messages: [{ role: "user", content: "hello" }] },
    models: ["test-model"],
    signal: controller.signal,
    upstream: (_payload, { signal }) => runCliProcess({
      command: "fake-cli",
      args: [],
      options: {},
      signal,
      timeout: 1_000,
      label: "Fake CLI",
      decode: () => ({ object: "chat.completion", choices: [] }),
      spawnImpl: () => {
        child = fakeCliProcess();
        return child;
      },
    }),
  }), { signal: controller.signal });

  let releaseSecond;
  const second = schedule(() => new Promise((resolve) => { releaseSecond = resolve; }));
  let thirdStarted = false;
  const third = schedule(() => {
    thirdStarted = true;
    return "third";
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(child);
  assert.equal(thirdStarted, false);
  controller.abort();

  const canceled = await first;
  assert.equal(canceled.status, 502);
  assert.match(canceled.json.error.message, /provider request was canceled/);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(await third, "third");
  assert.equal(thirdStarted, true);
  releaseSecond();
  await second;
});

test("CLI timeout terminates the process and rejects without waiting for process exit", async () => {
  const child = fakeCliProcess();
  await assert.rejects(
    runCliProcess({
      command: "fake-cli",
      args: [],
      options: {},
      timeout: 10,
      label: "Fake CLI",
      decode: () => ({}),
      spawnImpl: () => child,
    }),
    /Fake CLI timed out after 10ms/,
  );
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("bridge accepts 128 KiB aggregate JSON bodies and rejects one byte more", async () => {
  const empty = JSON.stringify({ padding: "" });
  const exact = Buffer.from(JSON.stringify({
    padding: "x".repeat(MAX_REQUEST_BODY_BYTES - Buffer.byteLength(empty)),
  }));
  assert.equal(exact.length, MAX_REQUEST_BODY_BYTES);
  assert.equal((await readBridgeJson(streamedRequest(exact))).padding.length,
    MAX_REQUEST_BODY_BYTES - Buffer.byteLength(empty));

  const oversized = Buffer.from(JSON.stringify({
    padding: "x".repeat(MAX_REQUEST_BODY_BYTES - Buffer.byteLength(empty) + 1),
  }));
  await assert.rejects(
    readBridgeJson(streamedRequest(oversized, 0)),
    (error) => error.status === 413,
  );
  await assert.rejects(
    readBridgeJson(streamedRequest(Buffer.from("{}"), MAX_REQUEST_BODY_BYTES + 1)),
    (error) => error.status === 413,
  );
});

test("bridge rejects browser-originated and non-JSON provider requests", () => {
  assert.doesNotThrow(() => validateBridgeRequest({
    headers: { "content-type": "application/json; charset=utf-8" },
  }));
  assert.throws(
    () => validateBridgeRequest({ headers: { "content-type": "text/plain" } }),
    (error) => error.status === 415,
  );
  assert.throws(
    () => validateBridgeRequest({
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
    }),
    (error) => error.status === 403,
  );
  assert.throws(
    () => validateBridgeRequest({
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
    }),
    (error) => error.status === 403,
  );
});
