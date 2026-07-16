import { buildPlanSchemaPrompt, validateBuildPlan } from "../bedrock/behavior_packs/mc_wizard/scripts/build-plan.js";
import { buildStructureSchemaPrompt, validateBuildStructurePlan } from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";
import { machinePlanSchemaPrompt, validateMachinePlan } from "../bedrock/behavior_packs/mc_wizard/scripts/machine-plan.js";
import { COMMAND_LESSONS, commandLessonPrompt } from "../bedrock/behavior_packs/mc_wizard/scripts/command-lessons.js";
import { recipeItemIds } from "../bedrock/behavior_packs/mc_wizard/scripts/recipe-display.js";
import {
  capabilityProgramPrompt,
  validateCapabilityProgram,
} from "../bedrock/behavior_packs/mc_wizard/scripts/capability-program.js";
import { capabilityRuntimePrompt } from "../bedrock/behavior_packs/mc_wizard/scripts/capability-runtime.js";

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
    name: "build_automatic_wool_farm",
    description: "Physically build and test a real Bedrock automatic wool farm with a sheep on renewable grass, an observer-triggered dispenser loaded with shears, and hopper-minecart collection into a chest.",
    action: { type: "place_blueprint", id: "automatic_wool_farm", version: 1 },
  },
  {
    name: "build_automatic_kelp_farm",
    description: "Physically build and test a real Bedrock automatic kelp farm with a source-water growth column, observer-triggered piston harvesting, and floating-item collection into a chest.",
    action: { type: "place_blueprint", id: "automatic_kelp_farm", version: 1 },
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
    name: "travel_to_dimension",
    description: "Safely move the requesting player and nearby players together to the requested Bedrock dimension. Use this for requests to take, teleport, or travel to the Nether, Overworld, or End; do not build a portal-shaped structure as a substitute.",
    action: { type: "dimension_travel", version: 1, destination: "nether" },
  },
  {
    name: "cast_splash_potion_rain",
    description: "Create a bounded shower of falling splash-potion projectiles around the player. Use this for imaginative requests to make splash potions rain from the sky; do not substitute ordinary weather rain.",
    action: { type: "potion_rain", version: 1, radius: 8, durationSeconds: 8 },
  },
  {
    name: "give_player_items",
    description: "Put requested ordinary Minecraft items directly into the requesting player's inventory instead of relaying a give command.",
    action: { type: "give_items", version: 1, items: [{ itemId: "minecraft:iron_pickaxe", amount: 1 }] },
  },
  {
    name: "light_area_with_torches",
    description: "Light the nearby area with visible torches placed by MC Wizard as a player. Use this by default for requests to light up or brighten the area; use night vision only when the child explicitly asks for that effect.",
    action: { type: "place_area_torches", version: 1 },
  },
  {
    name: "execute_minecraft_commands",
    description: "Execute ordinary Bedrock commands to produce an immediate in-world result when no narrower skill covers it. Commands omit the leading slash and use @s for the requesting player. Never merely explain a command when the child asked for the result.",
    action: { type: "run_commands", version: 1, commands: ["effect @s night_vision 999999 0 true"] },
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

const FORBIDDEN_COMMAND_ROOTS = new Set([
  "allowlist", "ban", "ban-ip", "banlist", "changesetting", "deop", "kick", "op",
  "pardon", "pardon-ip", "permissions", "reload", "reloadconfig",
  "reloadpacketlimitconfig", "save", "script", "sendshowstoreoffer", "setmaxplayers",
  "stop", "whitelist",
]);

function allowedCommand(value) {
  if (typeof value !== "string") return null;
  const command = value.trim();
  if (!command || command.length > 240 || command.startsWith("/")
    || /[\u0000-\u001f\u007f]/.test(command)) return null;
  const root = command.split(/\s+/, 1)[0].toLowerCase();
  if (FORBIDDEN_COMMAND_ROOTS.has(root)) return null;
  // Every player selector must stay requester-scoped. World-coordinate commands need no selector.
  if (/@(?:a|e|p|r)(?:\b|\[)/i.test(command)) return null;
  return command;
}

export function allowedWizardAction(value) {
  if (value?.type === "execute_program" && value.version === 1) {
    try {
      return { type: "execute_program", version: 1, program: validateCapabilityProgram(value.program) };
    } catch {
      return null;
    }
  }
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
  if (value?.type === "dimension_travel") {
    return value.version === 1 && ["overworld", "nether", "the_end"].includes(value.destination)
      ? { type: "dimension_travel", version: 1, destination: value.destination } : null;
  }
  if (value?.type === "potion_rain" && value.version === 1) {
    const radius = Math.min(12, Math.max(3, Math.floor(Number(value.radius) || 8)));
    const durationSeconds = Math.min(15, Math.max(3, Math.floor(Number(value.durationSeconds) || 8)));
    return { type: "potion_rain", version: 1, radius, durationSeconds };
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
  if (value?.type === "run_commands" && value.version === 1 && Array.isArray(value.commands)
    && value.commands.length >= 1 && value.commands.length <= 8) {
    const commands = value.commands.map(allowedCommand);
    return commands.every(Boolean) ? { type: "run_commands", version: 1, commands } : null;
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

export function wizardActionRejection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "no action object";
  if (value.version !== 1) return "action version must be 1";
  try {
    if (value.type === "build_structure") validateBuildStructurePlan(value.plan);
    else if (value.type === "build_machine") validateMachinePlan(value.plan);
    else if (value.type === "build_plan") validateBuildPlan(value.plan);
    else if (value.type === "execute_program") validateCapabilityProgram(value.program);
    else return allowedWizardAction(value) ? null : "action is not registered or its arguments are invalid";
    return null;
  } catch (error) {
    return String(error?.message || error).slice(0, 240);
  }
}

export function allowedWizardGoal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !["objective", "successCriteria", "status"].includes(key))) return null;
  const clean = (text) => typeof text === "string"
    ? text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  const objective = clean(value.objective);
  const successCriteria = clean(value.successCriteria);
  if (!objective || objective.length > 500 || !successCriteria || successCriteria.length > 500
    || !["active", "complete"].includes(value.status)) return null;
  return { objective, successCriteria, status: value.status };
}

export function wizardGoalPrompt() {
  return `For an in-world request, include goal={"objective":"the player's intended result","successCriteria":"observable facts that prove the result works","status":"active"}. Keep the same goal for follow-up corrections and revise its objective or success criteria from the player's feedback; return a concrete corrective action at the existing project instead of action=null or a replacement build. Use status="complete" only after the live-world observation proves every success criterion.`;
}

export function wizardSkillPrompt() {
  return [...WIZARD_SKILLS, {
    name: "show_crafting_recipe",
    description: "Show a requested crafting recipe as an in-world ingredient display. Resolve the exact Bedrock item ID; do not invent one.",
    action: { type: "show_recipe", version: 1, itemId: "minecraft:crafting_table" },
  }]
    .map(({ name, description, action }) => `- ${name}: ${description}\n  action=${JSON.stringify(action)}`)
    .join("\n")
    + `\n\n${capabilityProgramPrompt()}\n${capabilityRuntimePrompt()}\n\nCapability selection:\n- Use build_complete_structure only for buildings, sculptures, and other static geometry.\n- Use build_bounded_machine for a working farm, redstone machine, or corrective revision that needs exact blocks, directions, interactions, inputs, and outputs.\n- Use build_validated_plan only for a small decorative block-by-block detail; it is not a fallback for a complete structure or working machine.\n- Use execute_program for a novel request that needs several different actions, live observation, or verification.\n- Use execute_minecraft_commands for a concrete in-world result not covered by a narrower action. Use @s for the requesting child, never a nearest-player or broad selector. Do not expose the command in chat unless explicitly asked.\n- Treat criticism such as “too short,” “items escape,” “make it work,” or “that is not what I asked for” as a revision of the active project. Preserve its location, observe the problem, and issue the next corrective action.\n${wizardGoalPrompt()}`;
}
