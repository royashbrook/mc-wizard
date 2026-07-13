export const STRUCTURE_LIMITS = Object.freeze({ width: 128, depth: 128, height: 64 });

export const STRUCTURE_PHASES = Object.freeze(["foundation", "shell", "roof", "details"]);

export const STRUCTURE_PRIMITIVE_LIMIT = 96;

export const STRUCTURE_ENTITY_LIMIT = 8;

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
  "rooms",
  "second_floor",
  "decorations",
]);

const ENTITY_TYPES = new Set(["minecraft:villager_v2"]);

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

function validatePrimitives(value, dimensions, { partial = false } = {}) {
  if (!Array.isArray(value) || value.length < (partial ? 1 : STRUCTURE_PHASES.length)
    || value.length > STRUCTURE_PRIMITIVE_LIMIT) {
    throw new Error(`primitives must contain ${partial ? 1 : STRUCTURE_PHASES.length}-${STRUCTURE_PRIMITIVE_LIMIT} entries`);
  }
  const seenPhases = new Set();
  const solidPhases = new Set();
  let lastPhase = 0;
  let totalVolume = 0;
  const solidMin = [Infinity, Infinity, Infinity];
  const solidMax = [-Infinity, -Infinity, -Infinity];
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
    if (blockId !== "minecraft:air" && !MATERIALS.has(blockId)) {
      throw new Error(`primitives[${index}].blockId is not allowed`);
    }
    const first = vector(primitive.from, `primitives[${index}].from`, dimensions);
    const second = vector(primitive.to, `primitives[${index}].to`, dimensions);
    const from = first.map((coordinate, axis) => Math.min(coordinate, second[axis]));
    const to = first.map((coordinate, axis) => Math.max(coordinate, second[axis]));
    if (shape === "line" && from.filter((coordinate, axis) => coordinate === to[axis]).length < 2) {
      throw new Error(`primitives[${index}] line must be axis-aligned`);
    }
    totalVolume += (to[0] - from[0] + 1) * (to[1] - from[1] + 1) * (to[2] - from[2] + 1);
    if (blockId !== "minecraft:air") {
      solidPhases.add(primitive.phase);
      for (let axis = 0; axis < 3; axis += 1) {
        solidMin[axis] = Math.min(solidMin[axis], from[axis]);
        solidMax[axis] = Math.max(solidMax[axis], to[axis]);
      }
    }
    return { shape, phase: primitive.phase, blockId, from, to };
  });
  if (!partial && STRUCTURE_PHASES.some((phase) => !seenPhases.has(phase))) {
    throw new Error(`primitives must include ${STRUCTURE_PHASES.join(", ")}`);
  }
  if (!partial && STRUCTURE_PHASES.some((phase) => !solidPhases.has(phase))) {
    throw new Error(`solid primitives must include ${STRUCTURE_PHASES.join(", ")}`);
  }
  if (totalVolume > 2_000_000) throw new Error("primitive plan is too large");
  const expectedMax = [dimensions.width - 1, dimensions.height - 1, dimensions.depth - 1];
  if (!partial && (solidMin.some((coordinate) => coordinate !== 0)
    || solidMax.some((coordinate, axis) => coordinate !== expectedMax[axis]))) {
    throw new Error("solid primitive bounds must match the requested dimensions");
  }
  return primitives;
}

function validateEntities(value, dimensions) {
  if (!Array.isArray(value) || value.length > STRUCTURE_ENTITY_LIMIT) {
    throw new Error(`entities must contain 0-${STRUCTURE_ENTITY_LIMIT} entries`);
  }
  return value.map((entity, index) => {
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
      throw new Error(`entities[${index}] must be an object`);
    }
    const typeId = String(entity.typeId || "");
    if (!ENTITY_TYPES.has(typeId)) throw new Error(`entities[${index}].typeId is not allowed`);
    return {
      typeId,
      location: vector(entity.location, `entities[${index}].location`, dimensions),
    };
  });
}

export function validateBuildStructurePlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("structure plan must be an object");
  const mode = value.mode === undefined ? undefined : String(value.mode);
  if (mode !== undefined && mode !== "modify") throw new Error("mode must be modify when provided");
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
  if (mode) plan.mode = mode;
  if (value.primitives !== undefined) {
    plan.primitives = validatePrimitives(value.primitives, dimensions, { partial: mode === "modify" });
  }
  if (value.entities !== undefined) plan.entities = validateEntities(value.entities, dimensions);
  return plan;
}

export function primitiveStructureOperations(plan) {
  return (plan.primitives || []).map(({ phase, blockId, from, to }) => ({ phase, blockId, from, to }));
}

export function expansionClearOperations(previousPlan, nextPlan) {
  const before = previousPlan.dimensions;
  const after = nextPlan.dimensions;
  if (!["width", "depth", "height"].some((axis) => after[axis] > before[axis])) return [];
  const shiftX = Math.round((before.width - after.width) / 2);
  const shiftZ = Math.round((before.depth - after.depth) / 2);
  const old = {
    minX: -shiftX,
    maxX: -shiftX + before.width - 1,
    minZ: -shiftZ,
    maxZ: -shiftZ + before.depth - 1,
    maxY: before.height - 1,
  };
  const x0 = Math.max(0, old.minX);
  const x1 = Math.min(after.width - 1, old.maxX);
  const z0 = Math.max(0, old.minZ);
  const z1 = Math.min(after.depth - 1, old.maxZ);
  const operations = [];
  const add = (from, to) => {
    if (from.every((value, axis) => value <= to[axis])) {
      operations.push({ phase: "preparation", blockId: "minecraft:air", from, to });
    }
  };
  add([0, 0, 0], [x0 - 1, after.height - 1, after.depth - 1]);
  add([x1 + 1, 0, 0], [after.width - 1, after.height - 1, after.depth - 1]);
  add([x0, 0, 0], [x1, after.height - 1, z0 - 1]);
  add([x0, 0, z1 + 1], [x1, after.height - 1, after.depth - 1]);
  add([x0, old.maxY + 1, z0], [x1, after.height - 1, z1]);
  return operations;
}

const boxesIntersect = (a, b) => a.from.every((from, axis) => (
  from <= b.to[axis] && a.to[axis] >= b.from[axis]
));

export function obsoleteExpansionOperations(previousPlan, nextPlan, previousOperations) {
  const before = previousPlan.dimensions;
  const after = nextPlan.dimensions;
  if (!["width", "depth", "height"].some((axis) => after[axis] !== before[axis])) return [];
  const shrinking = ["width", "depth", "height"].some((axis) => after[axis] < before[axis]);
  const edgeX = before.width - 1;
  const edgeZ = before.depth - 1;
  const envelope = previousOperations.filter((operation) => (
    operation.blockId !== "minecraft:air"
    && (shrinking || operation.phase === "roof" || (operation.phase === "shell"
      && (operation.from[0] === 0 || operation.to[0] === edgeX
        || operation.from[2] === 0 || operation.to[2] === edgeZ)))
  ));
  return envelope.flatMap((region) => {
    const oldBlockIds = [...new Set(previousOperations
      .filter((operation) => operation.blockId !== "minecraft:air" && boxesIntersect(region, operation))
      .map(({ blockId }) => blockId))];
    return oldBlockIds.map((replaceBlockId) => ({
      phase: "cleanup",
      blockId: "minecraft:air",
      replaceBlockId,
      from: region.from,
      to: region.to,
    }));
  });
}

export function buildStructureSchemaPrompt() {
  return `build_structure action={"type":"build_structure","version":1,"plan":{"title":"7x7 Oak House","kind":"house","dimensions":{"width":7,"depth":7,"height":5},"materials":{"primary":"minecraft:oak_planks","accent":"minecraft:oak_log","roof":"minecraft:spruce_planks"},"features":["floor","walls","door","windows","roof","lighting"],"phases":["foundation","shell","roof","details"]}}. `
    + `This compact plan means the adapter must finish every phase, using player placement for details and sliced fill operations when the structure is large. Preserve every explicitly requested dimension exactly. `
    + `Limits: width 1-${STRUCTURE_LIMITS.width}, depth 1-${STRUCTURE_LIMITS.depth}, height 1-${STRUCTURE_LIMITS.height}. `
    + `For a known ordinary building, omit primitives and the adapter will generate it. For a follow-up edit, set "mode":"modify"; omit primitives to regenerate the ordinary structure in place, or include only the changed primitives. `
    + `For every new unusual or representational shape (for example a dragon, statue, creature, treehouse, vehicle, or pixel-art object), include 4-${STRUCTURE_PRIMITIVE_LIMIT} primitives so the model's shape is built instead of a generic building. `
    + `A primitive is {"shape":"box|line","phase":"foundation|shell|roof|details","blockId":"minecraft:...","from":[x,y,z],"to":[x,y,z]}; coordinates are inclusive, zero-based, and must stay inside dimensions. minecraft:air is allowed only as a primitive blockId, never counts toward a new structure's phases or bounds, and may be the only material only in mode modify. New structures need solid geometry in every phase spanning all requested bounds; modify primitives may be partial. Lines must be axis-aligned and stay in phase order. `
    + `Example unusual plan addition for 7x7x5 dimensions: "primitives":[{"shape":"line","phase":"foundation","blockId":"minecraft:stone","from":[0,0,3],"to":[6,0,3]},{"shape":"box","phase":"shell","blockId":"minecraft:green_concrete","from":[2,1,0],"to":[4,2,6]},{"shape":"line","phase":"roof","blockId":"minecraft:green_concrete","from":[3,3,3],"to":[3,4,3]},{"shape":"box","phase":"details","blockId":"minecraft:white_concrete","from":[3,3,2],"to":[3,3,2]}]. `
    + `Optional entities contains 0-${STRUCTURE_ENTITY_LIMIT} {"typeId":"minecraft:villager_v2","location":[x,y,z]} entries inside the dimensions. `
    + `Allowed materials: ${[...MATERIALS].join(", ")}. Allowed features: ${[...FEATURES].join(", ")}.`;
}
