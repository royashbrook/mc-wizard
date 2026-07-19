export const PLAN_LIMITS = Object.freeze({ maxBlocks: 128, x: 8, y: 12, z: 20 });

// Inert, engine-supported vanilla blocks only. Never command_block, structure_block,
// mob_spawner, barrier, or tnt — this allowlist is a safety boundary (#35 widened it
// with decorative/structural blocks only).
const WOOL_AND_CONCRETE_COLORS = Object.freeze([
  "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray",
  "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black",
]);

const ITEMS = Object.freeze({
  "minecraft:cobblestone": "minecraft:cobblestone",
  "minecraft:stone": "minecraft:stone",
  "minecraft:smooth_stone": "minecraft:smooth_stone",
  "minecraft:stone_bricks": "minecraft:stone_bricks",
  "minecraft:quartz_block": "minecraft:quartz_block",
  "minecraft:oak_planks": "minecraft:oak_planks",
  "minecraft:spruce_planks": "minecraft:spruce_planks",
  "minecraft:birch_planks": "minecraft:birch_planks",
  "minecraft:oak_log": "minecraft:oak_log",
  "minecraft:spruce_log": "minecraft:spruce_log",
  "minecraft:oak_stairs": "minecraft:oak_stairs",
  "minecraft:spruce_stairs": "minecraft:spruce_stairs",
  "minecraft:birch_stairs": "minecraft:birch_stairs",
  "minecraft:oak_slab": "minecraft:oak_slab",
  "minecraft:spruce_slab": "minecraft:spruce_slab",
  "minecraft:birch_slab": "minecraft:birch_slab",
  "minecraft:oak_fence": "minecraft:oak_fence",
  "minecraft:spruce_fence": "minecraft:spruce_fence",
  "minecraft:birch_fence": "minecraft:birch_fence",
  "minecraft:wooden_door": "minecraft:wooden_door",
  "minecraft:spruce_door": "minecraft:spruce_door",
  "minecraft:birch_door": "minecraft:birch_door",
  "minecraft:trapdoor": "minecraft:trapdoor",
  "minecraft:spruce_trapdoor": "minecraft:spruce_trapdoor",
  "minecraft:birch_trapdoor": "minecraft:birch_trapdoor",
  "minecraft:ladder": "minecraft:ladder",
  "minecraft:torch": "minecraft:torch",
  "minecraft:glass": "minecraft:glass",
  ...Object.fromEntries(WOOL_AND_CONCRETE_COLORS.map((color) => [`minecraft:${color}_wool`, `minecraft:${color}_wool`])),
  ...Object.fromEntries(WOOL_AND_CONCRETE_COLORS.map((color) => [`minecraft:${color}_concrete`, `minecraft:${color}_concrete`])),
  "minecraft:bookshelf": "minecraft:bookshelf",
  "minecraft:glowstone": "minecraft:glowstone",
  "minecraft:sea_lantern": "minecraft:sea_lantern",
  "minecraft:redstone_lamp": "minecraft:redstone_lamp",
  "minecraft:redstone": "minecraft:redstone_wire",
  "minecraft:redstone_torch": "minecraft:redstone_torch",
  "minecraft:lever": "minecraft:lever",
  "minecraft:stone_button": "minecraft:stone_button",
});

const BELOW_ONLY_ITEMS = new Set(["minecraft:redstone", "minecraft:redstone_torch"]);
const NEIGHBOR_OFFSETS = Object.freeze([
  [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1],
]);

const integerVector = (value, name) => {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isInteger)) {
    throw new Error(`${name} must be three integers`);
  }
  return [...value];
};
const key = ([x, y, z]) => `${x},${y},${z}`;

// Salvage operator (#35): model-authored support/order is ignored entirely — the
// support graph is fully derivable from targets, so it is synthesized here.
// Irreparable entries (out of bounds, disallowed item, duplicate, floating) are
// dropped with a violation record; the whole plan is rejected only when too few
// entries survive, and the thrown Error message is the JSON violation list.
export function validateBuildPlan(value, { salvage = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plan must be an object");
  const title = String(value.title || "Custom build").replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 32)
    || "Custom build";
  if (!Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > PLAN_LIMITS.maxBlocks) {
    throw new Error(`plan must contain 1-${PLAN_LIMITS.maxBlocks} blocks`);
  }
  const dropped = [];
  const drop = (index, reason) => {
    if (!salvage) throw new Error(reason);
    dropped.push({ index, reason });
  };

  // Pass 1: normalize each entry independently; classify irreparable violations.
  const seen = new Set();
  const entries = [];
  value.blocks.forEach((block, index) => {
    let target;
    try {
      target = integerVector(block?.target, `blocks[${index}].target`);
    } catch (error) {
      drop(index, error.message);
      return;
    }
    const [x, y, z] = target;
    if (Math.abs(x) > PLAN_LIMITS.x || y < 0 || y > PLAN_LIMITS.y || z < 0 || z > PLAN_LIMITS.z) {
      drop(index, `blocks[${index}].target is outside the build bounds`);
      return;
    }
    const itemId = String(block?.itemId || "");
    const expectedType = ITEMS[itemId];
    if (!expectedType) {
      drop(index, `blocks[${index}].itemId is not allowed`);
      return;
    }
    if (seen.has(key(target))) {
      drop(index, `blocks[${index}].target is duplicated`);
      return;
    }
    seen.add(key(target));
    const authoredSupport = Array.isArray(block?.support) && block.support.length === 3
      && block.support.every(Number.isInteger) ? [...block.support] : null;
    entries.push({ index, target, itemId, expectedType, authoredSupport, support: null });
  });

  // Pass 2: BFS from the y=0 ground layer through 6-adjacency orders the solids
  // ground-up and hands each one a synthesized support (ground or the adjacent
  // block that reached it). Below-only items sort last so nothing rests on them.
  const solids = entries.filter((entry) => !BELOW_ONLY_ITEMS.has(entry.itemId));
  const belowOnly = entries.filter((entry) => BELOW_ONLY_ITEMS.has(entry.itemId));
  const solidByKey = new Map(solids.map((entry) => [key(entry.target), entry]));
  const placedKeys = new Set();
  const ordered = [];
  const queue = [];
  for (const entry of solids) {
    if (entry.target[1] !== 0) continue;
    entry.support = [entry.target[0], -1, entry.target[2]];
    placedKeys.add(key(entry.target));
    queue.push(entry);
  }
  while (queue.length) {
    const entry = queue.shift();
    ordered.push(entry);
    for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
      const neighborKey = key([entry.target[0] + dx, entry.target[1] + dy, entry.target[2] + dz]);
      const next = solidByKey.get(neighborKey);
      if (!next || placedKeys.has(neighborKey)) continue;
      next.support = [...entry.target];
      placedKeys.add(neighborKey);
      queue.push(next);
    }
  }
  for (const entry of solids) {
    if (!placedKeys.has(key(entry.target))) {
      drop(entry.index, `blocks[${entry.index}].support must be ground or an earlier planned block (floating)`);
    }
  }
  belowOnly.sort((a, b) => (a.target[1] - b.target[1]) || (a.index - b.index));
  for (const entry of belowOnly) {
    const [x, y, z] = entry.target;
    if (y === 0) {
      entry.support = [x, -1, z];
    } else if (placedKeys.has(key([x, y - 1, z]))) {
      entry.support = [x, y - 1, z];
    } else {
      drop(entry.index, `blocks[${entry.index}].${entry.itemId.split(":")[1]} requires support directly below`);
      continue;
    }
    placedKeys.add(key(entry.target));
    ordered.push(entry);
  }

  // Survival floor: small plans must survive whole; larger plans tolerate drops
  // down to max(4, 50% of input) survivors.
  const floor = Math.min(value.blocks.length, Math.max(4, Math.ceil(value.blocks.length / 2)));
  if (ordered.length < floor) {
    const violations = dropped.length ? dropped : [{ index: -1, reason: "no blocks reachable from the ground" }];
    throw new Error(JSON.stringify(violations));
  }

  let repairedSupports = 0;
  const blocks = ordered.map((entry) => {
    if (!entry.authoredSupport || key(entry.authoredSupport) !== key(entry.support)) repairedSupports += 1;
    return { target: entry.target, support: entry.support, itemId: entry.itemId, expectedType: entry.expectedType };
  });
  return { title, blocks, salvage: { dropped, repairedSupports } };
}

export function planBounds(plan) {
  const axes = [0, 1, 2].map((axis) => plan.blocks.map((block) => block.target[axis]));
  return {
    min: axes.map((values) => Math.min(...values)),
    max: axes.map((values) => Math.max(...values)),
  };
}

export function expectedPlacementStates(itemId, support, target) {
  if (!/_log$/.test(itemId)) return {};
  if (support[0] !== target[0]) return { pillar_axis: "x" };
  if (support[2] !== target[2]) return { pillar_axis: "z" };
  return { pillar_axis: "y" };
}

export function buildPlanSchemaPrompt() {
  return `build_validated_plan action={"type":"build_plan","version":1,"plan":{"title":"short title","blocks":[{"target":[x,y,z],"itemId":"minecraft:oak_planks"}]}}. `
    + `Limits: at most ${PLAN_LIMITS.maxBlocks} blocks; x -${PLAN_LIMITS.x}..${PLAN_LIMITS.x}; y 0..${PLAN_LIMITS.y}; z 0..${PLAN_LIMITS.z}. `
    + `Order and support are computed for you; just list blocks. Every block must connect to the ground at y=0 through adjacent blocks; redstone and redstone torches need a block directly below. `
    + `Allowed item IDs: ${Object.keys(ITEMS).join(", ")}. Use this only when the player explicitly asks you to build a small structure not covered by another skill.`;
}
