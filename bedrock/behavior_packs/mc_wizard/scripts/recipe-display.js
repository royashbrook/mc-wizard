const R = "minecraft:redstone";
const C = "minecraft:cobblestone";
const P = "minecraft:oak_planks";
const I = "minecraft:iron_ingot";

const RECIPES = Object.freeze({
  "minecraft:crafting_table": {
    name: "Crafting Table",
    grid: [null, null, null, P, P, null, P, P, null],
    count: 1,
  },
  "minecraft:chest": {
    name: "Chest",
    grid: [P, P, P, P, null, P, P, P, P],
    count: 1,
  },
  "minecraft:furnace": {
    name: "Furnace",
    grid: [C, C, C, C, null, C, C, C, C],
    count: 1,
  },
  "minecraft:hopper": {
    name: "Hopper",
    grid: [I, null, I, I, "minecraft:chest", I, null, I, null],
    count: 1,
  },
  "minecraft:piston": {
    name: "Piston",
    grid: [P, P, P, C, I, C, C, R, C],
    count: 1,
  },
  "minecraft:observer": {
    name: "Observer",
    grid: [C, C, C, R, R, "minecraft:quartz", C, C, C],
    count: 1,
  },
  "minecraft:dispenser": {
    name: "Dispenser",
    grid: [C, C, C, C, "minecraft:bow", C, C, R, C],
    count: 1,
  },
  "minecraft:repeater": {
    name: "Redstone Repeater",
    grid: [null, null, null, "minecraft:redstone_torch", R, "minecraft:redstone_torch", "minecraft:stone", "minecraft:stone", "minecraft:stone"],
    count: 1,
  },
  "minecraft:comparator": {
    name: "Redstone Comparator",
    grid: [null, "minecraft:redstone_torch", null, "minecraft:redstone_torch", "minecraft:quartz", "minecraft:redstone_torch", "minecraft:stone", "minecraft:stone", "minecraft:stone"],
    count: 1,
  },
  "minecraft:redstone_lamp": {
    name: "Redstone Lamp",
    grid: [null, R, null, R, "minecraft:glowstone", R, null, R, null],
    count: 1,
  },
});

const place = (itemId, target, support, expectedType = itemId) => ({ itemId, target, support, expectedType });

export function recipeFor(itemId) {
  const recipe = RECIPES[itemId];
  return recipe ? { itemId, ...recipe, grid: [...recipe.grid] } : undefined;
}

export function recipeItemIds() {
  return Object.keys(RECIPES);
}

/** Build an upright crafting grid. Item frames hold the real ingredients. */
export function createRecipeDisplay(itemId) {
  const recipe = recipeFor(itemId);
  if (!recipe) throw new Error(`unsupported recipe: ${itemId}`);
  const placements = [];
  for (let y = 0; y <= 3; y += 1) {
    for (let x = -2; x <= 3; x += 1) {
      placements.push(place("minecraft:oak_planks", [x, y, 3], [x, y - 1, 3]));
    }
  }
  const ingredientFrames = recipe.grid.map((ingredient, index) => {
    const target = [-2 + (index % 3), 3 - Math.floor(index / 3), 2];
    placements.push(place("minecraft:frame", target, [target[0], target[1], 3]));
    return { target, ingredient };
  });
  const outputFrame = [3, 2, 2];
  placements.push(place("minecraft:frame", outputFrame, [3, 2, 3]));
  const interaction = (frame, displayedItemId) => ({
    action: "use_item_on_block",
    itemId: displayedItemId,
    block: frame,
    faceTarget: [frame[0], frame[1], frame[2] - 1],
  });
  const interactions = ingredientFrames
    .filter(({ ingredient }) => ingredient)
    .map(({ target, ingredient }) => interaction(target, ingredient));
  interactions.push(interaction(outputFrame, itemId));
  return {
    id: "show_recipe",
    title: `${recipe.name} Recipe`,
    itemId,
    placements,
    interactions,
    bounds: { min: [-2, -1, 2], max: [3, 3, 3] },
    recipe,
    success: `${recipe.name} recipe ready! The nine frames are the crafting grid. Empty frames stay empty, and the frame on the right shows what you make.`,
  };
}
