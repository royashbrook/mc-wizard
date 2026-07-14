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
  "minecraft:brick_block",
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

const PRIMITIVE_MATERIALS = new Set([
  ...MATERIALS,
  "minecraft:lava",
  "minecraft:redstone_block",
  "minecraft:redstone_lamp",
]);

export function isAllowedStructureMaterial(blockId) {
  return MATERIALS.has(blockId);
}

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
  "rainbow",
]);

const ENTITY_TYPES = new Set([
  "minecraft:villager_v2",
  "minecraft:goat",
  "minecraft:iron_golem",
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

function vector(value, name, dimensions, horizontalMargin = 0) {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${name} must be an x,y,z vector`);
  const limits = [dimensions.width, dimensions.height, dimensions.depth];
  return value.map((coordinate, axis) => {
    const number = Number(coordinate);
    const margin = axis === 1 ? 0 : horizontalMargin;
    if (!Number.isInteger(number) || number < -margin || number >= limits[axis] + margin) {
      throw new Error(`${name} is outside the requested dimensions`);
    }
    return number;
  });
}

function primitiveVolume(shape, from, to) {
  const size = from.map((coordinate, axis) => to[axis] - coordinate + 1);
  if (shape !== "hollow_box") return size.reduce((total, length) => total * length, 1);
  return size.reduce((total, length) => total * length, 1)
    - size.map((length) => length - 2).reduce((total, length) => total * length, 1);
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
    const shape = ["box", "line", "hollow_box"].includes(primitive.shape) ? primitive.shape : undefined;
    if (!shape) throw new Error(`primitives[${index}].shape must be box, line, or hollow_box`);
    const phaseIndex = STRUCTURE_PHASES.indexOf(primitive.phase);
    if (phaseIndex < 0) throw new Error(`primitives[${index}].phase is unsupported`);
    if (phaseIndex < lastPhase) throw new Error("primitives must stay in phase order");
    lastPhase = phaseIndex;
    seenPhases.add(primitive.phase);
    const blockId = String(primitive.blockId || "");
    if (blockId !== "minecraft:air" && !PRIMITIVE_MATERIALS.has(blockId)) {
      throw new Error(`primitives[${index}].blockId is not allowed`);
    }
    const extension = partial ? 4 : 0;
    const first = vector(primitive.from, `primitives[${index}].from`, dimensions, extension);
    const second = vector(primitive.to, `primitives[${index}].to`, dimensions, extension);
    const from = first.map((coordinate, axis) => Math.min(coordinate, second[axis]));
    const to = first.map((coordinate, axis) => Math.max(coordinate, second[axis]));
    if (shape === "line" && from.filter((coordinate, axis) => coordinate === to[axis]).length < 2) {
      throw new Error(`primitives[${index}] line must be axis-aligned`);
    }
    if (shape === "hollow_box" && from.some((coordinate, axis) => to[axis] - coordinate < 2)) {
      throw new Error(`primitives[${index}] hollow_box must be at least 3x3x3`);
    }
    totalVolume += primitiveVolume(shape, from, to);
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

function validateCityGeometry(plan) {
  if (plan.mode === "modify" || /^First pass\b/i.test(plan.title)
    || !["city", "village", "settlement"].includes(plan.kind)) return;
  if (!plan.primitives) throw new Error("a city needs authored primitives");
  const buildings = plan.primitives.filter(({ shape, blockId, from, to }) => (
    shape === "hollow_box"
    && blockId !== "minecraft:air"
    && from[1] >= 0
    && to[0] - from[0] >= 3
    && to[1] - from[1] >= 3
    && to[2] - from[2] >= 3
  ));
  if (buildings.length < 4) {
    throw new Error("a city needs at least four distinct habitable hollow_box buildings");
  }
  for (let first = 0; first < buildings.length; first += 1) {
    for (let second = first + 1; second < buildings.length; second += 1) {
      const a = buildings[first];
      const b = buildings[second];
      const separated = a.to[0] + 1 < b.from[0] || b.to[0] + 1 < a.from[0]
        || a.to[2] + 1 < b.from[2] || b.to[2] + 1 < a.from[2];
      if (!separated) throw new Error("city buildings must be distinct and separated, not duplicate or nested shells");
    }
  }
  const centersX = buildings.map(({ from, to }) => (from[0] + to[0]) / 2);
  const centersZ = buildings.map(({ from, to }) => (from[2] + to[2]) / 2);
  if (Math.max(...centersX) - Math.min(...centersX) < (plan.dimensions.width - 1) * 0.5
    || Math.max(...centersZ) - Math.min(...centersZ) < (plan.dimensions.depth - 1) * 0.5) {
    throw new Error("city buildings must be distributed across both sides of the site");
  }
  const heights = buildings.map(({ from, to }) => to[1] - from[1] + 1);
  if (plan.kind === "city" && Math.max(...heights) - Math.min(...heights) < 2) {
    throw new Error("a city needs a varied skyline, not four identical-height rooms");
  }

  const routes = plan.primitives.filter(({ phase, blockId, from, to }) => (
    phase === "foundation" && blockId !== "minecraft:air" && from[1] === 0 && to[1] === 0
  ));
  const longX = routes.filter(({ from, to }) => (
    to[0] - from[0] + 1 >= Math.ceil(plan.dimensions.width * 0.7) && to[2] - from[2] + 1 <= 3
  ));
  const longZ = routes.filter(({ from, to }) => (
    to[2] - from[2] + 1 >= Math.ceil(plan.dimensions.depth * 0.7) && to[0] - from[0] + 1 <= 3
  ));
  const crossing = longX.some((xRoute) => longZ.some((zRoute) => (
    xRoute !== zRoute
    && xRoute.from[0] <= zRoute.to[0] && xRoute.to[0] >= zRoute.from[0]
    && xRoute.from[2] <= zRoute.to[2] && xRoute.to[2] >= zRoute.from[2]
  )));
  if (!crossing) throw new Error("a city needs two distinct thin connected paths crossing in both directions");
  const routeTouches = (building) => routes.some((route) => {
    const dx = Math.max(route.from[0] - building.to[0], building.from[0] - route.to[0], 0);
    const dz = Math.max(route.from[2] - building.to[2], building.from[2] - route.to[2], 0);
    return dx + dz <= 1;
  });
  if (!buildings.every(routeTouches)) throw new Error("every city building must connect to the path network");

  const openings = plan.primitives.filter(({ phase, blockId }) => (
    phase === "details" && blockId === "minecraft:air"
  ));
  const hasDoor = (building) => openings.some(({ from, to }) => {
    if (from[1] > building.from[1] + 1 || to[1] < building.from[1] + 2) return false;
    const onXWall = (from[0] <= building.from[0] && to[0] >= building.from[0]
        || from[0] <= building.to[0] && to[0] >= building.to[0])
      && to[2] >= building.from[2] + 1 && from[2] <= building.to[2] - 1;
    const onZWall = (from[2] <= building.from[2] && to[2] >= building.from[2]
        || from[2] <= building.to[2] && to[2] >= building.to[2])
      && to[0] >= building.from[0] + 1 && from[0] <= building.to[0] - 1;
    return onXWall || onZWall;
  });
  if (!buildings.every(hasDoor)) throw new Error("every city building needs a two-block-tall exterior doorway");
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
  validateCityGeometry(plan);
  return plan;
}

export function primitiveStructureOperations(plan) {
  return (plan.primitives || []).flatMap(({ shape, phase, blockId, from, to }) => {
    if (shape !== "hollow_box") return [{ phase, blockId, from, to }];
    const [x0, y0, z0] = from;
    const [x1, y1, z1] = to;
    const operation = (start, end) => ({ phase, blockId, from: start, to: end });
    return [
      operation([x0, y0, z0], [x1, y0, z1]),
      operation([x0, y0 + 1, z0], [x0, y1 - 1, z1]),
      operation([x1, y0 + 1, z0], [x1, y1 - 1, z1]),
      operation([x0 + 1, y0 + 1, z0], [x1 - 1, y1 - 1, z0]),
      operation([x0 + 1, y0 + 1, z1], [x1 - 1, y1 - 1, z1]),
      operation([x0, y1, z0], [x1, y1, z1]),
    ];
  });
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
  const firstPass = /^First pass\b/i.test(previousPlan.title || "");
  if (!firstPass && !["width", "depth", "height"].some((axis) => after[axis] !== before[axis])) return [];
  const shrinking = ["width", "depth", "height"].some((axis) => after[axis] < before[axis]);
  const edgeX = before.width - 1;
  const edgeZ = before.depth - 1;
  const envelope = previousOperations.filter((operation) => (
    operation.blockId !== "minecraft:air"
    && (firstPass || shrinking || operation.phase === "roof" || (operation.phase === "shell"
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
    + `For every new unusual, multi-building, or representational shape (for example a city, village, settlement, dragon, statue, creature, treehouse, vehicle, or pixel-art object), include 4-${STRUCTURE_PRIMITIVE_LIMIT} primitives so the model's complete shape is built instead of a generic building. `
    + `A primitive is {"shape":"box|line|hollow_box","phase":"foundation|shell|roof|details","blockId":"minecraft:...","from":[x,y,z],"to":[x,y,z]}; coordinates are inclusive and zero-based. New structures must stay inside dimensions. A mode-modify primitive may extend x or z up to four blocks outside the existing footprint for an attached balcony, eave, bridge, moat, or exterior detail; y must always stay inside height. A hollow_box must be at least 3x3x3 and builds a one-block-thick floor, four walls, and ceiling around an empty interior. minecraft:air is allowed only as a primitive blockId, never counts toward a new structure's phases or bounds, and may be the only material only in mode modify. New structures need solid geometry in every phase spanning all requested bounds; modify primitives may be partial. Lines must be axis-aligned and stay in phase order. `
    + `Use hollow_box for every habitable building or room; never represent one as a solid box. Carve door and window openings with later minecraft:air box primitives, and add interior floors, dividing walls, lighting, or furnishings as details. A city must contain at least four separated habitable hollow_box buildings distributed across both axes with varied heights; give every building a two-block-tall exterior air doorway connected to a thin foundation path. Use two distinct paths no more than three blocks wide that cross and span at least 70% of x and z. Never use one giant slab, duplicate shells, one box, or one floating room as a city. `
    + `Example unusual plan addition for 7x7x5 dimensions: "primitives":[{"shape":"line","phase":"foundation","blockId":"minecraft:stone","from":[0,0,3],"to":[6,0,3]},{"shape":"box","phase":"shell","blockId":"minecraft:green_concrete","from":[2,1,0],"to":[4,2,6]},{"shape":"line","phase":"roof","blockId":"minecraft:green_concrete","from":[3,3,3],"to":[3,4,3]},{"shape":"box","phase":"details","blockId":"minecraft:white_concrete","from":[3,3,2],"to":[3,3,2]}]. `
    + `Optional entities contains 0-${STRUCTURE_ENTITY_LIMIT} entries inside the dimensions. Supported typeId values are ${[...ENTITY_TYPES].join(", ")}. `
    + `Allowed structural materials: ${[...MATERIALS].join(", ")}. Primitive-only blocks also include minecraft:lava, minecraft:redstone_block, and minecraft:redstone_lamp. Allowed features: ${[...FEATURES].join(", ")}.`;
}
