import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  allowedWizardAction,
  allowedWizardGoal,
  wizardSkillPrompt,
} from "../src/skills.mjs";
import { classifyAction } from "../src/wizard.mjs";

test("dimension travel is a validated in-world capability", () => {
  const action = { type: "dimension_travel", version: 1, destination: "nether" };
  assert.deepEqual(allowedWizardAction(action), action);
  assert.equal(allowedWizardAction({ ...action, destination: "moon" }), null);
  assert.match(wizardSkillPrompt(), /do not build a portal-shaped structure as a substitute/i);
});

test("requester-scoped Bedrock commands are executable but admin and broad selectors are rejected", () => {
  const action = { type: "run_commands", version: 1, commands: ["effect @s night_vision 999999 0 true"] };
  assert.deepEqual(allowedWizardAction(action), action);
  assert.equal(allowedWizardAction({ ...action, commands: ["effect @a night_vision 60"] }), null);
  assert.equal(allowedWizardAction({ ...action, commands: ["op @s"] }), null);
  assert.equal(allowedWizardAction({ ...action, commands: ["/effect @s night_vision 60"] }), null);
  assert.match(wizardSkillPrompt(), /use @s for the requesting child/i);
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
  assert.ok(actions.some((entry) => entry.properties?.type?.const === "run_commands"));
  assert.ok(actions.some((entry) => entry.properties?.type?.const === "place_area_torches"));
});

test("capability prompt distinguishes projects and revisions", () => {
  const prompt = wizardSkillPrompt();
  assert.match(prompt, /build_complete_structure only for buildings/i);
  assert.match(prompt, /build_bounded_machine for a working farm/i);
  assert.match(prompt, /revision of the active project/i);
  assert.match(prompt, /status="complete" only after the live-world observation proves/i);
});
