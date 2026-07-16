const place = (itemId, target, support, expectedType = itemId, extra = {}) => ({
  itemId,
  target,
  support,
  expectedType,
  ...extra,
});

/**
 * A compact automatic egg farm. Every block is placed through the same
 * SimulatedPlayer pipeline as the calculator. The temporary block lets a
 * player aim the hopper into the chest without opening the chest UI.
 */
export function createAutomaticChickenFarmBlueprint() {
  const placements = [
    place("minecraft:smooth_stone", [0, 0, 1], [0, -1, 1], "minecraft:smooth_stone", { temporary: true }),
    place("minecraft:hopper", [0, 0, 2], [0, 0, 1], "minecraft:hopper", { facingTarget: [0, 0, 1] }),
    { action: "break", target: [0, 0, 1], temporary: true },
    place("minecraft:chest", [0, 0, 1], [0, -1, 1]),
    place("minecraft:glass", [-1, 0, 2], [-1, -1, 2]),
    place("minecraft:glass", [1, 0, 2], [1, -1, 2]),
    place("minecraft:glass", [0, 0, 3], [0, -1, 3]),
    place("minecraft:glass", [-1, 1, 2], [-1, 0, 2]),
    place("minecraft:glass", [1, 1, 2], [1, 0, 2]),
    place("minecraft:glass", [0, 1, 3], [0, 0, 3]),
    place("minecraft:glass", [0, 1, 1], [0, 0, 1]),
    // Two-block-high walls keep chickens from hopping or being pushed out
    // when several of them crowd onto the single hopper.
    place("minecraft:glass", [-1, 2, 2], [-1, 1, 2]),
    place("minecraft:glass", [1, 2, 2], [1, 1, 2]),
    place("minecraft:glass", [0, 2, 3], [0, 1, 3]),
    place("minecraft:glass", [0, 2, 1], [0, 1, 1]),
  ];
  const interactions = Array.from({ length: 4 }, () => ({
    action: "use_item_on_block",
    itemId: "minecraft:chicken_spawn_egg",
    block: [0, 0, 3],
    faceTarget: [0, 0, 2],
    expectedEntity: "minecraft:chicken",
  }));
  return {
    id: "automated_chicken_farm",
    title: "Automatic Egg Farm",
    placements,
    interactions,
    verification: [
      { kind: "container_link", from: [0, 0, 2], to: [0, 0, 1] },
      { kind: "entity_count", entityType: "minecraft:chicken", min: 4, bounds: { min: [0, 0, 2], max: [0, 2, 2] } },
    ],
    bounds: { min: [-1, -1, 1], max: [1, 2, 3] },
    success: "Chicken farm ready! The two-block-high glass pen keeps all four chickens over the hopper, and the hopper moves every egg into the chest. Open the chest at the front to collect them.",
    usage: "Wait about five to ten minutes for eggs. Feed the chickens seeds if you want more chickens and faster egg collecting.",
  };
}
