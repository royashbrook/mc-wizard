const place = (itemId, target, support, expectedType = itemId, extra = {}) => ({
  itemId,
  target,
  support,
  expectedType,
  ...extra,
});

const piston = (target, support) => place(
  "minecraft:sticky_piston",
  target,
  support,
  "minecraft:sticky_piston",
  {
    facingTarget: support,
    // Pistons point back toward the player, so gaze at the outside support.
    placementLookTarget: support,
    orientationTarget: [
      target[0] + target[0] - support[0],
      target[1] + target[1] - support[1],
      target[2] + target[2] - support[2],
    ],
  },
);

/** A direct-power 2x2 piston door: lever on closes, lever off opens. */
export function createTwoByTwoPistonDoorBlueprint() {
  const placements = [
    // Permanent side frames let the Wizard aim every piston inward.
    place("minecraft:smooth_stone", [-3, 0, 1], [-3, -1, 1]),
    place("minecraft:smooth_stone", [-3, 1, 1], [-3, 0, 1]),
    place("minecraft:smooth_stone", [-3, 2, 1], [-3, 1, 1]),
    place("minecraft:smooth_stone", [4, 0, 1], [4, -1, 1]),
    place("minecraft:smooth_stone", [4, 1, 1], [4, 0, 1]),
    place("minecraft:smooth_stone", [4, 2, 1], [4, 1, 1]),
    piston([-2, 1, 1], [-3, 1, 1]),
    piston([-2, 2, 1], [-3, 2, 1]),
    piston([3, 1, 1], [4, 1, 1]),
    piston([3, 2, 1], [4, 2, 1]),

    // Door blocks start retracted in the open doorway.
    place("minecraft:polished_deepslate", [-1, 1, 1], [-2, 1, 1]),
    place("minecraft:polished_deepslate", [-1, 2, 1], [-2, 2, 1]),
    place("minecraft:polished_deepslate", [2, 1, 1], [3, 1, 1]),
    place("minecraft:polished_deepslate", [2, 2, 1], [3, 2, 1]),

    // A raised shared line feeds repeaters directly into the two lower support
    // blocks. Dust atop those supports powers both upper pistons.
    ...Array.from({ length: 6 }, (_, index) => {
      const x = index - 2;
      return place("minecraft:smooth_stone", [x, 0, 4], [x, -1, 4]);
    }),
    place("minecraft:smooth_stone", [-2, 0, 3], [-2, -1, 3]),
    place("minecraft:smooth_stone", [3, 0, 3], [3, -1, 3]),
    place("minecraft:smooth_stone", [-2, 0, 2], [-2, -1, 2]),
    place("minecraft:smooth_stone", [3, 0, 2], [3, -1, 2]),
    place("minecraft:smooth_stone", [0, 0, 5], [0, -1, 5]),
    place("minecraft:smooth_stone", [-2, 1, 2], [-2, 0, 2]),
    place("minecraft:smooth_stone", [3, 1, 2], [3, 0, 2]),
    place("minecraft:repeater", [-2, 1, 3], [-2, 0, 3], [
      "minecraft:unpowered_repeater",
      "minecraft:powered_repeater",
    ], {
      placementLookTarget: [-2, 1, 2],
      orientationTarget: [-2, 1, 2],
    }),
    place("minecraft:repeater", [3, 1, 3], [3, 0, 3], [
      "minecraft:unpowered_repeater",
      "minecraft:powered_repeater",
    ], {
      placementLookTarget: [3, 1, 2],
      orientationTarget: [3, 1, 2],
    }),
    ...Array.from({ length: 6 }, (_, index) => {
      const x = index - 2;
      return place("minecraft:redstone", [x, 1, 4], [x, 0, 4], "minecraft:redstone_wire");
    }),
    place("minecraft:redstone", [-2, 2, 2], [-2, 1, 2], "minecraft:redstone_wire"),
    place("minecraft:redstone", [3, 2, 2], [3, 1, 2], "minecraft:redstone_wire"),
    place("minecraft:smooth_stone", [0, 1, 5], [0, 0, 5]),
    place("minecraft:lever", [0, 2, 5], [0, 1, 5]),
  ];
  const pistons = [[-2, 1, 1], [-2, 2, 1], [3, 1, 1], [3, 2, 1]];
  const retractedBlocks = [[-1, 1, 1], [-1, 2, 1], [2, 1, 1], [2, 2, 1]];
  const closedBlocks = [[0, 1, 1], [0, 2, 1], [1, 1, 1], [1, 2, 1]];
  return {
    id: "two_by_two_piston_door",
    title: "2x2 Piston Door",
    placements,
    interactions: [
      {
        action: "use_item_on_block",
        itemId: "minecraft:stick",
        block: [0, 2, 5],
        faceTarget: [0, 3, 5],
        expectedState: { state: "open_bit", value: true },
      },
      {
        action: "use_item_on_block",
        itemId: "minecraft:stick",
        block: [0, 2, 5],
        faceTarget: [0, 3, 5],
        expectedState: { state: "open_bit", value: false },
      },
    ],
    verification: [
      {
        kind: "piston_door",
        control: [0, 2, 5],
        pistons,
        retractedBlocks,
        closedBlocks,
        opening: { min: [0, 1, 1], max: [1, 2, 1] },
        finalState: "open",
        finalControlState: false,
      },
    ],
    bounds: { min: [-3, -1, 1], max: [4, 2, 5] },
    success: "The 2x2 piston door is open and tested! One lever controls all four sticky pistons, so every door block moves together.",
    usage: "The one lever controls the whole door: flip it once to close the two-block-wide doorway, and flip it again to open it.",
  };
}
