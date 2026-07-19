import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isAllowedStructureMaterial } from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";

const STOP_WORDS = new Set([
  "a", "an", "and", "build", "can", "construct", "could", "create", "for", "hey", "look", "make", "me", "my",
  "please", "research", "the", "up", "wiz", "wizard", "would", "you",
]);

const LEARNED_ACTION_TYPES = new Set([
  "build_machine", "build_plan", "build_structure", "execute_program", "place_blueprint",
]);
const LEARNED_PROGRAM_CAPABILITIES = new Set([
  "control.wait", "observe.snapshot", "player.break-blocks", "player.move", "player.place-blocks",
  "player.use-item", "script.spawn-entity", "verify.blocks", "verify.entities",
]);

const SIMILARITY_FLOOR = 0.6;
const SUBJECT_SYNONYMS = [
  ["dog", "puppy", "pup"],
  ["cat", "kitten", "kitty"],
  ["house", "home", "cottage"],
  ["boat", "ship"],
  ["statue", "sculpture"],
  ["couch", "sofa"],
];
const CANONICAL_SUBJECT = new Map();
for (const group of SUBJECT_SYNONYMS) {
  for (const word of group) CANONICAL_SUBJECT.set(word, group[0]);
}
const canonicalToken = (token) => CANONICAL_SUBJECT.get(token) || token;
const keyTokens = (key) => new Set(key.split(" ").filter(Boolean).map(canonicalToken));

// #35: capability-safety acceptance for freshly researched novel actions.
// Unlike reusableLearnedAction, staged titles and low work counts are quality
// concerns for storage, not safety concerns for acceptance — only unlearned
// action types, command/console/configure capabilities, and off-allowlist
// structure materials reject a novel plan here.
export function safeNovelAction(action) {
  if (!action || !LEARNED_ACTION_TYPES.has(action.type)) return false;
  if (action.type === "execute_program") {
    return Array.isArray(action.program?.steps) && action.program.steps.length > 0
      && action.program.steps.every(({ capability }) => LEARNED_PROGRAM_CAPABILITIES.has(capability));
  }
  if (action.type !== "build_structure") return true;
  return ["primary", "accent", "roof"].every((name) => (
    isAllowedStructureMaterial(action.plan?.materials?.[name])
  ));
}

export function reusableLearnedAction(action) {
  if (!action || !LEARNED_ACTION_TYPES.has(action.type)) return false;
  if (["build_machine", "build_structure"].includes(action.type)
    && /^(?:First pass|Progress \d+)\b/i.test(action.plan?.title || "")) return false;
  if (action.type === "build_machine") {
    const work = (action.plan?.placements?.length || 0) + (action.plan?.interactions?.length || 0);
    if (work < 2) return false;
  }
  if (action.type !== "execute_program") return true;
  return Array.isArray(action.program?.steps) && action.program.steps.length > 0
    && action.program.steps.every(({ capability }) => LEARNED_PROGRAM_CAPABILITIES.has(capability));
}

export function recipeKey(question) {
  return String(question || "").toLowerCase().match(/[a-z0-9]+/g)
    ?.filter((word) => !STOP_WORDS.has(word)).join(" ").slice(0, 300) || "";
}

const clone = (value) => value == null ? value : structuredClone(value);
const tierRank = (entry) => entry.tier === "verified" ? 1 : 0;

// Exact key first; otherwise the best overlap-coefficient match that also names the
// stored recipe's build subject (last key token or a listed synonym) in the query.
function matchEntry(entries, question) {
  const key = recipeKey(question);
  if (!key) return null;
  const exact = entries.get(key);
  if (exact) return { entry: exact, similarity: 1, exact: true };
  const queryTokens = keyTokens(key);
  let best = null;
  for (const entry of entries.values()) {
    const storedTokens = keyTokens(entry.key);
    let shared = 0;
    for (const token of queryTokens) if (storedTokens.has(token)) shared += 1;
    const denominator = Math.min(queryTokens.size, storedTokens.size);
    const similarity = denominator ? shared / denominator : 0;
    if (similarity < SIMILARITY_FLOOR) continue;
    const subject = canonicalToken(entry.key.split(" ").at(-1));
    if (!queryTokens.has(subject)) continue;
    if (!best || tierRank(entry) > tierRank(best.entry)
      || (tierRank(entry) === tierRank(best.entry) && similarity > best.similarity)) {
      best = { entry, similarity, exact: false };
    }
  }
  return best;
}

export function createMemoryLearnedRecipeStore({ maxRecipes = 100 } = {}) {
  const entries = new Map();
  return {
    async find(question) {
      const entry = entries.get(recipeKey(question));
      if (!entry) return null;
      entry.uses += 1;
      return clone(entry);
    },
    async findBest(question) {
      const match = matchEntry(entries, question);
      if (!match) return null;
      match.entry.uses += 1;
      return { entry: clone(match.entry), similarity: match.similarity, exact: match.exact };
    },
    async promote({ question, action, grade, verified, tier, successes, failures, uses }) {
      const key = recipeKey(question);
      if (!key || !reusableLearnedAction(action)
        || !Number.isFinite(grade) || grade < 4 || grade > 5) return null;
      const previous = entries.get(key);
      // Verified completions (or an already-verified entry) keep the proved tier;
      // grade>=4 completed-but-unverified actions now accrue as provisional (#35).
      const proved = verified === true || tier === "verified" || previous?.tier === "verified";
      const entry = {
        key,
        action: clone(action),
        grade,
        tier: proved ? "verified" : "provisional",
        successes: Number.isFinite(successes)
          ? successes : (previous?.successes || 0) + (verified === true ? 1 : 0),
        failures: Number.isFinite(failures) ? failures : previous?.failures || 0,
        uses: Number.isFinite(uses) ? uses : previous?.uses || 0,
        updatedAt: new Date().toISOString(),
      };
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > maxRecipes) entries.delete(entries.keys().next().value);
      return clone(entry);
    },
    async recordOutcome(question, { success } = {}) {
      const match = matchEntry(entries, question);
      if (!match) return null;
      const { entry } = match;
      entry.updatedAt = new Date().toISOString();
      if (success === true) {
        entry.successes += 1;
        entry.tier = "verified";
        return { entry: clone(entry), removed: false };
      }
      entry.failures += 1;
      const removed = entry.failures >= entry.successes + 2;
      if (removed) entries.delete(entry.key);
      return { entry: clone(entry), removed };
    },
    async remove(question) {
      return entries.delete(recipeKey(question));
    },
    async list() {
      return clone([...entries.values()]);
    },
  };
}

export async function createFileLearnedRecipeStore({ filePath, maxRecipes = 100 } = {}) {
  if (!filePath) throw new Error("learned recipe file path is required");
  const memory = createMemoryLearnedRecipeStore({ maxRecipes });
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    const entries = Array.isArray(parsed?.recipes) && [1, 2, 3].includes(parsed?.version)
      ? parsed.recipes : [];
    for (const entry of entries) {
      // Version 1 predates executor/world verification. Keep only interim v1 records
      // that already carry the new proof bit; unverified legacy recipes must be relearned.
      if (parsed.version === 1 && entry?.verified !== true) continue;
      // v1/v2 verified entries carry no counters: promote() reads them as verified with
      // successes=1, failures=0. v3 entries pass their tier and counters straight through.
      await memory.promote({
        ...entry,
        question: entry.question || entry.key,
        verified: entry.verified === true || entry.tier === "verified",
      });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let pendingWrite = Promise.resolve();
  const persist = () => {
    pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 3, recipes: await memory.list() })}\n`, { mode: 0o600 });
      await rename(temporary, filePath);
    });
    return pendingWrite;
  };
  return {
    find: (question) => memory.find(question),
    findBest: (question) => memory.findBest(question),
    list: () => memory.list(),
    async promote(value) {
      const entry = await memory.promote(value);
      if (entry) await persist();
      return entry;
    },
    async recordOutcome(question, outcome) {
      const result = await memory.recordOutcome(question, outcome);
      if (result) await persist();
      return result;
    },
    async remove(question) {
      const removed = await memory.remove(question);
      if (removed) await persist();
      return removed;
    },
  };
}
