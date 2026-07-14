import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  allowedWizardAction,
  allowedWizardGoal,
  wizardSkillPrompt,
} from "../src/skills.mjs";

test("dimension travel is a validated in-world capability", () => {
  const action = { type: "dimension_travel", version: 1, destination: "nether" };
  assert.deepEqual(allowedWizardAction(action), action);
  assert.equal(allowedWizardAction({ ...action, destination: "moon" }), null);
  assert.match(wizardSkillPrompt(), /do not build a portal-shaped structure as a substitute/i);
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

test("JSON response schema exposes goal and dimension-travel contracts", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/wizard-response.schema.json", import.meta.url)));
  assert.ok(schema.properties.goal);
  const actions = schema.properties.action.anyOf;
  assert.ok(actions.some((entry) => entry.properties?.type?.const === "dimension_travel"));
});

test("capability prompt distinguishes projects and revisions", () => {
  const prompt = wizardSkillPrompt();
  assert.match(prompt, /build_complete_structure only for buildings/i);
  assert.match(prompt, /build_bounded_machine for a working farm/i);
  assert.match(prompt, /revision of the active project/i);
  assert.match(prompt, /status="complete" only after the live-world observation proves/i);
});
