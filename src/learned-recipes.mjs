import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STOP_WORDS = new Set([
  "a", "an", "and", "build", "can", "construct", "could", "create", "for", "hey", "look", "make", "me", "my",
  "please", "research", "the", "up", "wiz", "wizard", "would", "you",
]);

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
    async promote({ question, action, grade }) {
      const key = recipeKey(question);
      if (!key || !action || grade < 4) return null;
      const entry = {
        key,
        question: String(question).replace(/\s+/g, " ").trim().slice(0, 500),
        action: clone(action),
        grade,
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
    for (const entry of Array.isArray(parsed?.recipes) ? parsed.recipes : []) {
      await memory.promote(entry);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const persist = async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, recipes: await memory.list() })}\n`, { mode: 0o600 });
    await rename(temporary, filePath);
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
