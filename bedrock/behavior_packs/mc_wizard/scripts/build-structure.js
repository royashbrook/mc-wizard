export const STRUCTURE_LIMITS = Object.freeze({ width: 128, depth: 128, height: 64 });

export const STRUCTURE_PHASES = Object.freeze(["foundation", "shell", "roof", "details"]);

export const STRUCTURE_PRIMITIVE_LIMIT = 96;

const MATERIALS = new Set([
  "minecraft:cobblestone",
  "minecraft:stone",
  "minecraft:smooth_stone",
  "minecraft:stone_bricks",
  "minecraft:deepslate_bricks",
  "minecraft:oak_planks",
  "minecraft:spruce_planks",
  "minecraft:birch_planks",
  "minecraft:cherry_planks",
  "minecraft:oak_log",
  "minecraft:spruce_log",
  "minecraft:birch_log",
  "minecraft:bricks",
  "minecraft:quartz_block",
  "minecraft:white_concrete",
  "minecraft:glass",
  "minecraft:copper_block",
  "minecraft:polished_blackstone_bricks",
  "minecraft:sandstone",
  "minecraft:red_sandstone",
  "minecraft:prismarine_bricks",
  "minecraft:dark_prismarine",
  "minecraft:obsidian",
  "minecraft:moss_block",
  "minecraft:jungle_planks",
  "minecraft:acacia_planks",
  "minecraft:dark_oak_planks",
  "minecraft:mangrove_planks",
  "minecraft:jungle_log",
  "minecraft:acacia_log",
  "minecraft:dark_oak_log",
  "minecraft:mangrove_log",
  "minecraft:cherry_log",
  "minecraft:oak_leaves",
  "minecraft:spruce_leaves",
  "minecraft:birch_leaves",
  "minecraft:jungle_leaves",
  "minecraft:acacia_leaves",
  "minecraft:dark_oak_leaves",
  "minecraft:mangrove_leaves",
  "minecraft:cherry_leaves",
  "minecraft:black_concrete",
  "minecraft:blue_concrete",
  "minecraft:brown_concrete",
  "minecraft:cyan_concrete",
  "minecraft:gray_concrete",
  "minecraft:green_concrete",
  "minecraft:light_blue_concrete",
  "minecraft:light_gray_concrete",
  "minecraft:lime_concrete",
  "minecraft:magenta_concrete",
  "minecraft:orange_concrete",
  "minecraft:pink_concrete",
  "minecraft:purple_concrete",
  "minecraft:red_concrete",
  "minecraft:yellow_concrete",
  "minecraft:sea_lantern",
  "minecraft:glowstone",
  "minecraft:shroomlight",
  "minecraft:iron_block",
  "minecraft:gold_block",
  "minecraft:diamond_block",
  "minecraft:emerald_block",
]);

const FEATURES = new Set([
  "floor",
  "walls",
  "door",
  "windows",
  "roof",
  "lighting",
  "battlements",
  "towers",
  "supports",
  "walkway",
  "railings",
]);

const clean = (value, fallback, max) => String(value || fallback)
  .replace(/[^a-zA-Z0-9 _-]/g, "")
  .trim()
  .slice(0, max) || fallback;

function dimension(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > STRUCTURE_LIMITS[name]) {
    throw new Error(`${name} must be an integer from 1-${STRUCTURE_LIMITS[name]}`);
  }
  return number;
}

function vector(value, name, dimensions) {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${name} must be an x,y,z vector`);
  const limits = [dimensions.width, dimensions.height, dimensions.depth];
  return value.map((coordinate, axis) => {
    const number = Number(coordinate);
    if (!Number.isInteger(number) || number < 0 || number >= limits[axis]) {
      throw new Error(`${name} is outside the requested dimensions`);
    }
    return number;
  });
}

function validatePrimitives(value, dimensions) {
  if (!Array.isArray(value) || value.length < STRUCTURE_PHASES.length
    || value.length > STRUCTURE_PRIMITIVE_LIMIT) {
    throw new Error(`primitives must contain ${STRUCTURE_PHASES.length}-${STRUCTURE_PRIMITIVE_LIMIT} entries`);
  }
  const seenPhases = new Set();
  let lastPhase = 0;
  let totalVolume = 0;
  const occupiedMin = [Infinity, Infinity, Infinity];
  const occupiedMax = [-Infinity, -Infinity, -Infinity];
  const primitives = value.map((primitive, index) => {
    if (!primitive || typeof primitive !== "object" || Array.isArray(primitive)) {
      throw new Error(`primitives[${index}] must be an object`);
    }
    const shape = primitive.shape === "box" || primitive.shape === "line" ? primitive.shape : undefined;
    if (!shape) throw new Error(`primitives[${index}].shape must be box or line`);
    const phaseIndex = STRUCTURE_PHASES.indexOf(primitive.phase);
    if (phaseIndex < 0) throw new Error(`primitives[${index}].phase is unsupported`);
    if (phaseIndex < lastPhase) throw new Error("primitives must stay in phase order");
    lastPhase = phaseIndex;
    seenPhases.add(primitive.phase);
    const blockId = String(primitive.blockId || "");
    if (!MATERIALS.has(blockId)) throw new Error(`primitives[${index}].blockId is not allowed`);
    const first = vector(primitive.from, `primitives[${index}].from`, dimensions);
    const second = vector(primitive.to, `primitives[${index}].to`, dimensions);
    const from = first.map((coordinate, axis) => Math.min(coordinate, second[axis]));
    const to = first.map((coordinate, axis) => Math.max(coordinate, second[axis]));
    if (shape === "line" && from.filter((coordinate, axis) => coordinate === to[axis]).length < 2) {
      throw new Error(`primitives[${index}] line must be axis-aligned`);
    }
    totalVolume += (to[0] - from[0] + 1) * (to[1] - from[1] + 1) * (to[2] - from[2] + 1);
    for (let axis = 0; axis < 3; axis += 1) {
      occupiedMin[axis] = Math.min(occupiedMin[axis], from[axis]);
      occupiedMax[axis] = Math.max(occupiedMax[axis], to[axis]);
    }
    return { shape, phase: primitive.phase, blockId, from, to };
  });
  if (STRUCTURE_PHASES.some((phase) => !seenPhases.has(phase))) {
    throw new Error(`primitives must include ${STRUCTURE_PHASES.join(", ")}`);
  }
  if (totalVolume > 2_000_000) throw new Error("primitive plan is too large");
  const expectedMax = [dimensions.width - 1, dimensions.height - 1, dimensions.depth - 1];
  if (occupiedMin.some((coordinate) => coordinate !== 0)
    || occupiedMax.some((coordinate, axis) => coordinate !== expectedMax[axis])) {
    throw new Error("primitive bounds must match the requested dimensions");
  }
  return primitives;
}

export function validateBuildStructurePlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("structure plan must be an object");
  const dimensions = {
    width: dimension(value.dimensions?.width, "width"),
    depth: dimension(value.dimensions?.depth, "depth"),
    height: dimension(value.dimensions?.height, "height"),
  };
  const materials = Object.fromEntries(["primary", "accent", "roof"].map((name) => {
    const itemId = String(value.materials?.[name] || "");
    if (!MATERIALS.has(itemId)) throw new Error(`materials.${name} is not allowed`);
    return [name, itemId];
  }));
  if (!Array.isArray(value.features) || !value.features.length) throw new Error("features must not be empty");
  const features = [...new Set(value.features.map(String))];
  if (features.some((feature) => !FEATURES.has(feature))) throw new Error("features contains an unsupported feature");
  if (!Array.isArray(value.phases) || value.phases.length !== STRUCTURE_PHASES.length
    || value.phases.some((phase, index) => phase !== STRUCTURE_PHASES[index])) {
    throw new Error(`phases must be ${STRUCTURE_PHASES.join(", ")}`);
  }
  const plan = {
    title: clean(value.title, "Custom Structure", 32),
    kind: clean(value.kind, "structure", 48).toLowerCase(),
    dimensions,
    materials,
    features,
    phases: [...STRUCTURE_PHASES],
  };
  if (value.primitives !== undefined) plan.primitives = validatePrimitives(value.primitives, dimensions);
  return plan;
}

export function primitiveStructureOperations(plan) {
  return (plan.primitives || []).map(({ phase, blockId, from, to }) => ({ phase, blockId, from, to }));
}

export function buildStructureSchemaPrompt() {
  return `build_structure action={"type":"build_structure","version":1,"plan":{"title":"7x7 Oak House","kind":"house","dimensions":{"width":7,"depth":7,"height":5},"materials":{"primary":"minecraft:oak_planks","accent":"minecraft:oak_log","roof":"minecraft:spruce_planks"},"features":["floor","walls","door","windows","roof","lighting"],"phases":["foundation","shell","roof","details"]}}. `
    + `This compact plan means the adapter must finish every phase, using player placement for details and sliced fill operations when the structure is large. Preserve every explicitly requested dimension exactly. `
    + `Limits: width 1-${STRUCTURE_LIMITS.width}, depth 1-${STRUCTURE_LIMITS.depth}, height 1-${STRUCTURE_LIMITS.height}. `
    + `For a known ordinary building, omit primitives and the adapter will generate it. For every unusual or representational shape (for example a dragon, statue, creature, treehouse, vehicle, or pixel-art object), include 4-${STRUCTURE_PRIMITIVE_LIMIT} primitives so the model's shape is built instead of a generic building. `
    + `A primitive is {"shape":"box|line","phase":"foundation|shell|roof|details","blockId":"minecraft:...","from":[x,y,z],"to":[x,y,z]}; coordinates are inclusive, zero-based, and must stay inside dimensions. Together, the requested subject—not an unrelated full-size pad—must touch x=0, y=0, z=0 and the maximum edge of every requested dimension so the finished shape really has the requested size. Lines must be axis-aligned. Keep primitives grouped in phase order and include every phase; for non-buildings, use roof as the upper-shape phase. `
    + `Example unusual plan addition for 7x7x5 dimensions: "primitives":[{"shape":"line","phase":"foundation","blockId":"minecraft:stone","from":[0,0,3],"to":[6,0,3]},{"shape":"box","phase":"shell","blockId":"minecraft:green_concrete","from":[2,1,0],"to":[4,2,6]},{"shape":"line","phase":"roof","blockId":"minecraft:green_concrete","from":[3,3,3],"to":[3,4,3]},{"shape":"box","phase":"details","blockId":"minecraft:white_concrete","from":[3,3,2],"to":[3,3,2]}]. `
    + `Allowed materials: ${[...MATERIALS].join(", ")}. Allowed features: ${[...FEATURES].join(", ")}.`;
}
