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
  assert.ok(plan.properties.entities.items.properties.typeId.enum.includes("minecraft:villager_v2"));
});

for (const fixture of fixtures) {
  test(`replays live chat regression: ${fixture.id}`, () => {
    const history = fixture.replayHistory
      ? fixture.history.reduce((turns, turn) => {
        const action = classifyAction(turn.question, turns);
        return [...turns, { ...turn, ...(action && { action }), status: action ? "completed" : undefined }];
      }, [])
      : fixture.history;
    const action = classifyAction(fixture.question, history);
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
    if (expected.destination) assert.equal(action.destination, expected.destination);
    if (expected.placementCount !== undefined) assert.equal(action.plan?.placements?.length, expected.placementCount);
    if (expected.interactionCount !== undefined) assert.equal(action.plan?.interactions?.length, expected.interactionCount);
    if (expected.lastPlacementAction) assert.equal(action.plan?.placements?.at(-1)?.action, expected.lastPlacementAction);
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
    for (const blockId of expected.blockIds || []) {
      assert.ok(action.plan?.primitives?.some((primitive) => primitive.blockId === blockId), `missing ${blockId}`);
    }
    for (const [typeId, count] of Object.entries(expected.entityCounts || {})) {
      assert.equal(action.plan?.entities?.filter((entity) => entity.typeId === typeId).length, count, typeId);
    }
    for (const [itemId, amount] of Object.entries(expected.itemCounts || {})) {
      assert.equal(action.items?.find((item) => item.itemId === itemId)?.amount, amount, itemId);
    }
  });
}
