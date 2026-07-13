import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyAction } from "../src/wizard.mjs";

const fixtures = JSON.parse(readFileSync(
  new URL("./fixtures/live-chat-regressions.json", import.meta.url),
  "utf8",
));
const responseSchema = JSON.parse(readFileSync(
  new URL("../schemas/wizard-response.schema.json", import.meta.url),
  "utf8",
));

test("response schema carries the bounded live-regression actions", () => {
  const actions = responseSchema.properties.action.anyOf;
  const action = (type) => actions.find((candidate) => candidate.properties?.type?.const === type);
  assert.ok(action("place_blueprint").properties.id.enum.includes("automatic_wool_farm"));
  assert.deepEqual(action("potion_rain").properties.radius, { type: "integer", minimum: 3, maximum: 12 });
  assert.deepEqual(action("potion_rain").properties.durationSeconds, { type: "integer", minimum: 3, maximum: 15 });
  const plan = action("build_structure").properties.plan;
  assert.equal(plan.properties.mode.const, "modify");
  for (const feature of ["rooms", "second_floor", "decorations"]) {
    assert.ok(plan.properties.features.items.enum.includes(feature));
  }
  assert.equal(plan.properties.entities.maxItems, 8);
  assert.equal(plan.properties.entities.items.properties.typeId.const, "minecraft:villager_v2");
});

for (const fixture of fixtures) {
  test(`replays live chat regression: ${fixture.id}`, () => {
    const action = classifyAction(fixture.question, fixture.history);
    const expected = fixture.expected;

    if (expected.type === null) {
      assert.equal(action, null, `${fixture.id} must remain conversation, not become an action`);
      return;
    }
    assert.ok(action, `${fixture.id} must produce an action`);
    assert.equal(action.type, expected.type);
    if (expected.id) assert.equal(action.id, expected.id);

    if (action.type === "potion_rain") {
      assert.ok(action.radius >= 3 && action.radius <= 12, "potion radius must stay bounded");
      assert.ok(action.durationSeconds >= 3 && action.durationSeconds <= 15, "potion duration must stay bounded");
    }

    if (expected.kind) assert.equal(action.plan?.kind, expected.kind);
    if (expected.mode) assert.equal(action.plan?.mode || "new", expected.mode);
    for (const dimension of ["width", "depth", "height"]) {
      if (expected[dimension] !== undefined) {
        assert.equal(action.plan?.dimensions?.[dimension], expected[dimension], dimension);
      }
    }
    if (expected.feature) assert.ok(action.plan?.features?.includes(expected.feature));
    for (const feature of expected.features || []) {
      assert.ok(action.plan?.features?.includes(feature), `missing ${feature}`);
    }
    if (expected.entity) {
      assert.ok(action.plan?.entities?.some(({ typeId }) => typeId === expected.entity));
      assert.ok(action.plan.entities.length <= 8);
    }
  });
}
