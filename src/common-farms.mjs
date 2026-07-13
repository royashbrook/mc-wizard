import { validateMachinePlan } from "../bedrock/behavior_packs/mc_wizard/scripts/machine-plan.js";

const place = (itemId, target, support, orientationTarget = null) => ({
  itemId, target, support, orientationTarget,
});

const pillar = (x, z, top) => Array.from({ length: top + 1 }, (_, y) => place(
  "minecraft:smooth_stone",
  [x, y, z],
  y === 0 ? [x, -1, z] : [x, y - 1, z],
));

function raisedCollector(soil) {
  return [
    place("minecraft:chest", [0, 0, 0], [0, -1, 0]),
    place("minecraft:hopper", [0, 0, 1], [0, 0, 0], [0, 0, 0]),
    place("minecraft:smooth_stone", [0, 1, 1], [0, 0, 1]),
    place(soil, [0, 2, 1], [0, 1, 1]),
  ];
}

function collectorMinecart() {
  return {
    action: "use_item_on_block",
    itemId: "minecraft:hopper_minecart",
    block: [0, 1, 1],
    faceTarget: [0, 2, 1],
  };
}

function pistonFarm(title, kind, crop, needsWater = false) {
  return validateMachinePlan({
    title,
    kind,
    placements: [
      ...raisedCollector("minecraft:dirt"),

      // A one-block basin keeps sugar cane hydrated. Bamboo uses the same
      // compact shell dry so both farms have the same kid-readable shape.
      place("minecraft:smooth_stone", [-1, 0, 1], [-1, -1, 1]),
      place("minecraft:glass", [-1, 1, 1], [-1, 0, 1]),
      place("minecraft:glass", [-2, 1, 1], [-1, 1, 1]),
      place("minecraft:glass", [-1, 1, 0], [-1, 1, 1]),
      place("minecraft:glass", [-1, 1, 2], [-1, 1, 1]),
      place("minecraft:glass", [-2, 2, 1], [-2, 1, 1]),
      place("minecraft:glass", [-1, 2, 0], [-1, 1, 0]),
      place("minecraft:glass", [-1, 2, 2], [-1, 1, 2]),

      // A freshly placed cart can retain a tiny amount of motion. Stop it at
      // both ends of its one-block rail so the collector cannot wander out
      // from under the crop after verification succeeds.
      place("minecraft:glass", [0, 1, 0], [0, 0, 0]),
      place("minecraft:smooth_stone", [0, 0, 2], [0, -1, 2]),
      place("minecraft:glass", [0, 1, 2], [0, 0, 2]),
      place("minecraft:smooth_stone", [1, 0, 1], [1, -1, 1]),
      place("minecraft:glass", [1, 1, 1], [1, 0, 1]),

      // Observer output descends one step through dust and a repeater, then
      // enters the piston directly. This circuit is reliable in Bedrock.
      ...pillar(0, 3, 4),
      ...pillar(1, 3, 4),
      ...pillar(2, 3, 3),
      ...pillar(2, 2, 3),
      ...pillar(1, 2, 3),
      place("minecraft:piston", [0, 4, 2], [0, 4, 3], [0, 4, 1]),
      place("minecraft:observer", [0, 5, 2], [0, 4, 2], [0, 5, 1]),
      // Carry the observer pulse down one explicit step, then point a repeater
      // straight into the piston. This avoids edition-specific indirect power.
      place("minecraft:redstone", [0, 5, 3], [0, 4, 3]),
      place("minecraft:redstone", [1, 5, 3], [1, 4, 3]),
      place("minecraft:redstone", [2, 4, 3], [2, 3, 3]),
      place("minecraft:redstone", [2, 4, 2], [2, 3, 2]),
      place("minecraft:repeater", [1, 4, 2], [1, 3, 2], [0, 4, 2]),

      // The crop column is enclosed, so a piston-broken item stays directly
      // above the collector instead of bouncing outside a water stream.
      place("minecraft:glass", [-1, 3, 0], [-1, 2, 0]),
      place("minecraft:glass", [0, 3, 0], [-1, 3, 0]),
      place("minecraft:glass", [1, 3, 0], [0, 3, 0]),
      ...[-1, 0, 1].flatMap((x) => [4, 5].map((y) => (
        place("minecraft:glass", [x, y, 0], [x, y - 1, 0])
      ))),
      place("minecraft:glass", [-1, 3, 1], [-1, 3, 0]),
      place("minecraft:glass", [1, 3, 1], [1, 3, 0]),
      ...[-1, 1].flatMap((x) => [4, 5].map((y) => (
        place("minecraft:glass", [x, y, 1], [x, y - 1, 1])
      ))),
      place("minecraft:glass", [0, 3, 2], [1, 3, 2]),

      // Swap the temporary soil support for a rail. The hopper minecart sits
      // under the dirt and picks items up through it, exactly as a player can.
      { action: "break", target: [0, 1, 1] },
      place("minecraft:rail", [0, 1, 1], [0, 0, 1]),
      place(crop, [0, 3, 1], [0, 2, 1]),
    ],
    interactions: [
      ...needsWater ? [{
        action: "use_item_on_block",
        itemId: "minecraft:water_bucket",
        block: [-1, 1, 1],
        faceTarget: [-1, 2, 1],
      }] : [],
      collectorMinecart(),
    ],
  });
}

function cactusFarm() {
  return validateMachinePlan({
    title: "Automatic Cactus Farm",
    kind: "automatic cactus farm",
    placements: [
      // Three front hoppers collect the whole stream and feed one output chest.
      place("minecraft:chest", [0, 0, 0], [0, -1, 0]),
      place("minecraft:hopper", [0, 0, 1], [0, 0, 0], [0, 0, 0]),
      place("minecraft:hopper", [0, 1, 1], [0, 0, 1], [0, 0, 1]),
      place("minecraft:hopper", [-1, 1, 1], [0, 1, 1], [0, 1, 1]),
      place("minecraft:hopper", [1, 1, 1], [0, 1, 1], [0, 1, 1]),

      // A permanent floor supports the sand and a three-wide water basin.
      ...[-1, 0, 1].flatMap((x) => [2, 3, 4].flatMap((z) => pillar(x, z, 1))),

      // Retaining walls keep every water lane aimed at the hopper row.
      ...[-2, 2].flatMap((x) => [1, 2, 3, 4].flatMap((z) => (
        x === 2 && z === 3 ? [] : [
          ...pillar(x, z, 1),
          place("minecraft:glass", [x, 2, z], [x, 1, z]),
        ]
      ))),
      ...[-1, 0, 1].flatMap((x) => [
        ...pillar(x, 5, 1),
        place("minecraft:glass", [x, 2, 5], [x, 1, 5]),
      ]),
      ...[-1, 1].flatMap((x) => [
        ...pillar(x, 0, 1),
        place("minecraft:glass", [x, 2, 0], [x, 1, 0]),
      ]),
      place("minecraft:glass", [0, 2, 0], [-1, 2, 0]),

      // Natural growth at y=4 touches this arm, breaks, and falls into water.
      ...pillar(2, 3, 4),
      place("minecraft:smooth_stone", [1, 4, 3], [2, 4, 3]),
      place("minecraft:sand", [0, 2, 3], [0, 1, 3]),
      place("minecraft:cactus", [0, 3, 3], [0, 2, 3]),
    ],
    interactions: [-1, 0, 1].map((x) => ({
      action: "use_item_on_block",
      itemId: "minecraft:water_bucket",
      block: [x, 1, 4],
      faceTarget: [x, 2, 4],
    })),
  });
}

const PLANS = Object.freeze({
  sugar_cane: pistonFarm("Automatic Sugar Cane Farm", "automatic sugar cane farm", "minecraft:sugar_cane", true),
  bamboo: pistonFarm("Automatic Bamboo Farm", "automatic bamboo farm", "minecraft:bamboo"),
  cactus: cactusFarm(),
});

const CROPS = [
  ["sugar_cane", /\b(?:sugar\s*cane|sugarcane|reeds?)\b/i],
  ["bamboo", /\bbamboo\b/i],
  ["cactus", /\b(?:cacti|cactus)\b/i],
];

export function commonFarmAction(question) {
  const text = String(question || "");
  if (/\b(?:don['’]?t|do not|never|without)\b.{0,30}\b(?:build|make|create|place|set\s*up)\b/i.test(text)
    || /\bjust\s+(?:explain|describe|tell)\b/i.test(text)
    || /\bwant\s+to\s+(?:know|learn|understand)\b/i.test(text)) return null;
  const asksForBuild = /\b(?:build|make|create|construct|place|demo|demonstrate|show\s+me|set\s*up)\b/i.test(text)
    || /\b(?:want|need)\b.{0,50}\b(?:automatic|automated|auto|farm|harvest(?:er|ing)?)\b/i.test(text);
  if (!asksForBuild || !/\b(?:automatic|automated|auto|farm|harvest(?:er|ing)?)\b/i.test(text)) return null;
  if (/\bkelp\b/i.test(text)) {
    return { type: "place_blueprint", id: "automatic_kelp_farm", version: 1 };
  }
  const id = CROPS.find(([, pattern]) => pattern.test(text))?.[0];
  return id ? { type: "build_machine", version: 1, plan: PLANS[id] } : null;
}
