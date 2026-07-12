export const PLAN_LIMITS = Object.freeze({ maxBlocks: 128, x: 8, y: 12, z: 20 });

const ITEMS = Object.freeze({
  "minecraft:cobblestone": "minecraft:cobblestone",
  "minecraft:stone": "minecraft:stone",
  "minecraft:smooth_stone": "minecraft:smooth_stone",
  "minecraft:oak_planks": "minecraft:oak_planks",
  "minecraft:spruce_planks": "minecraft:spruce_planks",
  "minecraft:birch_planks": "minecraft:birch_planks",
  "minecraft:oak_log": "minecraft:oak_log",
  "minecraft:spruce_log": "minecraft:spruce_log",
  "minecraft:glass": "minecraft:glass",
  "minecraft:white_wool": "minecraft:white_wool",
  "minecraft:red_wool": "minecraft:red_wool",
  "minecraft:blue_wool": "minecraft:blue_wool",
  "minecraft:yellow_wool": "minecraft:yellow_wool",
  "minecraft:green_wool": "minecraft:green_wool",
  "minecraft:bookshelf": "minecraft:bookshelf",
  "minecraft:glowstone": "minecraft:glowstone",
  "minecraft:sea_lantern": "minecraft:sea_lantern",
  "minecraft:redstone_lamp": "minecraft:redstone_lamp",
  "minecraft:redstone": "minecraft:redstone_wire",
  "minecraft:redstone_torch": "minecraft:redstone_torch",
  "minecraft:lever": "minecraft:lever",
  "minecraft:stone_button": "minecraft:stone_button",
});

const integerVector = (value, name) => {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isInteger)) {
    throw new Error(`${name} must be three integers`);
  }
  return [...value];
};
const key = ([x, y, z]) => `${x},${y},${z}`;

export function validateBuildPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plan must be an object");
  const title = String(value.title || "Custom build").replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 32)
    || "Custom build";
  if (!Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > PLAN_LIMITS.maxBlocks) {
    throw new Error(`plan must contain 1-${PLAN_LIMITS.maxBlocks} blocks`);
  }
  const placed = new Set();
  const blocks = value.blocks.map((block, index) => {
    const target = integerVector(block?.target, `blocks[${index}].target`);
    const support = integerVector(block?.support, `blocks[${index}].support`);
    const [x, y, z] = target;
    if (Math.abs(x) > PLAN_LIMITS.x || y < 0 || y > PLAN_LIMITS.y || z < 0 || z > PLAN_LIMITS.z) {
      throw new Error(`blocks[${index}].target is outside the build bounds`);
    }
    if (Math.abs(target[0] - support[0]) + Math.abs(target[1] - support[1]) + Math.abs(target[2] - support[2]) !== 1) {
      throw new Error(`blocks[${index}].support must touch its target`);
    }
    const itemId = String(block?.itemId || "");
    const expectedType = ITEMS[itemId];
    if (!expectedType) throw new Error(`blocks[${index}].itemId is not allowed`);
    if ((itemId === "minecraft:redstone" || itemId === "minecraft:redstone_torch")
      && !(support[0] === target[0] && support[1] === target[1] - 1 && support[2] === target[2])) {
      throw new Error(`blocks[${index}].${itemId.split(":")[1]} requires support directly below`);
    }
    if (placed.has(key(target))) throw new Error(`blocks[${index}].target is duplicated`);
    const supportIsGround = support[1] === -1 && target[1] === 0;
    if (!supportIsGround && !placed.has(key(support))) {
      throw new Error(`blocks[${index}].support must be ground or an earlier planned block`);
    }
    placed.add(key(target));
    return { target, support, itemId, expectedType };
  });
  return { title, blocks };
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
  return `build_validated_plan action={"type":"build_plan","version":1,"plan":{"title":"short title","blocks":[{"target":[x,y,z],"support":[x,y,z],"itemId":"minecraft:oak_planks"}]}}. `
    + `Limits: at most ${PLAN_LIMITS.maxBlocks} blocks; x -${PLAN_LIMITS.x}..${PLAN_LIMITS.x}; y 0..${PLAN_LIMITS.y}; z 0..${PLAN_LIMITS.z}. `
    + `Every support must touch its target and be either ground at y=-1 or an earlier target. `
    + `Allowed item IDs: ${Object.keys(ITEMS).join(", ")}. Use this only when the player explicitly asks you to build a small structure not covered by another skill.`;
}
