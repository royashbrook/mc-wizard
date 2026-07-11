// Geometry adapted for this spike from Minecraft Wiki's “Full adder 1”.
// Source content is CC BY-NC-SA 3.0; retain attribution and replace this module
// with an independently designed/openly licensed circuit before commercial use.
// https://minecraft.wiki/w/Tutorial:Arithmetic_logic/Full_adder_1

const MODULE_SUPPORTS = {
  1: [[2, 3], [4, 3], [2, 4], [4, 4], [4, 6], [1, 7], [3, 7], [1, 8], [3, 8]],
  2: [[3, 4], [4, 7], [2, 8]],
  3: [[1, 4], [2, 4], [4, 4], [1, 5], [1, 6], [1, 7], [3, 7], [1, 8], [3, 8]],
};
const MODULE_DUST = {
  1: [[3, 0], [3, 1], [3, 2], [2, 5], [4, 5], [2, 6], [1, 9], [3, 9]],
  2: [[2, 3], [4, 3], [4, 6], [1, 7], [3, 7]],
  3: [[3, 4], [4, 7], [5, 7], [2, 8]],
  4: [[1, 4], [1, 5], [1, 6], [0, 7], [1, 7]],
};
const MODULE_STANDING_TORCHES = {
  2: [[2, 4], [4, 4], [1, 8], [3, 8]],
  4: [[2, 4], [1, 8]],
};
const MODULE_WALL_TORCHES = [
  { target: [1, 1, 6], support: [1, 1, 7] },
  { target: [3, 1, 6], support: [3, 1, 7] },
  { target: [2, 1, 2], support: [2, 1, 3] },
  { target: [4, 1, 2], support: [4, 1, 3] },
  { target: [3, 2, 3], support: [3, 2, 4] },
  { target: [2, 2, 7], support: [2, 2, 8] },
];
const MODULE_OFFSETS = [0, 6];
const TORCH_TYPES = ["minecraft:redstone_torch", "minecraft:unlit_redstone_torch"];
const LAMP_TYPES = ["minecraft:redstone_lamp", "minecraft:lit_redstone_lamp"];

function key([x, y, z]) {
  return `${x},${y},${z}`;
}

function shifted([x, y, z], offset) {
  return [x + offset, y, z];
}

function addStructure(structures, location, itemId = "minecraft:smooth_stone") {
  structures.set(key(location), { location, itemId });
}

function addPlacement(placements, targets, placement) {
  const targetKey = key(placement.target);
  if (targets.has(targetKey)) throw new Error(`calculator blueprint overlaps at ${targetKey}`);
  targets.add(targetKey);
  placements.push(placement);
}

export function createCalculatorBlueprint() {
  const structures = new Map();
  for (let x = 0; x <= 11; x += 1) {
    for (let z = 0; z <= 9; z += 1) addStructure(structures, [x, 0, z]);
  }
  for (const x of [1, 3, 7, 9]) {
    addStructure(structures, [x, 0, 10], "minecraft:lime_wool");
    addStructure(structures, [x, 0, 11], "minecraft:lime_wool");
  }
  for (const location of [[3, 0, -1], [9, 0, -1]]) {
    addStructure(structures, location, "minecraft:pink_wool");
  }
  addStructure(structures, [-1, 3, 7], "minecraft:pink_wool");

  for (const offset of MODULE_OFFSETS) {
    for (const [height, points] of Object.entries(MODULE_SUPPORTS)) {
      for (const [x, z] of points) addStructure(structures, [x + offset, Number(height), z]);
    }
    addStructure(structures, [5 + offset, 2, 7], "minecraft:yellow_wool");
    addStructure(structures, [0 + offset, 3, 7], "minecraft:yellow_wool");
    addStructure(structures, [1 + offset, 0, 9], "minecraft:lime_wool");
    addStructure(structures, [3 + offset, 0, 9], "minecraft:lime_wool");
    addStructure(structures, [3 + offset, 0, 0], "minecraft:pink_wool");
  }

  const placements = [];
  const targets = new Set();
  const scaffolds = new Map();
  for (const { location } of structures.values()) {
    for (let y = 0; y < location[1]; y += 1) {
      const scaffold = [location[0], y, location[2]];
      if (!structures.has(key(scaffold))) scaffolds.set(key(scaffold), scaffold);
    }
  }
  const supportBlocks = [...structures.values(), ...[...scaffolds.values()].map((location) => ({
    location,
    itemId: "minecraft:smooth_stone",
    temporary: true,
  }))].sort((a, b) => (
    a.location[1] - b.location[1]
    || a.location[2] - b.location[2]
    || a.location[0] - b.location[0]
  ));
  for (const structure of supportBlocks) {
    addPlacement(placements, targets, {
      itemId: structure.itemId,
      target: structure.location,
      support: [structure.location[0], structure.location[1] - 1, structure.location[2]],
      expectedType: structure.itemId,
      temporary: structure.temporary === true,
    });
  }
  for (const location of [...scaffolds.values()].sort((a, b) => b[1] - a[1])) {
    placements.push({ action: "break", target: location, temporary: true });
    targets.delete(key(location));
  }

  const component = (itemId, target, support, expectedType = itemId) => {
    if (!structures.has(key(support))) {
      throw new Error(`calculator component at ${key(target)} lacks support ${key(support)}`);
    }
    addPlacement(placements, targets, { itemId, target, support, expectedType });
  };
  for (const offset of MODULE_OFFSETS) {
    for (const [height, points] of Object.entries(MODULE_DUST)) {
      for (const [x, z] of points) {
        const target = [x + offset, Number(height), z];
        component("minecraft:redstone", target, [target[0], target[1] - 1, target[2]], "minecraft:redstone_wire");
      }
    }
    for (const [height, points] of Object.entries(MODULE_STANDING_TORCHES)) {
      for (const [x, z] of points) {
        const target = [x + offset, Number(height), z];
        component("minecraft:redstone_torch", target, [target[0], target[1] - 1, target[2]], TORCH_TYPES);
      }
    }
    for (const torch of MODULE_WALL_TORCHES) {
      component(
        "minecraft:redstone_torch",
        shifted(torch.target, offset),
        shifted(torch.support, offset),
        TORCH_TYPES,
      );
    }
  }
  for (const x of [1, 3, 7, 9]) {
    component("minecraft:redstone", [x, 1, 10], [x, 0, 10], "minecraft:redstone_wire");
    component("minecraft:lever", [x, 1, 11], [x, 0, 11]);
  }
  component("minecraft:redstone_lamp", [3, 1, -1], [3, 0, -1], LAMP_TYPES);
  component("minecraft:redstone_lamp", [9, 1, -1], [9, 0, -1], LAMP_TYPES);
  component("minecraft:redstone_lamp", [-1, 4, 7], [-1, 3, 7], LAMP_TYPES);

  return {
    placements,
    bounds: { min: [-1, -1, -1], max: [11, 4, 11] },
    inputs: {
      a1: [1, 1, 11],
      b1: [3, 1, 11],
      a0: [7, 1, 11],
      b0: [9, 1, 11],
    },
    outputs: {
      s2: [-1, 4, 7],
      s1: [3, 1, -1],
      s0: [9, 1, -1],
    },
  };
}

export function calculatorResult(a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a > 3 || b < 0 || b > 3) {
    throw new RangeError("calculator inputs must be integers from 0 to 3");
  }
  const sum = a + b;
  return { sum, bits: [(sum >> 2) & 1, (sum >> 1) & 1, sum & 1] };
}
