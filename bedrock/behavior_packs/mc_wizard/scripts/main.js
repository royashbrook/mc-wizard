import {
  BlockPermutation,
  Direction,
  EquipmentSlot,
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
import {
  expectedPlacementStates,
  planBounds,
  validateBuildPlan,
} from "./build-plan.js";
import { commandLesson } from "./command-lessons.js";
import { splitMessage } from "./chat.js";

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
// Match a creative player's practical block reach. Every placement is still
// verified because the API can report a use animation without changing the world.
const BUILD_REACH_SQUARED = 5.5 * 5.5;
const lastBuildTick = new Map();
const greetedPlayers = new Set();
const engineAddressedMessageCounts = new Map();
const queuedBuilds = new Map();
const pendingQuestions = new Map();
const lastUndo = new Map();
const placementRetries = new Map();
const preparedPlacements = new Set();
const TRANSACTION_JOURNAL = "mcwizard:active_transaction";
const UNDO_RETENTION_TICKS = 20 * 60 * 10;
const WORKSHOP_COUNTER = "mcwizard:workshop_counter";
const WORKSHOP_TICKING_AREA = "mc_wizard_workshop";

let wizard;
let followPlayerId;
let wizardShouldStay = false;
let wizardSpeaking = false;
let buildInProgress = false;
let activeBuildToken;
let nextBuildToken = 0;
let nextQuestionToken = 0;
let buildMovement;
let activeTransaction;
let lastAmbientTick = 0;

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
    component.signBook(bookTitle(payload.title || question), label);
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

function standingBlockY(location) {
  return Math.floor(location.y + 0.01);
}

function arrivalPosition(player) {
  const base = {
    x: Math.floor(player.location.x),
    y: standingBlockY(player.location),
    z: Math.floor(player.location.z),
  };
  for (const [x, z] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, -2]]) {
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

function equipWizard(itemId = "mcwizard:wand") {
  if (!wizardIsValid()) return;
  try {
    wizard.setItem(new ItemStack(itemId, 1), 0, true);
  } catch (error) {
    console.warn(`[MC Wizard] could not equip ${itemId}: ${error}`);
    if (itemId !== "minecraft:stick") equipWizard("minecraft:stick");
  }
}

function removeOldCostume() {
  if (!wizardIsValid()) return;
  const equippable = wizard.getComponent("minecraft:equippable");
  if (!equippable) return;
  try {
    equippable.setEquipment(EquipmentSlot.Head, undefined);
    equippable.setEquipment(EquipmentSlot.Chest, undefined);
  } catch (error) {
    console.warn(`[MC Wizard] could not clear the old costume: ${error}`);
  }
}

function ensureWizard(anchor) {
  if (wizardIsValid()) {
    removeOldCostume();
    return wizard;
  }

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
    removeOldCostume();
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

function moveWizardBeside(bot, player) {
  const distance = distanceSquared(bot.location, player.location);
  const destination = arrivalPosition(player);
  if ((distance < 2.25 * 2.25 || distance > 4.5 * 4.5)
    && destination
    && distanceSquared(bot.location, destination) > 0.75 * 0.75) {
    bot.navigateToLocation(destination, 0.65);
    return true;
  }
  bot.stopMoving();
  bot.lookAtEntity(player, LookDuration.UntilMove);
  return false;
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
    } else moveWizardBeside(bot, player);
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

function worldSmallTalk(player, question) {
  const text = question.trim();
  const asksMood = /\b(?:what(?:’|'| i)s up|how are you|how(?:’|'| i)s it going|you doing)\b/i.test(text);
  const asksWeather = /\b(?:weather|rain|raining|sunny|storm|storming|thunder|sky)\b/i.test(text);
  const asksTime = /\b(?:what time|time is it|day or night|night or day|is it (?:day|night)|daytime|nighttime)\b/i.test(text);
  if (!asksMood && !asksWeather && !asksTime) return undefined;
  let weather;
  try {
    weather = typeof player.dimension.getWeather === "function" ? player.dimension.getWeather() : undefined;
  } catch {
    weather = undefined;
  }
  const time = world.getTimeOfDay();
  const dayPart = time < 1000 || time >= 23000 ? "sunrise"
    : time < 12000 ? "daytime"
      : time < 13000 ? "sunset"
        : "night";
  if (asksTime) {
    const hour = Math.floor((time / 1000 + 6) % 24);
    return `It’s ${dayPart} right now—about ${String(hour).padStart(2, "0")}:00 in Minecraft time.`;
  }
  if (weather === "Thunder") return `That thunder has excellent wizard timing. It’s ${dayPart}, so I’m keeping my wand dry and watching the sky.`;
  if (weather === "Rain") return `It’s raining at ${dayPart}. Good weather for roofs, hidden workshops, and dramatic entrances.`;
  if (weather === "Clear") return `Clear skies at ${dayPart}. I’m doing well and ready to wander, build, or inspect whatever you’re making.`;
  return `I’m doing well. It’s ${dayPart} here, and I’m ready to explore or build with you.`;
}

function idleLookAround(player) {
  if (!wizardIsValid() || system.currentTick - lastAmbientTick < 200) return;
  lastAmbientTick = system.currentTick;
  const base = {
    x: Math.floor(player.location.x),
    y: standingBlockY(player.location),
    z: Math.floor(player.location.z),
  };
  for (let radius = 1; radius <= 4; radius += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      for (let z = -radius; z <= radius; z += 1) {
        const location = { x: base.x + x, y: base.y, z: base.z + z };
        const typeId = player.dimension.getBlock(location)?.typeId || "";
        if (/redstone|command_block|comparator|repeater|lever|button|lamp/.test(typeId)) {
          wizard.lookAtBlock(location, LookDuration.UntilMove);
          return;
        }
      }
    }
  }
  const view = player.getViewDirection();
  wizard.lookAtLocation({
    x: player.location.x + view.x * 5,
    y: player.location.y + Math.max(1, view.y * 5),
    z: player.location.z + view.z * 5,
  }, LookDuration.UntilMove);
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

function beginTransaction(playerId, token, dimension, expectedBlocks) {
  const unique = new Map(expectedBlocks.map(({ location }) => [
    `${location.x},${location.y},${location.z}`,
    { x: location.x, y: location.y, z: location.z },
  ]));
  const locations = [...unique.values()];
  if (!locations.length || locations.length > 400) throw new Error("build transaction is outside the 1-400 block limit");
  const protectedRadius = Number(variable("mc_wizard_protected_spawn_radius", 0)) || 0;
  if (protectedRadius > 0 && dimension.id === "minecraft:overworld") {
    const spawn = world.getDefaultSpawnLocation();
    if (locations.some((location) => (
      Math.abs(location.x - spawn.x) <= protectedRadius && Math.abs(location.z - spawn.z) <= protectedRadius
    ))) throw new Error("that build would enter the protected spawn area");
  }
  const snapshots = locations.map((location) => {
    const block = dimension.getBlock(location);
    if (!block) throw new Error(`could not snapshot ${location.x},${location.y},${location.z}`);
    return {
      location,
      typeId: block.typeId,
      states: block.permutation.getAllStates(),
    };
  });
  const transaction = {
    playerId,
    token,
    dimensionId: dimension.id,
    snapshots,
    expectedBlocks,
  };
  world.setDynamicProperty(TRANSACTION_JOURNAL, JSON.stringify({
    dimensionId: dimension.id,
    snapshots,
  }));
  activeTransaction = transaction;
  return transaction;
}

function restoreSnapshots(transaction) {
  const dimension = world.getDimension(transaction.dimensionId);
  for (const snapshot of transaction.snapshots) {
    dimension.getBlock(snapshot.location)?.setPermutation(
      BlockPermutation.resolve(snapshot.typeId, snapshot.states || {}),
    );
  }
}

function rollbackTransaction(token) {
  if (!activeTransaction || activeTransaction.token !== token) return;
  restoreSnapshots(activeTransaction);
  world.setDynamicProperty(TRANSACTION_JOURNAL, undefined);
  activeTransaction = undefined;
}

function commitTransaction(token) {
  if (!activeTransaction || activeTransaction.token !== token) return;
  const transaction = activeTransaction;
  lastUndo.set(transaction.playerId, {
    ...transaction,
    expiresTick: system.currentTick + UNDO_RETENTION_TICKS,
  });
  world.setDynamicProperty(TRANSACTION_JOURNAL, undefined);
  activeTransaction = undefined;
}

function undoLastBuild(player) {
  const transaction = lastUndo.get(player.id);
  if (!transaction || transaction.expiresTick <= system.currentTick) {
    lastUndo.delete(player.id);
    speak(player, "I don’t have a recent build to undo.");
    return false;
  }
  if (buildInProgress) {
    speak(player, "I’ll finish or roll back the current build before undoing another one.");
    return false;
  }
  restoreSnapshots(transaction);
  lastUndo.delete(player.id);
  speak(player, "Undone. I restored every block from before my last build.");
  return true;
}

function recoverInterruptedTransaction() {
  const journal = world.getDynamicProperty(TRANSACTION_JOURNAL);
  if (typeof journal !== "string" || !journal) return;
  try {
    restoreSnapshots(JSON.parse(journal));
    console.warn("[MC Wizard] restored an interrupted build transaction");
  } catch (error) {
    console.warn(`[MC Wizard] could not restore interrupted build: ${error}`);
  } finally {
    world.setDynamicProperty(TRANSACTION_JOURNAL, undefined);
  }
}

async function prepareBuildWorkshop(player) {
  try {
    const sequence = Math.max(0, Number(world.getDynamicProperty(WORKSHOP_COUNTER)) || 0);
    world.setDynamicProperty(WORKSHOP_COUNTER, sequence + 1);
    const dimension = world.getDimension("overworld");
    const spawn = world.getDefaultSpawnLocation();
    const center = {
      x: Math.floor(spawn.x) + 48 + (sequence % 8) * 64,
      y: 256,
      z: Math.floor(spawn.z) + 48 + Math.floor(sequence / 8) * 64,
    };
    speak(player, "No room here—opening a fresh workshop and moving us there now.");
    try {
      dimension.runCommand(`tickingarea remove ${WORKSHOP_TICKING_AREA}`);
    } catch {}
    dimension.runCommand(`tickingarea add circle ${center.x} ${center.y} ${center.z} 4 ${WORKSHOP_TICKING_AREA} true`);
    player.teleport({ x: center.x + 0.5, y: center.y, z: center.z + 0.5 }, { dimension });
    await system.waitTicks(20);
    dimension.runCommand(`fill ${center.x - 24} ${center.y} ${center.z - 24} ${center.x} ${center.y + 24} ${center.z + 24} air`);
    dimension.runCommand(`fill ${center.x + 1} ${center.y} ${center.z - 24} ${center.x + 24} ${center.y + 24} ${center.z + 24} air`);
    dimension.runCommand(`fill ${center.x - 24} ${center.y - 1} ${center.z - 24} ${center.x + 24} ${center.y - 1} ${center.z + 24} grass_block`);
    await system.waitTicks(1);
    if (dimension.getBlock({ x: center.x, y: center.y - 1, z: center.z })?.typeId !== "minecraft:grass_block"
      || dimension.getBlock(center)?.typeId !== "minecraft:air") {
      throw new Error("workshop blocks were not loaded after preparation");
    }
    player.teleport({ x: center.x + 0.5, y: center.y, z: center.z + 0.5 }, { dimension });
    if (wizardIsValid()) {
      wizard.teleport({ x: center.x + 2.5, y: center.y, z: center.z + 0.5 }, { dimension });
    }
    system.runTimeout(() => {
      try {
        dimension.runCommand(`tickingarea remove ${WORKSHOP_TICKING_AREA}`);
      } catch {}
    }, 12_000);
    console.warn(`[MC Wizard] prepared workshop ${sequence} for ${player.name}`);
    return true;
  } catch (error) {
    console.warn(`[MC Wizard] could not prepare a workshop: ${error}`);
    speak(player, "My workshop spell failed, so I stopped before changing this area. Try that request once more.");
    return false;
  }
}

function queueBuild(player, callback, delayTicks = 40, message = "I queued that build and will start it automatically.") {
  const alreadyQueued = queuedBuilds.has(player.id);
  queuedBuilds.set(player.id, callback);
  speak(player, alreadyQueued ? "I updated your queued build request." : message);
  if (alreadyQueued) return;
  const attempt = () => {
    const current = playerById(player.id);
    if (!current) {
      queuedBuilds.delete(player.id);
      return;
    }
    if (buildInProgress) {
      system.runTimeout(attempt, 40);
      return;
    }
    const queued = queuedBuilds.get(player.id);
    queuedBuilds.delete(player.id);
    if (queued) queued(current);
  };
  system.runTimeout(attempt, delayTicks);
}

function findClearSite(player, forward, right) {
  const location = player.location;
  const base = {
    x: Math.floor(location.x) + forward.x * 5,
    y: standingBlockY(location),
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

function horizontalClearanceSquared(location, target) {
  const dx = Math.max(target.x - location.x, 0, location.x - (target.x + 1));
  const dz = Math.max(target.z - location.z, 0, location.z - (target.z + 1));
  return dx * dx + dz * dz;
}

function navigateWizardToBuildPosition(destination, forceDirect = false, movement) {
  wizard.stopFlying();
  if (forceDirect && Math.abs(destination.y - wizard.location.y) <= 1.5) {
    if (movement?.lastJumpTick
      && system.currentTick - movement.lastJumpTick < 12
      && !wizard.isOnGround) return;
    wizard.moveToLocation(destination, { speed: 0.8, faceTarget: true });
    if (wizard.isOnGround
      && (!movement?.lastJumpTick || system.currentTick - movement.lastJumpTick >= 12)
      && wizard.jump()
      && movement) movement.lastJumpTick = system.currentTick;
    return;
  }
  try {
    const navigation = wizard.navigateToLocation(destination, 1);
    if (navigation.isFullPath) {
      if (system.currentTick % 10 === 0) wizard.jump();
      return;
    }
  } catch {
    // Bedrock can briefly report a fractional airborne height over redstone.
  }
  if (Math.abs(destination.y - wizard.location.y) <= 1.5) {
    wizard.moveToLocation(destination, { speed: 0.8, faceTarget: true });
  }
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
  const targetTouchesBody = (target.y === feet.y || target.y === feet.y + 1)
    && horizontalClearanceSquared(wizard.location, target) < 0.4 * 0.4;
  return !targetOccupiesBody
    && !targetTouchesBody
    && canReachBuildTarget(wizard.location, target)
    && canReachBuildTarget(wizard.location, support);
}

function positionWizardForBuild(dimension, target, support = target, forceMove = false) {
  if (!wizardIsValid()) throw new Error("the simulated player is unavailable");
  const key = `${dimension.id}:${target.x},${target.y},${target.z}:${support.x},${support.y},${support.z}`;
  if (!forceMove && wizardCanReach(dimension, target, support)) {
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
    for (let x = target.x - 5; x <= target.x + 5; x += 1) {
      for (let z = target.z - 5; z <= target.z + 5; z += 1) {
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

  if (buildMovement?.key === key) {
    if (wizardCanReach(dimension, target, support)
      && distanceSquared(wizard.location, buildMovement.destination) < 1) {
      wizard.stopMoving();
      buildMovement = undefined;
      return true;
    }
    const movementElapsed = system.currentTick - buildMovement.startedTick;
    if (buildMovement.mode === "flight-takeoff") {
      wizard.fly();
      if (movementElapsed < 10) return false;
      const clearanceY = Math.max(wizard.location.y, buildMovement.destination.y) + 4;
      buildMovement = {
        ...buildMovement,
        mode: "flight",
        startedTick: system.currentTick,
        waypoint: 0,
        waypoints: [
          { x: wizard.location.x, y: clearanceY, z: wizard.location.z },
          { x: buildMovement.destination.x, y: clearanceY, z: buildMovement.destination.z },
          buildMovement.destination,
        ],
        commandedWaypoint: undefined,
      };
      return false;
    }
    if (buildMovement.mode === "flight-land") {
      wizard.stopFlying();
      if (wizard.isOnGround || movementElapsed > 40) {
        buildMovement = {
          ...buildMovement,
          mode: "ground",
          startedTick: system.currentTick,
          attempt: 0,
          tried: [],
        };
        navigateWizardToBuildPosition(buildMovement.destination);
      }
      return false;
    }
    if (buildMovement.mode === "flight") {
      if (movementElapsed > 600) {
        const from = `${wizard.location.x.toFixed(1)},${wizard.location.y.toFixed(1)},${wizard.location.z.toFixed(1)}`;
        const to = `${buildMovement.destination.x.toFixed(1)},${buildMovement.destination.y.toFixed(1)},${buildMovement.destination.z.toFixed(1)}`;
        buildMovement = undefined;
        wizard.stopMoving();
        throw new Error(`the simulated player could not fly from ${from} to ${to} within reach of ${target.x},${target.y},${target.z}`);
      }
      let waypoint = buildMovement.waypoints[buildMovement.waypoint];
      if (distanceSquared(wizard.location, waypoint) < 0.5) {
        buildMovement.waypoint += 1;
        buildMovement.commandedWaypoint = undefined;
        waypoint = buildMovement.waypoints[buildMovement.waypoint];
        if (buildMovement.waypoint === 2) {
          buildMovement.mode = "flight-land";
          buildMovement.startedTick = system.currentTick;
          wizard.stopMoving();
          wizard.stopFlying();
          return false;
        }
        if (!waypoint) {
          buildMovement = undefined;
          wizard.stopMoving();
          return false;
        }
      }
      if (buildMovement.commandedWaypoint !== buildMovement.waypoint) {
        wizard.moveToLocation(waypoint, { speed: 1, faceTarget: true });
        buildMovement.commandedWaypoint = buildMovement.waypoint;
      }
      return false;
    }
    if (movementElapsed > 120) {
      const alternative = (buildMovement.attempt || 0) < 3
        ? validCandidates.find((location) => (
          distanceSquared(location, buildMovement.destination) >= 2.25
          && !(buildMovement.tried || []).some((tried) => distanceSquared(location, tried) < 0.25)
        ))
        : undefined;
      if (alternative) {
        buildMovement = {
          ...buildMovement,
          destination: alternative,
          startedTick: system.currentTick,
          attempt: (buildMovement.attempt || 0) + 1,
          tried: [...(buildMovement.tried || []), buildMovement.destination],
          lastJumpTick: undefined,
        };
        wizard.stopMoving();
        return false;
      }
      buildMovement = {
        ...buildMovement,
        mode: "flight-takeoff",
        startedTick: system.currentTick,
      };
      wizard.stopMoving();
      wizard.fly();
      return false;
    }
    if (movementElapsed > 600) {
      const from = `${wizard.location.x.toFixed(1)},${wizard.location.y.toFixed(1)},${wizard.location.z.toFixed(1)}`;
      const to = `${buildMovement.destination.x.toFixed(1)},${buildMovement.destination.y.toFixed(1)},${buildMovement.destination.z.toFixed(1)}`;
      buildMovement = undefined;
      wizard.stopMoving();
      throw new Error(
        `the simulated player could not move from ${from} to ${to} within reach of ${target.x},${target.y},${target.z}`,
      );
    }
    navigateWizardToBuildPosition(
      buildMovement.destination,
      movementElapsed > 40,
      buildMovement,
    );
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
  const forcedDestination = forceMove
    ? validCandidates.find((location) => distanceSquared(location, wizard.location) >= 2.25)
    : undefined;
  const destination = forcedDestination || elevatedDestination || validCandidates[0];
  buildMovement = { key, destination, startedTick: system.currentTick, mode: "ground" };
  wizard.stopMoving();
  navigateWizardToBuildPosition(destination);
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
  expectedStates = {},
) {
  if (!wizardIsValid()) throw new Error("the simulated player is unavailable");
  const targetBeforePlacement = dimension.getBlock(target);
  if (!targetBeforePlacement || !SAFE_SPACE.has(targetBeforePlacement.typeId)) {
    throw new Error(`build target is no longer clear at ${target.x},${target.y},${target.z}`);
  }
  if (buildTargetHasEntity(dimension, target)) {
    throw new Error(`an entity entered the build area at ${target.x},${target.y},${target.z}`);
  }
  const retryKey = `${target.x},${target.y},${target.z}:${itemId}`;
  if (!positionWizardForBuild(dimension, target, support, placementRetries.has(retryKey))) return false;

  const item = new ItemStack(itemId, 1);
  if (!preparedPlacements.has(retryKey)) {
    wizard.stopUsingItem();
    if (!wizard.setItem(item, 0, true)) throw new Error(`could not equip ${itemId}`);
    wizard.lookAtBlock(support, LookDuration.Instant);
    preparedPlacements.add(retryKey);
    return "placement-prepare";
  }
  preparedPlacements.delete(retryKey);
  wizard.lookAtBlock(support, LookDuration.Instant);
  const placed = wizard.useItemOnBlock(
    item,
    support,
    direction,
    faceLocation(direction),
  );
  if (!placed) {
    const attempts = (placementRetries.get(retryKey) || 0) + 1;
    console.warn(`[MC Wizard] placement retry ${attempts} for ${itemId}; wizard=${wizard.location.x.toFixed(1)},${wizard.location.y.toFixed(1)},${wizard.location.z.toFixed(1)} target=${target.x},${target.y},${target.z} support=${support.x},${support.y},${support.z}; use=false`);
    if (attempts <= 3) {
      placementRetries.set(retryKey, attempts);
      wizard.stopMoving();
      return "placement-retry";
    }
    placementRetries.delete(retryKey);
    throw new Error(`the simulated player could not place ${itemId} after ${attempts} attempts`);
  }

  const block = dimension.getBlock(target);
  const expectedTypes = Array.isArray(expectedType) ? expectedType : [expectedType];
  if (!block || !expectedTypes.includes(block.typeId)) {
    const attempts = (placementRetries.get(retryKey) || 0) + 1;
    console.warn(`[MC Wizard] placement retry ${attempts} for ${itemId}; wizard=${wizard.location.x.toFixed(1)},${wizard.location.y.toFixed(1)},${wizard.location.z.toFixed(1)} target=${target.x},${target.y},${target.z} support=${support.x},${support.y},${support.z}; result=${block?.typeId || "nothing"}`);
    if (attempts <= 3) {
      placementRetries.set(retryKey, attempts);
      wizard.stopMoving();
      return "placement-retry";
    }
    placementRetries.delete(retryKey);
    throw new Error(
      `${itemId} placement created ${block?.typeId || "nothing"}, not ${expectedTypes.join(" or ")}, after ${attempts} attempts`,
    );
  }
  placementRetries.delete(retryKey);
  for (const [state, expected] of Object.entries(expectedStates)) {
    const actual = block.permutation.getState(state);
    if (actual !== expected) {
      throw new Error(`${itemId} orientation ${state}=${actual}, expected ${expected}`);
    }
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

function clearBuild(token, rollback = false) {
  if (activeBuildToken !== token) return false;
  if (rollback) rollbackTransaction(token);
  activeBuildToken = undefined;
  buildInProgress = false;
  buildMovement = undefined;
  placementRetries.clear();
  preparedPlacements.clear();
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
  if (!complete) {
    const actual = dimension.getBlock(mismatch.location)?.typeId || "unloaded";
    const expected = Array.isArray(mismatch.typeId) ? mismatch.typeId.join(" or ") : mismatch.typeId;
    console.warn(
      "[MC Wizard] final build verification failed at "
        + mismatch.location.x + "," + mismatch.location.y + "," + mismatch.location.z
        + ": expected " + expected + ", got " + actual,
    );
    clearBuild(token, true);
    if (player) speak(player, "The build failed verification, so I restored the area to exactly how it was before I started.");
    return;
  }
  commitTransaction(token);
  if (!clearBuild(token) || !player) return;
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
    clearBuild(token, true);
    return;
  }
  if (index === 0 && !activeTransaction) {
    try {
      beginTransaction(playerId, token, dimension, expectedBlocks);
    } catch (error) {
      console.warn(`[MC Wizard] transaction refused: ${error}`);
      clearBuild(token, true);
      const player = playerById(playerId);
      if (player) speak(player, `I won’t start that build: ${error.message}.`);
      return;
    }
  }
  if (index >= steps.length) {
    finishBuild(playerId, token, dimension, expectedBlocks, successMessage);
    return;
  }

  let stepComplete;
  try {
    stepComplete = steps[index]();
    if (stepComplete !== false
      && stepComplete !== "placement-retry"
      && stepComplete !== "placement-prepare"
      && index % 50 === 0) {
      console.warn("[MC Wizard] build progress " + index + "/" + steps.length);
    }
  } catch (error) {
    console.warn(`[MC Wizard] build step ${index} failed: ${error}`);
    clearBuild(token, true);
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
      stepComplete === false || stepComplete === "placement-retry" || stepComplete === "placement-prepare"
        ? index
        : index + 1,
    ),
    stepComplete === "placement-retry" ? 10
      : stepComplete === "placement-prepare" ? 3
        : stepComplete === false ? 1 : delayTicks,
  );
}

async function buildCopperBulbTFlipFlop(player) {
  console.warn("[MC Wizard] T flip-flop build requested by " + player.name);
  const previousBuild = lastBuildTick.get(player.id) || -Infinity;
  if (system.currentTick - previousBuild < 200) {
    queueBuild(
      player,
      buildCopperBulbTFlipFlop,
      200 - (system.currentTick - previousBuild),
      "I queued that T flip-flop and will start it in a few seconds.",
    );
    return;
  }
  if (buildInProgress) {
    queueBuild(player, buildCopperBulbTFlipFlop);
    return;
  }

  let dimension = player.dimension;
  let forward = cardinalDirection(player);
  console.warn("[MC Wizard] T flip-flop facing " + forward.name);
  let right = { x: -forward.z, z: forward.x };
  let base = findClearSite(player, forward, right);
  if (!base && await prepareBuildWorkshop(player)) {
    dimension = player.dimension;
    forward = cardinalDirection(player);
    right = { x: -forward.z, z: forward.x };
    base = findClearSite(player, forward, right);
  }
  if (!base) {
    console.warn("[MC Wizard] no clear T flip-flop site near " + player.name);
    speak(player, "I couldn’t prepare a safe build site, so I stopped before placing anything.");
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

function playerCopyableCalculatorSupport(dimension, itemId, target, plannedSupport) {
  const isFloorTile = itemId === "minecraft:smooth_stone" || itemId.endsWith("_wool");
  if (!isFloorTile || plannedSupport.y !== target.y - 1) return plannedSupport;
  const neighbors = [
    { x: target.x - 1, y: target.y, z: target.z },
    { x: target.x + 1, y: target.y, z: target.z },
    { x: target.x, y: target.y, z: target.z - 1 },
    { x: target.x, y: target.y, z: target.z + 1 },
  ];
  return neighbors.find((location) => dimension.getBlock(location)?.isSolid) || plannedSupport;
}

function playerAccessibleCalculatorOrder(placements) {
  const ordered = [];
  const built = new Set();
  const key = ([x, y, z]) => `${x},${y},${z}`;
  const isStackedFullBlock = (placement) => placement.action !== "break"
    && (placement.itemId === "minecraft:smooth_stone" || placement.itemId.endsWith("_wool"))
    && placement.support[1] === placement.target[1] - 1;
  const hasBuiltNeighbor = (placement) => {
    const [x, y, z] = placement.target;
    return [[x - 1, y, z], [x + 1, y, z], [x, y, z - 1], [x, y, z + 1]]
      .some((location) => built.has(key(location)));
  };

  for (let index = 0; index < placements.length;) {
    const first = placements[index];
    if (!isStackedFullBlock(first)) {
      ordered.push(first);
      if (first.action !== "break") built.add(key(first.target));
      index += 1;
      continue;
    }
    const run = [];
    while (index < placements.length
      && isStackedFullBlock(placements[index])
      && placements[index].target[1] === first.target[1]) {
      run.push(placements[index]);
      index += 1;
    }
    while (run.length) {
      const nextIndex = run.findIndex(hasBuiltNeighbor);
      const [next] = run.splice(nextIndex < 0 ? 0 : nextIndex, 1);
      ordered.push(next);
      built.add(key(next.target));
    }
  }
  return ordered;
}

function customLocation(origin, forward, right, [x, y, z]) {
  return {
    x: origin.x + right.x * x + forward.x * z,
    y: origin.y + y,
    z: origin.z + right.z * x + forward.z * z,
  };
}

function findCustomSite(player, plan, forward, right) {
  const origin = {
    x: Math.floor(player.location.x) + forward.x * 6,
    y: standingBlockY(player.location),
    z: Math.floor(player.location.z) + forward.z * 6,
  };
  const bounds = planBounds(plan);
  for (let x = bounds.min[0] - 2; x <= bounds.max[0] + 2; x += 1) {
    for (let z = bounds.min[2] - 2; z <= bounds.max[2] + 2; z += 1) {
      const ground = player.dimension.getBlock(customLocation(origin, forward, right, [x, -1, z]));
      if (!ground || !SAFE_GROUND.has(ground.typeId)) return null;
    }
  }
  for (const placement of plan.blocks) {
    const target = customLocation(origin, forward, right, placement.target);
    const block = player.dimension.getBlock(target);
    if (!block || !SAFE_SPACE.has(block.typeId) || buildTargetHasEntity(player.dimension, target)) return null;
  }
  return origin;
}

async function buildValidatedPlan(player, value) {
  let plan;
  try {
    plan = validateBuildPlan(value);
  } catch (error) {
    speak(player, `I rejected that plan before touching the world: ${error.message}.`);
    return;
  }
  if (buildInProgress) {
    queueBuild(player, (current) => buildValidatedPlan(current, value));
    return;
  }
  let dimension = player.dimension;
  let forward = cardinalDirection(player);
  let right = { x: -forward.z, z: forward.x };
  let origin = findCustomSite(player, plan, forward, right);
  if (!origin && await prepareBuildWorkshop(player)) {
    dimension = player.dimension;
    forward = cardinalDirection(player);
    right = { x: -forward.z, z: forward.x };
    origin = findCustomSite(player, plan, forward, right);
  }
  if (!origin) {
    speak(player, "I couldn’t prepare a safe workshop for that plan, so I stopped before placing anything.");
    return;
  }
  const bot = bringWizardTo(player);
  if (!bot) {
    speak(player, "My player body is unavailable, so I won’t pretend to build it.");
    return;
  }
  buildInProgress = true;
  const token = ++nextBuildToken;
  activeBuildToken = token;
  lastBuildTick.set(player.id, system.currentTick);
  const steps = plan.blocks.map((placement) => {
    const target = customLocation(origin, forward, right, placement.target);
    const support = customLocation(origin, forward, right, placement.support);
    const direction = directionFromSupport(support, target);
    const expectedStates = expectedPlacementStates(
      placement.itemId,
      [support.x, support.y, support.z],
      [target.x, target.y, target.z],
    );
    return () => placeAsWizard(
      dimension,
      placement.itemId,
      support,
      target,
      placement.expectedType,
      undefined,
      direction,
      expectedStates,
    );
  });
  const expectedBlocks = plan.blocks.map((placement) => ({
    location: customLocation(origin, forward, right, placement.target),
    typeId: placement.expectedType,
  }));
  speak(player, `I validated “${plan.title}”. I’ll place its ${plan.blocks.length} blocks one at a time, then verify all of them.`);
  system.runTimeout(() => runBuildSteps(
    player.id,
    token,
    dimension,
    steps,
    expectedBlocks,
    `${plan.title} is built and verified. Say “wizard undo” within ten minutes if you want me to restore the area.`,
    8,
  ), 20);
}

async function buildCommandLesson(player, id) {
  const lesson = commandLesson(id);
  if (!lesson) {
    speak(player, "I don’t have that command-block lesson.");
    return;
  }
  if (buildInProgress) {
    queueBuild(player, (current) => buildCommandLesson(current, id));
    return;
  }
  let dimension = player.dimension;
  let forward = cardinalDirection(player);
  let right = { x: -forward.z, z: forward.x };
  let base = findClearSite(player, forward, right);
  if (!base && await prepareBuildWorkshop(player)) {
    dimension = player.dimension;
    forward = cardinalDirection(player);
    right = { x: -forward.z, z: forward.x };
    base = findClearSite(player, forward, right);
  }
  if (!base) {
    speak(player, "I couldn’t prepare a safe command workshop, so I stopped before placing anything.");
    return;
  }
  if (!bringWizardTo(player)) {
    speak(player, "My player body is unavailable, so I won’t pretend to place the command block.");
    return;
  }
  buildInProgress = true;
  const token = ++nextBuildToken;
  activeBuildToken = token;
  const commandBlock = offset(base, forward, right, 0);
  const button = offset(commandBlock, forward, right, 0, 0, 1);
  const steps = [
    () => placeAsWizard(
      dimension,
      "minecraft:command_block",
      offset(commandBlock, forward, right, 0, 0, -1),
      commandBlock,
      "minecraft:command_block",
    ),
    () => placeAsWizard(
      dimension,
      "minecraft:stone_button",
      commandBlock,
      button,
      "minecraft:stone_button",
    ),
  ];
  const expectedBlocks = [
    { location: commandBlock, typeId: "minecraft:command_block" },
    { location: button, typeId: "minecraft:stone_button" },
  ];
  speak(player, `I’ll place the hardware for “${lesson.title}”. Bedrock does not let my script safely type novel command text, so you will paste one short command yourself.`);
  system.runTimeout(() => runBuildSteps(
    player.id,
    token,
    dimension,
    steps,
    expectedBlocks,
    `Lesson ready. Open the command block and paste: ${lesson.command} Set it to Impulse, Unconditional, Needs Redstone, then press the button. ${lesson.explanation}`,
    10,
  ), 20);
}

function findCalculatorSite(player, forward, right) {
  const origin = {
    x: Math.floor(player.location.x) + forward.x * 18 - right.x * 5,
    y: standingBlockY(player.location),
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

async function buildRedstoneCalculator(player) {
  console.warn("[MC Wizard] calculator build requested by " + player.name);
  const previousBuild = lastBuildTick.get(player.id) || -Infinity;
  if (system.currentTick - previousBuild < 200) {
    queueBuild(
      player,
      buildRedstoneCalculator,
      200 - (system.currentTick - previousBuild),
      "I queued that calculator and will start it in a few seconds.",
    );
    return;
  }
  if (buildInProgress) {
    queueBuild(player, buildRedstoneCalculator);
    return;
  }

  let dimension = player.dimension;
  let forward = cardinalDirection(player);
  console.warn("[MC Wizard] calculator facing " + forward.name);
  let right = { x: -forward.z, z: forward.x };
  let origin = findCalculatorSite(player, forward, right);
  if (!origin && await prepareBuildWorkshop(player)) {
    dimension = player.dimension;
    forward = cardinalDirection(player);
    right = { x: -forward.z, z: forward.x };
    origin = findCalculatorSite(player, forward, right);
  }
  if (!origin) {
    console.warn("[MC Wizard] no clear calculator site near " + player.name);
    speak(player, "I couldn’t prepare a safe calculator workshop, so I stopped before placing anything.");
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

  const orderedPlacements = playerAccessibleCalculatorOrder(blueprint.placements);
  const steps = orderedPlacements.map((placement) => {
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
    const plannedSupport = calculatorLocation(origin, forward, right, placement.support);
    return () => {
      const support = playerCopyableCalculatorSupport(
        dimension,
        placement.itemId,
        target,
        plannedSupport,
      );
      return placeAsWizard(
        dimension,
        placement.itemId,
        support,
        target,
        placement.expectedType,
        undefined,
        directionFromSupport(support, target),
      );
    };
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
      variable("mc_wizard_e2e", false) === true ? 8 : 12,
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
  console.warn("[MC Wizard] applying response action=" + (payload.action
    ? `${payload.action.type}:${payload.action.id || payload.action.plan?.title || "unnamed"}`
    : "none"));
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
  } else if (action?.type === "build_plan" && action.version === 1) {
    buildValidatedPlan(player, action.plan);
  } else if (action?.type === "command_lesson" && action.version === 1) {
    buildCommandLesson(player, action.id);
  }
}

async function askBackend(playerId, question, mode = "wizard") {
  const player = playerById(playerId);
  if (!player) return;
  const key = `${playerId}:${mode}`;
  const token = ++nextQuestionToken;
  pendingQuestions.set(key, token);
  if (mode === "general") player.sendMessage("§b[AI]§r Thinking…");
  else {
    bringWizardTo(player);
    const acknowledgements = [
      "Hmm—one moment.",
      "I’m checking that carefully.",
      "Give me a moment to work that out.",
    ];
    for (const [ticks, message] of [
      [80, acknowledgements[token % acknowledgements.length]],
      [240, "Still working—I’m staying with it."],
    ]) {
      system.runTimeout(() => {
        if (pendingQuestions.get(key) !== token) return;
        const current = playerById(playerId);
        if (current) speak(current, message);
      }, ticks);
    }
  }

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
    system.run(() => {
      if (pendingQuestions.get(key) !== token) {
        console.warn(`[MC Wizard] discarded stale ${mode} response for ${player.name}`);
        return;
      }
      pendingQuestions.delete(key);
      applyResponse(playerId, payload, question);
    });
  } catch (error) {
    console.warn(`[MC Wizard] ${error}`);
    system.run(() => {
      if (pendingQuestions.get(key) !== token) return;
      pendingQuestions.delete(key);
      const current = playerById(playerId);
      if (!current) return;
      if (mode === "general") current.sendMessage("§b[AI]§r I can’t reach the model right now.");
      else speak(current, "I can’t reach my knowledge service right now. Ask an adult to check the MC Wizard server.");
    });
  }
}

function cancelPendingQuestion(player, mode = "wizard") {
  pendingQuestions.delete(`${player.id}:${mode}`);
}

async function clearBackendSession(playerName, mode) {
  try {
    const request = new HttpRequest(WIZARD_URL.replace(/\/v1\/ask(?:\?.*)?$/, "/v1/session"))
      .setMethod(HttpRequestMethod.Delete)
      .setBody(JSON.stringify({ player: playerName, mode }))
      .addHeader("Content-Type", "application/json");
    if (AUTHORIZATION) request.addHeader("Authorization", AUTHORIZATION);
    await http.request(request);
  } catch (error) {
    console.warn(`[MC Wizard] could not clear ${mode} session for ${playerName}: ${error}`);
  }
}

function handleLocalCommand(player, question) {
  const simple = question.trim();
  if (/^(?:hi|hello|hey|hiya|yo)(?:\s+(?:wiz|wizard))?[!.?]*$/i.test(simple)) {
    cancelPendingQuestion(player);
    speak(player, "Hi! I’m right here. What should we build or learn today?");
    return true;
  }
  if (/^(?:are you ready|you ready|ready)(?:\s+(?:wiz|wizard))?[!.?]*$/i.test(simple)) {
    cancelPendingQuestion(player);
    speak(player, "Ready! Tell me what you want to try, and I’ll start with you.");
    return true;
  }
  if (/^(?:thanks|thank you|thx)(?:\s+(?:wiz|wizard))?[!.?]*$/i.test(simple)) {
    cancelPendingQuestion(player);
    speak(player, "You’re welcome! I’m ready for the next idea.");
    return true;
  }
  if (/\b(?:tell me (?:a )?joke|minecraft joke)\b/i.test(simple)) {
    cancelPendingQuestion(player);
    speak(player, "Why did the creeper cross the road? To get to the other ssssside!");
    return true;
  }
  const smallTalk = worldSmallTalk(player, simple);
  if (smallTalk) {
    cancelPendingQuestion(player);
    speak(player, smallTalk);
    return true;
  }
  if (/^(?:undo|undo (?:my |the )?last build)(?: please)?[.!]?$/i.test(question)) {
    undoLastBuild(player);
    return true;
  }
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
      cancelPendingQuestion(player);
      void clearBackendSession(player.name, "wizard");
      void clearBackendSession(player.name, "general");
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
    if (activeBuildToken !== undefined) rollbackTransaction(activeBuildToken);
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
    } else if (!moveWizardBeside(wizard, player)) idleLookAround(player);
  } catch (error) {
    console.warn(`[MC Wizard] follow loop failed: ${error}`);
  }
}, 80);

world.afterEvents.worldLoad.subscribe(() => {
  recoverInterruptedTransaction();
  console.warn(`[MC Wizard] ready; brain=${WIZARD_URL}`);
  if (variable("mc_wizard_e2e", false) === true) {
    system.runTimeout(() => startE2E({
      routeAddressedMessage,
      engineAddressedMessageCount: (playerId) => engineAddressedMessageCounts.get(playerId) || 0,
      undoLastBuild,
      hasCommittedBuild: (playerId) => lastUndo.has(playerId),
      buildValidatedPlan,
      prepareBuildWorkshop,
      deliverTestBook: (player) => deliverModelAnswer(player, {
        label: "E2E",
        answer: "# Redstone guide\n\n" + "Use repeaters to control timing, comparators to measure signals, and lamps to make output easy to read. ".repeat(12),
      }, "redstone guide"),
    }), 20);
  }
});
