const place = (itemId, target, support, expectedType = itemId, extra = {}) => ({
  itemId,
  target,
  support,
  expectedType,
  ...extra,
});

/**
 * A three-hopper furnace: input from above, fuel from the side, and output
 * into the chest at the front. Temporary blocks give the side-facing hoppers
 * a real face to click, matching normal player placement.
 */
export function createAutomaticSmelterBlueprint() {
  return {
    id: "automatic_smelter",
    title: "Automatic Smelter",
    placements: [
      place("minecraft:smooth_stone", [0, 0, 1], [0, -1, 1], "minecraft:smooth_stone", { temporary: true }),
      place("minecraft:hopper", [0, 0, 2], [0, 0, 1], "minecraft:hopper", { facingTarget: [0, 0, 1] }),
      { action: "break", target: [0, 0, 1], temporary: true },
      place("minecraft:chest", [0, 0, 1], [0, -1, 1]),
      place("minecraft:furnace", [0, 1, 2], [0, 0, 2]),
      place("minecraft:hopper", [-1, 1, 2], [0, 1, 2], "minecraft:hopper", { facingTarget: [0, 1, 2] }),
      place("minecraft:chest", [-1, 2, 2], [-1, 1, 2]),
      place("minecraft:hopper", [0, 2, 2], [0, 1, 2], "minecraft:hopper", { facingTarget: [0, 1, 2] }),
      place("minecraft:chest", [0, 3, 2], [0, 2, 2]),
    ],
    interactions: [
      { action: "load_container", block: [0, 3, 2], slots: [{ slot: 0, itemId: "minecraft:raw_iron", amount: 1 }] },
      { action: "load_container", block: [-1, 2, 2], slots: [{ slot: 0, itemId: "minecraft:coal", amount: 1 }] },
    ],
    verification: [
      { kind: "container_link", from: [0, 2, 2], to: [0, 1, 2] },
      { kind: "container_link", from: [-1, 1, 2], to: [0, 1, 2] },
      { kind: "container_link", from: [0, 0, 2], to: [0, 0, 1] },
      {
        kind: "smelter_pipeline",
        input: [0, 3, 2],
        fuel: [-1, 2, 2],
        furnace: [0, 1, 2],
        output: [0, 0, 1],
        expectedOutput: "minecraft:iron_ingot",
      },
    ],
    bounds: { min: [-1, -1, 1], max: [0, 3, 2] },
    success: "Automatic smelter ready and tested! I fed raw iron and coal through it, and the finished iron reached the front chest.",
    usage: "Put ore or food in the top chest and coal, charcoal, or another furnace fuel in the side chest. Collect the finished stack from the front chest.",
  };
}
