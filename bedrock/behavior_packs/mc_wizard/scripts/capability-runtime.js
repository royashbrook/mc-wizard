export const RUNTIME_CAPABILITIES = Object.freeze([
  "artifact.book",
  "control.wait",
  "observe.snapshot",
  "player.break-blocks",
  "player.move",
  "player.place-blocks",
  "player.use-item",
  "script.effect",
  "script.spawn-entity",
  "script.teleport",
  "verify.blocks",
  "verify.entities",
  "world.command",
]);

const CAPABILITIES = new Set(RUNTIME_CAPABILITIES);
const ITEM_ID = /^minecraft:[a-z0-9_]+$/;
const EFFECT_ID = /^(?:minecraft:)?[a-z0-9_]+$/;
const REQUESTER_SELECTOR = "@s(?:\\[[^\\]\\r\\n]{1,120}\\])?";
const COORDINATE = "(?:~[-+]?\\d*(?:\\.\\d+)?|[-+]?\\d+(?:\\.\\d+)?)";
const REQUESTER_COMMAND_PATTERNS = [
  new RegExp(`^ability\\s+${REQUESTER_SELECTOR}\\s+\\S+(?:\\s+\\S+)?$`, "i"),
  new RegExp(`^clear\\s+${REQUESTER_SELECTOR}(?:\\s+\\S+){0,3}$`, "i"),
  new RegExp(`^effect\\s+${REQUESTER_SELECTOR}\\s+(?:clear|[a-z0-9_]+(?:\\s+\\d+){0,2}(?:\\s+(?:true|false))?)$`, "i"),
  new RegExp(`^enchant\\s+${REQUESTER_SELECTOR}\\s+[a-z0-9_]+(?:\\s+\\d+)?$`, "i"),
  new RegExp(`^gamemode\\s+\\S+\\s+${REQUESTER_SELECTOR}$`, "i"),
  new RegExp(`^give\\s+${REQUESTER_SELECTOR}\\s+[a-z0-9_:]+(?:\\s+\\d+){0,2}$`, "i"),
  new RegExp(`^(?:teleport|tp)\\s+${REQUESTER_SELECTOR}\\s+${COORDINATE}\\s+${COORDINATE}\\s+${COORDINATE}(?:\\s+(?:true|false))?$`, "i"),
  new RegExp(`^spawnpoint\\s+${REQUESTER_SELECTOR}(?:\\s+${COORDINATE}\\s+${COORDINATE}\\s+${COORDINATE})?$`, "i"),
  new RegExp(`^xp\\s+[-+]?\\d+[lL]?\\s+${REQUESTER_SELECTOR}$`, "i"),
];
const FORBIDDEN_SPAWN_ENTITIES = new Set([
  "minecraft:ender_crystal", "minecraft:ender_dragon", "minecraft:lightning_bolt",
  "minecraft:tnt", "minecraft:wither", "minecraft:wither_skull",
]);

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${name} has an unsupported field`);
}

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}-${max}`);
  return value;
}

function text(value, name, maxLength) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || clean.length > maxLength) throw new Error(`${name} must contain 1-${maxLength} characters`);
  return clean;
}

function itemId(value, name) {
  if (!ITEM_ID.test(value || "")) throw new Error(`${name} must be a namespaced Minecraft id`);
  return value;
}

function vector(value, name) {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${name} must be [x,y,z]`);
  return [
    integer(value[0], `${name}[0]`, -128, 128),
    integer(value[1], `${name}[1]`, -64, 64),
    integer(value[2], `${name}[2]`, -128, 128),
  ];
}

function vectorList(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 400) {
    throw new Error(`${name} must contain 1-400 locations`);
  }
  const vectors = value.map((entry, index) => vector(entry, `${name}[${index}]`));
  if (new Set(vectors.map((entry) => entry.join(","))).size !== vectors.length) {
    throw new Error(`${name} contains a duplicate location`);
  }
  return vectors;
}

export function normalizeRequesterCommand(value, name = "command") {
  const command = text(value, name, 240);
  if (command.startsWith("/") || /[\r\n\0]/.test(value)) throw new Error(`${name} is not one safe command`);
  if (/@(?:a|e|p|r)(?:\b|\[)/i.test(command)) throw new Error(`${name} contains a broad player selector`);
  if (!REQUESTER_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    throw new Error(`${name} is not an allowed requester-only command`);
  }
  return command;
}

function placement(value, name) {
  exactKeys(value, ["itemId", "target", "support", "expectedType", "orientationTarget", "expectedStates"], name);
  const target = vector(value.target, `${name}.target`);
  const support = vector(value.support, `${name}.support`);
  if (target.reduce((sum, coordinate, index) => sum + Math.abs(coordinate - support[index]), 0) !== 1) {
    throw new Error(`${name}.support must touch its target`);
  }
  let expectedStates = {};
  if (value.expectedStates !== undefined) {
    exactKeys(value.expectedStates, Object.keys(value.expectedStates), `${name}.expectedStates`);
    if (Object.keys(value.expectedStates).length > 12
      || Object.values(value.expectedStates).some((entry) => !["boolean", "number", "string"].includes(typeof entry))) {
      throw new Error(`${name}.expectedStates is invalid`);
    }
    expectedStates = { ...value.expectedStates };
  }
  return {
    itemId: itemId(value.itemId, `${name}.itemId`),
    target,
    support,
    expectedType: itemId(value.expectedType || value.itemId, `${name}.expectedType`),
    expectedStates,
    ...(value.orientationTarget !== undefined && value.orientationTarget !== null
      ? { orientationTarget: vector(value.orientationTarget, `${name}.orientationTarget`) } : {}),
  };
}

function blockExpectation(value, name) {
  exactKeys(value, ["target", "typeId"], name);
  return { target: vector(value.target, `${name}.target`), typeId: itemId(value.typeId, `${name}.typeId`) };
}

function normalizeArguments(capability, value) {
  const name = `${capability}.arguments`;
  if (capability === "control.wait") {
    exactKeys(value, ["ticks"], name);
    return { ticks: integer(value.ticks, `${name}.ticks`, 1, 200) };
  }
  if (capability === "player.move") {
    exactKeys(value, ["target", "mode"], name);
    const mode = value.mode || "walk";
    if (!['walk', 'fly'].includes(mode)) throw new Error(`${name}.mode must be walk or fly`);
    return { target: vector(value.target, `${name}.target`), mode };
  }
  if (capability === "player.place-blocks") {
    exactKeys(value, ["blocks"], name);
    if (!Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > 400) {
      throw new Error(`${name}.blocks must contain 1-400 placements`);
    }
    const blocks = value.blocks.map((entry, index) => placement(entry, `${name}.blocks[${index}]`));
    if (new Set(blocks.map(({ target }) => target.join(","))).size !== blocks.length) {
      throw new Error(`${name}.blocks contains a duplicate target`);
    }
    return { blocks };
  }
  if (capability === "player.break-blocks") {
    exactKeys(value, ["targets"], name);
    return { targets: vectorList(value.targets, `${name}.targets`) };
  }
  if (capability === "player.use-item") {
    exactKeys(value, ["itemId", "block", "faceTarget", "expectedFaceType", "expectedEntity", "expectedEntityCount", "expectedState"], name);
    const expectedState = value.expectedState;
    if (expectedState !== undefined) {
      exactKeys(expectedState, ["state", "value"], `${name}.expectedState`);
      text(expectedState.state, `${name}.expectedState.state`, 80);
    }
    return {
      itemId: itemId(value.itemId, `${name}.itemId`),
      block: vector(value.block, `${name}.block`),
      faceTarget: vector(value.faceTarget, `${name}.faceTarget`),
      ...(value.expectedFaceType && { expectedFaceType: itemId(value.expectedFaceType, `${name}.expectedFaceType`) }),
      ...(value.expectedEntity && { expectedEntity: itemId(value.expectedEntity, `${name}.expectedEntity`) }),
      ...(value.expectedEntityCount !== undefined && {
        expectedEntityCount: integer(value.expectedEntityCount, `${name}.expectedEntityCount`, 1, 32),
      }),
      ...(expectedState && { expectedState: { state: expectedState.state, value: expectedState.value } }),
    };
  }
  if (capability === "world.command") {
    exactKeys(value, ["commands"], name);
    if (!Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > 16) {
      throw new Error(`${name}.commands must contain 1-16 commands`);
    }
    return { commands: value.commands.map((entry, index) => normalizeRequesterCommand(entry, `${name}.commands[${index}]`)) };
  }
  if (capability === "artifact.book") {
    exactKeys(value, ["title", "text", "author"], name);
    return {
      title: text(value.title, `${name}.title`, 80),
      text: text(value.text, `${name}.text`, 20_000),
      author: value.author ? text(value.author, `${name}.author`, 24) : "MC Wizard",
    };
  }
  if (capability === "observe.snapshot") {
    exactKeys(value, [], name);
    return {};
  }
  if (capability === "verify.blocks") {
    exactKeys(value, ["blocks"], name);
    if (!Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > 400) {
      throw new Error(`${name}.blocks must contain 1-400 expectations`);
    }
    return { blocks: value.blocks.map((entry, index) => blockExpectation(entry, `${name}.blocks[${index}]`)) };
  }
  if (capability === "verify.entities") {
    exactKeys(value, ["typeId", "location", "minimum", "maxDistance"], name);
    return {
      typeId: itemId(value.typeId, `${name}.typeId`),
      location: vector(value.location, `${name}.location`),
      minimum: integer(value.minimum, `${name}.minimum`, 0, 64),
      maxDistance: integer(value.maxDistance, `${name}.maxDistance`, 1, 64),
    };
  }
  if (capability === "script.spawn-entity") {
    exactKeys(value, ["typeId", "location", "count", "nameTag"], name);
    const typeId = itemId(value.typeId, `${name}.typeId`);
    if (FORBIDDEN_SPAWN_ENTITIES.has(typeId)) throw new Error(`${name}.typeId requires elevated authority`);
    return {
      typeId,
      location: vector(value.location, `${name}.location`),
      count: value.count === undefined ? 1 : integer(value.count, `${name}.count`, 1, 32),
      ...(value.nameTag && { nameTag: text(value.nameTag, `${name}.nameTag`, 64) }),
    };
  }
  if (capability === "script.teleport") {
    exactKeys(value, ["subject", "target"], name);
    if (!["requester", "wizard"].includes(value.subject)) throw new Error(`${name}.subject is invalid`);
    return { subject: value.subject, target: vector(value.target, `${name}.target`) };
  }
  if (capability === "script.effect") {
    exactKeys(value, ["subject", "effectId", "duration", "amplifier", "showParticles"], name);
    if (!["requester", "wizard"].includes(value.subject)) throw new Error(`${name}.subject is invalid`);
    if (!EFFECT_ID.test(value.effectId || "")) throw new Error(`${name}.effectId is invalid`);
    return {
      subject: value.subject,
      effectId: value.effectId,
      duration: integer(value.duration, `${name}.duration`, 1, 1_000_000),
      amplifier: value.amplifier === undefined ? 0 : integer(value.amplifier, `${name}.amplifier`, 0, 255),
      showParticles: value.showParticles !== false,
    };
  }
  throw new Error(`capability ${capability} is not installed`);
}

export function normalizeRuntimeStep(step) {
  if (!CAPABILITIES.has(step?.capability)) throw new Error(`capability ${step?.capability || "unknown"} is not installed`);
  return { ...step, arguments: normalizeArguments(step.capability, step.arguments) };
}

export function runtimeProgramHasEvidence(steps) {
  const verifiers = steps.filter(({ capability }) => capability === "verify.blocks");
  const expectedBlocks = new Map(verifiers.flatMap(({ arguments: args }) => (
    args.blocks.map(({ target, typeId }) => [target.join(","), typeId])
  )));
  const blockChanges = steps.flatMap(({ capability, arguments: args }) => {
    if (capability === "player.place-blocks") {
      return args.blocks.map(({ target, expectedType }) => [target.join(","), expectedType]);
    }
    if (capability === "player.break-blocks") {
      return args.targets.map((target) => [target.join(","), "minecraft:air"]);
    }
    return [];
  });
  if (blockChanges.length && blockChanges.some(([target, typeId]) => expectedBlocks.get(target) !== typeId)) return false;
  const spawned = steps.filter(({ capability }) => capability === "script.spawn-entity");
  const entityChecks = steps.filter(({ capability }) => capability === "verify.entities");
  if (spawned.some(({ arguments: spawn }) => !entityChecks.some(({ arguments: check }) => (
    check.typeId === spawn.typeId && check.minimum >= spawn.count
      && check.location.join(",") === spawn.location.join(",")
  )))) return false;
  const mutatesWorld = steps.some(({ capability }) => /^(?:artifact\.|player\.(?:break|place|use)|script\.|world\.)/.test(capability));
  const hasExplicitVerifier = steps.some(({ capability }) => capability.startsWith("verify."));
  const selfCheckingMutation = steps.some(({ capability }) => [
    "artifact.book", "player.use-item", "script.effect", "script.teleport",
  ].includes(capability));
  return mutatesWorld && (hasExplicitVerifier || selfCheckingMutation);
}

export function capabilityRuntimePrompt() {
  return `Runtime capability manifest (relative vectors are [right, up, forward] from a nearby origin):\n`
    + `- player.move arguments={"target":[x,y,z],"mode":"walk|fly"}\n`
    + `- player.place-blocks arguments={"blocks":[{"itemId":"minecraft:stone","target":[x,y,z],"support":[x,y,z],"expectedType":"minecraft:stone","orientationTarget":[x,y,z]}]}\n`
    + `- player.break-blocks arguments={"targets":[[x,y,z]]}\n`
    + `- player.use-item arguments={"itemId":"minecraft:lever","block":[x,y,z],"faceTarget":[x,y,z]}\n`
    + `- world.command arguments={"commands":["requester-scoped Bedrock command without leading slash"]}\n`
    + `- script.spawn-entity arguments={"typeId":"minecraft:horse","location":[x,y,z],"count":1}\n`
    + `- script.teleport arguments={"subject":"requester|wizard","target":[x,y,z]}\n`
    + `- script.effect arguments={"subject":"requester|wizard","effectId":"night_vision","duration":1200,"amplifier":0,"showParticles":false}\n`
    + `- artifact.book arguments={"title":"short title","text":"complete book text","author":"MC Wizard"}\n`
    + `- observe.snapshot arguments={}\n- verify.blocks arguments={"blocks":[{"target":[x,y,z],"typeId":"minecraft:stone"}]}\n`
    + `- verify.entities arguments={"typeId":"minecraft:horse","location":[2,0,1],"minimum":1,"maxDistance":4}\n`
    + `- control.wait arguments={"ticks":20}`;
}
