const place = (itemId, target, support, expectedType = itemId, extra = {}) => ({
  itemId,
  target,
  support,
  expectedType,
  ...extra,
});

const FILTER_FILLER = "minecraft:stick";
const FILTER_FILLER_NAME = "Wizard Filter - Leave Here";

/**
 * One slice of the standard overflow-safe hopper sorter. The comparator sees
 * signal two at rest (41 filter items plus four one-item blockers). One more
 * matching item raises it to three, reaches the repeater after three dust, and
 * briefly unlocks the chest-feeding hopper below the filter.
 */
export function createItemSorterBlueprint(filterItem = "minecraft:iron_ingot") {
  if (typeof filterItem !== "string" || !filterItem.startsWith("minecraft:")) {
    throw new Error("item sorter needs a normal minecraft item id");
  }
  const filterSlots = [
    { slot: 0, itemId: filterItem, amount: 41 },
    ...Array.from({ length: 4 }, (_, index) => ({
      slot: index + 1,
      itemId: FILTER_FILLER,
      amount: 1,
      nameTag: FILTER_FILLER_NAME,
    })),
  ];
  return {
    id: "item_sorter",
    title: "Item Sorter",
    filterItem,
    placements: [
      // Output, overflow, and redstone supports.
      place("minecraft:smooth_stone", [0, 0, -1], [0, -1, -1]),
      place("minecraft:smooth_stone", [-1, 0, 0], [-1, -1, 0]),
      place("minecraft:smooth_stone", [-1, 1, 0], [-1, 0, 0]),
      place("minecraft:smooth_stone", [-1, 2, 0], [-1, 1, 0]),
      place("minecraft:smooth_stone", [0, 0, 1], [0, -1, 1], "minecraft:smooth_stone", { temporary: true }),
      place("minecraft:smooth_stone", [0, 0, 2], [0, -1, 2]),
      place("minecraft:smooth_stone", [0, 1, 1], [0, 0, 1]),
      place("minecraft:smooth_stone", [0, 1, 2], [0, 0, 2]),
      place("minecraft:smooth_stone", [0, 0, 3], [0, -1, 3], "minecraft:smooth_stone", { temporary: true }),
      place("minecraft:smooth_stone", [0, 1, 3], [0, 0, 3]),
      place("minecraft:smooth_stone", [0, 0, 4], [0, -1, 4]),

      // The lower hopper feeds the sorted chest. The filter above points into
      // the comparator (not a container), so it keeps its 45 setup items.
      place("minecraft:chest", [0, 1, -1], [0, 0, -1]),
      place("minecraft:hopper", [0, 1, 0], [0, 1, -1], "minecraft:hopper", { facingTarget: [0, 1, -1] }),
      place("minecraft:comparator", [0, 2, 1], [0, 1, 1], [
        "minecraft:unpowered_comparator",
        "minecraft:powered_comparator",
      ], { orientationTarget: [0, 2, 2] }),
      place("minecraft:hopper", [0, 2, 0], [0, 2, 1], "minecraft:hopper", { facingTarget: [0, 2, 1] }),

      // The top hopper passes unmatched items to the overflow chest while the
      // unlocked filter hopper below pulls only items matching its full slots.
      place("minecraft:chest", [-1, 3, 0], [-1, 2, 0]),
      place("minecraft:hopper", [0, 3, 0], [-1, 3, 0], "minecraft:hopper", { facingTarget: [-1, 3, 0] }),
      place("minecraft:chest", [0, 4, 0], [0, 3, 0]),

      // Three dust distinguish comparator strength two from three. The
      // repeater powers the torch's block; that switches the torch off and
      // unlocks the lower hopper for exactly the extra matching item.
      place("minecraft:redstone", [0, 2, 2], [0, 1, 2], "minecraft:redstone_wire"),
      place("minecraft:redstone", [0, 2, 3], [0, 1, 3], "minecraft:redstone_wire"),
      place("minecraft:redstone", [0, 1, 4], [0, 0, 4], "minecraft:redstone_wire"),
      { action: "break", target: [0, 0, 3], temporary: true },
      { action: "break", target: [0, 0, 1], temporary: true },
      place("minecraft:repeater", [0, 0, 3], [0, -1, 3], [
        "minecraft:unpowered_repeater",
        "minecraft:powered_repeater",
      ], { orientationTarget: [0, 0, 2] }),
      place("minecraft:redstone_torch", [0, 0, 1], [0, 0, 2], [
        "minecraft:redstone_torch",
        "minecraft:unlit_redstone_torch",
      ], { facingTarget: [0, 0, 2] }),
    ],
    interactions: [
      { action: "load_container", block: [0, 2, 0], slots: filterSlots },
      {
        action: "use_item_on_block",
        itemId: "minecraft:stick",
        block: [0, 2, 1],
        faceTarget: [0, 3, 1],
        expectedState: { state: "output_subtract_bit", value: true },
      },
      {
        action: "use_item_on_block",
        itemId: "minecraft:stick",
        block: [0, 2, 1],
        faceTarget: [0, 3, 1],
        expectedState: { state: "output_subtract_bit", value: false },
      },
      {
        action: "load_container",
        block: [0, 4, 0],
        slots: [{ slot: 0, itemId: "minecraft:feather", amount: 1 }],
      },
      { action: "wait_ticks", ticks: 40 },
      {
        action: "load_container",
        block: [0, 4, 0],
        slots: [{ slot: 0, itemId: filterItem, amount: 1 }],
      },
      { action: "wait_ticks", ticks: 40 },
      {
        action: "load_container",
        block: [0, 4, 0],
        slots: [{ slot: 0, itemId: filterItem, amount: 1 }],
      },
    ],
    verification: [
      { kind: "container_link", from: [0, 1, 0], to: [0, 1, -1] },
      { kind: "container_link", from: [0, 3, 0], to: [-1, 3, 0] },
      { kind: "container_contents", block: [0, 2, 0], slots: filterSlots },
      {
        kind: "item_filter",
        input: [0, 4, 0],
        filter: [0, 2, 0],
        filterItem,
        matchedOutput: [0, 1, -1],
        overflowOutput: [-1, 3, 0],
        overflowTestItem: "minecraft:feather",
      },
    ],
    bounds: { min: [-1, -1, -1], max: [0, 4, 4] },
    success: `Item sorter ready and flow-tested! Two ${filterItem.replace("minecraft:", "").replaceAll("_", " ")} items cycled the Bedrock filter and sent one to the front chest, while a feather went to overflow.`,
    usage: "Drop mixed items in the top chest. Keep the four named Wizard Filter sticks in their hopper slots; a player can copy them by naming ordinary sticks on an anvil.",
  };
}

export const itemSorterFillerItem = FILTER_FILLER;
export const itemSorterFillerName = FILTER_FILLER_NAME;
