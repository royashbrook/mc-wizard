import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInteractionLog, readRecentInteractions } from "../src/interaction-log.mjs";
import { createHttpServer, validateFeedbackBody } from "../src/server.mjs";
import { createFileSessionStore, createMemorySessionStore } from "../src/sessions.mjs";
import { createWizard } from "../src/wizard.mjs";

const corpus = { size: 1, search: () => [] };
const quiet = { log() {}, warn() {}, error() {} };
const salt = "test-feedback-private-salt";
const adminSource = await readFile(new URL("../src/admin.mjs", import.meta.url), "utf8");

async function dispatch(server, { method = "GET", url = "/", body, token } = {}) {
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
  return { status: response.status, value: JSON.parse(response.body) };
}

test("validates a bounded exact feedback request", () => {
  assert.deepEqual(validateFeedbackBody({
    player: " Feedback Kid! ",
    requestId: "request-1",
    grade: 2,
    feedback: "too\n  dark",
  }), {
    player: "Feedback Kid",
    requestId: "request-1",
    grade: 2,
    feedback: "too dark",
  });
  for (const grade of [0, 6, 2.5, "2"]) {
    assert.throws(() => validateFeedbackBody({
      player: "Kid", requestId: "request-1", grade,
    }), /grade must be an integer from 1 to 5/);
  }
  assert.throws(() => validateFeedbackBody({
    player: "Kid", requestId: "not safe!", grade: 3,
  }), /requestId/);
  assert.throws(() => validateFeedbackBody({
    player: "Kid", requestId: "request-1", grade: 3, feedback: "x".repeat(501),
  }), /feedback must be at most 500 characters/);
});

test("the operator desk renders grades, notes, follow-ups, and a distribution", () => {
  assert.match(adminSource, /entry\.event==="feedback"/);
  assert.match(adminSource, /entry\.grade\+'\/5'/);
  assert.match(adminSource, /function feedbackSummary\(entries\)/);
  assert.match(adminSource, /\.toFixed\(1\)/);
  assert.match(adminSource, /grades · average/);
  assert.match(adminSource, /\[1,2,3,4,5\]/);
});

test("file sessions bind one bounded grade to the exact terminal request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-feedback-session-"));
  const filePath = join(directory, "sessions.json");
  try {
    const store = await createFileSessionStore({ filePath, salt });
    await store.set("FeedbackKid", "wizard", [{
      question: "Build a castle",
      answer: "I’ll build it.",
      action: { type: "build_structure", version: 1, plan: { title: "Castle" } },
      goal: { objective: "Build a castle", successCriteria: "Castle exists", status: "active" },
      requestId: "castle-request",
      goalId: "castle-goal",
      status: "pending",
      responseMode: "local-skill",
    }]);
    const pending = await store.recordFeedback("FeedbackKid", "wizard", {
      requestId: "castle-request", grade: 2, note: "make it taller",
    });
    assert.equal(pending.pending, true);
    assert.equal(pending.recorded, false);
    assert.deepEqual(await store.recordFeedback("AnotherKid", "wizard", {
      requestId: "castle-request", grade: 2, note: "make it taller",
    }), { matched: false, recorded: false, duplicate: false });

    await store.updateAction("FeedbackKid", "wizard", {
      requestId: "castle-request", status: "completed", detail: "verified",
    });
    const recorded = await store.recordFeedback("FeedbackKid", "wizard", {
      requestId: "castle-request", grade: 2,
    });
    assert.equal(recorded.recorded, true);
    assert.equal(recorded.goalId, "castle-goal");
    assert.equal(recorded.responseMode, "local-skill");
    const enriched = await store.recordFeedback("FeedbackKid", "wizard", {
      requestId: "castle-request", grade: 2, note: "make it taller",
    });
    assert.equal(enriched.recorded, true);
    assert.equal(enriched.note, "make it taller");
    const duplicate = await store.recordFeedback("FeedbackKid", "wizard", {
      requestId: "castle-request", grade: 1, note: "different note",
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.grade, 2);

    const reloaded = await createFileSessionStore({ filePath, salt });
    assert.deepEqual(reloaded.get("FeedbackKid", "wizard")[0].feedback, {
      grade: 2, note: "make it taller",
    });
    assert.equal(reloaded.get("FeedbackKid", "wizard")[0].responseMode, "local-skill");
    assert.doesNotMatch(await readFile(filePath, "utf8"), /FeedbackKid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("project feedback becomes a same-goal refinement instruction", async () => {
  const sessions = createMemorySessionStore();
  const wizard = createWizard({ corpus, sessions, env: {}, logger: quiet });
  const initial = await wizard.ask({
    player: "ProjectKid", question: "Build an unlit Nether portal", requestId: "portal-request",
  });
  await sessions.updateAction("ProjectKid", "wizard", {
    requestId: initial.requestId, status: "completed", detail: "verified",
  });

  const result = await wizard.recordFeedback({
    player: "ProjectKid",
    requestId: initial.requestId,
    grade: 2,
    feedback: "light the portal",
  });
  assert.equal(result.matched, true);
  assert.equal(result.recorded, true);
  assert.equal(result.goalId, initial.goalId);
  assert.match(result.message, /same project/i);
  assert.equal(result.followUp.goalId, initial.goalId);
  assert.equal(result.followUp.action.type, "build_machine");
  assert.equal(result.followUp.action.plan.mode, "modify");
  assert.equal(result.followUp.action.plan.interactions.length, 1);
  assert.equal(sessions.get("ProjectKid", "wizard").at(-1).goalId, initial.goalId);
});

test("a high grade with praise closes cleanly instead of inventing corrective work", async () => {
  const sessions = createMemorySessionStore();
  const wizard = createWizard({ corpus, sessions, env: {}, logger: quiet });
  const initial = await wizard.ask({
    player: "PraiseKid", question: "give me night vision", requestId: "effect-request",
  });
  await sessions.updateAction("PraiseKid", "wizard", {
    requestId: initial.requestId, status: "completed", detail: "effect applied",
  });
  const result = await wizard.recordFeedback({
    player: "PraiseKid",
    requestId: initial.requestId,
    grade: 5,
    feedback: "for giving me night vision because it worked",
  });
  assert.match(result.message, /glad that worked/i);
  assert.equal(result.followUp, undefined);
});

test("a high grade still applies short concrete corrections to the active project", async () => {
  for (const feedback of [
    "more windows", "taller", "not enough light", "windows", "too short", "needs windows",
    "chimney", "needs a porch", "more color", "brighter", "darker", "ugly",
  ]) {
    const player = `CorrectionKid-${feedback}`;
    const sessions = createMemorySessionStore();
    const wizard = createWizard({ corpus, sessions, env: {}, logger: quiet });
    const initial = await wizard.ask({ player, question: "Build a house", requestId: `house-${feedback}` });
    await sessions.updateAction(player, "wizard", {
      requestId: initial.requestId, status: "completed", detail: "house placed",
    });
    const result = await wizard.recordFeedback({
      player, requestId: initial.requestId, grade: 5, feedback,
    });
    assert.match(result.message, /next instruction|improving/i, feedback);
    assert.ok(result.followUp, feedback);
  }
});

test("informational feedback regenerates an answer without a world action", async () => {
  const sessions = createMemorySessionStore();
  let calls = 0;
  const responses = [
    "Cats can be tamed with raw cod or salmon.",
    "Hold raw cod or salmon, approach gently, and feed the cat until hearts appear.",
  ];
  const wizard = createWizard({
    corpus,
    sessions,
    env: { AI_BASE_URL: "http://model/v1", AI_MODEL: "helper", AI_STYLE: "chat" },
    logger: quiet,
    fetchImpl: async () => {
      const answer = responses[calls++];
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ answer, action: null, goal: null }) } }],
      }), { status: 200 });
    },
  });
  const initial = await wizard.ask({
    player: "CatKid", question: "How do I tame a cat?", requestId: "cat-request",
  });
  assert.equal(initial.action, null);
  const result = await wizard.recordFeedback({
    player: "CatKid",
    requestId: initial.requestId,
    grade: 3,
    feedback: "make that easier for a nine year old",
  });
  assert.equal(calls, 2);
  assert.equal(result.followUp.action, null);
  assert.match(result.followUp.answer, /approach gently/i);
  assert.equal(result.followUp.goal, undefined);
  assert.equal(sessions.get("CatKid", "wizard")[0].responseMode, "chat:helper");
});

test("actionable feedback after an informational miss performs the requested world action", async () => {
  const sessions = createMemorySessionStore();
  const wizard = createWizard({ corpus, sessions, env: {}, logger: quiet });
  const missed = await wizard.ask({
    player: "LostKid", question: "How do cats work?", requestId: "missed-request",
  });
  assert.equal(missed.action, null);

  const result = await wizard.recordFeedback({
    player: "LostKid",
    requestId: missed.requestId,
    grade: 1,
    feedback: "build and light a netherportal",
  });
  assert.match(result.message, /doing it now/i);
  assert.equal(result.followUp.action.type, "build_machine");
  assert.equal(result.followUp.action.plan.kind, "nether portal");
  assert.equal(result.followUp.action.plan.interactions[0].itemId, "minecraft:flint_and_steel");
});

test("actionable feedback can replace a failed goal attempt with a command-backed solution", async () => {
  const sessions = createMemorySessionStore();
  const wizard = createWizard({ corpus, sessions, env: {}, logger: quiet });
  const initial = await wizard.ask({
    player: "DarkKid", question: "light up this area", requestId: "lighting-request",
  });
  assert.equal(initial.action.type, "place_area_torches");
  await sessions.updateAction("DarkKid", "wizard", {
    requestId: initial.requestId, status: "failed", detail: "the first lighting spell failed",
  });

  const result = await wizard.recordFeedback({
    player: "DarkKid",
    requestId: initial.requestId,
    grade: 1,
    feedback: "give me night vision",
  });
  assert.match(result.message, /doing it now/i);
  assert.equal(result.followUp.goalId, initial.goalId);
  assert.deepEqual(result.followUp.action.commands, ["effect @s night_vision 999999 0 true"]);
});

test("a command request executes even while an earlier command goal is still active", async () => {
  const sessions = createMemorySessionStore();
  const wizard = createWizard({ corpus, sessions, env: {}, logger: quiet });
  const first = await wizard.ask({
    player: "CommandKid", question: "give me night vision", requestId: "effect-request",
  });
  await sessions.updateAction("CommandKid", "wizard", {
    requestId: first.requestId, status: "completed", detail: "effect applied",
  });
  const second = await wizard.ask({
    player: "CommandKid", question: "light up this area", requestId: "light-request",
  });
  assert.deepEqual(second.action, { type: "place_area_torches", version: 1 });
});

test("feedback endpoint is private, exact, terminal, idempotent, and logged without gamertags", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-feedback-server-"));
  const filePath = join(directory, "interactions.jsonl");
  const sessions = createMemorySessionStore();
  const wizard = createWizard({ corpus, sessions, env: {}, logger: quiet });
  const interactionLog = createInteractionLog({ filePath, salt });
  const server = createHttpServer({
    wizard, corpus, token: "feedback-token", interactionLog, cooldownMs: 0, logger: quiet,
  });
  try {
    const unauthorized = await dispatch(server, {
      method: "POST", url: "/v1/feedback",
      body: { player: "ServerKid", requestId: "info-request", grade: 5 },
    });
    assert.equal(unauthorized.status, 401);

    const ask = await dispatch(server, {
      method: "POST", url: "/v1/ask", token: "feedback-token",
      body: { player: "ServerKid", requestId: "info-request", question: "Tell me about cats" },
    });
    assert.equal(ask.status, 200);
    const crossPlayer = await dispatch(server, {
      method: "POST", url: "/v1/feedback", token: "feedback-token",
      body: { player: "OtherKid", requestId: "info-request", grade: 5 },
    });
    assert.equal(crossPlayer.status, 404);
    const recorded = await dispatch(server, {
      method: "POST", url: "/v1/feedback", token: "feedback-token",
      body: {
        player: "ServerKid",
        requestId: "info-request",
        grade: 5,
        feedback: "ServerKid wants a shorter answer",
      },
    });
    assert.equal(recorded.status, 200);
    assert.equal(recorded.value.recorded, true);
    assert.equal(recorded.value.followUp.action, null);
    const duplicate = await dispatch(server, {
      method: "POST", url: "/v1/feedback", token: "feedback-token",
      body: { player: "ServerKid", requestId: "info-request", grade: 1, feedback: "again" },
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.value.duplicate, true);

    const build = await dispatch(server, {
      method: "POST", url: "/v1/ask", token: "feedback-token",
      body: { player: "ServerKid", requestId: "build-request", question: "Build a house" },
    });
    assert.equal(build.status, 200);
    const pending = await dispatch(server, {
      method: "POST", url: "/v1/feedback", token: "feedback-token",
      body: { player: "ServerKid", requestId: "build-request", grade: 2, feedback: "too small" },
    });
    assert.equal(pending.status, 409);

    const entries = await readRecentInteractions(filePath);
    assert.deepEqual(entries.map(({ event }) => event), ["ask", "feedback", "ask"]);
    assert.equal(entries[1].grade, 5);
    assert.equal(entries[1].note, "[player] wants a shorter answer");
    assert.equal(entries[1].outcome.status, "answered");
    assert.equal(entries[1].followUp.requestId, recorded.value.followUp.requestId);
    assert.match(entries[1].followUp.answer, /clearer try/i);
    assert.doesNotMatch(await readFile(filePath, "utf8"), /ServerKid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
