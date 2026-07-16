const place = (itemId, target, support, expectedType = itemId, extra = {}) => ({
  itemId,
  target,
  support,
  expectedType,
  ...extra,
});

const GRASS_SOURCES = Object.freeze([[-1, 2, 2], [1, 2, 2], [0, 2, 1]]);

/**
 * A one-sheep automatic wool farm. The observer notices when the sheep eats
 * its grass, then pulses a shears-loaded dispenser. A hopper minecart collects
 * wool through the grass block and unloads through the hopper into the chest.
 */
export function createAutomaticWoolFarmBlueprint() {
  const centerGrass = [0, 2, 2];
  const dispenser = [0, 3, 3];
  const shearsSlot = { slot: 0, itemId: "minecraft:shears", amount: 1 };
  return {
    id: "automatic_wool_farm",
    title: "Automatic Wool Farm",
    placements: [
      // Build the chest-facing hopper first, using a temporary aiming block.
      place("minecraft:smooth_stone", [0, 0, 1], [0, -1, 1], "minecraft:smooth_stone", { temporary: true }),
      place("minecraft:hopper", [0, 0, 2], [0, 0, 1], "minecraft:hopper", { facingTarget: [0, 0, 1] }),
      { action: "break", target: [0, 0, 1], temporary: true },
      place("minecraft:chest", [0, 0, 1], [0, -1, 1]),

      // The temporary block holds the grass while the collection rail is made.
      place("minecraft:smooth_stone", [0, 1, 2], [0, 0, 2], "minecraft:smooth_stone", { temporary: true }),
      place("minecraft:grass_block", centerGrass, [0, 1, 2], ["minecraft:grass_block", "minecraft:dirt"]),
      ...GRASS_SOURCES.map((target) => place("minecraft:grass_block", target, centerGrass)),

      // Grass -> observer -> solid block -> dust -> dispenser.
      place("minecraft:observer", [0, 2, 3], centerGrass, "minecraft:observer", {
        orientationTarget: centerGrass,
      }),
      place("minecraft:smooth_stone", [0, 2, 4], [0, 2, 3]),
      place("minecraft:dispenser", dispenser, [0, 2, 3], "minecraft:dispenser", {
        orientationTarget: [0, 3, 2],
      }),
      place("minecraft:redstone", [0, 3, 4], [0, 2, 4], "minecraft:redstone_wire"),
      place("minecraft:lever", [1, 2, 4], [0, 2, 4]),

      // Two-block-high walls keep the sheep on the observed grass. The three
      // grass blocks under the walls remain available to regrow eaten grass.
      place("minecraft:glass", [-1, 3, 2], [-1, 2, 2]),
      place("minecraft:glass", [-1, 4, 2], [-1, 3, 2]),
      place("minecraft:glass", [1, 3, 2], [1, 2, 2]),
      place("minecraft:glass", [1, 4, 2], [1, 3, 2]),
      place("minecraft:glass", [0, 3, 1], [0, 2, 1]),
      place("minecraft:glass", [0, 4, 1], [0, 3, 1]),
      place("minecraft:glass", [0, 4, 3], dispenser),

      { action: "break", target: [0, 1, 2], temporary: true },
      place("minecraft:rail", [0, 1, 2], [0, 0, 2]),
    ],
    interactions: [
      { action: "load_container", block: dispenser, slots: [shearsSlot] },
      {
        action: "use_item_on_block",
        itemId: "minecraft:hopper_minecart",
        block: [0, 1, 2],
        faceTarget: centerGrass,
        expectedEntity: "minecraft:hopper_minecart",
      },
      {
        action: "use_item_on_block",
        itemId: "minecraft:sheep_spawn_egg",
        block: centerGrass,
        faceTarget: [0, 3, 2],
        expectedEntity: "minecraft:sheep",
      },
      {
        action: "use_item_on_block",
        itemId: "minecraft:stick",
        block: [1, 2, 4],
        faceTarget: [1, 3, 4],
        expectedState: { state: "open_bit", value: true },
      },
      { action: "wait_ticks", ticks: 8 },
      {
        action: "use_item_on_block",
        itemId: "minecraft:stick",
        block: [1, 2, 4],
        faceTarget: [1, 3, 4],
        expectedState: { state: "open_bit", value: false },
      },
      { action: "wait_ticks", ticks: 60 },
    ],
    verification: [
      { kind: "container_link", from: [0, 0, 2], to: [0, 0, 1] },
      { kind: "block_facing", from: [0, 2, 3], to: centerGrass },
      { kind: "block_facing", from: dispenser, to: [0, 3, 2] },
      { kind: "container_contents", block: dispenser, slots: [shearsSlot] },
      {
        kind: "entity_count",
        entityType: "minecraft:hopper_minecart",
        min: 1,
        bounds: { min: [0, 1, 2], max: [0, 1, 2] },
      },
      {
        kind: "entity_count",
        entityType: "minecraft:sheep",
        min: 1,
        bounds: { min: [0, 3, 2], max: [0, 3, 2] },
      },
      {
        kind: "wool_farm_pipeline",
        grass: centerGrass,
        grassSources: GRASS_SOURCES.map((point) => [...point]),
        observer: [0, 2, 3],
        dispenser,
        collector: [0, 1, 2],
        hopper: [0, 0, 2],
        output: [0, 0, 1],
        expectedOutputSuffix: "_wool",
      },
    ],
    bounds: { min: [-1, -1, 1], max: [1, 4, 4] },
    success: "Automatic wool farm ready and tested! The observer fires the shears when the sheep eats, and the hopper minecart carries the wool into the front chest.",
    usage: "Collect wool from the front chest. Leave the three outside grass blocks uncovered so the sheep's center grass can grow back.",
  };
}

export const woolFarmGrassSources = GRASS_SOURCES;
