const place = (itemId, target, support, expectedType = itemId, extra = {}) => ({
  itemId,
  target,
  support,
  expectedType,
  ...extra,
});

/**
 * A source-water kelp column. A side observer watches the third kelp block and
 * pulses a piston into it, leaving the planted base intact. Harvested kelp
 * floats into the top stream and then into the hopper and output chest.
 */
export function createAutomaticKelpFarmBlueprint() {
  const plant = [0, 1, 4];
  const harvest = [0, 2, 4];
  const sensedGrowth = [0, 3, 4];
  const piston = [0, 2, 5];
  const observer = [-1, 3, 4];
  const output = [0, 4, 1];
  const hopper = [0, 4, 2];
  const collectionWater = [0, 5, 2];
  const waterColumn = [1, 2, 3, 4, 5].map((y) => [0, y, 4]);
  const streamSource = [0, 5, 4];
  const collectionStream = [[0, 5, 3], collectionWater];
  const refillSources = [[1, 2, 4], [0, 2, 3]];

  const placements = [
    // Raise the output chest just below the collection stream.
    ...[0, 1, 2, 3].map((y) => place(
      "minecraft:smooth_stone",
      [0, y, 1],
      y === 0 ? [0, -1, 1] : [0, y - 1, 1],
    )),
    place("minecraft:chest", output, [0, 3, 1]),
    place("minecraft:hopper", hopper, output, "minecraft:hopper", { facingTarget: output }),
    place("minecraft:smooth_stone", [0, 4, 3], hopper),
    place("minecraft:smooth_stone", [-1, 4, 2], hopper),
    place("minecraft:smooth_stone", [1, 4, 2], hopper),

    // Dry tank first; water and kelp are added later from the Wizard's hand.
    place("minecraft:sand", [0, 0, 4], [0, -1, 4]),
    ...[-1].flatMap((x) => [0, 1, 2]
      .map((y) => place(
      "minecraft:glass",
      [x, y, 4],
      y === 0 ? [x, -1, 4] : [x, y - 1, 4],
      ))),
    ...[0, 1].map((y) => place(
      "minecraft:glass",
      [0, y, 3],
      y === 0 ? [0, -1, 3] : [0, y - 1, 3],
    )),
    place("minecraft:glass", [0, 0, 5], [0, -1, 5]),
    place("minecraft:glass", [0, 1, 5], [0, 0, 5]),
    place("minecraft:glass", [1, 0, 4], [1, -1, 4]),
    place("minecraft:glass", [1, 1, 4], [1, 0, 4]),

    // Two sealed sources meet at the piston harvest cell. Bedrock can leave air
    // after one source drains into a retracted piston, while two adjacent source
    // blocks recreate the water cell and keep the kelp column renewable.
    ...[[2, 4]].flatMap(([x, z]) => [0, 1, 2, 3].map((y) => place(
      "minecraft:glass",
      [x, y, z],
      y === 0 ? [x, -1, z] : [x, y - 1, z],
    ))),
    ...[[1, 3], [1, 5], [-1, 3]].flatMap(([x, z]) => [0, 1, 2].map((y) => place(
      "minecraft:glass",
      [x, y, z],
      y === 0 ? [x, -1, z] : [x, y - 1, z],
    ))),
    place("minecraft:glass", [1, 3, 3], [1, 2, 3]),
    place("minecraft:glass", [0, 3, 3], [1, 3, 3]),
    ...[0, 1, 2].map((y) => place(
      "minecraft:glass",
      [0, y, 2],
      y === 0 ? [0, -1, 2] : [0, y - 1, 2],
    )),
    place("minecraft:glass", [1, 3, 4], [2, 3, 4]),
    place("minecraft:glass", [1, 4, 4], [1, 3, 4]),

    // A side observer feeds a same-level dust path directly into the piston.
    // This avoids Java-only quasi-connectivity assumptions and works on Bedrock.
    ...[[-2, 4], [-2, 5], [-1, 5]].flatMap(([x, z]) => [0, 1, 2].map((y) => place(
      "minecraft:smooth_stone",
      [x, y, z],
      y === 0 ? [x, -1, z] : [x, y - 1, z],
    ))),
    place("minecraft:piston", piston, [0, 1, 5], "minecraft:piston", {
      orientationTarget: harvest,
    }),
    place("minecraft:observer", observer, [-1, 2, 4], "minecraft:observer", {
      orientationTarget: sensedGrowth,
    }),
    place("minecraft:glass", [-1, 4, 4], observer),
    place("minecraft:redstone", [-2, 3, 4], [-2, 2, 4], "minecraft:redstone_wire"),
    place("minecraft:redstone", [-2, 3, 5], [-2, 2, 5], "minecraft:redstone_wire"),
    place("minecraft:glass", [0, 3, 5], piston),
    place("minecraft:glass", [0, 4, 5], [0, 3, 5]),
    place("minecraft:glass", [0, 5, 5], [0, 4, 5]),

    // One-block-wide top stream carries floating kelp into the hopper.
    ...[-1, 1].flatMap((x) => [2, 3].map((z, index) => place(
      "minecraft:glass",
      [x, 5, z],
      index === 0 ? [x, 4, z] : [x, 5, z - 1],
    ))),
    place("minecraft:glass", [0, 5, 1], output),
    place("minecraft:glass", [-1, 5, 4], [-1, 4, 4]),
    place("minecraft:glass", [1, 5, 4], [1, 4, 4]),
  ];

  // The top source at z=4 flows through z=3 and z=2. Do not place a second
  // source over the hopper: that cancels the current carrying kelp forward.
  const water = waterColumn.map((faceTarget, index) => ({
    action: "use_item_on_block",
    itemId: "minecraft:water_bucket",
    block: index === 0 ? [0, 0, 4] : [-1, faceTarget[1], 4],
    faceTarget,
    expectedFaceType: "minecraft:water",
  }));

  return {
    id: "automatic_kelp_farm",
    title: "Automatic Kelp Farm",
    placements,
    interactions: [
      ...water,
      {
        action: "use_item_on_block",
        itemId: "minecraft:water_bucket",
        block: [2, 2, 4],
        faceTarget: refillSources[0],
        expectedFaceType: "minecraft:water",
      },
      {
        action: "use_item_on_block",
        itemId: "minecraft:water_bucket",
        block: [0, 2, 2],
        faceTarget: refillSources[1],
        expectedFaceType: "minecraft:water",
      },
      {
        action: "use_item_on_block",
        itemId: "minecraft:kelp",
        block: [0, 0, 4],
        faceTarget: plant,
        expectedFaceType: "minecraft:kelp",
      },
      // Connect the piston only after filling the watched water block. Otherwise
      // the observer's fill pulse extends into the bucket placement and Bedrock
      // can wash out the moving piston before the column is sealed.
      {
        action: "use_item_on_block",
        itemId: "minecraft:redstone",
        block: [-1, 2, 5],
        faceTarget: [-1, 3, 5],
        expectedFaceType: "minecraft:redstone_wire",
      },
      { action: "wait_ticks", ticks: 160 },
    ],
    verification: [
      { kind: "container_link", from: hopper, to: output },
      { kind: "block_facing", from: piston, to: harvest },
      { kind: "block_facing", from: observer, to: sensedGrowth },
      {
        kind: "kelp_farm_pipeline",
        plant,
        waterColumn: waterColumn.slice(1),
        streamSource,
        collectionStream,
        collectionWater,
        refillSources,
        harvest,
        sensedGrowth,
        piston,
        observer,
        hopper,
        output,
        expectedOutput: "minecraft:kelp",
      },
    ],
    bounds: { min: [-2, -1, 1], max: [2, 5, 5] },
    success: "Automatic kelp farm ready and tested! The observer harvests new growth, and the floating kelp rides the top stream into the output chest.",
    usage: "Collect kelp from the upper front chest. Keep the glass water column closed so every harvested piece floats into the hopper.",
  };
}
