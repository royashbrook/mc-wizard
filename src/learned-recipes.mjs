import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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

export function createMemoryLearnedRecipeStore({ maxRecipes = 100 } = {}) {
  const entries = new Map();
  return {
    async find(question) {
      const entry = entries.get(recipeKey(question));
      if (!entry) return null;
      entry.uses += 1;
      return clone(entry);
    },
    async promote({ question, action, grade, verified }) {
      const key = recipeKey(question);
      if (!key || verified !== true || !reusableLearnedAction(action)
        || !Number.isFinite(grade) || grade < 4 || grade > 5) return null;
      const entry = {
        key,
        action: clone(action),
        grade,
        verified: true,
        uses: entries.get(key)?.uses || 0,
        updatedAt: new Date().toISOString(),
      };
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > maxRecipes) entries.delete(entries.keys().next().value);
      return clone(entry);
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
    const entries = Array.isArray(parsed?.recipes) && [1, 2].includes(parsed?.version)
      ? parsed.recipes : [];
    for (const entry of entries) {
      // Version 1 predates executor/world verification. Keep only interim v1 records
      // that already carry the new proof bit; unverified legacy recipes must be relearned.
      if (parsed.version === 1 && entry?.verified !== true) continue;
      await memory.promote({ ...entry, question: entry.question || entry.key });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let pendingWrite = Promise.resolve();
  const persist = () => {
    pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 2, recipes: await memory.list() })}\n`, { mode: 0o600 });
      await rename(temporary, filePath);
    });
    return pendingWrite;
  };
  return {
    find: (question) => memory.find(question),
    list: () => memory.list(),
    async promote(value) {
      const entry = await memory.promote(value);
      if (entry) await persist();
      return entry;
    },
    async remove(question) {
      const removed = await memory.remove(question);
      if (removed) await persist();
      return removed;
    },
  };
}
