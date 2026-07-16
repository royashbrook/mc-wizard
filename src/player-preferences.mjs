import { createHmac } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_PLAYERS = 200;
const MAX_DISTANCE = 12;
const MIN_DISTANCE = 3;
const KINDS = new Set(["proximity", "material", "teleport"]);

const MATERIALS = [
  ["mushroom blocks", "minecraft:red_mushroom_block"],
  ["mushroom block", "minecraft:red_mushroom_block"],
  ["oak", "minecraft:oak_planks"],
  ["spruce", "minecraft:spruce_planks"],
  ["birch", "minecraft:birch_planks"],
  ["stone bricks", "minecraft:stone_bricks"],
  ["stone", "minecraft:stone"],
  ["glass", "minecraft:glass"],
  ["quartz", "minecraft:quartz_block"],
];
const MATERIAL_IDS = new Set(MATERIALS.map(([, blockId]) => blockId));

function clone(value) {
  return structuredClone(value);
}

function timestamp(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function identity(value) {
  const result = String(value || "").trim();
  return result && result.length <= 192 ? result : "";
}

function normalizeEntry(value, now) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !KINDS.has(value.kind)) return undefined;
  const createdAt = timestamp(value.createdAt, now);
  const updatedAt = timestamp(value.updatedAt, createdAt);
  if (value.kind === "proximity") {
    const minimumDistance = Number(value.minimumDistance);
    if (!Number.isFinite(minimumDistance)) return undefined;
    return {
      kind: "proximity",
      scope: "interaction",
      minimumDistance: Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, Math.round(minimumDistance))),
      source: "player_explicit",
      createdAt,
      updatedAt,
    };
  }
  if (value.kind === "material") {
    const blockId = String(value.blockId || "");
    const label = String(value.label || "").replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 48);
    if (!MATERIAL_IDS.has(blockId) || !label) return undefined;
    return {
      kind: "material",
      scope: "build",
      blockId,
      label,
      exclusive: value.exclusive === true,
      source: "player_explicit",
      createdAt,
      updatedAt,
    };
  }
  if (value.askBeforeTeleport !== true) return undefined;
  return {
    kind: "teleport",
    scope: "movement",
    askBeforeTeleport: true,
    source: "player_explicit",
    createdAt,
    updatedAt,
  };
}

export function normalizePlayerPreferences(value, now = Date.now()) {
  const entries = Array.isArray(value) ? value : [];
  const byKind = new Map();
  for (const entry of entries) {
    const normalized = normalizeEntry(entry, now);
    if (!normalized) continue;
    const prior = byKind.get(normalized.kind);
    if (!prior || normalized.updatedAt >= prior.updatedAt) byKind.set(normalized.kind, normalized);
  }
  return [...byKind.values()].sort((left, right) => left.kind.localeCompare(right.kind));
}

export function materialPreferenceFor(text) {
  const lower = String(text || "").toLowerCase();
  return MATERIALS.find(([label]) => new RegExp(`\\b${label.replace(/ /g, "\\s+")}\\b`, "i").test(lower));
}

export function parsePlayerPreferenceInstruction(question, { previousQuestion, previousAction } = {}) {
  const text = String(question || "").replace(/[\u2018\u2019]/g, "'").trim();
  if (!text) return undefined;
  // A preference is never addressable by name. Treat attempts to inspect or
  // remove somebody else's notes as a privacy request, not as an instruction.
  if (/\b(?:forget|erase|delete|remove|show|list|tell)\b.{0,64}\b(?:someone else|another player|their|his|her)\b/i.test(text)) {
    return { type: "private" };
  }
  if (/\b(?:forget|erase|delete|remove|show|list|tell)\b.{0,64}\b[a-z][a-z0-9_-]{1,30}'s\s+(?:memory|memories|notes?|rules?|preferences?|materials?)\b/i.test(text)) {
    return { type: "private" };
  }
  if (/\b(?:what|show|list|tell)\b.{0,48}\b(?:remember|memory|memories|notes)\b/i.test(text)) {
    return /\b(?:me|my|mine)\b/i.test(text) ? { type: "list" } : { type: "private" };
  }
  const clearAll = /\bforget\b.{0,48}\b(?:everything|all)\b/i.test(text)
    || /\b(?:erase|delete|remove)\b.{0,24}\b(?:all|everything)\b.{0,24}\b(?:me|my|myself)\b.{0,24}\b(?:memory|memories|notes?|rules?|preferences?)\b/i.test(text);
  if (clearAll) {
    if (!/\b(?:about|for)\b/i.test(text) || /\b(?:about|for)\s+(?:me|myself)\b/i.test(text)) return { type: "clear" };
    return { type: "private" };
  }
  if (/\b(?:forget|erase|delete|remove)\b.{0,32}\bmy\s+(?:memory|memories|notes)\b/i.test(text)) {
    return { type: "clear" };
  }
  const removesNote = /\b(?:forget|erase|delete)\b/i.test(text)
    || /\bremove\b.{0,48}\b(?:memory|memories|note|notes|rule|rules|preference|preferences|remember)\b/i.test(text);
  if (removesNote && /\b(?:mushroom|material|blocks?|palette)\b/i.test(text)) {
    return { type: "remove", kind: "material" };
  }
  if (removesNote && /\b(?:close|distance|space|away|near)\b/i.test(text)) {
    return { type: "remove", kind: "proximity" };
  }
  if (removesNote && /\b(?:teleport|tp|travel)\b/i.test(text)) {
    return { type: "remove", kind: "teleport" };
  }
  if (/^\s*(?:forget|erase|delete|remove)\s+(?:that|it)\b/i.test(text)) return { type: "remove-last" };

  if (/(?:\bgo away\b|\bnot so close\b|\btoo close\b|\bstanding too close\b|\bkeep (?:back|your distance)\b|\bstay (?:away|back)\b|\bgive me space\b|\bdon'?t stand near me\b)/i.test(text)) {
    return { type: "set", preference: { kind: "proximity", minimumDistance: 8 } };
  }
  if (/(?:\bdon'?t|\bdo not|\bnever)\s+(?:teleport(?:ing)?|tp)\s+me\b|\b(?:always\s+)?ask(?: me)? before (?:you )?(?:teleport(?:ing)?|tp)\s*(?:me)?\b/i.test(text)) {
    return { type: "set", preference: { kind: "teleport", askBeforeTeleport: true } };
  }
  const contextWasTravel = previousAction?.type === "dimension_travel"
    || /\b(?:teleport|\btp\b|travel|nether|overworld|the end)\b/i.test(String(previousQuestion || ""));
  if (/^\s*(?:don'?t|do not) do that again\b/i.test(text) && contextWasTravel) {
    return { type: "set", preference: { kind: "teleport", askBeforeTeleport: true } };
  }
  const durableBuildRule = /\b(?:from now on|always|remember|every build|my stuff|my builds?|keep using)\b/i.test(text);
  const material = materialPreferenceFor(text);
  if (durableBuildRule && material) {
    const [label, blockId] = material;
    return { type: "set", preference: { kind: "material", blockId, label, exclusive: /\bonly\b/i.test(text) } };
  }
  return undefined;
}

export function describePlayerPreferences(entries) {
  const preferences = normalizePlayerPreferences(entries);
  if (!preferences.length) return "I don’t have any lasting notes for you.";
  return preferences.map((entry) => {
    if (entry.kind === "proximity") return `I’ll give you about ${entry.minimumDistance} blocks of space.`;
    if (entry.kind === "material") return `I’ll use ${entry.exclusive ? "only " : ""}${entry.label} for your builds unless you name something else.`;
    return "I’ll ask before I teleport you unless you directly ask me to travel.";
  }).join(" ");
}

function directPlayerTravelRequest(question) {
  return /\b(?:teleport|\btp\b|take|bring|send|move|travel)\b.{0,48}\b(?:me|us|everyone|all of us|the party)\b/i.test(String(question || ""));
}

export function playerPreferencePrompt(entries, question, { explicitMaterial } = {}) {
  const preferences = normalizePlayerPreferences(entries);
  if (!preferences.length) return "";
  const namesExplicitMaterial = materialPreferenceFor(question);
  const currentTurnMaterial = explicitMaterial === undefined ? Boolean(namesExplicitMaterial) : explicitMaterial;
  const directTravel = directPlayerTravelRequest(question);
  const lines = preferences.map((entry) => {
    if (entry.kind === "proximity") return `Keep about ${entry.minimumDistance} blocks of personal space.`;
    if (entry.kind === "material" && !currentTurnMaterial) {
      return `Use ${entry.exclusive ? "only " : ""}${entry.label} for building unless that would make a requested machine nonfunctional.`;
    }
    if (entry.kind === "teleport" && !directTravel) return "Do not teleport this player unless they explicitly ask in this turn.";
    return undefined;
  }).filter(Boolean);
  return lines.length ? `Persistent private player preferences (apply only to this player; never reveal them to anyone else):\n- ${lines.join("\n- ")}` : "";
}

export function createMemoryPlayerPreferenceStore({ now = () => Date.now(), maxPlayers = MAX_PLAYERS } = {}) {
  const records = new Map();
  const get = (playerIdentity) => {
    const key = identity(playerIdentity);
    return key ? clone(records.get(key)?.entries || []) : [];
  };
  const trim = () => {
    if (records.size <= maxPlayers) return;
    const oldest = [...records.entries()].sort(([, left], [, right]) => left.updatedAt - right.updatedAt);
    for (const [key] of oldest.slice(0, records.size - maxPlayers)) records.delete(key);
  };
  const put = (playerIdentity, entries) => {
    const key = identity(playerIdentity);
    if (!key) return [];
    const normalized = normalizePlayerPreferences(entries, now());
    if (!normalized.length) {
      records.delete(key);
      return [];
    }
    records.set(key, { entries: normalized, updatedAt: now() });
    trim();
    return get(key);
  };
  return {
    get,
    async set(playerIdentity, preference) {
      const key = identity(playerIdentity);
      const normalized = normalizeEntry(preference, now());
      if (!key || !normalized) return { changed: false, entries: get(key) };
      const existing = get(key);
      const prior = existing.find((entry) => entry.kind === normalized.kind);
      const entry = { ...normalized, createdAt: prior?.createdAt || normalized.createdAt, updatedAt: now() };
      const entries = put(key, [...existing.filter(({ kind }) => kind !== entry.kind), entry]);
      return { changed: JSON.stringify(prior) !== JSON.stringify(entry), entries, entry };
    },
    async remove(playerIdentity, kind) {
      if (!KINDS.has(kind)) return { removed: false, entries: get(playerIdentity) };
      const before = get(playerIdentity);
      const entries = put(playerIdentity, before.filter((entry) => entry.kind !== kind));
      return { removed: entries.length !== before.length, entries };
    },
    async clear(playerIdentity) {
      const key = identity(playerIdentity);
      const removed = Boolean(key && records.delete(key));
      return { removed, entries: [] };
    },
    stats() {
      return {
        players: records.size,
        preferences: [...records.values()].reduce((total, record) => total + record.entries.length, 0),
      };
    },
  };
}

export async function createFilePlayerPreferenceStore({ filePath, salt, now = () => Date.now(), maxPlayers = MAX_PLAYERS } = {}) {
  if (!filePath) throw new Error("player preference file path is required");
  if (!salt || String(salt).length < 16) throw new Error("player preference salt must be at least 16 characters");
  let data = { version: 1, players: {} };
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (parsed?.version === 1 && parsed.players && typeof parsed.players === "object") {
      data.players = Object.fromEntries(Object.entries(parsed.players).flatMap(([key, record]) => {
        const entries = normalizePlayerPreferences(record?.entries, now());
        return entries.length ? [[key, { entries, updatedAt: timestamp(record?.updatedAt, now()) }]] : [];
      }));
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const keyFor = (playerIdentity) => createHmac("sha256", salt).update(identity(playerIdentity)).digest("hex");
  let write = Promise.resolve();
  const prune = () => {
    const entries = Object.entries(data.players).sort(([, left], [, right]) => right.updatedAt - left.updatedAt).slice(0, maxPlayers);
    data.players = Object.fromEntries(entries);
  };
  const persist = () => {
    prune();
    write = write.catch(() => {}).then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.tmp`;
      await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      await rename(temporary, filePath);
    });
    return write;
  };
  const get = (playerIdentity) => {
    const key = identity(playerIdentity);
    return key ? clone(data.players[keyFor(key)]?.entries || []) : [];
  };
  const save = async (playerIdentity, entries) => {
    const key = keyFor(playerIdentity);
    const normalized = normalizePlayerPreferences(entries, now());
    if (normalized.length) data.players[key] = { entries: normalized, updatedAt: now() };
    else delete data.players[key];
    await persist();
    return get(playerIdentity);
  };
  return {
    get,
    async set(playerIdentity, preference) {
      const normalized = normalizeEntry(preference, now());
      if (!identity(playerIdentity) || !normalized) return { changed: false, entries: get(playerIdentity) };
      const existing = get(playerIdentity);
      const prior = existing.find((entry) => entry.kind === normalized.kind);
      const entry = { ...normalized, createdAt: prior?.createdAt || normalized.createdAt, updatedAt: now() };
      const entries = await save(playerIdentity, [...existing.filter(({ kind }) => kind !== entry.kind), entry]);
      return { changed: JSON.stringify(prior) !== JSON.stringify(entry), entries, entry };
    },
    async remove(playerIdentity, kind) {
      if (!KINDS.has(kind)) return { removed: false, entries: get(playerIdentity) };
      const before = get(playerIdentity);
      const entries = await save(playerIdentity, before.filter((entry) => entry.kind !== kind));
      return { removed: entries.length !== before.length, entries };
    },
    async clear(playerIdentity) {
      const before = get(playerIdentity);
      if (before.length) await save(playerIdentity, []);
      return { removed: Boolean(before.length), entries: [] };
    },
    stats() {
      return {
        players: Object.keys(data.players).length,
        preferences: Object.values(data.players).reduce((total, record) => total + record.entries.length, 0),
      };
    },
  };
}
