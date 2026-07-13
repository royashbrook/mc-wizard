export const MACHINE_PLAN_LIMITS = Object.freeze({ placements: 96, interactions: 12, x: 8, y: 12, z: 20 });

const PLACE_ITEMS = Object.freeze({
  "minecraft:smooth_stone": "minecraft:smooth_stone",
  "minecraft:cobblestone": "minecraft:cobblestone",
  "minecraft:oak_planks": "minecraft:oak_planks",
  "minecraft:glass": "minecraft:glass",
  "minecraft:dirt": "minecraft:dirt",
  "minecraft:sand": "minecraft:sand",
  "minecraft:slime_block": "minecraft:slime_block",
  "minecraft:honey_block": "minecraft:honey_block",
  "minecraft:piston": "minecraft:piston",
  "minecraft:sticky_piston": "minecraft:sticky_piston",
  "minecraft:observer": "minecraft:observer",
  "minecraft:dispenser": "minecraft:dispenser",
  "minecraft:dropper": "minecraft:dropper",
  "minecraft:hopper": "minecraft:hopper",
  "minecraft:chest": "minecraft:chest",
  "minecraft:barrel": "minecraft:barrel",
  "minecraft:redstone": "minecraft:redstone_wire",
  "minecraft:redstone_torch": "minecraft:redstone_torch",
  "minecraft:repeater": ["minecraft:unpowered_repeater", "minecraft:powered_repeater"],
  "minecraft:comparator": ["minecraft:unpowered_comparator", "minecraft:powered_comparator"],
  "minecraft:lever": "minecraft:lever",
  "minecraft:stone_button": "minecraft:stone_button",
  "minecraft:sugar_cane": ["minecraft:sugar_cane", "minecraft:reeds"],
  "minecraft:bamboo": "minecraft:bamboo",
  "minecraft:cactus": "minecraft:cactus",
});

const INTERACTION_ITEMS = Object.freeze({
  "minecraft:water_bucket": { expectedFaceType: "minecraft:water" },
  "minecraft:stick": { control: true },
  "minecraft:chicken_spawn_egg": { expectedEntity: "minecraft:chicken" },
  "minecraft:cow_spawn_egg": { expectedEntity: "minecraft:cow" },
  "minecraft:pig_spawn_egg": { expectedEntity: "minecraft:pig" },
  "minecraft:sheep_spawn_egg": { expectedEntity: "minecraft:sheep" },
});

const DIRECTIONAL_ITEMS = new Set([
  "minecraft:piston", "minecraft:sticky_piston", "minecraft:observer", "minecraft:dispenser",
  "minecraft:dropper", "minecraft:hopper", "minecraft:repeater", "minecraft:comparator",
]);
const SCAFFOLD_ITEMS = new Set(["minecraft:smooth_stone", "minecraft:cobblestone"]);
const BELOW_ONLY = new Set([
  "minecraft:redstone", "minecraft:redstone_torch", "minecraft:repeater", "minecraft:comparator",
  "minecraft:sugar_cane", "minecraft:bamboo", "minecraft:cactus",
]);

const key = ([x, y, z]) => `${x},${y},${z}`;
const clean = (value, fallback, max) => String(value || fallback)
  .replace(/[^a-zA-Z0-9 _-]/g, "")
  .trim()
  .slice(0, max) || fallback;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  if (Object.keys(value).some((entry) => !allowed.includes(entry))) throw new Error(`${name} has an unsupported field`);
}

function vector(value, name, { ground = false } = {}) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isInteger)) {
    throw new Error(`${name} must be three integers`);
  }
  const [x, y, z] = value;
  if (Math.abs(x) > MACHINE_PLAN_LIMITS.x || y < (ground ? -1 : 0) || y > MACHINE_PLAN_LIMITS.y
    || z < 0 || z > MACHINE_PLAN_LIMITS.z) {
    throw new Error(`${name} is outside the machine bounds`);
  }
  return [...value];
}

const touches = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) === 1;

export function validateMachinePlan(value) {
  exactKeys(value, ["title", "kind", "placements", "interactions"], "machine plan");
  if (!Array.isArray(value.placements) || value.placements.length < 1
    || value.placements.length > MACHINE_PLAN_LIMITS.placements) {
    throw new Error(`placements must contain 1-${MACHINE_PLAN_LIMITS.placements} entries`);
  }
  if (!Array.isArray(value.interactions) || value.interactions.length > MACHINE_PLAN_LIMITS.interactions) {
    throw new Error(`interactions must contain 0-${MACHINE_PLAN_LIMITS.interactions} entries`);
  }

  const placed = new Map();
  const placements = value.placements.map((placement, index) => {
    if (placement?.action === "break") {
      exactKeys(placement, ["action", "target"], `placements[${index}]`);
      const target = vector(placement.target, `placements[${index}].target`);
      const prior = placed.get(key(target));
      if (!prior || !SCAFFOLD_ITEMS.has(prior.itemId)) {
        throw new Error(`placements[${index}] may only break an earlier stone scaffold`);
      }
      placed.delete(key(target));
      return { action: "break", target };
    }

    exactKeys(placement, ["itemId", "target", "support", "orientationTarget"], `placements[${index}]`);
    const itemId = String(placement.itemId || "");
    if (!PLACE_ITEMS[itemId]) throw new Error(`placements[${index}].itemId is not allowed`);
    const target = vector(placement.target, `placements[${index}].target`);
    const support = vector(placement.support, `placements[${index}].support`, { ground: true });
    if (!touches(target, support)) throw new Error(`placements[${index}].support must touch its target`);
    const supportIsGround = support[1] === -1 && target[1] === 0;
    if (!supportIsGround && !placed.has(key(support))) {
      throw new Error(`placements[${index}].support must be ground or an earlier placement`);
    }
    if (BELOW_ONLY.has(itemId)
      && !(support[0] === target[0] && support[1] === target[1] - 1 && support[2] === target[2])) {
      throw new Error(`placements[${index}].${itemId.split(":")[1]} requires support directly below`);
    }
    if (placed.has(key(target))) throw new Error(`placements[${index}].target is duplicated`);
    const orientationTarget = placement.orientationTarget === null ? null
      : vector(placement.orientationTarget, `placements[${index}].orientationTarget`);
    if (DIRECTIONAL_ITEMS.has(itemId) && (!orientationTarget || !touches(target, orientationTarget))) {
      throw new Error(`placements[${index}].orientationTarget must touch the directional block`);
    }
    if (!DIRECTIONAL_ITEMS.has(itemId) && orientationTarget) {
      throw new Error(`placements[${index}].orientationTarget is only for directional blocks`);
    }
    const normalized = { itemId, target, support, orientationTarget };
    placed.set(key(target), normalized);
    return normalized;
  });

  const controls = new Set([...placed.entries()]
    .filter(([, placement]) => placement.itemId === "minecraft:lever")
    .map(([location]) => location));
  const interactions = value.interactions.map((interaction, index) => {
    exactKeys(interaction, ["action", "itemId", "block", "faceTarget"], `interactions[${index}]`);
    if (interaction.action !== "use_item_on_block") throw new Error(`interactions[${index}].action is unsupported`);
    const itemId = String(interaction.itemId || "");
    if (!INTERACTION_ITEMS[itemId]) throw new Error(`interactions[${index}].itemId is not allowed`);
    const block = vector(interaction.block, `interactions[${index}].block`, { ground: true });
    const faceTarget = vector(interaction.faceTarget, `interactions[${index}].faceTarget`);
    if (!touches(block, faceTarget)) throw new Error(`interactions[${index}].faceTarget must touch its block`);
    if (itemId === "minecraft:stick" && !controls.has(key(block))) {
      throw new Error(`interactions[${index}] may only toggle a planned lever`);
    }
    if (itemId !== "minecraft:water_bucket" && !placed.has(key(block))) {
      throw new Error(`interactions[${index}].block must be a planned block`);
    }
    return { action: "use_item_on_block", itemId, block, faceTarget };
  });

  return {
    title: clean(value.title, "Working Machine", 32),
    kind: clean(value.kind, "machine", 48).toLowerCase(),
    placements,
    interactions,
  };
}

export function machineBlueprint(value) {
  const plan = validateMachinePlan(value);
  const placements = plan.placements.map((placement) => placement.action === "break" ? placement : {
    ...placement,
    expectedType: PLACE_ITEMS[placement.itemId],
    ...placement.orientationTarget && { orientationTarget: placement.orientationTarget },
  });
  const toggles = new Map();
  const preparedInteractions = plan.interactions.map((interaction) => {
    const behavior = INTERACTION_ITEMS[interaction.itemId];
    if (behavior.control) {
      const count = toggles.get(key(interaction.block)) || 0;
      toggles.set(key(interaction.block), count + 1);
      return { ...interaction, expectedState: { state: "open_bit", value: count % 2 === 0 } };
    }
    return { ...interaction, ...behavior };
  });
  const preInteractions = preparedInteractions.filter(({ expectedFaceType }) => expectedFaceType);
  const interactions = preparedInteractions.filter(({ expectedFaceType }) => !expectedFaceType);
  const verification = [];
  for (const placement of plan.placements) {
    if (placement.action === "break" || !placement.orientationTarget) continue;
    verification.push(placement.itemId === "minecraft:hopper"
      ? { kind: "container_link", from: placement.target, to: placement.orientationTarget }
      : { kind: "block_facing", from: placement.target, to: placement.orientationTarget });
  }
  for (const interaction of preparedInteractions) {
    if (interaction.expectedFaceType) {
      verification.push({ kind: "block_type", block: interaction.faceTarget, typeId: interaction.expectedFaceType });
    } else if (interaction.expectedEntity) {
      verification.push({
        kind: "entity_count",
        entityType: interaction.expectedEntity,
        min: 1,
        bounds: { min: interaction.faceTarget, max: interaction.faceTarget },
      });
    }
  }
  const points = [
    ...plan.placements.flatMap((placement) => placement.action === "break"
      ? [placement.target] : [placement.target, placement.support, placement.orientationTarget].filter(Boolean)),
    ...plan.interactions.flatMap(({ block, faceTarget }) => [block, faceTarget]),
  ];
  const bounds = {
    min: [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]))),
    max: [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]))),
  };
  return {
    title: plan.title,
    placements,
    preInteractions,
    interactions,
    verification,
    bounds,
    success: `${plan.title} is built. I checked every planned block, direction, and working interaction.`,
    usage: "Try its control or input while I watch; if one part behaves strangely, tell me what moved and I’ll tune it.",
  };
}

export function machinePlanSchemaPrompt() {
  return `build_machine action={"type":"build_machine","version":1,"plan":{"title":"short title","kind":"repeat the requested machine noun exactly","placements":[{"itemId":"minecraft:observer","target":[0,1,2],"support":[0,0,2],"orientationTarget":[0,1,1]}],"interactions":[]}}. `
    + `This is the bounded player-action plan for a working farm or machine without a fixed skill. Use real inputs, outputs, supports, controls, and collection where the design needs them. Never use build_structure for a functional machine. `
    + `Limits: ${MACHINE_PLAN_LIMITS.placements} placements, ${MACHINE_PLAN_LIMITS.interactions} interactions; x -${MACHINE_PLAN_LIMITS.x}..${MACHINE_PLAN_LIMITS.x}, y 0..${MACHINE_PLAN_LIMITS.y}, z 0..${MACHINE_PLAN_LIMITS.z}. `
    + `Every placement needs an adjacent ground or earlier support. Directional blocks require an adjacent orientationTarget; other blocks use null. A break placement may only remove earlier smooth-stone or cobblestone scaffolding. `
    + `Allowed placement items: ${Object.keys(PLACE_ITEMS).join(", ")}. Allowed interaction items: ${Object.keys(INTERACTION_ITEMS).join(", ")}.`;
}
