import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeRuntimeStep,
  runtimeProgramHasEvidence,
  synthesizeRuntimeEvidence,
} from "../bedrock/behavior_packs/mc_wizard/scripts/capability-runtime.js";

const step = (capability, args) => normalizeRuntimeStep({
  id: `model_${capability.replace(/\W/g, "_")}`,
  capability,
  arguments: args,
  expect: "The visible result is correct.",
  onFailure: "replan",
});

const place = (blocks) => step("player.place-blocks", { blocks });
const cake = { itemId: "minecraft:cake", target: [0, 0, 1], support: [0, -1, 1], expectedType: "minecraft:cake" };

function verifiedBlockTargets(steps) {
  return steps
    .filter(({ capability }) => capability === "verify.blocks")
    .flatMap(({ arguments: args }) => args.blocks.map(({ target }) => target.join(",")));
}

test("synthesis gives a verify-free place+spawn program complete runtime evidence", () => {
  const program = [
    place([cake, {
      itemId: "minecraft:hopper", target: [1, 0, 1], support: [1, -1, 1],
      expectedType: "minecraft:hopper", expectedStates: { facing_direction: 2 },
    }]),
    step("script.spawn-entity", { typeId: "minecraft:horse", location: [2, 0, 1], count: 2 }),
  ];
  assert.equal(runtimeProgramHasEvidence(program), false);
  const evidenced = synthesizeRuntimeEvidence(program);
  assert.equal(runtimeProgramHasEvidence(evidenced), true);
  const verify = evidenced.find(({ capability }) => capability === "verify.blocks");
  assert.deepEqual(verify.arguments.blocks, [
    { target: [0, 0, 1], typeId: "minecraft:cake" },
    { target: [1, 0, 1], typeId: "minecraft:hopper", expectedStates: { facing_direction: 2 } },
  ]);
  const entities = evidenced.find(({ capability }) => capability === "verify.entities");
  assert.deepEqual(entities.arguments, {
    typeId: "minecraft:horse", location: [2, 0, 1], minimum: 2, maxDistance: 4,
  });
  assert.equal(new Set(evidenced.map(({ id }) => id)).size, evidenced.length);
});

test("synthesis verifies broken blocks as air", () => {
  const program = [step("player.break-blocks", { targets: [[3, 0, 0], [3, 1, 0]] })];
  const evidenced = synthesizeRuntimeEvidence(program);
  assert.equal(runtimeProgramHasEvidence(evidenced), true);
  const verify = evidenced.find(({ capability }) => capability === "verify.blocks");
  assert.deepEqual(verify.arguments.blocks, [
    { target: [3, 0, 0], typeId: "minecraft:air" },
    { target: [3, 1, 0], typeId: "minecraft:air" },
  ]);
});

test("a conflicting model-authored verify is replaced by the mutation's declared truth", () => {
  const program = [
    place([cake]),
    step("verify.blocks", { blocks: [{ target: [0, 0, 1], typeId: "minecraft:stone" }] }),
  ];
  assert.equal(runtimeProgramHasEvidence(program), false);
  const evidenced = synthesizeRuntimeEvidence(program);
  assert.equal(runtimeProgramHasEvidence(evidenced), true);
  assert.equal(evidenced.length, program.length, "correction happens in place, no duplicate verify appended");
  assert.deepEqual(evidenced[1].arguments.blocks, [{ target: [0, 0, 1], typeId: "minecraft:cake" }]);
});

test("a model verify with a wrong block state is corrected while stricter extras are kept", () => {
  const hopper = place([{
    itemId: "minecraft:hopper", target: [1, 0, 1], support: [1, -1, 1],
    expectedType: "minecraft:hopper", expectedStates: { facing_direction: 2 },
  }]);
  const wrongState = step("verify.blocks", { blocks: [{
    target: [1, 0, 1], typeId: "minecraft:hopper", expectedStates: { facing_direction: 3 },
  }] });
  const stricter = step("verify.blocks", { blocks: [{
    target: [1, 0, 1], typeId: "minecraft:hopper", expectedStates: { facing_direction: 2, toggle_bit: false },
  }] });
  const corrected = synthesizeRuntimeEvidence([hopper, wrongState]);
  assert.equal(runtimeProgramHasEvidence(corrected), true);
  assert.deepEqual(corrected[1].arguments.blocks[0].expectedStates, { facing_direction: 2 });
  const kept = synthesizeRuntimeEvidence([hopper, stricter]);
  assert.deepEqual(kept[1].arguments.blocks[0].expectedStates, { facing_direction: 2, toggle_bit: false });
});

test("unrelated model verifies and sufficient entity checks are kept untouched", () => {
  const unrelated = step("verify.blocks", { blocks: [{ target: [9, 9, 9], typeId: "minecraft:torch" }] });
  const spawnCheck = step("verify.entities", {
    typeId: "minecraft:horse", location: [2, 0, 1], minimum: 3, maxDistance: 8,
  });
  const program = [
    place([cake]),
    step("script.spawn-entity", { typeId: "minecraft:horse", location: [2, 0, 1], count: 1 }),
    unrelated,
    spawnCheck,
  ];
  const evidenced = synthesizeRuntimeEvidence(program);
  assert.equal(runtimeProgramHasEvidence(evidenced), true);
  assert.ok(evidenced.includes(unrelated), "unrelated model verify survives verbatim");
  assert.ok(evidenced.includes(spawnCheck), "sufficient entity check survives verbatim");
  assert.equal(evidenced.filter(({ capability }) => capability === "verify.entities").length, 1,
    "no redundant entity check appended when the model's already covers the spawn");
});

test("world.command and server.* mutations gain no synthesized evidence", () => {
  const command = step("world.command", { commands: ["effect @s night_vision 1200 0 true"] });
  const console_ = step("server.console", { commands: ["allowlist off"] });
  const configure = step("server.configure", { experiments: { gametest: true } });
  for (const mutation of [command, console_, configure]) {
    const program = [mutation];
    assert.equal(synthesizeRuntimeEvidence(program), program,
      "non-deterministic mutations pass through identically");
  }
  // The tail check still governs them: self-checking today, and an observe-only
  // program still has no evidence after synthesis.
  assert.equal(runtimeProgramHasEvidence(synthesizeRuntimeEvidence([command])), true);
  const observeOnly = [step("observe.snapshot", {})];
  assert.equal(synthesizeRuntimeEvidence(observeOnly), observeOnly);
  assert.equal(runtimeProgramHasEvidence(observeOnly), false);
});

test("synthesized evidence never references a coordinate absent from the mutations", () => {
  const program = [
    place([cake, { itemId: "minecraft:torch", target: [0, 1, 1], support: [0, 0, 1], expectedType: "minecraft:torch" }]),
    step("player.break-blocks", { targets: [[4, 0, 4]] }),
    step("verify.blocks", { blocks: [{ target: [9, 9, 9], typeId: "minecraft:stone" }] }),
  ];
  const mutated = new Set(["0,0,1", "0,1,1", "4,0,4"]);
  const modelAuthored = new Set(verifiedBlockTargets(program));
  const evidenced = synthesizeRuntimeEvidence(program);
  for (const target of verifiedBlockTargets(evidenced)) {
    assert.ok(mutated.has(target) || modelAuthored.has(target),
      `synthesized verification invented coordinate ${target}`);
  }
  for (const { capability, arguments: args } of evidenced) {
    if (capability !== "verify.entities") continue;
    assert.fail(`no entity verification should be synthesized without a spawn (${args.typeId})`);
  }
});

test("large multi-step programs chunk synthesized verifications within the 400-block limit", () => {
  const wall = (offset) => Array.from({ length: 300 }, (_, index) => ({
    itemId: "minecraft:stone",
    target: [(offset + index) % 128, Math.floor((offset + index) / 128), 0],
    support: [(offset + index) % 128, Math.floor((offset + index) / 128) - 1, 0],
    expectedType: "minecraft:stone",
  }));
  const program = [place(wall(0)), place(wall(300))];
  const evidenced = synthesizeRuntimeEvidence(program);
  const verifies = evidenced.filter(({ capability }) => capability === "verify.blocks");
  assert.ok(verifies.every(({ arguments: args }) => args.blocks.length <= 400));
  assert.equal(verifies.flatMap(({ arguments: args }) => args.blocks).length, 600);
  assert.equal(runtimeProgramHasEvidence(evidenced), true);
  // Every synthesized step re-normalizes cleanly, so the pack can execute it.
  for (const entry of evidenced) assert.doesNotThrow(() => normalizeRuntimeStep(entry));
});

test("a precondition verify before the mutation of its target is never rewritten", () => {
  const precondition = step("verify.blocks", { blocks: [{ target: [2, 0, 1], typeId: "minecraft:air" }] });
  const program = [
    precondition,
    place([{
      itemId: "minecraft:cobblestone", target: [2, 0, 1], support: [2, -1, 1],
      expectedType: "minecraft:cobblestone",
    }]),
  ];
  const evidenced = synthesizeRuntimeEvidence(program);
  assert.equal(evidenced[0], precondition, "precondition survives verbatim, still expecting air");
  assert.deepEqual(evidenced[0].arguments.blocks, [{ target: [2, 0, 1], typeId: "minecraft:air" }]);
  // The precondition does not count as evidence for the final state, so a
  // post-mutation verification is synthesized and the program has evidence.
  const appended = evidenced.slice(program.length).filter(({ capability }) => capability === "verify.blocks");
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0].arguments.blocks, [{ target: [2, 0, 1], typeId: "minecraft:cobblestone" }]);
  assert.equal(runtimeProgramHasEvidence(evidenced), true);
});

test("re-mutated coordinates synthesize evidence for the final state only", () => {
  const overlaps = [
    {
      name: "place then break",
      program: [
        place([{ itemId: "minecraft:stone", target: [0, 0, 1], support: [0, -1, 1], expectedType: "minecraft:stone" }]),
        step("player.break-blocks", { targets: [[0, 0, 1]] }),
      ],
      finalTypeId: "minecraft:air",
    },
    {
      name: "break then place",
      program: [
        step("player.break-blocks", { targets: [[0, 0, 1]] }),
        place([{ itemId: "minecraft:stone", target: [0, 0, 1], support: [0, -1, 1], expectedType: "minecraft:stone" }]),
      ],
      finalTypeId: "minecraft:stone",
    },
    {
      name: "place A then place B",
      program: [
        place([{ itemId: "minecraft:stone", target: [0, 0, 1], support: [0, -1, 1], expectedType: "minecraft:stone" }]),
        place([{ itemId: "minecraft:chest", target: [0, 0, 1], support: [0, -1, 1], expectedType: "minecraft:chest" }]),
      ],
      finalTypeId: "minecraft:chest",
    },
    {
      name: "scaffold then chest (place, break, place)",
      program: [
        place([{ itemId: "minecraft:stone", target: [0, 0, 1], support: [0, -1, 1], expectedType: "minecraft:stone" }]),
        step("player.break-blocks", { targets: [[0, 0, 1]] }),
        place([{ itemId: "minecraft:chest", target: [0, 0, 1], support: [0, -1, 1], expectedType: "minecraft:chest" }]),
      ],
      finalTypeId: "minecraft:chest",
    },
  ];
  for (const { name, program, finalTypeId } of overlaps) {
    const evidenced = synthesizeRuntimeEvidence(program);
    const verifies = evidenced.filter(({ capability }) => capability === "verify.blocks");
    assert.equal(verifies.length, 1, `${name}: exactly one synthesized verify`);
    assert.deepEqual(verifies[0].arguments.blocks, [{ target: [0, 0, 1], typeId: finalTypeId }],
      `${name}: synthesized evidence matches the final state`);
    assert.equal(runtimeProgramHasEvidence(evidenced), true,
      `${name}: synthesized program must pass the evidence gate it will be executed under`);
  }
});

test("a verify between two mutations of its target expects the state as of its position", () => {
  const placeStone = place([{
    itemId: "minecraft:stone", target: [0, 0, 1], support: [0, -1, 1], expectedType: "minecraft:stone",
  }]);
  const interim = step("verify.blocks", { blocks: [{ target: [0, 0, 1], typeId: "minecraft:stone" }] });
  const breakStone = step("player.break-blocks", { targets: [[0, 0, 1]] });
  const evidenced = synthesizeRuntimeEvidence([placeStone, interim, breakStone]);
  assert.equal(evidenced[1], interim, "a position-correct interim verify survives verbatim");
  const appended = evidenced.slice(3).filter(({ capability }) => capability === "verify.blocks");
  assert.equal(appended.length, 1, "the final state still gains synthesized coverage");
  assert.deepEqual(appended[0].arguments.blocks, [{ target: [0, 0, 1], typeId: "minecraft:air" }]);
  assert.equal(runtimeProgramHasEvidence(evidenced), true);
  // A wrong interim expectation is corrected to the state at its position,
  // not to the final post-program state.
  const wrongInterim = step("verify.blocks", { blocks: [{ target: [0, 0, 1], typeId: "minecraft:chest" }] });
  const corrected = synthesizeRuntimeEvidence([placeStone, wrongInterim, breakStone]);
  assert.deepEqual(corrected[1].arguments.blocks, [{ target: [0, 0, 1], typeId: "minecraft:stone" }]);
  assert.equal(runtimeProgramHasEvidence(corrected), true);
});
