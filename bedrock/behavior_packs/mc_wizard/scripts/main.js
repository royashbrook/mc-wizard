import {
  BlockPermutation,
  Direction,
  GameMode,
  ItemStack,
  system,
  world,
} from "@minecraft/server";
import { LookDuration, spawnSimulatedPlayer } from "@minecraft/server-gametest";
import { variables, secrets } from "@minecraft/server-admin";
import { http, HttpRequest, HttpRequestMethod } from "@minecraft/server-net";
import { startE2E } from "./e2e.js";
import { createCalculatorBlueprint } from "./calculator.js";
import { bookPages, bookTitle } from "./book.js";

const PREFIX = "§d[MC Wizard]§r ";
const WIZARD_NAME = "MC Wizard";
const WIZARD_TAG = "mcwizard:bot";
const SAFE_SPACE = new Set([
  "minecraft:air",
  "minecraft:short_grass",
  "minecraft:tall_grass",
  "minecraft:fern",
  "minecraft:snow_layer",
]);
const SAFE_GROUND = new Set([
  "minecraft:grass_block",
  "minecraft:dirt",
  "minecraft:coarse_dirt",
  "minecraft:podzol",
  "minecraft:mycelium",
  "minecraft:stone",
  "minecraft:sand",
  "minecraft:red_sand",
  "minecraft:gravel",
  "minecraft:snow",
]);
const OPPOSITE_CARDINAL = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};
// Stay close enough that previously placed blocks cannot hide the clicked face.
// The API may report a use animation at longer range without changing the world.
const BUILD_REACH_SQUARED = 2.75 * 2.75;
const lastBuildTick = new Map();
const greetedPlayers = new Set();
const engineAddressedMessageCounts = new Map();

let wizard;
let followPlayerId;
let wizardShouldStay = false;
let wizardSpeaking = false;
let buildInProgress = false;
let activeBuildToken;
let nextBuildToken = 0;
let buildMovement;

function variable(name, fallback) {
  try {
    return variables.get(name) || fallback;
  } catch {
    return fallback;
  }
}

function secret(name) {
  try {
    return secrets.get(name);
  } catch {
    return undefined;
  }
}

const WIZARD_URL = variable("mc_wizard_url", "http://host.docker.internal:3000/v1/ask");
const AUTHORIZATION = secret("mc_wizard_authorization");

function hasWizardTag(player) {
  try {
    return player.hasTag(WIZARD_TAG);
  } catch {
    return false;
  }
}

function isWizardPlayer(player) {
  return Boolean(player)
    && typeof player.navigateToEntity === "function"
    && (hasWizardTag(player) || player.name === WIZARD_NAME);
}

function humanPlayers() {
  return world.getAllPlayers().filter((player) => !isWizardPlayer(player));
}

function playerById(id) {
  return humanPlayers().find((player) => player.id === id);
}

function wizardIsValid() {
  return Boolean(wizard?.isValid);
}

function splitMessage(message) {
  const lines = [];
  let remaining = String(message || "").replace(/\s+/g, " ").trim();
  while (remaining.length > 240) {
    const space = remaining.lastIndexOf(" ", 240);
    const cut = space > 0 ? space : 240;
    lines.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines;
}

function deliverModelAnswer(player, payload, question) {
  const label = String(payload.label || "AI").replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, 24) || "AI";
  const answer = String(payload.answer || "I found no answer.").trim();
  if (answer.length <= 700) {
    for (const line of splitMessage(answer)) player.sendMessage(`§b[${label}]§r ${line}`);
    return;
  }
  try {
    const book = new ItemStack("minecraft:writable_book", 1);
    const component = book.getComponent("minecraft:book");
    if (!component) throw new Error("book component is unavailable");
    component.setContents(bookPages(answer));
    component.signBook(bookTitle(question), label);
    player.dimension.spawnItem(book, {
      x: player.location.x,
      y: player.location.y + 0.5,
      z: player.location.z,
    });
    player.sendMessage(`§b[${label}]§r I dropped “${component.title}” at your feet.`);
  } catch (error) {
    console.warn(`[MC Wizard] could not create answer book: ${error}`);
    for (const line of splitMessage(answer)) player.sendMessage(`§b[${label}]§r ${line}`);
  }
}

function blockIsOpen(dimension, location) {
  return SAFE_SPACE.has(dimension.getBlock(location)?.typeId);
}

function arrivalPosition(player) {
  const base = {
    x: Math.floor(player.location.x),
    y: Math.floor(player.location.y),
    z: Math.floor(player.location.z),
  };
  for (const [x, z] of [[2, 0], [-2, 0], [0, 2], [0, -2], [3, 1], [-3, -1]]) {
    const feet = { x: base.x + x, y: base.y, z: base.z + z };
    const head = { x: feet.x, y: feet.y + 1, z: feet.z };
    const ground = player.dimension.getBlock({ x: feet.x, y: feet.y - 1, z: feet.z });
    if (ground?.isSolid
      && blockIsOpen(player.dimension, feet)
      && blockIsOpen(player.dimension, head)) {
      return { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 };
    }
  }
  return undefined;
}

function equipWizard(itemId = "minecraft:blaze_rod") {
  if (!wizardIsValid()) return;
  try {
    wizard.setItem(new ItemStack(itemId, 1), 0, true);
  } catch (error) {
    console.warn(`[MC Wizard] could not equip ${itemId}: ${error}`);
  }
}

function ensureWizard(anchor) {
  if (wizardIsValid()) return wizard;

  wizard = world.getAllPlayers().find((player) => isWizardPlayer(player));
  if (wizardIsValid()) return wizard;

  if (world.getAllPlayers().some((player) => player.name === WIZARD_NAME)) {
    console.warn(`[MC Wizard] cannot spawn: a non-simulated player is using the name ${WIZARD_NAME}`);
    wizard = undefined;
    return undefined;
  }

  try {
    const location = arrivalPosition(anchor);
    if (!location) {
      console.warn(`[MC Wizard] no safe standing space near ${anchor.name}`);
      return undefined;
    }
    wizard = spawnSimulatedPlayer(
      { dimension: anchor.dimension, ...location },
      WIZARD_NAME,
      GameMode.Creative,
    );
    wizard.addTag(WIZARD_TAG);
    equipWizard();
    wizard.lookAtEntity(anchor, LookDuration.UntilMove);
    console.warn(`[MC Wizard] spawned beside ${anchor.name}`);
    return wizard;
  } catch (error) {
    console.warn(`[MC Wizard] simulated player could not spawn: ${error}`);
    wizard = undefined;
    return undefined;
  }
}

function distanceSquared(a, b) {
  const x = a.x - b.x;
  const y = a.y - b.y;
  const z = a.z - b.z;
  return x * x + y * y + z * z;
}

function bringWizardTo(player, follow = true, forceMovement = false) {
  const bot = ensureWizard(player);
  if (!bot) return undefined;
  if (follow) {
    followPlayerId = player.id;
    wizardShouldStay = false;
  }

  try {
    if (buildInProgress && !forceMovement) {
      return bot;
    }
    const sameDimension = bot.dimension.id === player.dimension.id;
    if (!sameDimension) {
      console.warn(`[MC Wizard] ${player.name} is in another dimension; refusing to teleport`);
    } else if (distanceSquared(bot.location, player.location) > 4 * 4) {
      bot.navigateToEntity(player, 0.7);
    } else {
      bot.stopMoving();
      bot.lookAtEntity(player, LookDuration.UntilMove);
    }
  } catch (error) {
    console.warn(`[MC Wizard] could not move to ${player.name}: ${error}`);
  }
  return bot;
}

function speak(player, message) {
  const bot = ensureWizard(player);
  for (const line of splitMessage(message)) {
    if (bot?.isValid) {
      try {
        bot.lookAtEntity(player, LookDuration.UntilMove);
        wizardSpeaking = true;
        bot.chat(line);
        continue;
      } catch (error) {
        console.warn(`[MC Wizard] simulated chat failed: ${error}`);
      } finally {
        wizardSpeaking = false;
      }
    }
    player.sendMessage(`${PREFIX}${line}`);
  }
}

function cardinalDirection(player) {
  const view = player.getViewDirection();
  if (Math.abs(view.x) > Math.abs(view.z)) {
    return view.x >= 0
      ? { name: "east", x: 1, z: 0 }
      : { name: "west", x: -1, z: 0 };
  }
  return view.z >= 0
    ? { name: "south", x: 0, z: 1 }
    : { name: "north", x: 0, z: -1 };
}

function offset(base, forward, right, along, across = 0, up = 0) {
  return {
    x: base.x + forward.x * along + right.x * across,
    y: base.y + up,
    z: base.z + forward.z * along + right.z * across,
  };
}

function buildTargetHasEntity(dimension, target) {
  const below = { x: target.x, y: target.y - 1, z: target.z };
  return [...dimension.getEntitiesAtBlockLocation(target), ...dimension.getEntitiesAtBlockLocation(below)]
    .some((entity) => !isWizardPlayer(entity));
}

function findClearSite(player, forward, right) {
  const location = player.location;
  const base = {
    x: Math.floor(location.x) + forward.x * 5,
    y: Math.floor(location.y),
    z: Math.floor(location.z) + forward.z * 5,
  };
  const occupied = [
    offset(base, forward, right, 0),
    offset(base, forward, right, 0, 0, 1),
    offset(base, forward, right, 1),
    offset(base, forward, right, 2),
    offset(base, forward, right, 3),
  ];
  if (occupied.some((position) => buildTargetHasEntity(player.dimension, position))) {
    console.warn("[MC Wizard] T flip-flop site contains a non-wizard entity");
    return null;
  }
  for (let along = -1; along <= 4; along += 1) {
    for (let across = -1; across <= 1; across += 1) {
      const ground = player.dimension.getBlock(offset(base, forward, right, along, across, -1));
      if (!ground || !SAFE_GROUND.has(ground.typeId)) {
        console.warn("[MC Wizard] T flip-flop ground rejected: " + (ground?.typeId || "unloaded"));
        return null;
      }
      const feet = player.dimension.getBlock(offset(base, forward, right, along, across));
      const head = player.dimension.getBlock(offset(base, forward, right, along, across, 1));
      if (!feet || !head || !SAFE_SPACE.has(feet.typeId) || !SAFE_SPACE.has(head.typeId)) {
        console.warn("[MC Wizard] T flip-flop space rejected: "
          + (feet?.typeId || "unloaded") + "/" + (head?.typeId || "unloaded"));
        return null;
      }
    }
  }
  return base;
}

function faceLocation(direction) {
  if (direction === Direction.Down) return { x: 0.5, y: 0, z: 0.5 };
  if (direction === Direction.North) return { x: 0.5, y: 0.5, z: 0 };
  if (direction === Direction.South) return { x: 0.5, y: 0.5, z: 1 };
  if (direction === Direction.East) return { x: 1, y: 0.5, z: 0.5 };
  if (direction === Direction.West) return { x: 0, y: 0.5, z: 0.5 };
  return { x: 0.5, y: 1, z: 0.5 };
}

function directionFromSupport(support, target) {
  if (target.y > support.y) return Direction.Up;
  if (target.y < support.y) return Direction.Down;
  if (target.x > support.x) return Direction.East;
  if (target.x < support.x) return Direction.West;
  if (target.z > support.z) return Direction.South;
  return Direction.North;
}

function canReachBuildTarget(location, target) {
  const targetCenter = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 };
  const eye = { x: location.x, y: location.y + 1.62, z: location.z };
  return distanceSquared(eye, targetCenter) <= BUILD_REACH_SQUARED;
}

function wizardCanReach(dimension, target, support = target) {
  if (!wizardIsValid() || wizard.dimension.id !== dimension.id) return false;
  const feet = {
    x: Math.floor(wizard.location.x),
    y: Math.floor(wizard.location.y),
    z: Math.floor(wizard.location.z),
  };
  const targetOccupiesBody = target.x === feet.x
    && target.z === feet.z
    && (target.y === feet.y || target.y === feet.y + 1);
  return !targetOccupiesBody
    && canReachBuildTarget(wizard.location, target)
    && canReachBuildTarget(wizard.location, support);
}

function positionWizardForBuild(dimension, target, support = target) {
  if (!wizardIsValid()) throw new Error("the simulated player is unavailable");
  if (wizardCanReach(dimension, target, support)) {
    wizard.stopMoving();
    if (buildMovement) {
      buildMovement = undefined;
      return false;
    }
    buildMovement = undefined;
    return true;
  }

  const candidates = [];
  for (let y = target.y + 1; y >= target.y - 4; y -= 1) {
    for (let x = target.x - 3; x <= target.x + 3; x += 1) {
      for (let z = target.z - 3; z <= target.z + 3; z += 1) {
        if (x === target.x && z === target.z) continue;
        const location = { x: x + 0.5, y, z: z + 0.5 };
        if (!canReachBuildTarget(location, target) || !canReachBuildTarget(location, support)) continue;
        candidates.push(location);
      }
    }
  }
  candidates.sort((a, b) => distanceSquared(a, wizard.location) - distanceSquared(b, wizard.location));
  const validCandidates = [];
  for (const location of candidates) {
    const feet = { x: Math.floor(location.x), y: location.y, z: Math.floor(location.z) };
    const head = { ...feet, y: feet.y + 1 };
    const ground = dimension.getBlock({ ...feet, y: feet.y - 1 });
    if (!ground?.isSolid || !blockIsOpen(dimension, feet) || !blockIsOpen(dimension, head)) continue;
    const occupied = [...dimension.getEntitiesAtBlockLocation(feet), ...dimension.getEntitiesAtBlockLocation(head)]
      .some((entity) => entity.id !== wizard.id);
    if (occupied) continue;
    validCandidates.push(location);
  }
  if (!validCandidates.length) {
    throw new Error(`the simulated player cannot stand within reach of ${target.x},${target.y},${target.z}`);
  }

  const key = `${dimension.id}:${target.x},${target.y},${target.z}:${support.x},${support.y},${support.z}`;
  if (buildMovement?.key === key) {
    if (system.currentTick - buildMovement.startedTick > 400) {
      const from = `${wizard.location.x.toFixed(1)},${wizard.location.y.toFixed(1)},${wizard.location.z.toFixed(1)}`;
      const to = `${buildMovement.destination.x.toFixed(1)},${buildMovement.destination.y.toFixed(1)},${buildMovement.destination.z.toFixed(1)}`;
      buildMovement = undefined;
      wizard.stopMoving();
      throw new Error(
        `the simulated player could not fly from ${from} to ${to} within reach of ${target.x},${target.y},${target.z}`,
      );
    }
    wizard.fly();
    wizard.moveToLocation(buildMovement.destination, { speed: 0.8, faceTarget: true });
    return false;
  }

  const elevatedDestination = validCandidates
    .map((location) => ({ ...location, y: location.y + 1 }))
    .find((location) => {
      const feet = {
        x: Math.floor(location.x),
        y: Math.floor(location.y),
        z: Math.floor(location.z),
      };
      const head = { ...feet, y: feet.y + 1 };
      return canReachBuildTarget(location, target)
        && canReachBuildTarget(location, support)
        && blockIsOpen(dimension, feet)
        && blockIsOpen(dimension, head);
    });
  const destination = elevatedDestination || validCandidates[0];
  buildMovement = { key, destination, startedTick: system.currentTick };
  wizard.fly();
  wizard.moveToLocation(destination, { speed: 0.8, faceTarget: true });
  wizard.lookAtLocation(target, LookDuration.UntilMove);
  return false;
}

function placeAsWizard(
  dimension,
  itemId,
  support,
  target,
  expectedType,
  permutation,
  direction = Direction.Up,
) {
  if (!wizardIsValid()) throw new Error("the simulated player is unavailable");
  const targetBeforePlacement = dimension.getBlock(target);
  if (!targetBeforePlacement || !SAFE_SPACE.has(targetBeforePlacement.typeId)) {
    throw new Error(`build target is no longer clear at ${target.x},${target.y},${target.z}`);
  }
  if (buildTargetHasEntity(dimension, target)) {
    throw new Error(`an entity entered the build area at ${target.x},${target.y},${target.z}`);
  }
  if (!positionWizardForBuild(dimension, target, support)) return false;

  const item = new ItemStack(itemId, 1);
  wizard.stopUsingItem();
  if (!wizard.setItem(item, 0, true)) throw new Error(`could not equip ${itemId}`);
  wizard.lookAtBlock(support, LookDuration.Instant);
  const placed = wizard.useItemOnBlock(
    item,
    support,
    direction,
    faceLocation(direction),
  );
  if (!placed) throw new Error(`the simulated player could not place ${itemId}`);

  const block = dimension.getBlock(target);
  const expectedTypes = Array.isArray(expectedType) ? expectedType : [expectedType];
  if (!block || !expectedTypes.includes(block.typeId)) {
    throw new Error(
      `${itemId} placement created ${block?.typeId || "nothing"}, not ${expectedTypes.join(" or ")}`,
    );
  }
  if (permutation) block.setPermutation(permutation);
  return true;
}

function breakAsWizard(dimension, target) {
  if (!wizardIsValid()) throw new Error("the simulated player is unavailable");
  if (buildTargetHasEntity(dimension, target)) {
    throw new Error(`an entity entered the scaffold at ${target.x},${target.y},${target.z}`);
  }
  const block = dimension.getBlock(target);
  if (!block) throw new Error(`could not load scaffold at ${target.x},${target.y},${target.z}`);
  if (block.typeId === "minecraft:air") return true;
  if (!positionWizardForBuild(dimension, target)) return false;
  wizard.lookAtBlock(target, LookDuration.Instant);
  if (!wizard.breakBlock(target, Direction.Up)) {
    throw new Error(`the simulated player could not remove scaffold at ${target.x},${target.y},${target.z}`);
  }
  return true;
}

function clearBuild(token) {
  if (activeBuildToken !== token) return false;
  activeBuildToken = undefined;
  buildInProgress = false;
  buildMovement = undefined;
  if (wizardIsValid()) {
    wizard.stopMoving();
    wizard.stopFlying();
  }
  equipWizard();
  return true;
}

function finishBuild(playerId, token, dimension, expectedBlocks, successMessage) {
  if (activeBuildToken !== token) return;
  const player = playerById(playerId);
  const mismatch = expectedBlocks.find(({ location, typeId }) => {
    const expectedTypes = Array.isArray(typeId) ? typeId : [typeId];
    return !expectedTypes.includes(dimension.getBlock(location)?.typeId);
  });
  const complete = !mismatch;
  if (!clearBuild(token) || !player) return;
  if (!complete) {
    const actual = dimension.getBlock(mismatch.location)?.typeId || "unloaded";
    const expected = Array.isArray(mismatch.typeId) ? mismatch.typeId.join(" or ") : mismatch.typeId;
    console.warn(
      "[MC Wizard] final build verification failed at "
        + mismatch.location.x + "," + mismatch.location.y + "," + mismatch.location.z
        + ": expected " + expected + ", got " + actual,
    );
    speak(player, "I placed the parts, but the circuit changed before I could verify it. I won’t call that finished.");
    return;
  }
  console.warn("[MC Wizard] final build verification passed");
  speak(player, successMessage);
}

function runBuildSteps(
  playerId,
  token,
  dimension,
  steps,
  expectedBlocks,
  successMessage,
  delayTicks,
  index = 0,
) {
  if (activeBuildToken !== token) return;
  if (!playerById(playerId)) {
    clearBuild(token);
    return;
  }
  if (index >= steps.length) {
    finishBuild(playerId, token, dimension, expectedBlocks, successMessage);
    return;
  }

  let stepComplete;
  try {
    stepComplete = steps[index]();
    if (stepComplete !== false && index % 50 === 0) {
      console.warn("[MC Wizard] build progress " + index + "/" + steps.length);
    }
  } catch (error) {
    console.warn(`[MC Wizard] build step ${index} failed: ${error}`);
    clearBuild(token);
    const player = playerById(playerId);
    if (player) speak(player, `I had to stop: ${error.message}. I did not fake the missing placement.`);
    return;
  }
  system.runTimeout(
    () => runBuildSteps(
      playerId,
      token,
      dimension,
      steps,
      expectedBlocks,
      successMessage,
      delayTicks,
      stepComplete === false ? index : index + 1,
    ),
    stepComplete === false ? 1 : delayTicks,
  );
}

function buildCopperBulbTFlipFlop(player) {
  console.warn("[MC Wizard] T flip-flop build requested by " + player.name);
  const previousBuild = lastBuildTick.get(player.id) || -Infinity;
  if (system.currentTick - previousBuild < 200) {
    speak(player, "Give me a few seconds before placing another demo.");
    return;
  }
  if (buildInProgress) {
    speak(player, "I’m already building one demo. I’ll finish that first.");
    return;
  }

  const dimension = player.dimension;
  const forward = cardinalDirection(player);
  console.warn("[MC Wizard] T flip-flop facing " + forward.name);
  const right = { x: -forward.z, z: forward.x };
  const base = findClearSite(player, forward, right);
  if (!base) {
    console.warn("[MC Wizard] no clear T flip-flop site near " + player.name);
    speak(player, "I couldn’t find a clear spot nearby. Move to an open area and ask again.");
    return;
  }

  const bot = bringWizardTo(player);
  if (!bot) {
    speak(player, "I can explain this build, but my player body is unavailable, so I won’t pretend to place it.");
    return;
  }

  buildInProgress = true;
  const token = ++nextBuildToken;
  activeBuildToken = token;
  lastBuildTick.set(player.id, system.currentTick);
  const buildBlock = offset(base, forward, right, 1, 1);
  const buildSpot = { x: buildBlock.x + 0.5, y: buildBlock.y, z: buildBlock.z + 0.5 };
  try {
    bot.navigateToLocation(buildSpot, 0.8);
    bot.lookAtLocation(base, LookDuration.UntilMove);
  } catch (error) {
    console.warn(`[MC Wizard] could not walk to build site: ${error}`);
  }
  speak(player, "I’ll make a small copper-bulb T flip-flop here. Watch the parts in my hand as I place them.");

  const bulb = offset(base, forward, right, 0);
  const button = offset(bulb, forward, right, 0, 0, 1);
  const comparator = offset(base, forward, right, 1);
  const wire = offset(base, forward, right, 2);
  const lamp = offset(base, forward, right, 3);
  const steps = [
    () => placeAsWizard(
      dimension,
      "minecraft:copper_bulb",
      offset(bulb, forward, right, 0, 0, -1),
      bulb,
      "minecraft:copper_bulb",
    ),
    () => placeAsWizard(
      dimension,
      "minecraft:stone_button",
      bulb,
      button,
      "minecraft:stone_button",
    ),
    () => placeAsWizard(
      dimension,
      "minecraft:comparator",
      offset(comparator, forward, right, 0, 0, -1),
      comparator,
      "minecraft:unpowered_comparator",
      BlockPermutation.resolve("minecraft:unpowered_comparator", {
        "minecraft:cardinal_direction": OPPOSITE_CARDINAL[forward.name],
        output_lit_bit: false,
        output_subtract_bit: false,
      }),
    ),
    () => placeAsWizard(
      dimension,
      "minecraft:redstone",
      offset(wire, forward, right, 0, 0, -1),
      wire,
      "minecraft:redstone_wire",
    ),
    () => placeAsWizard(
      dimension,
      "minecraft:redstone_lamp",
      offset(lamp, forward, right, 0, 0, -1),
      lamp,
      "minecraft:redstone_lamp",
    ),
  ];
  const expectedBlocks = [
    { location: bulb, typeId: "minecraft:copper_bulb" },
    { location: button, typeId: "minecraft:stone_button" },
    { location: comparator, typeId: ["minecraft:unpowered_comparator", "minecraft:powered_comparator"] },
    { location: wire, typeId: "minecraft:redstone_wire" },
    { location: lamp, typeId: "minecraft:redstone_lamp" },
  ];

  system.runTimeout(() => {
    if (activeBuildToken !== token) return;
    if (!wizardIsValid()) {
      clearBuild(token);
      const current = playerById(player.id);
      if (current) speak(current, "My player body disappeared, so I stopped before placing anything else.");
      return;
    }
    runBuildSteps(
      player.id,
      token,
      dimension,
      steps,
      expectedBlocks,
      "Built! Press the button on the copper bulb. The bulb stores one bit, the comparator reads it, and the output lamp should alternate on and off.",
      12,
    );
  }, 20);
}

function calculatorLocation(origin, forward, right, [x, y, z]) {
  return {
    x: origin.x + right.x * x - forward.x * z,
    y: origin.y + y,
    z: origin.z + right.z * x - forward.z * z,
  };
}

function findCalculatorSite(player, forward, right) {
  const origin = {
    x: Math.floor(player.location.x) + forward.x * 18 - right.x * 5,
    y: Math.floor(player.location.y),
    z: Math.floor(player.location.z) + forward.z * 18 - right.z * 5,
  };
  for (let x = -1; x <= 11; x += 1) {
    for (let z = -1; z <= 11; z += 1) {
      const ground = player.dimension.getBlock(calculatorLocation(origin, forward, right, [x, -1, z]));
      if (!ground || !SAFE_GROUND.has(ground.typeId)) return null;
      for (let y = 0; y <= 5; y += 1) {
        const block = player.dimension.getBlock(calculatorLocation(origin, forward, right, [x, y, z]));
        if (!block || !SAFE_SPACE.has(block.typeId)) return null;
      }
    }
  }
  return origin;
}

function buildRedstoneCalculator(player) {
  console.warn("[MC Wizard] calculator build requested by " + player.name);
  const previousBuild = lastBuildTick.get(player.id) || -Infinity;
  if (system.currentTick - previousBuild < 200) {
    speak(player, "Give me a few seconds before placing another demo.");
    return;
  }
  if (buildInProgress) {
    speak(player, "I’m already building one demo. I’ll finish that first.");
    return;
  }

  const dimension = player.dimension;
  const forward = cardinalDirection(player);
  console.warn("[MC Wizard] calculator facing " + forward.name);
  const right = { x: -forward.z, z: forward.x };
  const origin = findCalculatorSite(player, forward, right);
  if (!origin) {
    console.warn("[MC Wizard] no clear calculator site near " + player.name);
    speak(player, "A working redstone calculator needs a clear, flat 13 by 13 natural-ground area. Move to a flat field and ask again.");
    return;
  }

  let blueprint;
  try {
    blueprint = createCalculatorBlueprint();
  } catch (error) {
    console.warn(`[MC Wizard] calculator blueprint invalid: ${error}`);
    speak(player, "My calculator blueprint failed its own safety check, so I won’t place it.");
    return;
  }
  const bot = bringWizardTo(player);
  if (!bot) {
    speak(player, "I can explain the calculator, but my player body is unavailable, so I won’t pretend to build it.");
    return;
  }

  buildInProgress = true;
  const token = ++nextBuildToken;
  activeBuildToken = token;
  lastBuildTick.set(player.id, system.currentTick);
  const buildSpot = calculatorLocation(origin, forward, right, [5, 0, 11]);
  try {
    bot.navigateToLocation({ x: buildSpot.x + 0.5, y: buildSpot.y, z: buildSpot.z + 0.5 }, 0.8);
    bot.lookAtLocation(calculatorLocation(origin, forward, right, [5, 1, 5]), LookDuration.UntilMove);
  } catch (error) {
    console.warn(`[MC Wizard] could not walk to calculator site: ${error}`);
  }
  speak(player, "I’ll build a two-bit binary adder using only blocks, redstone dust, torches, levers, and lamps. It adds any two numbers from zero to three.");

  const steps = blueprint.placements.map((placement) => {
    const target = calculatorLocation(origin, forward, right, placement.target);
    if (placement.action === "break") {
      let breakStarted = false;
      let polls = 0;
      return () => {
        const block = dimension.getBlock(target);
        if (!block) throw new Error(`could not load scaffold at ${target.x},${target.y},${target.z}`);
        if (block.typeId === "minecraft:air") return true;
        if (!breakStarted) {
          if (!breakAsWizard(dimension, target)) return false;
          breakStarted = true;
          return dimension.getBlock(target)?.typeId === "minecraft:air";
        }
        positionWizardForBuild(dimension, target);
        polls += 1;
        if (polls > 40) {
          throw new Error(`scaffold did not clear at ${target.x},${target.y},${target.z}`);
        }
        return false;
      };
    }
    const support = calculatorLocation(origin, forward, right, placement.support);
    const direction = directionFromSupport(support, target);
    return () => placeAsWizard(
      dimension,
      placement.itemId,
      support,
      target,
      placement.expectedType,
      undefined,
      direction,
    );
  });
  const finalBlocks = new Map();
  for (const placement of blueprint.placements) {
    const location = calculatorLocation(origin, forward, right, placement.target);
    const locationKey = `${location.x},${location.y},${location.z}`;
    if (placement.action === "break") {
      finalBlocks.set(locationKey, { location, typeId: "minecraft:air" });
    }
    else finalBlocks.set(locationKey, { location, typeId: placement.expectedType });
  }

  system.runTimeout(() => {
    if (activeBuildToken !== token) return;
    if (!wizardIsValid()) {
      clearBuild(token);
      const current = playerById(player.id);
      if (current) speak(current, "My player body disappeared, so I stopped the calculator build.");
      return;
    }
    runBuildSteps(
      player.id,
      token,
      dimension,
      steps,
      [...finalBlocks.values()],
      "Calculator built. The four near levers are A-two, B-two, A-one, and B-one. Read the three pink output lamps as four, two, one. Try one plus three: the lamps should show one-zero-zero, which is four.",
      12,
    );
  }, 20);
}

function applyResponse(playerId, payload, question) {
  const player = playerById(playerId);
  if (!player) {
    console.warn("[MC Wizard] response arrived after its player disappeared");
    return;
  }
  if (payload.kind === "general") {
    deliverModelAnswer(player, payload, question);
    return;
  }
  console.warn("[MC Wizard] applying response action=" + (payload.action?.id || "none"));
  bringWizardTo(player);
  speak(player, payload.answer || "I found no answer.");

  const action = payload.action;
  if (action?.type === "place_blueprint"
    && action.id === "copper_bulb_t_flip_flop"
    && action.version === 1) {
    buildCopperBulbTFlipFlop(player);
  } else if (action?.type === "place_blueprint"
    && action.id === "binary_adder_2bit"
    && action.version === 1) {
    buildRedstoneCalculator(player);
  }
}

async function askBackend(playerId, question, mode = "wizard") {
  const player = playerById(playerId);
  if (!player) return;
  if (mode === "general") player.sendMessage("§b[AI]§r Thinking…");
  else bringWizardTo(player);

  try {
    const request = new HttpRequest(WIZARD_URL)
      .setMethod(HttpRequestMethod.Post)
      .setBody(JSON.stringify({ player: player.name, question, mode }))
      .addHeader("Content-Type", "application/json");
    if (AUTHORIZATION) request.addHeader("Authorization", AUTHORIZATION);
    const response = await http.request(request);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`brain returned HTTP ${response.status}`);
    }
    const payload = JSON.parse(response.body);
    system.run(() => applyResponse(playerId, payload, question));
  } catch (error) {
    console.warn(`[MC Wizard] ${error}`);
    system.run(() => {
      const current = playerById(playerId);
      if (!current) return;
      if (mode === "general") current.sendMessage("§b[AI]§r I can’t reach the model right now.");
      else speak(current, "I can’t reach my knowledge service right now. Ask an adult to check the MC Wizard server.");
    });
  }
}

function handleLocalCommand(player, question) {
  const wantsMovement = /^(?:come(?: here)?|follow(?: me)?|stay|wait here|stop following)(?: please)?[.!]?$/i
    .test(question);
  if (buildInProgress && wantsMovement) {
    speak(player, "I’m in the middle of placing a demo. I’ll move when I’m finished.");
    return true;
  }
  if (/^(?:come(?: here)?|follow(?: me)?)(?: please)?[.!]?$/i.test(question)) {
    bringWizardTo(player);
    speak(player, "Coming! I’ll follow you.");
    return true;
  }
  if (/^(?:stay|wait here|stop following)(?: please)?[.!]?$/i.test(question)) {
    const bot = ensureWizard(player);
    followPlayerId = player.id;
    wizardShouldStay = true;
    try {
      bot?.stopMoving();
      bot?.lookAtEntity(player, LookDuration.UntilMove);
    } catch (error) {
      console.warn(`[MC Wizard] could not stay: ${error}`);
    }
    speak(player, "I’ll stay here.");
    return true;
  }
  return false;
}

function routeAddressedMessage(player, message) {
  const trimmed = message.trim();
  const match = trimmed.match(/^!?(?:mc\s+)?wiz(?:ard)?(?:\s*[:,]\s*|\s+)(.*)$/i);
  const bareName = /^!?(?:mc\s+)?wiz(?:ard)?$/i.test(trimmed);
  const nearby = wizardIsValid()
    && wizard.dimension.id === player.dimension.id
    && distanceSquared(wizard.location, player.location) <= 12 * 12;
  const implicit = humanPlayers().length === 1 || nearby;
  if (!match && !bareName && !implicit) return false;
  const playerId = player.id;
  const question = match ? match[1].trim() : bareName ? "" : trimmed;
  system.run(() => {
    const current = playerById(playerId);
    if (!current) return;
    if (!question) {
      speak(current, "Ask me anything. You can say ‘wiz’ when other players are chatting too.");
      return;
    }
    if (!handleLocalCommand(current, question)) void askBackend(playerId, question);
  });
  return true;
}

function routeAIMessage(player, message) {
  const trimmed = message.trim();
  const match = trimmed.match(/^!?ai(?:\s*[:,]\s*|\s+)(.*)$/i);
  const bareName = /^!?ai$/i.test(trimmed);
  if (!match && !bareName) return false;
  const playerId = player.id;
  const question = match?.[1]?.trim();
  system.run(() => {
    const current = playerById(playerId);
    if (!current) return;
    if (!question) {
      current.sendMessage("§b[AI]§r Ask with: ai, why is the sky blue?");
      return;
    }
    void askBackend(playerId, question, "general");
  });
  return true;
}

world.beforeEvents.chatSend.subscribe((event) => {
  if (wizardSpeaking) return;
  if (isWizardPlayer(event.sender) || event.sender.name === WIZARD_NAME) return;
  if (!routeAIMessage(event.sender, event.message)
    && !routeAddressedMessage(event.sender, event.message)) return;
  engineAddressedMessageCounts.set(
    event.sender.id,
    (engineAddressedMessageCounts.get(event.sender.id) || 0) + 1,
  );
});

world.afterEvents.playerSpawn.subscribe((event) => {
  if (isWizardPlayer(event.player) || event.player.name === WIZARD_NAME) return;
  const playerId = event.player.id;
  const initialSpawn = event.initialSpawn;
  system.runTimeout(() => {
    const player = playerById(playerId);
    if (!player) return;
    followPlayerId ||= player.id;
    bringWizardTo(player, followPlayerId === player.id);
    if (initialSpawn && !greetedPlayers.has(player.id)) {
      greetedPlayers.add(player.id);
      speak(player, "Hello! I’m MC Wizard. Chat normally when we’re alone or nearby, or say ‘wiz’ when the server is busy. Ask about Bedrock redstone, commands, or a demo.");
    }
  }, 20);
});

world.afterEvents.playerLeave.subscribe(() => {
  system.run(() => {
    if (humanPlayers().length || !wizardIsValid()) return;
    try {
      wizard.disconnect();
    } catch (error) {
      console.warn(`[MC Wizard] disconnect failed: ${error}`);
    }
    wizard = undefined;
    followPlayerId = undefined;
    activeBuildToken = undefined;
    buildInProgress = false;
  });
});

system.runInterval(() => {
  const player = playerById(followPlayerId) || humanPlayers()[0];
  if (!player) return;
  followPlayerId = player.id;
  if (!wizardIsValid()) {
    const bot = ensureWizard(player);
    if (bot && wizardShouldStay) {
      try {
        bot.stopMoving();
        bot.lookAtEntity(player, LookDuration.UntilMove);
      } catch (error) {
        console.warn(`[MC Wizard] restore-stay failed: ${error}`);
      }
    }
    return;
  }
  if (wizardShouldStay || buildInProgress) return;
  try {
    const sameDimension = wizard.dimension.id === player.dimension.id;
    const distance = sameDimension ? distanceSquared(wizard.location, player.location) : Infinity;
    if (!sameDimension) {
      console.warn(`[MC Wizard] ${player.name} is in another dimension; refusing to teleport`);
    } else if (distance > 4 * 4) {
      wizard.navigateToEntity(player, 0.65);
    } else {
      wizard.stopMoving();
      wizard.lookAtEntity(player, LookDuration.UntilMove);
    }
  } catch (error) {
    console.warn(`[MC Wizard] follow loop failed: ${error}`);
  }
}, 80);

world.afterEvents.worldLoad.subscribe(() => {
  console.warn(`[MC Wizard] ready; brain=${WIZARD_URL}`);
  if (variable("mc_wizard_e2e", false) === true) {
    system.runTimeout(() => startE2E({
      routeAddressedMessage,
      engineAddressedMessageCount: (playerId) => engineAddressedMessageCounts.get(playerId) || 0,
    }), 20);
  }
});
