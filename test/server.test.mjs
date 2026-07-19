import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInteractionLog, readRecentInteractions } from "../src/interaction-log.mjs";
import { createHttpServer, validateActionResultBody } from "../src/server.mjs";

const salt = "test-server-telemetry-salt";
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

test("gate telemetry is logged for the operator but stripped from the pack response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-server-telemetry-"));
  const filePath = join(directory, "interactions.jsonl");
  const interactionLog = createInteractionLog({ filePath, salt });
  const wizard = {
    provider: "TestProvider",
    async ask() {
      return {
        answer: "I could not finish that plan, so here is a starter guide.",
        requestId: "telemetry-request",
        mode: "local-structure-fallback",
        telemetry: {
          providerConsulted: true,
          rejections: [
            { gate: "intent-match", reason: "TelemetryKid asked for a dragon but the plan was a house" },
            { gate: "build-contract", reason: "plan kind mismatch" },
          ],
        },
      };
    },
  };
  const server = createHttpServer({
    wizard, corpus: { size: 1 }, token: "test-token", interactionLog, cooldownMs: 0, logger: quiet,
  });
  try {
    const ask = await dispatch(server, {
      method: "POST", url: "/v1/ask", token: "test-token",
      body: { player: "TelemetryKid", question: "Build me a dragon" },
    });
    assert.equal(ask.status, 200);
    const clientResult = JSON.parse(ask.body);
    assert.equal("telemetry" in clientResult, false);
    assert.doesNotMatch(ask.body, /rejections|providerConsulted|intent-match/);
    assert.equal(clientResult.requestId, "telemetry-request");

    const [entry] = await readRecentInteractions(filePath);
    assert.equal(entry.event, "ask");
    assert.equal(entry.providerConsulted, true);
    assert.deepEqual(entry.rejections, [
      { gate: "intent-match", reason: "[player] asked for a dragon but the plan was a house" },
      { gate: "build-contract", reason: "plan kind mismatch" },
    ]);
    assert.doesNotMatch(await readFile(filePath, "utf8"), /TelemetryKid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a clean accepted result logs providerConsulted=false and no rejections key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-server-clean-"));
  const filePath = join(directory, "interactions.jsonl");
  const interactionLog = createInteractionLog({ filePath, salt });
  const wizard = {
    provider: "TestProvider",
    async ask() {
      return {
        answer: "Building it now.",
        requestId: "clean-request",
        action: { type: "build_structure", plan: { title: "Small House" } },
        telemetry: { providerConsulted: false, rejections: [] },
      };
    },
  };
  const server = createHttpServer({
    wizard, corpus: { size: 1 }, token: "test-token", interactionLog, cooldownMs: 0, logger: quiet,
  });
  try {
    const ask = await dispatch(server, {
      method: "POST", url: "/v1/ask", token: "test-token",
      body: { player: "CleanKid", question: "Build a house" },
    });
    assert.equal(ask.status, 200);
    assert.equal("telemetry" in JSON.parse(ask.body), false);
    const [entry] = await readRecentInteractions(filePath);
    assert.equal(entry.providerConsulted, false);
    assert.equal("rejections" in entry, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// The pack slices action-result detail at 1600 characters (main.js) so salvage
// drop records and violation lists arrive whole; the server cap must match or
// every long terminal report would be deterministically rejected with a 400.
test("a 1600-character action-result detail round-trips to the brain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-server-detail-"));
  const filePath = join(directory, "interactions.jsonl");
  const interactionLog = createInteractionLog({ filePath, salt });
  const recorded = [];
  const wizard = {
    provider: "TestProvider",
    async recordActionResult(result) {
      recorded.push(result);
      return { matched: true, updated: true, status: result.status };
    },
  };
  const server = createHttpServer({
    wizard, corpus: { size: 1 }, token: "test-token", interactionLog, cooldownMs: 0, logger: quiet,
  });
  const detail = `salvage dropped 24 entries: ${"x".repeat(1600)}`.slice(0, 1600);
  assert.equal(detail.length, 1600);
  try {
    const response = await dispatch(server, {
      method: "POST", url: "/v1/action-result", token: "test-token",
      body: { player: "SalvageKid", requestId: "salvage-req-1", status: "partial", detail },
    });
    assert.equal(response.status, 200, response.body);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].detail, detail, "the full 1600-character detail reaches recordActionResult");
    assert.equal(recorded[0].status, "partial");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an action-result detail over 1600 characters is rejected with 400 before the brain sees it", async () => {
  // Boundary unit checks against the validator itself.
  const base = { player: "SalvageKid", requestId: "salvage-req-2", status: "partial" };
  assert.equal(
    validateActionResultBody({ ...base, detail: "x".repeat(1600) }).detail.length,
    1600,
    "exactly 1600 characters is accepted",
  );
  assert.throws(
    () => validateActionResultBody({ ...base, detail: "x".repeat(1601) }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /at most 1600 characters/);
      return true;
    },
  );
  // End-to-end: the handler returns the 400 and recordActionResult never runs.
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-server-detail-overflow-"));
  const filePath = join(directory, "interactions.jsonl");
  const interactionLog = createInteractionLog({ filePath, salt });
  const recorded = [];
  const wizard = {
    provider: "TestProvider",
    async recordActionResult(result) {
      recorded.push(result);
      return { matched: true, updated: true, status: result.status };
    },
  };
  const server = createHttpServer({
    wizard, corpus: { size: 1 }, token: "test-token", interactionLog, cooldownMs: 0, logger: quiet,
  });
  try {
    const response = await dispatch(server, {
      method: "POST", url: "/v1/action-result", token: "test-token",
      body: { ...base, detail: "x".repeat(1601) },
    });
    assert.equal(response.status, 400);
    assert.match(response.body, /at most 1600 characters/);
    assert.equal(recorded.length, 0, "the oversized report never reaches the brain");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("results without telemetry keep their existing log shape", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-server-no-telemetry-"));
  const filePath = join(directory, "interactions.jsonl");
  const interactionLog = createInteractionLog({ filePath, salt });
  const wizard = {
    provider: "TestProvider",
    async ask() {
      return { answer: "Hello!", requestId: "plain-request" };
    },
  };
  const server = createHttpServer({
    wizard, corpus: { size: 1 }, token: "test-token", interactionLog, cooldownMs: 0, logger: quiet,
  });
  try {
    const ask = await dispatch(server, {
      method: "POST", url: "/v1/ask", token: "test-token",
      body: { player: "PlainKid", question: "hello" },
    });
    assert.equal(ask.status, 200);
    const [entry] = await readRecentInteractions(filePath);
    assert.equal("providerConsulted" in entry, false);
    assert.equal("rejections" in entry, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
