import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileSessionStore } from "../src/sessions.mjs";

const salt = "test-session-action-salt";

test("file sessions round-trip JSON-safe actions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-session-action-"));
  const filePath = join(directory, "sessions.json");
  const cyclic = { type: "invalid" };
  cyclic.self = cyclic;
  try {
    const store = await createFileSessionStore({ filePath, salt });
    await store.set("ActionKid", "wizard", [
      {
        question: "Build a wool farm",
        answer: "I’ll build it now.",
        requestId: "farm-1",
        goalId: "goal-farm-1",
        status: "pending",
        action: {
          type: "build_machine",
          version: 1,
          plan: { kind: "wool farm" },
          ignored: undefined,
        },
      },
      { question: "Bad action", answer: "No action.", action: cyclic },
    ]);

    const reloaded = await createFileSessionStore({ filePath, salt });
    assert.deepEqual(reloaded.get("ActionKid", "wizard"), [
      {
        question: "Build a wool farm",
        answer: "I’ll build it now.",
        action: { type: "build_machine", version: 1, plan: { kind: "wool farm" } },
        requestId: "farm-1",
        goalId: "goal-farm-1",
        status: "pending",
        requestSequence: 1,
      },
      { question: "Bad action", answer: "No action.", action: null, requestSequence: 2 },
    ]);
    const text = await readFile(filePath, "utf8");
    assert.equal(JSON.parse(text).version, 1);
    assert.doesNotMatch(text, /ActionKid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reserved request order survives out-of-order file appends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-session-order-"));
  const filePath = join(directory, "sessions.json");
  try {
    const store = await createFileSessionStore({ filePath, salt });
    const first = store.reserve("OrderKid", "wizard");
    const second = store.reserve("OrderKid", "wizard");
    assert.equal(store.isCurrent("OrderKid", "wizard", first), false);
    assert.equal(store.isCurrent("OrderKid", "wizard", second), true);
    await store.append("OrderKid", "wizard", {
      question: "second", answer: "fast", action: null, requestSequence: second,
    });
    await store.append("OrderKid", "wizard", {
      question: "first", answer: "slow", action: null, requestSequence: first,
    });
    assert.deepEqual(store.get("OrderKid", "wizard").map(({ question }) => question), ["first", "second"]);

    const reloaded = await createFileSessionStore({ filePath, salt });
    assert.deepEqual(reloaded.get("OrderKid", "wizard").map(({ question }) => question), ["first", "second"]);
    assert.equal(reloaded.reserve("OrderKid", "wizard"), 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a file append cannot publish a reply superseded while persistence is pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-session-current-"));
  const filePath = join(directory, "sessions.json");
  try {
    const store = await createFileSessionStore({ filePath, salt });
    const first = store.reserve("OrderKid", "wizard");
    const pending = store.appendIfCurrent("OrderKid", "wizard", {
      question: "old request", answer: "old reply", action: null, requestSequence: first,
    });
    store.reserve("OrderKid", "wizard");
    assert.equal(await pending, false);
    assert.deepEqual(store.get("OrderKid", "wizard"), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an active action survives dialogue trimming until its terminal result arrives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-active-action-"));
  const filePath = join(directory, "sessions.json");
  try {
    const store = await createFileSessionStore({ filePath, salt, maxTurns: 2 });
    const actionSequence = store.reserve("BusyKid", "wizard");
    await store.append("BusyKid", "wizard", {
      question: "Build a castle",
      answer: "I’ll build it now.",
      action: { type: "build_structure", version: 1, plan: { kind: "castle" } },
      requestId: "castle-long-build",
      status: "pending",
      requestSequence: actionSequence,
    });
    await store.updateAction("BusyKid", "wizard", {
      requestId: "castle-long-build", status: "started",
    });
    for (const question of ["How is it going?", "Tell me a joke while I wait"]) {
      await store.append("BusyKid", "wizard", {
        question,
        answer: "Still working.",
        action: null,
        requestSequence: store.reserve("BusyKid", "wizard"),
      });
    }

    assert.equal(store.get("BusyKid", "wizard").length, 3);
    assert.deepEqual(await store.updateAction("BusyKid", "wizard", {
      requestId: "castle-long-build",
      status: "completed",
      detail: "all blocks verified",
    }), { matched: true, updated: true, status: "completed" });

    const reloaded = await createFileSessionStore({ filePath, salt, maxTurns: 2 });
    const action = reloaded.get("BusyKid", "wizard")
      .find(({ requestId }) => requestId === "castle-long-build");
    assert.equal(action?.status, "completed");
    assert.equal(action?.detail, "all blocks verified");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("action results persist, bound details, and stay idempotent after completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-session-results-"));
  const filePath = join(directory, "sessions.json");
  try {
    const store = await createFileSessionStore({ filePath, salt });
    await store.set("ActionKid", "wizard", [{
      question: "Build a castle",
      answer: "I’ll build it.",
      action: { type: "build_structure", version: 1, plan: { kind: "castle" } },
      requestId: "castle-1",
      status: "pending",
    }]);
    assert.deepEqual(await store.updateAction("ActionKid", "wizard", {
      requestId: "castle-1", status: "started", detail: "placing\nblocks",
    }), { matched: true, updated: true, status: "started" });
    assert.deepEqual(await store.updateAction("ActionKid", "wizard", {
      requestId: "castle-1", status: "started", detail: "duplicate",
    }), { matched: true, updated: false, status: "started" });
    assert.deepEqual(await store.updateAction("ActionKid", "wizard", {
      requestId: "castle-1", status: "completed", detail: "all blocks verified",
    }), { matched: true, updated: true, status: "completed" });
    assert.deepEqual(await store.updateAction("ActionKid", "wizard", {
      requestId: "castle-1", status: "failed", detail: "late failure",
    }), { matched: true, updated: false, status: "completed" });

    const reloaded = await createFileSessionStore({ filePath, salt });
    assert.equal(reloaded.get("ActionKid", "wizard")[0].status, "completed");
    assert.equal(reloaded.get("ActionKid", "wizard")[0].detail, "all blocks verified");
    const terminalResult = {
      matched: true,
      updated: true,
      replan: { requestId: "castle-replan", answer: "I’ll repair it.", action: null },
    };
    assert.equal(await reloaded.setActionResult("ActionKid", "wizard", "castle-1", terminalResult), true);
    const restarted = await createFileSessionStore({ filePath, salt });
    assert.deepEqual(restarted.getActionResult("ActionKid", "wizard", "castle-1"), terminalResult);
    assert.equal(restarted.getActionResult("ActionKid", "wizard", "toString"), undefined);
    assert.equal(await restarted.setActionResult("ActionKid", "wizard", "__proto__", terminalResult), true);
    assert.deepEqual(restarted.getActionResult("ActionKid", "wizard", "__proto__"), terminalResult);
    assert.equal({}.matched, undefined);
    assert.deepEqual(await reloaded.updateAction("ActionKid", "wizard", {
      requestId: "missing", status: "started",
    }), { matched: false, updated: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy version 1 action turns migrate to an unknown outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-legacy-session-"));
  const filePath = join(directory, "sessions.json");
  const player = "LegacyKid";
  const playerHash = createHmac("sha256", salt).update(player).digest("hex");
  try {
    await writeFile(filePath, JSON.stringify({
      version: 1,
      behaviorRevision: 3,
      sessions: {
        [`wizard:${playerHash}`]: {
          updatedAt: 1_000,
          turns: [
            { question: "What were we doing?", answer: "Building a castle." },
            {
              question: "Build it",
              answer: "I’ll build it.",
              action: { type: "build_structure", version: 1, plan: { kind: "castle" } },
            },
          ],
        },
      },
    }));
    const store = await createFileSessionStore({ filePath, salt, now: () => 1_000 });
    assert.deepEqual(store.get(player, "wizard"), [
      {
        question: "What were we doing?",
        answer: "Building a castle.",
        action: null,
        requestSequence: 1,
      },
      {
        question: "Build it",
        answer: "I’ll build it.",
        action: { type: "build_structure", version: 1, plan: { kind: "castle" } },
        status: "unknown",
        requestSequence: 2,
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("discards dialogue from an incompatible agent behavior revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-wizard-stale-session-"));
  const filePath = join(directory, "sessions.json");
  const player = "StaleKid";
  const playerHash = createHmac("sha256", salt).update(player).digest("hex");
  try {
    await writeFile(filePath, JSON.stringify({
      version: 1,
      behaviorRevision: 2,
      sessions: {
        [`wizard:${playerHash}`]: {
          updatedAt: 1_000,
          turns: [{
            question: "Build a portal",
            answer: "I built a portal.",
            action: { type: "build_structure", version: 1, plan: { kind: "nether portal" } },
          }],
        },
      },
    }));
    const store = await createFileSessionStore({ filePath, salt, now: () => 1_000 });
    assert.deepEqual(store.get(player, "wizard"), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
