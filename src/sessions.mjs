import { createHmac } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const REQUEST_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const ACTION_STATUSES = new Set(["pending", "started", "completed", "failed", "unknown"]);
// Bump this when persisted dialogue from an older agent contract would teach the
// current planner false capabilities or revive invalid projects.
const BEHAVIOR_REVISION = 3;
const safeSequence = (value) => Number.isSafeInteger(value) && value >= 1 ? value : undefined;

function safeDetail(value) {
  if (typeof value !== "string") return undefined;
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500) || undefined;
}

function safeResponseMode(value) {
  return safeDetail(value)?.slice(0, 64);
}

function safeFeedback(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isInteger(value.grade) || value.grade < 1 || value.grade > 5) return undefined;
  const note = safeDetail(value.note);
  return { grade: value.grade, ...(note && { note }) };
}

function persistedTurn(turn) {
  let action = null;
  if (turn?.action && typeof turn.action === "object" && !Array.isArray(turn.action)) {
    try {
      const value = JSON.parse(JSON.stringify(turn.action));
      if (value && typeof value === "object" && !Array.isArray(value)) action = value;
    } catch {}
  }
  let goal = null;
  if (turn?.goal && typeof turn.goal === "object" && !Array.isArray(turn.goal)) {
    try {
      const value = JSON.parse(JSON.stringify(turn.goal));
      if (value && typeof value === "object" && !Array.isArray(value)) goal = value;
    } catch {}
  }
  const requestId = typeof turn?.requestId === "string" && REQUEST_ID.test(turn.requestId)
    ? turn.requestId : undefined;
  const goalId = typeof turn?.goalId === "string" && REQUEST_ID.test(turn.goalId)
    ? turn.goalId : undefined;
  const status = action && ACTION_STATUSES.has(turn?.status) ? turn.status : action ? "unknown" : undefined;
  const detail = action ? safeDetail(turn?.detail) : undefined;
  const responseMode = safeResponseMode(turn?.responseMode);
  const feedback = safeFeedback(turn?.feedback);
  const requestSequence = safeSequence(turn?.requestSequence);
  return {
    question: turn?.question,
    answer: turn?.answer,
    action,
    ...(goal && { goal }),
    ...(requestId && { requestId }),
    ...(goalId && { goalId }),
    ...(status && { status }),
    ...(detail && { detail }),
    ...(responseMode && { responseMode }),
    ...(feedback && { feedback }),
    ...(requestSequence && { requestSequence }),
  };
}

function normalizedTurns(turns) {
  let next = turns.reduce((maximum, turn) => (
    Math.max(maximum, safeSequence(turn?.requestSequence) || 0)
  ), 0);
  return turns.map((turn) => {
    const saved = persistedTurn(turn);
    return saved.requestSequence ? saved : { ...saved, requestSequence: ++next };
  }).sort((a, b) => a.requestSequence - b.requestSequence);
}

const unresolvedAction = (turn) => turn?.action
  && ["pending", "started"].includes(turn.status);

function trimTurns(turns, maxTurns) {
  const recentStart = Math.max(0, turns.length - maxTurns);
  return turns.filter((turn, index) => index >= recentStart || unresolvedAction(turn));
}

const latestSequence = (turns) => (Array.isArray(turns) ? turns : [])
  .reduce((maximum, turn) => Math.max(maximum, turn.requestSequence || 0), 0);

function reserveSequence(sequences, key, turns = []) {
  const current = Math.max(sequences.get(key) || 0, latestSequence(turns));
  if (current >= Number.MAX_SAFE_INTEGER) throw new Error("session request sequence exhausted");
  const sequence = current + 1;
  sequences.set(key, sequence);
  return sequence;
}

function appendTurn(session, turn, maxTurns) {
  const saved = persistedTurn(turn);
  const turns = session.turns.filter((entry) => entry.requestSequence !== saved.requestSequence);
  turns.push(saved);
  turns.sort((a, b) => a.requestSequence - b.requestSequence);
  session.turns = trimTurns(turns, maxTurns);
}

function updateAction(turns, requestId, status, detail) {
  if (!REQUEST_ID.test(requestId) || !["started", "completed", "failed"].includes(status)) {
    return { matched: false, updated: false };
  }
  const index = turns.findLastIndex((turn) => turn.action && turn.requestId === requestId);
  if (index < 0) return { matched: false, updated: false };
  const current = turns[index].status || "unknown";
  if (current === status) return { matched: true, updated: false, status: current };
  if (["completed", "failed"].includes(current)) {
    return { matched: true, updated: false, status: current };
  }
  turns[index] = persistedTurn({ ...turns[index], status, detail });
  return { matched: true, updated: true, status };
}

function feedbackBinding(turn, extra = {}) {
  const goalId = turn.goalId || (turn.goal ? turn.requestId : undefined);
  return {
    matched: true,
    requestId: turn.requestId,
    ...(goalId && { goalId }),
    question: turn.question,
    answer: turn.answer,
    action: turn.action,
    ...(turn.goal && { goal: turn.goal }),
    ...(turn.status && { status: turn.status }),
    ...(turn.detail && { detail: turn.detail }),
    ...(turn.responseMode && { responseMode: turn.responseMode }),
    ...extra,
  };
}

function updateFeedback(turns, requestId, grade, note) {
  if (!REQUEST_ID.test(requestId) || !Number.isInteger(grade) || grade < 1 || grade > 5) {
    return { matched: false, recorded: false, duplicate: false };
  }
  const index = turns.findLastIndex((turn) => turn.requestId === requestId);
  if (index < 0) return { matched: false, recorded: false, duplicate: false };
  const turn = turns[index];
  if (turn.action && ["pending", "started", "unknown"].includes(turn.status)) {
    return feedbackBinding(turn, { recorded: false, duplicate: false, pending: true });
  }
  const cleanNote = safeDetail(note);
  if (turn.feedback && (turn.feedback.note || turn.feedback.grade >= 4 || !cleanNote)) {
    return feedbackBinding(turn, {
      recorded: false,
      duplicate: true,
      grade: turn.feedback.grade,
      ...(turn.feedback.note && { note: turn.feedback.note }),
    });
  }
  const feedback = safeFeedback({ grade, note: cleanNote });
  turns[index] = persistedTurn({ ...turn, feedback });
  return feedbackBinding(turns[index], {
    recorded: true,
    duplicate: false,
    grade: feedback.grade,
    ...(feedback.note && { note: feedback.note }),
  });
}

export function createMemorySessionStore({ maxTurns = 12 } = {}) {
  const sessions = new Map();
  const sequences = new Map();
  return {
    get(player, mode) {
      return sessions.get(`${mode}:${player}`)?.turns || [];
    },
    async set(player, mode, turns) {
      const key = `${mode}:${player}`;
      const normalized = trimTurns(normalizedTurns(turns), maxTurns);
      sessions.set(key, {
        turns: normalized,
        updatedAt: Date.now(),
      });
      sequences.set(key, Math.max(sequences.get(key) || 0, latestSequence(normalized)));
    },
    reserve(player, mode) {
      const key = `${mode}:${player}`;
      return reserveSequence(sequences, key, sessions.get(key)?.turns);
    },
    isCurrent(player, mode, requestSequence) {
      return safeSequence(requestSequence) === sequences.get(`${mode}:${player}`);
    },
    async appendIfCurrent(player, mode, turn) {
      const key = `${mode}:${player}`;
      const requestSequence = safeSequence(turn?.requestSequence);
      if (!requestSequence || requestSequence !== sequences.get(key)) return false;
      const session = sessions.get(key) || { turns: [], updatedAt: 0 };
      appendTurn(session, { ...turn, requestSequence }, maxTurns);
      session.updatedAt = Date.now();
      sessions.set(key, session);
      return true;
    },
    async append(player, mode, turn) {
      const key = `${mode}:${player}`;
      const session = sessions.get(key) || { turns: [], updatedAt: 0 };
      const requestSequence = safeSequence(turn?.requestSequence)
        || reserveSequence(sequences, key, session.turns);
      sequences.set(key, Math.max(sequences.get(key) || 0, requestSequence));
      appendTurn(session, { ...turn, requestSequence }, maxTurns);
      session.updatedAt = Date.now();
      sessions.set(key, session);
    },
    async updateAction(player, mode, result) {
      const session = sessions.get(`${mode}:${player}`);
      if (!session) return { matched: false, updated: false };
      const outcome = updateAction(session.turns, result.requestId, result.status, result.detail);
      if (outcome.updated) session.updatedAt = Date.now();
      return outcome;
    },
    async recordFeedback(player, mode, { requestId, grade, note }) {
      const session = sessions.get(`${mode}:${player}`);
      if (!session) return { matched: false, recorded: false, duplicate: false };
      const outcome = updateFeedback(session.turns, requestId, grade, note);
      if (outcome.recorded) session.updatedAt = Date.now();
      return outcome;
    },
    async delete(player, mode) {
      const key = `${mode}:${player}`;
      sequences.delete(key);
      return sessions.delete(key);
    },
  };
}

export async function createFileSessionStore({
  filePath,
  salt,
  maxTurns = 12,
  ttlMs = 24 * 60 * 60 * 1_000,
  maxSessions = 100,
  now = () => Date.now(),
} = {}) {
  if (!filePath) throw new Error("session file path is required");
  if (!salt || salt.length < 16) throw new Error("session salt must be at least 16 characters");
  let data = { version: 1, behaviorRevision: BEHAVIOR_REVISION, sessions: {} };
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (parsed?.version === 1
      && parsed.behaviorRevision === BEHAVIOR_REVISION
      && parsed.sessions
      && typeof parsed.sessions === "object") {
      data = parsed;
      for (const session of Object.values(data.sessions)) {
        session.turns = Array.isArray(session?.turns) ? normalizedTurns(session.turns) : [];
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const keyFor = (player, mode) => {
    const playerHash = createHmac("sha256", salt).update(String(player)).digest("hex");
    return `${mode}:${playerHash}`;
  };
  const sequences = new Map(Object.entries(data.sessions)
    .map(([key, session]) => [key, latestSequence(session.turns)]));
  const prune = () => {
    const cutoff = now() - ttlMs;
    const entries = Object.entries(data.sessions)
      .filter(([, session]) => session.updatedAt >= cutoff)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, maxSessions);
    data.sessions = Object.fromEntries(entries);
  };
  let pendingWrite = Promise.resolve();
  const persist = () => {
    prune();
    pendingWrite = pendingWrite.then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.tmp`;
      await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      await rename(temporary, filePath);
    });
    return pendingWrite;
  };
  prune();

  return {
    get(player, mode) {
      prune();
      return data.sessions[keyFor(player, mode)]?.turns || [];
    },
    async set(player, mode, turns) {
      const key = keyFor(player, mode);
      const normalized = trimTurns(normalizedTurns(turns), maxTurns);
      data.sessions[key] = {
        updatedAt: now(),
        turns: normalized,
      };
      sequences.set(key, Math.max(sequences.get(key) || 0, latestSequence(normalized)));
      await persist();
    },
    reserve(player, mode) {
      const key = keyFor(player, mode);
      return reserveSequence(sequences, key, data.sessions[key]?.turns);
    },
    isCurrent(player, mode, requestSequence) {
      return safeSequence(requestSequence) === sequences.get(keyFor(player, mode));
    },
    async appendIfCurrent(player, mode, turn) {
      const key = keyFor(player, mode);
      const requestSequence = safeSequence(turn?.requestSequence);
      if (!requestSequence || requestSequence !== sequences.get(key)) return false;
      const session = data.sessions[key] || { turns: [], updatedAt: 0 };
      appendTurn(session, { ...turn, requestSequence }, maxTurns);
      session.updatedAt = now();
      data.sessions[key] = session;
      await persist();
      if (requestSequence === sequences.get(key)) return true;
      session.turns = session.turns.filter((entry) => entry.requestSequence !== requestSequence);
      session.updatedAt = now();
      await persist();
      return false;
    },
    async append(player, mode, turn) {
      const key = keyFor(player, mode);
      const session = data.sessions[key] || { turns: [], updatedAt: 0 };
      const requestSequence = safeSequence(turn?.requestSequence)
        || reserveSequence(sequences, key, session.turns);
      sequences.set(key, Math.max(sequences.get(key) || 0, requestSequence));
      appendTurn(session, { ...turn, requestSequence }, maxTurns);
      session.updatedAt = now();
      data.sessions[key] = session;
      await persist();
    },
    async updateAction(player, mode, result) {
      const session = data.sessions[keyFor(player, mode)];
      if (!session) return { matched: false, updated: false };
      const outcome = updateAction(session.turns, result.requestId, result.status, result.detail);
      if (outcome.updated) {
        session.updatedAt = now();
        await persist();
      }
      return outcome;
    },
    async recordFeedback(player, mode, { requestId, grade, note }) {
      const session = data.sessions[keyFor(player, mode)];
      if (!session) return { matched: false, recorded: false, duplicate: false };
      const outcome = updateFeedback(session.turns, requestId, grade, note);
      if (outcome.recorded) {
        session.updatedAt = now();
        await persist();
      }
      return outcome;
    },
    async delete(player, mode) {
      const key = keyFor(player, mode);
      const deleted = delete data.sessions[key];
      sequences.delete(key);
      if (deleted) await persist();
      return deleted;
    },
  };
}
