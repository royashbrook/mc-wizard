import { buildPlanSchemaPrompt, validateBuildPlan } from "../bedrock/behavior_packs/mc_wizard/scripts/build-plan.js";
import { buildStructureSchemaPrompt, validateBuildStructurePlan } from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";
import { machinePlanSchemaPrompt, validateMachinePlan } from "../bedrock/behavior_packs/mc_wizard/scripts/machine-plan.js";
import { COMMAND_LESSONS, commandLessonPrompt } from "../bedrock/behavior_packs/mc_wizard/scripts/command-lessons.js";
import { recipeItemIds } from "../bedrock/behavior_packs/mc_wizard/scripts/recipe-display.js";

const RECIPE_ITEM_IDS = new Set(recipeItemIds());

export const WIZARD_SKILLS = [
  {
    name: "build_t_flip_flop",
    description: "Physically build the small Bedrock copper-bulb T flip-flop demo when the player asks you to build or demonstrate one.",
    action: { type: "place_blueprint", id: "copper_bulb_t_flip_flop", version: 1 },
  },
  {
    name: "build_two_bit_calculator",
    description: "Physically build the tested two-bit redstone calculator when the player asks you to build a calculator, binary adder, or full-adder demo.",
    action: { type: "place_blueprint", id: "binary_adder_2bit", version: 1 },
  },
  {
    name: "build_automated_chicken_farm",
    description: "Physically build the tested automatic Bedrock chicken egg collector when the player asks for an automated chicken farm: chickens lay eggs into a hopper and chest.",
    action: { type: "place_blueprint", id: "automated_chicken_farm", version: 1 },
  },
  {
    name: "build_two_by_two_piston_door",
    description: "Physically build and test a complete 2x2 Bedrock sticky-piston door with one lever.",
    action: { type: "place_blueprint", id: "two_by_two_piston_door", version: 1 },
  },
  {
    name: "build_item_sorter",
    description: "Physically build and load a complete overflow-safe item sorter. The fixed model action sorts iron ingots; local requests can select another supported common item.",
    action: { type: "place_blueprint", id: "item_sorter", version: 1 },
  },
  {
    name: "build_automatic_smelter",
    description: "Physically build and verify a complete automatic furnace with separate input, fuel, and output chests.",
    action: { type: "place_blueprint", id: "automatic_smelter", version: 1 },
  },
  {
    name: "control_world_time_and_weather",
    description: "Immediately change requested world time and weather instead of relaying a command. Include time, weather, or both.",
    action: { type: "world_control", version: 1, time: "day", weather: "clear" },
  },
  {
    name: "give_player_items",
    description: "Put requested ordinary Minecraft items directly into the requesting player's inventory instead of relaying a give command.",
    action: { type: "give_items", version: 1, items: [{ itemId: "minecraft:iron_pickaxe", amount: 1 }] },
  },
  {
    name: "build_complete_structure",
    description: buildStructureSchemaPrompt(),
    action: { type: "build_structure", version: 1 },
  },
  {
    name: "build_bounded_machine",
    description: machinePlanSchemaPrompt(),
    action: { type: "build_machine", version: 1 },
  },
  {
    name: "build_validated_plan",
    description: buildPlanSchemaPrompt(),
    action: { type: "build_plan", version: 1 },
  },
  ...Object.values(COMMAND_LESSONS).map((lesson) => ({
    name: `command_lesson_${lesson.id}`,
    description: `Physically place a command block and button, then teach the player to paste the safe Bedrock command. ${commandLessonPrompt()}`,
    action: { type: "command_lesson", id: lesson.id, version: 1 },
  })),
];

export function allowedWizardAction(value) {
  if (value?.type === "place_blueprint" && value.id === "item_sorter" && value.version === 1) {
    const filterItem = value.filterItem || "minecraft:iron_ingot";
    const supported = new Set([
      "minecraft:coal", "minecraft:cobblestone", "minecraft:copper_ingot", "minecraft:diamond",
      "minecraft:dirt", "minecraft:emerald", "minecraft:gold_ingot", "minecraft:iron_ingot",
      "minecraft:oak_log", "minecraft:redstone", "minecraft:stone",
    ]);
    return supported.has(filterItem)
      ? { type: "place_blueprint", id: "item_sorter", version: 1, filterItem }
      : null;
  }
  if (value?.type === "world_control" && value.version === 1) {
    const time = ["day", "night", "noon", "midnight"].includes(value.time) ? value.time : undefined;
    const weather = ["clear", "rain", "thunder"].includes(value.weather) ? value.weather : undefined;
    return time || weather ? { type: "world_control", version: 1, ...(time && { time }), ...(weather && { weather }) } : null;
  }
  if (value?.type === "give_items" && value.version === 1 && Array.isArray(value.items)
    && value.items.length >= 1 && value.items.length <= 16) {
    const items = value.items.map(({ itemId, amount }) => ({ itemId: String(itemId || ""), amount: Number(amount) }));
    if (items.every(({ itemId, amount }) => /^minecraft:[a-z0-9_]+$/.test(itemId)
      && Number.isInteger(amount) && amount >= 1 && amount <= 64)) {
      return { type: "give_items", version: 1, items };
    }
    return null;
  }
  if (value?.type === "build_structure" && value.version === 1) {
    try {
      return { type: "build_structure", version: 1, plan: validateBuildStructurePlan(value.plan) };
    } catch {
      return null;
    }
  }
  if (value?.type === "build_machine" && value.version === 1) {
    try {
      return { type: "build_machine", version: 1, plan: validateMachinePlan(value.plan) };
    } catch {
      return null;
    }
  }
  if (value?.type === "show_recipe" && value.version === 1 && RECIPE_ITEM_IDS.has(value.itemId)) {
    return { type: "show_recipe", version: 1, itemId: value.itemId };
  }
  if (value?.type === "build_plan" && value.version === 1) {
    try {
      return { type: "build_plan", version: 1, plan: validateBuildPlan(value.plan) };
    } catch {
      return null;
    }
  }
  return WIZARD_SKILLS.find(({ action }) => (
    value?.type === action.type && value.id === action.id && value.version === action.version
  ))?.action || null;
}

export function wizardSkillPrompt() {
  return [...WIZARD_SKILLS, {
    name: "show_crafting_recipe",
    description: "Show a requested crafting recipe as an in-world ingredient display. Resolve the exact Bedrock item ID; do not invent one.",
    action: { type: "show_recipe", version: 1, itemId: "minecraft:crafting_table" },
  }]
    .map(({ name, description, action }) => `- ${name}: ${description}\n  action=${JSON.stringify(action)}`)
    .join("\n");
}
