import { createHmac } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function createMemorySessionStore({ maxTurns = 12 } = {}) {
  const sessions = new Map();
  return {
    get(player, mode) {
      return sessions.get(`${mode}:${player}`)?.turns || [];
    },
    async set(player, mode, turns) {
      sessions.set(`${mode}:${player}`, { turns: turns.slice(-maxTurns), updatedAt: Date.now() });
    },
    async delete(player, mode) {
      return sessions.delete(`${mode}:${player}`);
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
  let data = { version: 1, sessions: {} };
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object") data = parsed;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const keyFor = (player, mode) => {
    const playerHash = createHmac("sha256", salt).update(String(player)).digest("hex");
    return `${mode}:${playerHash}`;
  };
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
      data.sessions[keyFor(player, mode)] = {
        updatedAt: now(),
        turns: turns.slice(-maxTurns).map(({ question, answer }) => ({ question, answer })),
      };
      await persist();
    },
    async delete(player, mode) {
      const deleted = delete data.sessions[keyFor(player, mode)];
      if (deleted) await persist();
      return deleted;
    },
  };
}
