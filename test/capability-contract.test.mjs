import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  capabilityProgramRequiredAuthority,
  validateCapabilityProgram,
} from "../bedrock/behavior_packs/mc_wizard/scripts/capability-program.js";
import { runtimeProgramHasEvidence } from "../bedrock/behavior_packs/mc_wizard/scripts/capability-runtime.js";
import {
  allowedWizardAction,
  allowedWizardGoal,
  wizardSkillPrompt,
} from "../src/skills.mjs";
import { classifyAction, createWizard } from "../src/wizard.mjs";

test("capability programs compose novel actions without extending the response union", () => {
  const program = {
    title: "Cake horse staircase",
    steps: [
      {
        id: "research_cake",
        capability: "knowledge.research",
        arguments: { query: "Bedrock cake collision and horse movement" },
        expect: "The plan cites current Bedrock behavior.",
      },
      {
        id: "build_stairs",
        capability: "player.place-blocks",
        arguments: { itemId: "minecraft:cake", targets: [[1, 0, 2], [1, 1, 3]] },
        expect: "The requested cake staircase exists nearby.",
      },
      {
        id: "test_horse",
        capability: "verify.entity-path",
        arguments: { typeId: "minecraft:horse", path: "up the staircase", speed: "maximum" },
        expect: "A horse reaches the top at maximum speed.",
      },
    ],
  };
  assert.deepEqual(validateCapabilityProgram(program), {
    ...program,
    steps: program.steps.map((step) => ({ ...step, onFailure: "replan" })),
  });
  assert.equal(allowedWizardAction({ type: "execute_program", version: 1, program }), null);
  const executable = {
    title: "Cake step",
    site: "active_project",
    targetKind: "castle",
    steps: [{
      id: "build_step",
      capability: "player.place-blocks",
      arguments: { blocks: [{
        itemId: "minecraft:cake", target: [0, 0, 1], support: [0, -1, 1], expectedType: "minecraft:cake",
      }] },
      expect: "The cake step exists.",
    }, {
      id: "verify_step",
      capability: "verify.blocks",
      arguments: { blocks: [{ target: [0, 0, 1], typeId: "minecraft:cake" }] },
      expect: "The cake block is present.",
    }],
  };
  const validated = validateCapabilityProgram(executable);
  assert.deepEqual(allowedWizardAction({ type: "execute_program", version: 1, program: executable }), {
    type: "execute_program",
    version: 1,
    program: {
      ...validated,
      steps: validated.steps.map((entry, index) => ({
        ...entry,
        arguments: index === 0
          ? { blocks: [{ ...entry.arguments.blocks[0], expectedStates: {} }] }
          : entry.arguments,
      })),
    },
  });
});

test("the compiler derives exact final block evidence from validated placements", () => {
  const action = allowedWizardAction({
    type: "execute_program",
    version: 1,
    program: {
      title: "Furniture table",
      steps: [{
        id: "place_table",
        capability: "player.place-blocks",
        arguments: { blocks: [{
          itemId: "minecraft:oak_planks",
          target: [0, 1, 0],
          support: [0, 0, 0],
          expectedType: "minecraft:oak_planks",
        }] },
        expect: "The furniture table is placed.",
      }],
    },
  });
  assert.equal(action.type, "execute_program");
  assert.equal(action.program.steps.at(-1).capability, "verify.blocks");
  assert.deepEqual(action.program.steps.at(-1).arguments.blocks, [{
    target: [0, 1, 0], typeId: "minecraft:oak_planks",
  }]);
  assert.equal(runtimeProgramHasEvidence(action.program.steps), true);
});

test("capability programs derive admin authority and reject unsafe or ambiguous data", () => {
  const ownerProgram = validateCapabilityProgram({
    title: "Private family server",
    steps: [{
      id: "allow_owner",
      capability: "server.console",
      arguments: { command: "allowlist add alt3rname" },
      expect: "The owner remains allowed to join.",
    }],
  });
  assert.equal(capabilityProgramRequiredAuthority(ownerProgram), "owner");
  assert.equal(allowedWizardAction({ type: "execute_program", version: 1, program: ownerProgram }), null);
  assert.equal(capabilityProgramRequiredAuthority(validateCapabilityProgram({
    title: "Operator action",
    steps: [{
      id: "moderate",
      capability: "world.admin",
      arguments: {},
      expect: "The operator action succeeds.",
    }],
  })), "operator");
  assert.throws(() => validateCapabilityProgram({
    title: "Duplicate",
    steps: [ownerProgram.steps[0], ownerProgram.steps[0]],
  }), /unique and safe/);
  assert.throws(() => validateCapabilityProgram({
    title: "Unsafe",
    steps: [{ ...ownerProgram.steps[0], id: "unsafe", arguments: JSON.parse('{"__proto__":{"oops":true}}') }],
  }), /unsafe field/);
  for (const argumentsValue of [undefined, true, 1, "command"]) {
    assert.throws(() => validateCapabilityProgram({
      title: "Arguments are objects",
      steps: [{ ...ownerProgram.steps[0], id: "bad_args", arguments: argumentsValue }],
    }), /JSON values only|must be an object/);
  }
  assert.throws(() => validateCapabilityProgram({
    title: "   ",
    steps: [ownerProgram.steps[0]],
  }), /must contain/);
});

test("dimension travel is a validated in-world capability", () => {
  const action = { type: "dimension_travel", version: 1, destination: "nether" };
  assert.deepEqual(allowedWizardAction(action), action);
  assert.equal(allowedWizardAction({ ...action, destination: "moon" }), null);
  assert.match(wizardSkillPrompt(), /do not build a portal-shaped structure as a substitute/i);
});

test("surface and generated-structure travel are validated in-world capabilities", () => {
  for (const destination of ["surface", "nearest_village"]) {
    const action = { type: "local_travel", version: 1, destination };
    assert.deepEqual(allowedWizardAction(action), action);
  }
  assert.deepEqual(allowedWizardAction({
    type: "local_travel", version: 1, destination: "nearest_structure", structure: "mansion",
  }), {
    type: "local_travel", version: 1, destination: "nearest_structure",
    structure: "mansion", dimension: "overworld", label: "woodland mansion",
  });
  assert.deepEqual(allowedWizardAction({
    type: "local_travel", version: 1, destination: "nearest_structure",
    structure: "fortress", dimension: "nether",
  })?.dimension, "nether");
  assert.equal(allowedWizardAction({
    type: "local_travel", version: 1, destination: "nearest_structure", structure: "made_up_castle",
  }), null);
  assert.equal(allowedWizardAction({ type: "local_travel", version: 1, destination: "nearest_city" }), null);
  assert.match(wizardSkillPrompt(), /destination=surface/i);
  assert.match(wizardSkillPrompt(), /destination=nearest_village/i);
  assert.match(wizardSkillPrompt(), /mansion/);
  assert.match(wizardSkillPrompt(), /trial_chambers/);
});

test("trusted-family Bedrock commands allow every Minecraft target and admin action", () => {
  const action = { type: "run_commands", version: 1, commands: ["effect @s night_vision 999999 0 true"] };
  assert.deepEqual(allowedWizardAction(action), action);
  for (const command of [
    "effect @a night_vision 60", "effect OtherKid night_vision 60", "op @s",
    "execute as @s run op @s", "kill OtherKid", "tp OtherKid @s", "damage OtherKid 100",
    "fill ~ ~ ~ ~10 ~10 ~10 air", "/effect @s night_vision 60",
  ]) assert.ok(allowedWizardAction({ ...action, commands: [command] }));
  assert.match(wizardSkillPrompt(), /broad selectors are allowed/i);
  assert.match(wizardSkillPrompt(), /trusted private family sandbox/i);
});

test("operator requests route to the dedicated-server hand instead of a structure", () => {
  for (const question of ["wiz, make me an operator", "op me please", "give me operator permissions"]) {
    const action = classifyAction(question);
    assert.equal(action.type, "execute_program", question);
    assert.equal(action.program.steps[0].capability, "server.console", question);
    assert.deepEqual(action.program.steps[0].arguments.commands, ["op {{requester}}"], question);
  }
  assert.deepEqual(classifyAction("deop me").program.steps[0].arguments.commands, ["deop {{requester}}"]);
});

test("the full Wizard turn keeps operator intent out of generic build fallback", async () => {
  const wizard = createWizard({ corpus: { search: () => [] }, env: {} });
  const result = await wizard.ask({ player: "OperatorKid", question: "wiz, make me an operator" });
  assert.equal(result.action.type, "execute_program");
  assert.equal(result.action.program.steps[0].capability, "server.console");
  assert.doesNotMatch(result.answer, /first-pass|size guide/i);
});

test("rich item delivery supports exact connected recipients, names, enchantments, and large amounts", () => {
  const action = {
    type: "give_items", version: 1, recipient: "enti1ty303",
    items: [{
      itemId: "minecraft:diamond_sword", amount: 256, nameTag: "Star Cutter",
      enchantments: [{ id: "minecraft:sharpness", level: 5 }],
    }],
  };
  assert.deepEqual(allowedWizardAction(action), action);
  assert.equal(allowedWizardAction({ ...action, recipient: "@a" }), null);
  assert.equal(allowedWizardAction({ ...action, items: [{ ...action.items[0], amount: 10_001 }] }), null);
  assert.equal(allowedWizardAction({
    ...action, items: [{ ...action.items[0], enchantments: [{ id: "sharpness", level: 5 }] }],
  }), null);
});

test("common effects become commands while area lighting defaults to player-placed torches", () => {
  assert.deepEqual(classifyAction("give me the nightvision effect"), {
    type: "run_commands",
    version: 1,
    commands: ["effect @s night_vision 999999 0 true"],
  });
  const lighting = classifyAction("it's dark. light up this area");
  assert.deepEqual(lighting, { type: "place_area_torches", version: 1 });
  assert.equal(classifyAction("what command gives me night vision?"), null);
});

test("goal metadata is bounded and strips control characters", () => {
  assert.deepEqual(allowedWizardGoal({
    objective: "  Keep\nchickens contained  ",
    successCriteria: "No chicken can walk out; eggs reach the chest.",
    status: "active",
  }), {
    objective: "Keep chickens contained",
    successCriteria: "No chicken can walk out; eggs reach the chest.",
    status: "active",
  });
  assert.equal(allowedWizardGoal({ objective: "build", successCriteria: "works", status: "unsure" }), null);
  assert.equal(allowedWizardGoal({ objective: "build", successCriteria: "works", status: "active", extra: true }), null);
});

test("JSON response schema exposes goal, travel, and command contracts", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/wizard-response.schema.json", import.meta.url)));
  assert.ok(schema.properties.goal);
  const actions = schema.properties.action.anyOf;
  assert.ok(actions.some((entry) => entry.properties?.type?.const === "dimension_travel"));
  assert.ok(actions.some((entry) => entry.properties?.type?.const === "local_travel"));
  assert.ok(actions.some((entry) => entry.properties?.type?.const === "run_commands"));
  assert.ok(actions.some((entry) => entry.properties?.type?.const === "place_area_torches"));
  const program = actions.find((entry) => entry.properties?.type?.const === "execute_program");
  assert.equal(program.properties.program.properties.steps.maxItems, 48);
  assert.deepEqual(program.properties.program.properties.site.enum, ["nearby", "active_project"]);
  assert.equal(program.properties.program.properties.targetKind.maxLength, 80);
  assert.equal(program.properties.program.properties.steps.items.properties.arguments.type, "object");
  assert.equal(program.properties.program.properties.steps.items.properties.arguments.maxProperties, 64);
  assert.equal(program.properties.program.properties.title.pattern, "\\S");
  const gift = actions.find((entry) => entry.properties?.type?.const === "give_items");
  assert.equal(gift.properties.items.items.properties.amount.maximum, 10000);
  assert.ok(gift.properties.items.items.properties.nameTag);
  assert.ok(gift.properties.items.items.properties.enchantments);
});

test("capability prompt distinguishes projects and revisions", () => {
  const prompt = wizardSkillPrompt();
  assert.match(prompt, /build_complete_structure only for buildings/i);
  assert.match(prompt, /build_bounded_machine for a working farm/i);
  assert.match(prompt, /revision of the active project/i);
  assert.match(prompt, /status="complete" only after the live-world observation proves/i);
  assert.match(prompt, /novel or multi-step in-world goal, use execute_program/i);
  assert.match(prompt, /failed expectation is an observation/i);
  assert.match(prompt, /site="active_project" for every requested revision/i);
});
