const ITEM_ALIASES = new Map([
  ["command block", "command_block"],
  ["chain command block", "chain_command_block"],
  ["repeating command block", "repeating_command_block"],
  ["end gateway block", "end_gateway"],
  ["oak plank", "oak_planks"],
  ["wooden plank", "oak_planks"],
  ["redstone dust", "redstone"],
]);

// This is deliberately a capability cache, not a guesser. Unknown phrases go
// to the brain when it is healthy instead of becoming invented item IDs.
const OFFLINE_ITEMS = new Set([
  "arrow", "barrier", "bedrock", "blaze_rod", "bread", "chain_command_block",
  "chest", "cobblestone", "command_block", "comparator", "copper_ingot",
  "diamond", "diamond_axe", "diamond_hoe", "diamond_pickaxe", "diamond_shovel",
  "diamond_sword", "dirt", "emerald", "end_gateway", "flint_and_steel",
  "gold_ingot", "hopper", "iron_axe", "iron_hoe", "iron_ingot", "iron_pickaxe",
  "iron_shovel", "iron_sword", "jigsaw", "lever", "light_block", "oak_log",
  "oak_planks", "observer", "obsidian", "piston", "redstone", "redstone_torch",
  "repeater", "repeating_command_block", "stone", "stone_button", "sticky_piston",
  "structure_block", "tnt", "torch",
]);

function normalizedItemName(value) {
  let name = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\b(?:block|item)s?\s*$/i, (suffix) => suffix.toLowerCase())
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const alias = ITEM_ALIASES.get(name);
  if (alias) return alias;
  if (name.endsWith(" blocks")) name = name.slice(0, -1);
  else if (name.endsWith("s") && !/(ss|us)$/.test(name)) name = name.slice(0, -1);
  return ITEM_ALIASES.get(name) || name.replace(/[ -]+/g, "_");
}

export function offlineGiftRequest(question) {
  const match = String(question || "").trim().match(
    /^(?:please\s+)?(?:give|gimme|gimmie|bring|hand)\s+me\s+(?:(\d{1,3})\s+)?(?:(?:an?|some|the)\s+)?([a-z][a-z0-9 _'’-]{0,60}?)(?:\s+please)?[.!?]*$/i,
  );
  if (!match) return null;
  const amount = Math.min(Math.max(Number(match[1]) || 1, 1), 256);
  const item = normalizedItemName(match[2]);
  if (!OFFLINE_ITEMS.has(item)) return null;
  return { itemId: `minecraft:${item}`, amount };
}
