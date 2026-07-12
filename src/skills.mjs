import { buildPlanSchemaPrompt, validateBuildPlan } from "../bedrock/behavior_packs/mc_wizard/scripts/build-plan.js";
import { COMMAND_LESSONS, commandLessonPrompt } from "../bedrock/behavior_packs/mc_wizard/scripts/command-lessons.js";

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
  return WIZARD_SKILLS
    .map(({ name, description, action }) => `- ${name}: ${description}\n  action=${JSON.stringify(action)}`)
    .join("\n");
}
