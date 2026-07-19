import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  primitiveStructureOperations,
  validateBuildStructurePlan,
} from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";
import {
  normalizeRuntimeStep,
  runtimeProgramHasEvidence,
  synthesizeRuntimeEvidence,
} from "../bedrock/behavior_packs/mc_wizard/scripts/capability-runtime.js";

const mainScript = await readFile(new URL(
  "../bedrock/behavior_packs/mc_wizard/scripts/main.js",
  import.meta.url,
), "utf8");

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

const generatedKinds = new Set(
  sourceBetween(mainScript, "const GENERATED_STRUCTURE_KINDS = new Set([", "])")
    .split("[")[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean),
);

// Executes the real structurePlanOperations from the pack script with only its
// world-independent collaborators stubbed, so kind routing and the fail-fast
// run exactly as shipped.
function compileStructurePlanOperations(structureOperations) {
  const source = sourceBetween(mainScript, "function sameGeneratedStructureBase", "function worldStructureBox");
  const factory = new Function(
    "primitiveStructureOperations",
    "structureOperations",
    "GENERATED_STRUCTURE_KINDS",
    "structureBox",
    `${source}\nreturn structurePlanOperations;`,
  );
  return factory(
    primitiveStructureOperations,
    structureOperations,
    generatedKinds,
    (phase, blockId, from, to) => ({ phase, blockId, from, to }),
  );
}

const parametricMarker = { phase: "foundation", blockId: "minecraft:oak_planks", from: [0, 0, 0], to: [3, 0, 3] };

test("generated kinds without primitives still use the parametric generator", () => {
  for (const kind of ["house", "castle"]) {
    const calls = [];
    const structurePlanOperations = compileStructurePlanOperations((plan) => {
      calls.push(plan.kind);
      return [parametricMarker];
    });
    const operations = structurePlanOperations({ kind, title: `Test ${kind}`, entities: [] });
    assert.deepEqual(calls, [kind]);
    assert.deepEqual(operations, [parametricMarker]);
  }
});

test("modify-mode patches without primitives still succeed, even against stale saved plans", () => {
  const structurePlanOperations = compileStructurePlanOperations(() => [parametricMarker]);
  for (const kind of ["house", "dragon"]) {
    const operations = structurePlanOperations({ kind, mode: "modify", title: `Saved ${kind}`, entities: [] });
    assert.deepEqual(operations, [parametricMarker], `${kind} modify patch must not fail fast`);
  }
});

test("reconstructing a saved primitive-less plan suppresses the fail-fast; fresh plans keep it", () => {
  const structurePlanOperations = compileStructurePlanOperations(() => [parametricMarker]);
  // Legacy generic-box-era saved record: no primitives, no mode, non-generated kind.
  const legacy = { kind: "dragon", title: "Saved Dragon" };
  assert.deepEqual(
    structurePlanOperations(legacy, undefined, { reconstructing: true }),
    [parametricMarker],
    "the saved record replays as the parametric box it was actually built from",
  );
  assert.throws(
    () => structurePlanOperations(legacy),
    /needs authored shape primitives/,
    "a fresh primitive-less non-generated plan still fails fast",
  );
});

test("a primitive-less non-generated kind throws instead of becoming a generic box", () => {
  for (const kind of ["dragon", "spaceship"]) {
    let parametricCalled = false;
    const structurePlanOperations = compileStructurePlanOperations(() => {
      parametricCalled = true;
      return [parametricMarker];
    });
    assert.throws(
      () => structurePlanOperations({ kind, title: `Test ${kind}`, entities: [] }),
      (error) => {
        assert.match(error.message, /needs authored shape primitives \(box\/line\/hollow_box\)/);
        assert.ok(error.message.includes(kind), `message names the kind ${kind}`);
        assert.match(error.message, /send its silhouette instead of a generic building/);
        return true;
      },
    );
    assert.equal(parametricCalled, false, "the generic parametric generator is unreachable");
  }
});

test("a non-generated kind with authored primitives builds exactly those primitives", () => {
  let parametricCalled = false;
  const structurePlanOperations = compileStructurePlanOperations(() => {
    parametricCalled = true;
    return [parametricMarker];
  });
  const primitives = [
    { shape: "box", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 0], to: [4, 0, 4] },
    { shape: "box", phase: "shell", blockId: "minecraft:stone", from: [1, 1, 1], to: [3, 2, 3] },
  ];
  const operations = structurePlanOperations({ kind: "dragon", title: "Blocky Dragon", primitives, entities: [] });
  assert.equal(parametricCalled, false);
  assert.deepEqual(
    operations.map(({ blockId, from, to }) => ({ blockId, from, to })),
    primitives.map(({ blockId, from, to }) => ({ blockId, from, to })),
  );
});

// Executes the real buildStructure from the pack script with its world-facing
// collaborators stubbed, so plan validation, the fail-fast, and salvage-record
// forwarding run exactly as shipped. The prepareStructureArea stub throws to
// stop the harness at the world boundary, after the decisions under test.
function compileBuildStructure(state, { modificationSite } = {}) {
  const source = sourceBetween(mainScript, "async function buildStructure", "function findBlueprintSite");
  const factory = new Function(
    "validateBuildStructurePlan",
    "structurePlanOperations",
    "console",
    "speak",
    "failPendingAction",
    "queueBuild",
    "cardinalDirection",
    "findModificationSite",
    "findStructureSite",
    "obsoleteExpansionOperations",
    "validStructureInhabitantTag",
    "newStructureInhabitantTag",
    "bindBuildAction",
    "salvageDropsByToken",
    "prepareStructureArea",
    "endBuildAction",
    "clearBuild",
    "buildInProgress",
    "buildPreparing",
    "nextBuildToken",
    "activeBuildToken",
    `${source}\nreturn buildStructure;`,
  );
  state.spoken = [];
  state.failures = [];
  state.ended = [];
  state.salvageDropsByToken = new Map();
  return factory(
    validateBuildStructurePlan,
    compileStructurePlanOperations(() => [parametricMarker]),
    { warn() {} },
    (player, message) => state.spoken.push(message),
    (player, detail) => state.failures.push(detail),
    () => { throw new Error("queueBuild must not run in this harness"); },
    () => ({ x: 0, z: 1 }),
    () => modificationSite,
    () => ({ origin: { x: 0, y: 0, z: 0 }, clear: [] }),
    () => [],
    () => false,
    (token) => `wizard-structure-${token}`,
    () => true,
    state.salvageDropsByToken,
    async () => { throw new Error("harness stops before world preparation"); },
    (token, status, detail) => state.ended.push({ token, status, detail }),
    () => {},
    false,
    false,
    0,
    0,
  );
}

const wizardPlayer = () => ({ dimension: { id: "minecraft:overworld" } });

const dragonPlanValue = Object.freeze({
  kind: "dragon",
  title: "Blocky Dragon",
  dimensions: { width: 10, depth: 10, height: 8 },
  materials: { primary: "minecraft:stone", accent: "minecraft:glowstone", roof: "minecraft:oak_planks" },
  features: ["floor"],
  phases: ["foundation", "shell", "roof", "details"],
});

const dragonPrimitives = Object.freeze([
  { shape: "box", phase: "foundation", blockId: "minecraft:stone", from: [0, 0, 0], to: [9, 0, 9] },
  { shape: "hollow_box", phase: "shell", blockId: "minecraft:stone", from: [0, 1, 0], to: [9, 4, 9] },
  { shape: "box", phase: "roof", blockId: "minecraft:oak_planks", from: [0, 5, 0], to: [9, 5, 9] },
  { shape: "box", phase: "details", blockId: "minecraft:glowstone", from: [4, 2, 4], to: [5, 3, 5] },
]);

test("the fail-fast surfaces through the action-result flow, not an unhandled throw", async () => {
  const state = {};
  const buildStructure = compileBuildStructure(state);
  // Awaiting proves no throw escapes buildStructure for a validated but
  // primitive-less non-generated plan; the failure must ride failPendingAction.
  await buildStructure(wizardPlayer(), { ...dragonPlanValue });
  assert.equal(state.failures.length, 1, "the rejection reaches the action-result flow exactly once");
  assert.match(state.failures[0], /^structure plan validation failed: /);
  assert.match(state.failures[0], /needs authored shape primitives/);
  assert.equal(state.ended.length, 0, "no build token is ever opened");
  assert.equal(state.salvageDropsByToken.size, 0);
  assert.equal(state.spoken.length, 1, "the child hears the honest rejection line");
});

test("brain-side salvage drop records survive pack re-validation and bind to the build token", async () => {
  const dropped = [
    { index: 4, reason: "primitives[4].shape is unsupported" },
    { index: 7, reason: "primitives[7] is outside the requested dimensions" },
  ];
  const state = {};
  const buildStructure = compileBuildStructure(state);
  await buildStructure(wizardPlayer(), {
    ...dragonPlanValue,
    primitives: [...dragonPrimitives],
    salvage: { warnings: [], dropped },
  });
  assert.equal(state.failures.length, 0, "the salvaged plan builds; it is not rejected");
  assert.equal(state.salvageDropsByToken.size, 1);
  const [drops] = state.salvageDropsByToken.values();
  assert.deepEqual(drops, dropped, "the brain's drop records reach endBuildAction's partial path verbatim");
  assert.deepEqual(
    state.ended.map(({ status, detail }) => ({ status, detail })),
    [{ status: "failed", detail: "could not prepare a nearby build area" }],
    "the harness stopped at the world boundary, after the drops were bound",
  );
});

test("a clean plan with no brain drop records binds no salvage drops", async () => {
  const state = {};
  const buildStructure = compileBuildStructure(state);
  await buildStructure(wizardPlayer(), { ...dragonPlanValue, primitives: [...dragonPrimitives] });
  assert.equal(state.failures.length, 0);
  assert.equal(state.salvageDropsByToken.size, 0, "clean completions must not be rewritten to partial");
});

test("modifying a legacy primitive-less saved structure does not fail fast", async () => {
  const state = {};
  const buildStructure = compileBuildStructure(state, {
    modificationSite: {
      forward: { x: 0, z: 1 },
      right: { x: -1, z: 0 },
      origin: { x: 0, y: 0, z: 0 },
      clear: [],
      // Legacy generic-box-era record persisted before the fail-fast existed:
      // no primitives, no mode, and a kind outside GENERATED_STRUCTURE_KINDS.
      previous: { plan: { kind: "dragon", title: "Saved Dragon" } },
    },
  });
  await buildStructure(wizardPlayer(), {
    ...dragonPlanValue,
    mode: "modify",
    primitives: [...dragonPrimitives],
  });
  assert.equal(state.failures.length, 0, "the silhouette rejection must not fire against the saved record");
  assert.match(state.spoken[0], /improving it in place/, "the modify path proceeds");
  assert.deepEqual(
    state.ended.map(({ status }) => status),
    ["failed"],
    "the harness reached world preparation, so previousOperations reconstructed without throwing",
  );
});

const step = (capability, args) => normalizeRuntimeStep({
  id: `model_${capability.replace(/\W/g, "_")}`,
  capability,
  arguments: args,
  expect: "The visible result is correct.",
  onFailure: "replan",
});

test("a place+spawn program with no verifies passes the evidence assert after synthesis", () => {
  const program = [
    step("player.place-blocks", { blocks: [{
      itemId: "minecraft:stone", target: [0, 0, 1], support: [0, -1, 1], expectedType: "minecraft:stone",
    }] }),
    step("script.spawn-entity", { typeId: "minecraft:cat", location: [2, 0, 1], count: 1 }),
  ];
  assert.equal(runtimeProgramHasEvidence(program), false, "the raw program lacks evidence");
  assert.equal(runtimeProgramHasEvidence(synthesizeRuntimeEvidence(program)), true);
  // The pack synthesizes evidence at execution, before the unchanged final assert.
  const synthesisAt = mainScript.indexOf("const steps = synthesizeRuntimeEvidence(program.steps.map(normalizeRuntimeStep));");
  const assertAt = mainScript.indexOf("if (!runtimeProgramHasEvidence(steps)) throw new Error");
  assert.ok(synthesisAt !== -1, "executeCapabilityProgram synthesizes runtime evidence");
  assert.ok(assertAt !== -1, "the evidence assert survives as the final guard");
  assert.ok(synthesisAt < assertAt, "synthesis runs before the assert");
});

// Deliberate deviation from the older harness expectation (#35): world.command is
// classified self-checking by the unchanged runtimeProgramHasEvidence tail, so the
// honest guarantee is that synthesis never manufactures evidence for it, and that
// programs without any verifiable mutation still fail the assert.
test("world.command programs gain no synthesized evidence and observe-only programs still fail", () => {
  const command = step("world.command", { commands: ["say hello"] });
  const program = [command];
  assert.equal(synthesizeRuntimeEvidence(program), program, "world.command passes through untouched");
  assert.equal(
    synthesizeRuntimeEvidence(program).some(({ capability }) => capability.startsWith("verify.")),
    false,
  );
  const observeOnly = [step("observe.snapshot", {})];
  assert.equal(runtimeProgramHasEvidence(synthesizeRuntimeEvidence(observeOnly)), false);
});

function compileEndBuildAction(state) {
  const source = sourceBetween(mainScript, "function endBuildAction", "function structurePlayerKey");
  const factory = new Function(
    "actionReportsByToken",
    "salvageDropsByToken",
    "lastCompletedBuildTokens",
    "rememberLastStructure",
    "rememberLastProject",
    "withCurrentActionPlayer",
    "speak",
    "postActionResult",
    `${source}\nreturn endBuildAction;`,
  );
  state.spoken = [];
  state.posted = [];
  state.lastCompletedBuildTokens = new Map();
  return factory(
    state.actionReportsByToken,
    state.salvageDropsByToken,
    state.lastCompletedBuildTokens,
    () => {},
    () => {},
    (report, callback) => callback({ name: report.playerName }),
    (player, message) => state.spoken.push(message),
    (report, status, detail) => state.posted.push({ report, status, detail }),
  );
}

test("a completed salvaged build posts partial with the dropped indices and an honest line", () => {
  const dropped = [
    { index: 3, reason: "blocks[3].itemId is not allowed" },
    { index: 9, reason: "blocks[9] is floating" },
  ];
  const state = {
    actionReportsByToken: new Map([[7, { playerId: "p1", playerName: "Kid", requestId: "req-7" }]]),
    salvageDropsByToken: new Map([[7, dropped]]),
  };
  const endBuildAction = compileEndBuildAction(state);
  endBuildAction(7, "completed", "verified 20 planned blocks");
  assert.equal(state.posted.length, 1);
  assert.equal(state.posted[0].status, "partial");
  assert.match(state.posted[0].detail, /verified 20 planned blocks/);
  assert.match(state.posted[0].detail, /salvage dropped 2 entries/);
  assert.ok(state.posted[0].detail.includes(JSON.stringify(dropped)), "detail carries the dropped list verbatim");
  assert.equal(state.spoken.length, 1);
  assert.match(state.spoken[0], /built most of it/i);
  assert.match(state.spoken[0], /2 pieces/);
  assert.doesNotMatch(state.spoken[0], /didn’t hold/i, "no apology+fail language");
  assert.equal(state.lastCompletedBuildTokens.get("p1"), 7, "undo continuity treats the build as done in-world");
  assert.equal(state.salvageDropsByToken.has(7), false, "drop records are consumed");
});

test("clean completions and real failures are not rewritten by salvage records", () => {
  const state = {
    actionReportsByToken: new Map([
      [11, { playerId: "p1", playerName: "Kid", requestId: "req-11" }],
      [12, { playerId: "p1", playerName: "Kid", requestId: "req-12" }],
    ]),
    salvageDropsByToken: new Map([[12, [{ index: 0, reason: "dropped" }]]]),
  };
  const endBuildAction = compileEndBuildAction(state);
  endBuildAction(11, "completed", "verified 8 planned blocks");
  endBuildAction(12, "failed", "verification left 2 mismatched blocks");
  assert.deepEqual(state.posted.map(({ status }) => status), ["completed", "failed"]);
  assert.equal(state.posted[0].detail, "verified 8 planned blocks");
  assert.equal(state.posted[1].detail, "verification left 2 mismatched blocks", "failures keep their own detail");
  assert.equal(state.spoken.length, 0);
  assert.equal(state.salvageDropsByToken.size, 0, "records are cleared even when unused");
});

test("action-result details carry up to 1600 chars of violation-list JSON", () => {
  assert.match(mainScript, /String\(detail\)\.slice\(0, 1600\)/);
  assert.doesNotMatch(mainScript, /String\(detail\)\.slice\(0, 240\)/);
  assert.match(mainScript, /structure plan validation failed: \$\{String\(error\?\.message \|\| error\)\.slice\(0, 1600\)\}/);
  assert.match(mainScript, /machine plan validation failed: \$\{String\(error\?\.message \|\| error\)\.slice\(0, 1600\)\}/);
  // The build-plan path forwards error.message verbatim; the 1600 cap applies at post time.
  assert.match(mainScript, /build plan was rejected: \$\{error\.message\}/);
});

test("every salvage-capable executor binds its dropped entries to the build token", () => {
  const brainPickups = [...mainScript.matchAll(
    /const brainSalvageDrops = Array\.isArray\(value\?\.salvage\?\.dropped\) \? value\.salvage\.dropped : \[\];/g,
  )];
  assert.equal(brainPickups.length, 2, "buildStructure and buildValidatedPlan both read the brain's drop records before re-validation");
  const structureBindings = [...mainScript.matchAll(
    /const salvageDrops = \[\.\.\.brainSalvageDrops, \.\.\.\(plan\.salvage\?\.dropped \|\| \[\]\)\];\s*\n\s*if \(salvageDrops\.length\) salvageDropsByToken\.set\(token, salvageDrops\);/g,
  )];
  assert.equal(structureBindings.length, 2, "buildStructure and buildValidatedPlan both bind merged brain+pack salvage drops");
  assert.match(mainScript, /if \(blueprint\.dropped\?\.length\) salvageDropsByToken\.set\(token, blueprint\.dropped\);/);
  // The machine executor call stays byte-stable for the machine-plan contract
  // tests while the brain-validated drop records ride the blueprint.
  assert.match(mainScript, /buildInteractiveBlueprint\(player, machineBlueprint\(value\)\)/);
  assert.match(mainScript, /nextBlueprintSalvageDrops = Array\.isArray\(value\?\.dropped\)/);
});
