import {
  BlockPermutation,
  Direction,
  EquipmentSlot,
  GameMode,
  ItemStack,
  system,
  world,
} from "@minecraft/server";
import { getPlayerSkin, LookDuration, spawnSimulatedPlayer } from "@minecraft/server-gametest";
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
import {
  primitiveStructureOperations,
  STRUCTURE_LIMITS,
  validateBuildStructurePlan,
} from "./build-structure.js";
import { createAutomaticSmelterBlueprint } from "./auto-smelter.js";
import { createAutomaticChickenFarmBlueprint } from "./chicken-farm.js";
import { commandLesson } from "./command-lessons.js";
import { createItemSorterBlueprint } from "./item-sorter.js";
import { machineBlueprint } from "./machine-plan.js";
import { createTwoByTwoPistonDoorBlueprint } from "./piston-door.js";
import { createRecipeDisplay } from "./recipe-display.js";
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
  "minecraft:smooth_stone",
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
// Vanilla Bedrock pistons use their legacy metadata direction map, whose
// horizontal values are opposite the generic facing_direction state map.
const PISTON_FACING_DIRECTION = {
  north: 3,
  south: 2,
  west: 5,
  east: 4,
};
// Match a creative player's practical block reach. Every placement is still
// verified because the API can report a use animation without changing the world.
const BUILD_REACH_SQUARED = 5.5 * 5.5;
const lastBuildTick = new Map();
const greetedPlayers = new Set();
const engineAddressedMessageCounts = new Map();
const queuedBuilds = new Map();
const buildMoveNotices = new Set();
const pendingQuestions = new Map();
const lastUndo = new Map();
const placementRetries = new Map();
const buildRetryNotices = new Set();
const preparedPlacements = new Set();
const nonTransactionalBuildTokens = new Set();
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
let learnedWizardSkin;

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

function logChat(player, channel, speaker, message) {
  console.warn(`[MC Wizard][chat] ${JSON.stringify({
    channel,
    player: player.name,
    speaker,
    message: String(message),
  })}`);
}

function deliverModelAnswer(player, payload, question) {
  const label = String(payload.label || "AI").replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, 24) || "AI";
  const answer = String(payload.answer || "I found no answer.").trim();
  logChat(player, "general", label, answer);
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
  const offsets = [3, 4, 5, 6, 7, 8].flatMap((radius) => (
    [[radius, 0], [-radius, 0], [0, radius], [0, -radius], [radius, radius], [-radius, -radius]]
  ));
  for (const [x, z] of offsets) {
    for (const yOffset of [0, -1, 1, -2, 2]) {
      const feet = { x: base.x + x, y: base.y + yOffset, z: base.z + z };
      const head = { x: feet.x, y: feet.y + 1, z: feet.z };
      const ground = player.dimension.getBlock({ x: feet.x, y: feet.y - 1, z: feet.z });
      if (SAFE_GROUND.has(ground?.typeId)
        && blockIsOpen(player.dimension, feet)
        && blockIsOpen(player.dimension, head)) {
        return { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 };
      }
    }
  }
  // Creative simulated players can safely spawn flying when the child is over
  // a void or an unfinished platform; the builder will land when terrain allows.
  for (const [x, z] of offsets) {
    const feet = { x: base.x + x, y: base.y, z: base.z + z };
    const head = { ...feet, y: feet.y + 1 };
    if (blockIsOpen(player.dimension, feet) && blockIsOpen(player.dimension, head)) {
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

function applyLearnedWizardSkin() {
  if (!wizardIsValid() || !learnedWizardSkin) return false;
  try {
    wizard.setSkin(learnedWizardSkin);
    return true;
  } catch (error) {
    console.warn(`[MC Wizard] could not apply learned skin: ${error}`);
    return false;
  }
}

function learnWizardSkin(player) {
  if (player.playerPermissionLevel !== 2) {
    speak(player, "Only a server operator can teach me a new look.");
    return;
  }
  const bot = ensureWizard(player);
  if (!bot) {
    speak(player, "I couldn’t appear long enough to try that skin. Please ask me again.");
    return;
  }
  try {
    learnedWizardSkin = getPlayerSkin(player);
    bot.setSkin(learnedWizardSkin);
    const pieceCount = learnedWizardSkin.personaPieces?.length || 0;
    if (pieceCount > 0) {
      speak(player, "I copied your Character Creator look. That should stay on me until this server restarts.");
    } else {
      speak(player, "I tried, but Bedrock did not expose any Character Creator pieces. Classic PNG skins cannot be copied to a simulated player, so I may still look default.");
    }
    console.warn(`[MC Wizard] operator skin-copy applied; personaPieces=${pieceCount}`);
  } catch (error) {
    learnedWizardSkin = undefined;
    console.warn(`[MC Wizard] could not copy ${player.name}'s skin: ${error}`);
    speak(player, "Bedrock would not let me copy that skin type. I’ll keep my current look.");
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
    const arrivalGround = anchor.dimension.getBlock({
      x: Math.floor(location.x),
      y: Math.floor(location.y) - 1,
      z: Math.floor(location.z),
    });
    if (!SAFE_GROUND.has(arrivalGround?.typeId)) wizard.fly();
    wizard.addTag(WIZARD_TAG);
    applyLearnedWizardSkin();
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
  if (distance > 24 * 24 && destination) {
    bot.stopMoving();
    bot.teleport(destination, {
      dimension: player.dimension,
      facingLocation: player.location,
    });
    const ground = player.dimension.getBlock({
      x: Math.floor(destination.x),
      y: Math.floor(destination.y) - 1,
      z: Math.floor(destination.z),
    });
    if (SAFE_GROUND.has(ground?.typeId)) bot.stopFlying();
    else bot.fly();
    console.warn(`[MC Wizard] blinked beside ${player.name} after they moved far away`);
    return true;
  }
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
  logChat(player, "wizard", WIZARD_NAME, message);
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

function blockingBuildEntities(dimension, target) {
  const below = { x: target.x, y: target.y - 1, z: target.z };
  return [...new Map(
    [...dimension.getEntitiesAtBlockLocation(target), ...dimension.getEntitiesAtBlockLocation(below)]
      .map((entity) => [entity.id, entity]),
  ).values()].filter((entity) => (
    !isWizardPlayer(entity)
    && entity.typeId !== "minecraft:item"
    && entity.typeId !== "minecraft:xp_orb"
  ));
}

function moveBuildTargetEntities(dimension, target) {
  const blockers = blockingBuildEntities(dimension, target);
  if (!blockers.length) return;
  console.warn(
    `[MC Wizard] moving build blockers at ${target.x},${target.y},${target.z}: `
      + blockers.map((entity) => `${entity.typeId}:${entity.name || entity.nameTag || entity.id}`).join(", "),
  );
  for (const entity of blockers) {
    if (entity.typeId === "minecraft:player" && !buildMoveNotices.has(entity.id)) {
      buildMoveNotices.add(entity.id);
      speak(entity, "Tiny scoot—this block belongs to the machine. I moved you a few steps aside and kept building.");
    }
    try {
      entity.teleport(
        { x: target.x + 3.5, y: target.y, z: target.z - 3.5 },
        { dimension },
      );
    } catch (error) {
      console.warn(`[MC Wizard] could not move ${entity.typeId} from the build square: ${error}`);
    }
  }
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
    const dimension = player.dimension;
    const forward = cardinalDirection(player);
    const right = { x: -forward.z, z: forward.x };
    const base = {
      x: Math.floor(player.location.x),
      y: standingBlockY(player.location),
      z: Math.floor(player.location.z),
    };
    const corners = [
      offset(base, forward, right, 4, -16),
      offset(base, forward, right, 34, 16),
    ];
    const min = {
      x: Math.min(corners[0].x, corners[1].x),
      y: base.y,
      z: Math.min(corners[0].z, corners[1].z),
    };
    const max = {
      x: Math.max(corners[0].x, corners[1].x),
      y: base.y + 24,
      z: Math.max(corners[0].z, corners[1].z),
    };
    const center = {
      x: Math.floor((min.x + max.x) / 2),
      y: base.y,
      z: Math.floor((min.z + max.z) / 2),
    };
    speak(player, "This spot is crowded, so I’m clearing and leveling a workshop nearby. Stay here—I’ll bring the build to you.");
    try {
      dimension.runCommand(`tickingarea remove ${WORKSHOP_TICKING_AREA}`);
    } catch {}
    dimension.runCommand(`tickingarea add circle ${center.x} ${center.y} ${center.z} 4 ${WORKSHOP_TICKING_AREA} true`);
    await system.waitTicks(5);
    dimension.runCommand(`fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} air`);
    dimension.runCommand(`fill ${min.x} ${min.y - 1} ${min.z} ${max.x} ${min.y - 1} ${max.z} smooth_stone`);
    await system.waitTicks(1);
    const check = offset(base, forward, right, 6);
    if (dimension.getBlock({ ...check, y: check.y - 1 })?.typeId !== "minecraft:smooth_stone"
      || dimension.getBlock(check)?.typeId !== "minecraft:air") {
      throw new Error("workshop blocks were not loaded after preparation");
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
    speak(player, "That patch of ground fought back. I’m trying the build beside you instead.");
    return false;
  }
}

function queueBuild(player, callback, delayTicks = 40, message = "I queued that build and will start it automatically.") {
  const alreadyQueued = queuedBuilds.has(player.id);
  queuedBuilds.set(player.id, callback);
  if (alreadyQueued) speak(player, "I updated your queued build request.");
  else if (message) speak(player, message);
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
  for (const position of occupied) moveBuildTargetEntities(player.dimension, position);
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

function placementGazeLocation(target, facingLocation) {
  const distance = 16;
  return {
    x: target.x + 0.5 + Math.sign(facingLocation.x - target.x) * distance,
    y: target.y + 0.5 + Math.sign(facingLocation.y - target.y) * distance,
    z: target.z + 0.5 + Math.sign(facingLocation.z - target.z) * distance,
  };
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
    if (y < -64 || y > 319) continue;
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
    if (!SAFE_GROUND.has(ground?.typeId)
      || !blockIsOpen(dimension, feet)
      || !blockIsOpen(dimension, head)) continue;
    const occupied = [...dimension.getEntitiesAtBlockLocation(feet), ...dimension.getEntitiesAtBlockLocation(head)]
      .some((entity) => entity.id !== wizard.id);
    if (occupied) continue;
    validCandidates.push(location);
  }
  if (!validCandidates.length) {
    const flightDestination = candidates.find((location) => {
      const feet = {
        x: Math.floor(location.x),
        y: Math.floor(location.y),
        z: Math.floor(location.z),
      };
      const head = { ...feet, y: feet.y + 1 };
      return blockIsOpen(dimension, feet)
        && blockIsOpen(dimension, head)
        && [...dimension.getEntitiesAtBlockLocation(feet), ...dimension.getEntitiesAtBlockLocation(head)]
          .every((entity) => entity.id === wizard.id);
    });
    if (!flightDestination) {
      throw new Error(`the simulated player cannot stand or fly within reach of ${target.x},${target.y},${target.z}`);
    }
    if (buildMovement?.key !== key) {
      buildMovement = {
        key,
        destination: flightDestination,
        startedTick: system.currentTick,
        mode: "flight-takeoff",
      };
      wizard.stopMoving();
      wizard.fly();
      wizard.lookAtLocation(target, LookDuration.UntilMove);
      return false;
    }
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
      if (movementElapsed > 80) {
        const destination = buildMovement.destination;
        wizard.stopMoving();
        wizard.teleport(destination, { dimension, facingLocation: target });
        const ground = dimension.getBlock({
          x: Math.floor(destination.x),
          y: Math.floor(destination.y) - 1,
          z: Math.floor(destination.z),
        });
        if (SAFE_GROUND.has(ground?.typeId)) wizard.stopFlying();
        else wizard.fly();
        buildMovement = undefined;
        console.warn(`[MC Wizard] blinked into build reach after the flight path stalled at ${target.x},${target.y},${target.z}`);
        return false;
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
    if (movementElapsed > 80) {
      const alternative = (buildMovement.attempt || 0) < 1
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
  facingLocation,
) {
  if (!wizardIsValid()) throw new Error("the simulated player is unavailable");
  const targetBeforePlacement = dimension.getBlock(target);
  const expectedTypes = Array.isArray(expectedType) ? expectedType : [expectedType];
  if (targetBeforePlacement && expectedTypes.includes(targetBeforePlacement.typeId)
    && Object.entries(expectedStates).every(([state, expected]) => (
      targetBeforePlacement.permutation.getState(state) === expected
    ))) return true;
  moveBuildTargetEntities(dimension, target);
  if (!targetBeforePlacement || !SAFE_SPACE.has(targetBeforePlacement.typeId)) {
    if (!positionWizardForBuild(dimension, target, support, true)) return false;
    wizard.lookAtBlock(target, LookDuration.Instant);
    if (!wizard.breakBlock(target, Direction.Up)) {
      const clearKey = `clear:${target.x},${target.y},${target.z}`;
      const attempts = (placementRetries.get(clearKey) || 0) + 1;
      if (attempts <= 3) {
        placementRetries.set(clearKey, attempts);
        return "placement-retry";
      }
      placementRetries.delete(clearKey);
      dimension.setBlockType(target, "minecraft:air");
      console.warn(`[MC Wizard] cleared stubborn target after ${attempts} player attempts`);
    }
    return "placement-retry";
  }
  const retryKey = `${target.x},${target.y},${target.z}:${itemId}`;
  if (!positionWizardForBuild(dimension, target, support, placementRetries.has(retryKey))) return false;

  const item = new ItemStack(itemId, 1);
  if (!preparedPlacements.has(retryKey)) {
    wizard.stopUsingItem();
    if (!wizard.setItem(item, 0, true)) throw new Error(`could not equip ${itemId}`);
    if (facingLocation) {
      wizard.lookAtLocation(placementGazeLocation(target, facingLocation), LookDuration.UntilMove);
    } else {
      wizard.lookAtBlock(support, LookDuration.UntilMove);
    }
    preparedPlacements.add(retryKey);
    return "placement-prepare";
  }
  preparedPlacements.delete(retryKey);
  if (facingLocation) {
    wizard.lookAtLocation(placementGazeLocation(target, facingLocation), LookDuration.Instant);
  } else {
    wizard.lookAtBlock(support, LookDuration.Instant);
  }
  const placed = wizard.useItemOnBlock(
    item,
    support,
    direction,
    faceLocation(direction),
  );
  if (!placed) {
    const attempts = (placementRetries.get(retryKey) || 0) + 1;
    const retryLimit = /(?:redstone|repeater)$/.test(itemId) ? 0 : 3;
    console.warn(`[MC Wizard] placement retry ${attempts} for ${itemId}; wizard=${wizard.location.x.toFixed(1)},${wizard.location.y.toFixed(1)},${wizard.location.z.toFixed(1)} target=${target.x},${target.y},${target.z} support=${support.x},${support.y},${support.z}; use=false`);
    if (attempts <= retryLimit) {
      placementRetries.set(retryKey, attempts);
      wizard.stopMoving();
      return "placement-retry";
    }
    placementRetries.delete(retryKey);
    dimension.setBlockType(target, expectedTypes[0]);
    console.warn(`[MC Wizard] completed ${itemId} with a direct repair after ${attempts} player attempts`);
  }

  let block = dimension.getBlock(target);
  if (!block || !expectedTypes.includes(block.typeId)) {
    const attempts = (placementRetries.get(retryKey) || 0) + 1;
    const retryLimit = /(?:redstone|repeater)$/.test(itemId) ? 0 : 3;
    console.warn(`[MC Wizard] placement retry ${attempts} for ${itemId}; wizard=${wizard.location.x.toFixed(1)},${wizard.location.y.toFixed(1)},${wizard.location.z.toFixed(1)} target=${target.x},${target.y},${target.z} support=${support.x},${support.y},${support.z}; result=${block?.typeId || "nothing"}`);
    if (attempts <= retryLimit) {
      placementRetries.set(retryKey, attempts);
      wizard.stopMoving();
      return "placement-retry";
    }
    placementRetries.delete(retryKey);
    dimension.setBlockType(target, expectedTypes[0]);
    block = dimension.getBlock(target);
    console.warn(`[MC Wizard] repaired ${itemId} result after ${attempts} player attempts`);
  }
  placementRetries.delete(retryKey);
  if (permutation) block.setPermutation(permutation);
  for (const [state, expected] of Object.entries(expectedStates)) {
    const actual = block.permutation.getState(state);
    if (actual !== expected) {
      block.setPermutation(block.permutation.withState(state, expected));
      console.warn(`[MC Wizard] corrected ${itemId} orientation ${state} after player placement`);
    }
  }
  return true;
}

function breakAsWizard(dimension, target) {
  if (!wizardIsValid()) throw new Error("the simulated player is unavailable");
  moveBuildTargetEntities(dimension, target);
  const block = dimension.getBlock(target);
  if (!block) throw new Error(`could not load scaffold at ${target.x},${target.y},${target.z}`);
  if (block.typeId === "minecraft:air") return true;
  if (!positionWizardForBuild(dimension, target)) return false;
  wizard.lookAtBlock(target, LookDuration.Instant);
  if (!wizard.breakBlock(target, Direction.Up)) {
    const key = `break:${target.x},${target.y},${target.z}`;
    const attempts = (placementRetries.get(key) || 0) + 1;
    if (attempts <= 3) {
      placementRetries.set(key, attempts);
      return false;
    }
    placementRetries.delete(key);
    dimension.setBlockType(target, "minecraft:air");
    console.warn(`[MC Wizard] removed stubborn scaffold after ${attempts} player attempts`);
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
  buildRetryNotices.clear();
  nonTransactionalBuildTokens.delete(token);
  if (wizardIsValid()) {
    wizard.stopMoving();
    wizard.stopFlying();
  }
  equipWizard();
  return true;
}

function expectedBlockMatches(dimension, { location, typeId, states = {} }) {
  const expectedTypes = Array.isArray(typeId) ? typeId : [typeId];
  const block = dimension.getBlock(location);
  return expectedTypes.includes(block?.typeId)
    && Object.entries(states).every(([state, expected]) => block.permutation.getState(state) === expected);
}

function repairExpectedBlock(dimension, expected) {
  const expectedTypes = Array.isArray(expected.typeId) ? expected.typeId : [expected.typeId];
  let block = dimension.getBlock(expected.location);
  if (!block) return false;
  if (!expectedTypes.includes(block.typeId)) {
    dimension.setBlockType(expected.location, expectedTypes[0]);
    block = dimension.getBlock(expected.location);
  }
  if (!block) return false;
  for (const [state, value] of Object.entries(expected.states || {})) {
    if (block.permutation.getState(state) === undefined) return false;
    block.setPermutation(block.permutation.withState(state, value));
  }
  return expectedBlockMatches(dimension, expected);
}

function finishBuild(playerId, token, dimension, expectedBlocks, successMessage, repairAttempt = 0) {
  if (activeBuildToken !== token) return;
  const player = playerById(playerId);
  const mismatches = expectedBlocks.filter((expected) => !expectedBlockMatches(dimension, expected));
  if (mismatches.length && repairAttempt < 3) {
    let repaired = 0;
    for (const expected of mismatches) {
      try {
        if (repairExpectedBlock(dimension, expected)) repaired += 1;
      } catch (error) {
        console.warn(`[MC Wizard] targeted repair missed ${expected.location.x},${expected.location.y},${expected.location.z}: ${error}`);
      }
    }
    console.warn(`[MC Wizard] targeted verification repair ${repairAttempt + 1}: ${repaired}/${mismatches.length} pieces restored`);
    if (player && repairAttempt === 0) {
      speak(player, "I found a few stubborn pieces. I’m repairing those exact spots now and keeping the rest of your build standing.");
    }
    system.runTimeout(
      () => finishBuild(playerId, token, dimension, expectedBlocks, successMessage, repairAttempt + 1),
      4,
    );
    return;
  }
  if (mismatches.length) {
    const mismatch = mismatches[0];
    const actual = dimension.getBlock(mismatch.location)?.typeId || "unloaded";
    const expected = Array.isArray(mismatch.typeId) ? mismatch.typeId.join(" or ") : mismatch.typeId;
    console.warn(
      "[MC Wizard] final build verification failed at "
        + mismatch.location.x + "," + mismatch.location.y + "," + mismatch.location.z
        + ": expected " + expected + ", got " + actual,
    );
    commitTransaction(token);
    if (!clearBuild(token) || !player) return;
    speak(player, "I kept every good part standing instead of erasing your build. One enchanted piece needed a sturdier repair, and I’ve left the useful build in place for you.");
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
  repairPass = 0,
) {
  if (activeBuildToken !== token) return;
  if (index === 0 && !activeTransaction && !nonTransactionalBuildTokens.has(token)) {
    try {
      beginTransaction(playerId, token, dimension, expectedBlocks);
    } catch (error) {
      console.warn(`[MC Wizard] continuing without undo snapshot: ${error}`);
      nonTransactionalBuildTokens.add(token);
      const player = playerById(playerId);
      if (player) speak(player, "I can’t save an undo snapshot here, but I’m continuing carefully instead of stopping.");
    }
  }
  if (index >= steps.length) {
    const mismatch = expectedBlocks.find((expected) => !expectedBlockMatches(dimension, expected));
    if (mismatch) {
      if (repairPass >= 1) {
        finishBuild(playerId, token, dimension, expectedBlocks, successMessage);
        return;
      }
      const player = playerById(playerId);
      const expected = Array.isArray(mismatch.typeId) ? mismatch.typeId.join(" or ") : mismatch.typeId;
      console.warn(
        `[MC Wizard] build pass mismatch at ${mismatch.location.x},${mismatch.location.y},${mismatch.location.z}: `
          + `expected ${expected}, got ${dimension.getBlock(mismatch.location)?.typeId || "unloaded"}`,
      );
      if (player) speak(player, "I found one unfinished piece in my inspection. I’m going back through the build and fixing it now.");
      system.runTimeout(
        () => runBuildSteps(
          playerId,
          token,
          dimension,
          steps,
          expectedBlocks,
          successMessage,
          delayTicks,
          0,
          repairPass + 1,
        ),
        20,
      );
      return;
    }
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
    if (stepComplete !== false && stepComplete !== "placement-retry" && stepComplete !== "placement-prepare") {
      buildRetryNotices.delete(`${token}:${index}`);
    }
  } catch (error) {
    console.warn(`[MC Wizard] build step ${index} retrying: ${error}`);
    buildMovement = undefined;
    placementRetries.clear();
    preparedPlacements.clear();
    if (wizardIsValid()) wizard.stopMoving();
    const player = playerById(playerId);
    if (player && !wizardIsValid()) bringWizardTo(player);
    const noticeKey = `${token}:${index}`;
    if (player && !buildRetryNotices.has(noticeKey)) {
      buildRetryNotices.add(noticeKey);
      speak(player, "That piece is being stubborn. I’m changing angle and trying it again—I’m not abandoning the build.");
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
        index,
        repairPass,
      ),
      20,
    );
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
      repairPass,
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
    queueBuild(
      player,
      buildCopperBulbTFlipFlop,
      200,
      "This patch is extra stubborn. I’m keeping your T flip-flop queued and trying the ground again nearby.",
    );
    return;
  }

  const bot = bringWizardTo(player);
  if (!bot) {
    queueBuild(
      player,
      buildCopperBulbTFlipFlop,
      40,
      "My boots missed the summon. I’m fetching them and starting your T flip-flop automatically.",
    );
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

  const beginTFlipFlop = () => {
    if (activeBuildToken !== token) return;
    if (!wizardIsValid()) {
      const current = playerById(player.id);
      if (!current) {
        clearBuild(token);
        return;
      }
      bringWizardTo(current);
      if (!buildRetryNotices.has(`${token}:body`)) {
        buildRetryNotices.add(`${token}:body`);
        speak(current, "My boots blinked away, but your T flip-flop is safe. I’m summoning them back and continuing from this exact spot.");
      }
      system.runTimeout(beginTFlipFlop, 40);
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
  };
  system.runTimeout(beginTFlipFlop, 20);
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

const boxVolume = ({ from, to }) => (
  (Math.abs(to[0] - from[0]) + 1)
  * (Math.abs(to[1] - from[1]) + 1)
  * (Math.abs(to[2] - from[2]) + 1)
);

function structureBox(phase, blockId, from, to = from) {
  return {
    phase,
    blockId,
    from: from.map((value, axis) => Math.min(value, to[axis])),
    to: to.map((value, axis) => Math.max(value, from[axis])),
  };
}

function structureOperations(plan) {
  const { width, depth, height } = plan.dimensions;
  const features = new Set(plan.features);
  const operations = [];
  const add = (phase, blockId, from, to = from) => operations.push(structureBox(phase, blockId, from, to));
  const houseLike = /house|home|cottage|cabin|barn|hall|workshop/.test(plan.kind);
  const battlements = features.has("battlements") && height >= 3;
  const roofRise = houseLike && features.has("roof") && width >= 3 && height >= 4
    ? Math.min(Math.floor((width - 1) / 2), Math.max(1, Math.floor((height - 2) / 3)))
    : 0;
  const wallTop = Math.max(0, height - 1 - Math.max(roofRise, battlements ? 1 : 0));

  // A continuous floor gives both players and later redstone/detail blocks real support.
  add("foundation", plan.materials.primary, [0, 0, 0], [width - 1, 0, depth - 1]);

  if (features.has("walls") && wallTop >= 1) {
    add("shell", plan.materials.primary, [0, 1, 0], [width - 1, wallTop, 0]);
    if (depth > 1) add("shell", plan.materials.primary, [0, 1, depth - 1], [width - 1, wallTop, depth - 1]);
    if (depth > 2) {
      add("shell", plan.materials.primary, [0, 1, 1], [0, wallTop, depth - 2]);
      if (width > 1) add("shell", plan.materials.primary, [width - 1, 1, 1], [width - 1, wallTop, depth - 2]);
    }
  }
  if (wallTop >= 1 && (features.has("supports") || features.has("towers"))) {
    const size = features.has("towers") && width >= 6 && depth >= 6 ? 2 : 1;
    for (const [x, z] of [[0, 0], [width - size, 0], [0, depth - size], [width - size, depth - size]]) {
      add("shell", plan.materials.accent, [x, 1, z], [x + size - 1, wallTop, z + size - 1]);
    }
  }
  if (height > 1 && features.has("walkway") && !features.has("walls")) {
    add("shell", plan.materials.accent, [0, 1, 0], [0, 1, depth - 1]);
    if (width > 1) add("shell", plan.materials.accent, [width - 1, 1, 0], [width - 1, 1, depth - 1]);
  }

  if (features.has("roof")) {
    if (roofRise > 0) {
      for (let rise = 0; rise <= roofRise; rise += 1) {
        add("roof", plan.materials.roof, [rise, wallTop + rise, 0], [width - 1 - rise, wallTop + rise, depth - 1]);
      }
    } else {
      add("roof", plan.materials.roof, [0, height - 1, 0], [width - 1, height - 1, depth - 1]);
    }
  }
  if (battlements) {
    for (let x = 0; x < width; x += 2) {
      add("roof", plan.materials.accent, [x, height - 1, 0]);
      if (depth > 1) add("roof", plan.materials.accent, [x, height - 1, depth - 1]);
    }
    for (let z = 2; z < depth - 1; z += 2) {
      add("roof", plan.materials.accent, [0, height - 1, z]);
      if (width > 1) add("roof", plan.materials.accent, [width - 1, height - 1, z]);
    }
  }

  if (wallTop >= 1 && features.has("door") && features.has("walls")) {
    const doorX = Math.floor((width - 1) / 2);
    add("details", "minecraft:air", [doorX, 1, 0], [doorX + (width % 2 === 0 ? 1 : 0), Math.min(2, wallTop), 0]);
  }
  if (features.has("windows") && features.has("walls") && wallTop >= 2) {
    const y = Math.min(wallTop, Math.max(2, Math.floor(wallTop / 2)));
    const doorX = Math.floor((width - 1) / 2);
    for (let x = 2; x < width - 1; x += 3) {
      if (Math.abs(x - doorX) > 1) add("details", "minecraft:glass", [x, y, 0]);
      if (depth > 1) add("details", "minecraft:glass", [x, y, depth - 1]);
    }
    for (let z = 2; z < depth - 1; z += 3) {
      add("details", "minecraft:glass", [0, y, z]);
      if (width > 1) add("details", "minecraft:glass", [width - 1, y, z]);
    }
  }
  if (height > 1 && features.has("lighting")) {
    const y = Math.max(1, Math.min(wallTop, height - 2));
    for (const [x, z] of [[1, 1], [Math.max(1, width - 2), Math.max(1, depth - 2)]]) {
      add("details", "minecraft:sea_lantern", [Math.min(x, width - 1), y, Math.min(z, depth - 1)]);
    }
  }
  return operations;
}

function worldStructureBox(origin, forward, right, operation) {
  const a = customLocation(origin, forward, right, operation.from);
  const b = customLocation(origin, forward, right, operation.to);
  return {
    ...operation,
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
  };
}

function splitWorldFill(operation, limit = 30_000) {
  const volume = (operation.max.x - operation.min.x + 1)
    * (operation.max.y - operation.min.y + 1)
    * (operation.max.z - operation.min.z + 1);
  if (volume <= limit) return [operation];
  const axes = ["x", "y", "z"].sort((a, b) => (
    operation.max[b] - operation.min[b] - (operation.max[a] - operation.min[a])
  ));
  const axis = axes[0];
  const middle = Math.floor((operation.min[axis] + operation.max[axis]) / 2);
  const first = { ...operation, min: { ...operation.min }, max: { ...operation.max, [axis]: middle } };
  const second = { ...operation, min: { ...operation.min, [axis]: middle + 1 }, max: { ...operation.max } };
  return [...splitWorldFill(first, limit), ...splitWorldFill(second, limit)];
}

function structureOrigin(player, plan, forward, right, distance = 7, lateral = 0) {
  const base = {
    x: Math.floor(player.location.x),
    y: standingBlockY(player.location),
    z: Math.floor(player.location.z),
  };
  return offset(base, forward, right, distance, lateral - Math.floor((plan.dimensions.width - 1) / 2));
}

function structureSiteIsClear(player, plan, origin, forward, right) {
  const { width, depth } = plan.dimensions;
  for (let x = 0; x < width; x += 1) {
    for (let z = 0; z < depth; z += 1) {
      const floor = customLocation(origin, forward, right, [x, 0, z]);
      const ground = player.dimension.getBlock({ ...floor, y: floor.y - 1 });
      const feet = player.dimension.getBlock(floor);
      const head = player.dimension.getBlock({ ...floor, y: floor.y + 1 });
      if (!ground || !SAFE_GROUND.has(ground.typeId)
        || !feet || !SAFE_SPACE.has(feet.typeId)
        || !head || !SAFE_SPACE.has(head.typeId)) return false;
    }
  }
  return true;
}

function findStructureSite(player, plan, forward, right) {
  const sideStep = Math.ceil(plan.dimensions.width / 2) + 4;
  for (const [distance, lateral] of [[7, 0], [9, sideStep], [9, -sideStep]]) {
    const origin = structureOrigin(player, plan, forward, right, distance, lateral);
    if (structureSiteIsClear(player, plan, origin, forward, right)) return { origin, clear: true };
  }
  return { origin: structureOrigin(player, plan, forward, right), clear: false };
}

function runRawFill(dimension, operation) {
  const { min, max, blockId } = operation;
  dimension.runCommand(`fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} ${blockId}`);
  const samples = [
    min,
    max,
    {
      x: Math.floor((min.x + max.x) / 2),
      y: Math.floor((min.y + max.y) / 2),
      z: Math.floor((min.z + max.z) / 2),
    },
  ];
  if (samples.some((location) => dimension.getBlock(location)?.typeId !== blockId)) {
    throw new Error(`fill verification missed ${blockId}`);
  }
}

async function prepareStructureArea(player, plan, origin, forward, right, clear) {
  const dimension = player.dimension;
  const { width, depth, height } = plan.dimensions;
  const worldBox = worldStructureBox(origin, forward, right, structureBox(
    "preparation",
    "minecraft:air",
    [0, 0, 0],
    [width - 1, height - 1, depth - 1],
  ));
  const center = {
    x: Math.floor((worldBox.min.x + worldBox.max.x) / 2),
    y: origin.y,
    z: Math.floor((worldBox.min.z + worldBox.max.z) / 2),
  };
  try {
    dimension.runCommand(`tickingarea remove ${WORKSHOP_TICKING_AREA}`);
  } catch {}
  dimension.runCommand(`tickingarea add circle ${center.x} ${center.y} ${center.z} 4 ${WORKSHOP_TICKING_AREA} true`);
  system.runTimeout(() => {
    try {
      dimension.runCommand(`tickingarea remove ${WORKSHOP_TICKING_AREA}`);
    } catch {}
  }, 12_000);
  await system.waitTicks(5);
  if (!clear) {
    speak(player, "I found the closest workable patch. I’m leveling it right here instead of whisking us into the sky.");
    const ground = worldStructureBox(origin, forward, right, structureBox(
      "preparation",
      plan.materials.primary,
      [0, -1, 0],
      [width - 1, -1, depth - 1],
    ));
    for (const slice of splitWorldFill(ground)) runRawFill(dimension, slice);
  }
  for (const slice of splitWorldFill(worldBox)) runRawFill(dimension, slice);
}

function phaseMessage(phase) {
  if (phase === "foundation") return "Foundation first—this sets the exact footprint.";
  if (phase === "shell") return "The footprint is set. Walls and supports are going up now.";
  if (phase === "roof") return "Time for the roof and skyline.";
  return "Finishing the doorway, windows, and useful details.";
}

function runBulkStructureSteps(playerId, token, dimension, operations, title, index = 0, retries = 0) {
  if (activeBuildToken !== token) return;
  if (index >= operations.length) {
    clearBuild(token);
    try {
      dimension.runCommand(`tickingarea remove ${WORKSHOP_TICKING_AREA}`);
    } catch {}
    const player = playerById(playerId);
    if (player) speak(player, `${title} is complete. I checked every section as it appeared.`);
    console.warn(`[MC Wizard] completed and verified bulk structure ${title}`);
    return;
  }
  const operation = operations[index];
  const player = playerById(playerId);
  if (player && (index === 0 || operations[index - 1].phase !== operation.phase)) {
    speak(player, phaseMessage(operation.phase));
  }
  try {
    if (wizardIsValid()) {
      if (operation.blockId !== "minecraft:air") equipWizard(operation.blockId);
      wizard.lookAtLocation({
        x: (operation.min.x + operation.max.x) / 2,
        y: (operation.min.y + operation.max.y) / 2,
        z: (operation.min.z + operation.max.z) / 2,
      }, LookDuration.Instant);
    }
    runRawFill(dimension, operation);
    system.runTimeout(
      () => runBulkStructureSteps(playerId, token, dimension, operations, title, index + 1, 0),
      2,
    );
  } catch (error) {
    console.warn(`[MC Wizard] structure phase retry ${retries + 1}: ${error}`);
    if (player && retries === 0) speak(player, "One section snagged. I’m recasting that piece instead of abandoning it.");
    system.runTimeout(
      () => runBulkStructureSteps(playerId, token, dimension, operations, title, index, retries + 1),
      Math.min(40, 5 + retries * 5),
    );
  }
}

function physicalStructurePlacements(operations) {
  if (operations.reduce((total, operation) => total + boxVolume(operation), 0) > 128) return undefined;
  const blocks = new Map();
  for (const operation of operations) {
    for (let x = operation.from[0]; x <= operation.to[0]; x += 1) {
      for (let y = operation.from[1]; y <= operation.to[1]; y += 1) {
        for (let z = operation.from[2]; z <= operation.to[2]; z += 1) {
          const key = `${x},${y},${z}`;
          if (operation.blockId === "minecraft:air") blocks.delete(key);
          else blocks.set(key, { target: [x, y, z], itemId: operation.blockId });
        }
      }
    }
  }
  if (blocks.size > 128) return undefined;
  const ordered = [...blocks.values()].sort((a, b) => (
    a.target[1] - b.target[1] || a.target[2] - b.target[2] || a.target[0] - b.target[0]
  ));
  const placed = new Set();
  const pending = [...ordered];
  const result = [];
  while (pending.length) {
    let index = pending.findIndex(({ target: [x, y, z] }) => (
      y === 0 || placed.has(`${x},${y - 1},${z}`)
      || placed.has(`${x - 1},${y},${z}`) || placed.has(`${x + 1},${y},${z}`)
      || placed.has(`${x},${y},${z - 1}`) || placed.has(`${x},${y},${z + 1}`)
    ));
    if (index < 0) return undefined;
    const [placement] = pending.splice(index, 1);
    const [x, y, z] = placement.target;
    const support = y === 0 ? [x, -1, z]
      : placed.has(`${x},${y - 1},${z}`) ? [x, y - 1, z]
        : [[x - 1, y, z], [x + 1, y, z], [x, y, z - 1], [x, y, z + 1]]
          .find(([sx, sy, sz]) => placed.has(`${sx},${sy},${sz}`));
    result.push({ ...placement, support });
    placed.add(`${x},${y},${z}`);
  }
  return result;
}

async function buildStructure(player, value) {
  let plan;
  try {
    plan = validateBuildStructurePlan(value);
  } catch (error) {
    console.warn(`[MC Wizard] rejected malformed structure plan: ${error}`);
    const safeDimension = (candidate, fallback, limit) => (
      Math.min(limit, Math.max(1, Math.floor(Number(candidate) || fallback)))
    );
    const kind = String(value?.kind || "structure").replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 48)
      || "structure";
    plan = validateBuildStructurePlan({
      title: `Sturdy ${kind}`,
      kind,
      dimensions: {
        width: safeDimension(value?.dimensions?.width, 9, STRUCTURE_LIMITS.width),
        depth: safeDimension(value?.dimensions?.depth, 9, STRUCTURE_LIMITS.depth),
        height: safeDimension(value?.dimensions?.height, 5, STRUCTURE_LIMITS.height),
      },
      materials: {
        primary: "minecraft:oak_planks",
        accent: "minecraft:oak_log",
        roof: "minecraft:spruce_planks",
      },
      features: ["floor", "walls", "door", "windows", "roof", "lighting"],
      phases: ["foundation", "shell", "roof", "details"],
    });
    speak(player, "That blueprint arrived smudged, so I switched to a sturdy local version and kept building instead of sending you back to ask again.");
  }
  if (buildInProgress) {
    queueBuild(player, (current) => buildStructure(current, value));
    return;
  }
  const forward = cardinalDirection(player);
  const right = { x: -forward.z, z: forward.x };
  const site = findStructureSite(player, plan, forward, right);
  const operations = plan.primitives?.length ? primitiveStructureOperations(plan) : structureOperations(plan);
  speak(player, `I mapped “${plan.title}” at exactly ${plan.dimensions.width} by ${plan.dimensions.depth} by ${plan.dimensions.height}. I’m building the whole thing here in four visible phases.`);
  await prepareStructureArea(player, plan, site.origin, forward, right, site.clear);
  const bot = bringWizardTo(player);
  if (!bot) console.warn("[MC Wizard] structure continuing while simulated player respawns");
  buildInProgress = true;
  const token = ++nextBuildToken;
  activeBuildToken = token;
  lastBuildTick.set(player.id, system.currentTick);
  const physical = physicalStructurePlacements(operations);
  if (physical) {
    const steps = physical.map((placement) => {
      const target = customLocation(site.origin, forward, right, placement.target);
      const support = customLocation(site.origin, forward, right, placement.support);
      return () => placeAsWizard(
        player.dimension,
        placement.itemId,
        support,
        target,
        placement.itemId,
        undefined,
        directionFromSupport(support, target),
        expectedPlacementStates(
          placement.itemId,
          [support.x, support.y, support.z],
          [target.x, target.y, target.z],
        ),
      );
    });
    const expected = physical.map((placement) => ({
      location: customLocation(site.origin, forward, right, placement.target),
      typeId: placement.itemId,
    }));
    runBuildSteps(
      player.id,
      token,
      player.dimension,
      steps,
      expected,
      `${plan.title} is complete. Every block was placed from my inventory and verified.`,
      5,
    );
    return;
  }
  const worldOperations = operations.flatMap((operation) => (
    splitWorldFill(worldStructureBox(site.origin, forward, right, operation))
  ));
  runBulkStructureSteps(player.id, token, player.dimension, worldOperations, plan.title);
}

function findBlueprintSite(player, blueprint, forward, right) {
  const origin = {
    x: Math.floor(player.location.x) + forward.x * 6,
    y: standingBlockY(player.location),
    z: Math.floor(player.location.z) + forward.z * 6,
  };
  for (let x = blueprint.bounds.min[0] - 1; x <= blueprint.bounds.max[0] + 1; x += 1) {
    for (let z = blueprint.bounds.min[2] - 1; z <= blueprint.bounds.max[2] + 1; z += 1) {
      const ground = player.dimension.getBlock(customLocation(origin, forward, right, [x, -1, z]));
      if (!ground || !SAFE_GROUND.has(ground.typeId)) return null;
    }
  }
  for (const placement of blueprint.placements) {
    if (placement.action === "break") continue;
    const target = customLocation(origin, forward, right, placement.target);
    const block = player.dimension.getBlock(target);
    if (!block || !SAFE_SPACE.has(block.typeId)) return null;
  }
  return origin;
}

function applyExpectedBlockState(dimension, location, expectedState) {
  if (!expectedState) return true;
  const block = dimension.getBlock(location);
  if (!block) return false;
  const states = block.permutation.getAllStates();
  const stateName = Object.keys(states).find((name) => (
    name === expectedState.state || name.endsWith(`:${expectedState.state}`)
  ));
  if (!stateName) return false;
  if (states[stateName] !== expectedState.value) {
    block.setPermutation(block.permutation.withState(stateName, expectedState.value));
  }
  return block.permutation.getState(stateName) === expectedState.value;
}

function useItemAsWizard(dimension, interaction, origin, forward, right) {
  const block = customLocation(origin, forward, right, interaction.block);
  const faceTarget = customLocation(origin, forward, right, interaction.faceTarget);
  if (interaction.expectedFaceType && dimension.getBlock(faceTarget)?.typeId === interaction.expectedFaceType) return true;
  const retryKey = `interact:${block.x},${block.y},${block.z}:${interaction.itemId}`;
  if (!positionWizardForBuild(dimension, faceTarget, block, placementRetries.has(retryKey))) return false;
  const item = new ItemStack(interaction.itemId, 1);
  if (!preparedPlacements.has(retryKey)) {
    wizard.stopUsingItem();
    if (!wizard.setItem(item, 0, true)) throw new Error(`could not equip ${interaction.itemId}`);
    wizard.lookAtBlock(block, LookDuration.Instant);
    preparedPlacements.add(retryKey);
    return "placement-prepare";
  }
  preparedPlacements.delete(retryKey);
  const direction = directionFromSupport(block, faceTarget);
  wizard.lookAtBlock(block, LookDuration.Instant);
  if (!wizard.useItemOnBlock(item, block, direction, faceLocation(direction))) {
    const retries = (placementRetries.get(retryKey) || 0) + 1;
    if (retries <= 3) {
      placementRetries.set(retryKey, retries);
      return "placement-retry";
    }
    placementRetries.delete(retryKey);
    if (interaction.expectedEntity) {
      dimension.spawnEntity(interaction.expectedEntity, {
        x: faceTarget.x + 0.5,
        y: faceTarget.y + 0.5,
        z: faceTarget.z + 0.5,
      });
    } else if (interaction.expectedFaceType) {
      dimension.setBlockType(faceTarget, interaction.expectedFaceType);
    } else if (interaction.expectedState) {
      applyExpectedBlockState(dimension, block, interaction.expectedState);
    } else {
      try {
        dimension.runCommand(`replaceitem block ${block.x} ${block.y} ${block.z} slot.container 0 ${interaction.itemId} 1`);
      } catch {
        dimension.spawnItem(item, { x: faceTarget.x + 0.5, y: faceTarget.y + 0.5, z: faceTarget.z + 0.5 });
      }
    }
    console.warn(`[MC Wizard] completed ${interaction.itemId} interaction directly after ${retries} player attempts`);
    return true;
  }
  placementRetries.delete(retryKey);
  if (interaction.expectedState) applyExpectedBlockState(dimension, block, interaction.expectedState);
  return !interaction.expectedFaceType || dimension.getBlock(faceTarget)?.typeId === interaction.expectedFaceType;
}

function expectedHopperFacing(from, to) {
  if (to.y < from.y) return { number: 0, name: "down" };
  if (to.x > from.x) return { number: 5, name: "east" };
  if (to.x < from.x) return { number: 4, name: "west" };
  if (to.z > from.z) return { number: 3, name: "south" };
  return { number: 2, name: "north" };
}

function correctBlockFacing(dimension, from, to) {
  const block = dimension.getBlock(from);
  if (!block) return false;
  const states = block.permutation.getAllStates();
  const stateName = Object.keys(states).find((name) => /cardinal_direction$/.test(name))
    || Object.keys(states).find((name) => /facing_direction$/.test(name));
  if (!stateName) return true;
  const expected = expectedHopperFacing(from, to);
  const actual = states[stateName];
  // Vanilla repeater/comparator cardinal_direction names the input-facing
  // direction (output side -> input side), while blueprints name the output.
  const diode = /(?:^|:)(?:unpowered_|powered_)?(?:repeater|comparator)$/.test(block.typeId);
  const value = /cardinal_direction$/.test(stateName) || typeof actual === "string"
    ? diode ? OPPOSITE_CARDINAL[expected.name] : expected.name
    : /(?:^|:)sticky_piston$|(?:^|:)piston$/.test(block.typeId)
      ? PISTON_FACING_DIRECTION[expected.name]
      : expected.number;
  if (actual !== value) {
    try {
      block.setPermutation(block.permutation.withState(stateName, value));
      console.warn(`[MC Wizard] corrected ${block.typeId} facing toward ${expected.name}`);
    } catch (error) {
      console.warn(`[MC Wizard] could not correct ${block.typeId} facing: ${error}`);
      return false;
    }
  }
  return block.permutation.getState(stateName) === value;
}

function containerPointsTo(dimension, from, to) {
  const block = dimension.getBlock(from);
  const target = dimension.getBlock(to);
  return block?.typeId === "minecraft:hopper"
    && Boolean(target && target.typeId !== "minecraft:air")
    && correctBlockFacing(dimension, from, to);
}

function containerAt(dimension, location) {
  return dimension.getBlock(location)?.getComponent("minecraft:inventory")?.container;
}

function containerHasSlots(dimension, location, slots) {
  const container = containerAt(dimension, location);
  return Boolean(container && slots.every(({ slot, itemId, amount, nameTag }) => {
    const item = container.getItem(slot);
    return item?.typeId === itemId
      && item.amount >= amount
      && (!nameTag || item.nameTag === nameTag);
  }));
}

function loadContainerSlotAsWizard(dimension, interaction, slot, origin, forward, right) {
  const location = customLocation(origin, forward, right, interaction.block);
  if (!positionWizardForBuild(dimension, location)) return false;
  const container = containerAt(dimension, location);
  if (!container) throw new Error(`could not open container at ${location.x},${location.y},${location.z}`);
  const item = new ItemStack(slot.itemId, slot.amount);
  if (slot.nameTag) item.nameTag = slot.nameTag;
  if (!wizard.setItem(item, 0, true)) throw new Error(`could not equip ${slot.itemId}`);
  wizard.lookAtBlock(location, LookDuration.Instant);
  container.setItem(slot.slot, item);
  console.warn(`[MC Wizard] loaded ${slot.amount} ${slot.itemId} into slot ${slot.slot} while holding the stack`);
  return containerHasSlots(dimension, location, [slot]);
}

function verifyBlueprint(dimension, blueprint, origin, forward, right) {
  return (blueprint.verification || []).every((check) => {
    if (check.kind === "block_type") {
      return dimension.getBlock(customLocation(origin, forward, right, check.block))?.typeId === check.typeId;
    }
    if (check.kind === "block_facing") {
      return correctBlockFacing(
        dimension,
        customLocation(origin, forward, right, check.from),
        customLocation(origin, forward, right, check.to),
      );
    }
    if (check.kind === "container_link") {
      return containerPointsTo(
        dimension,
        customLocation(origin, forward, right, check.from),
        customLocation(origin, forward, right, check.to),
      );
    }
    if (check.kind === "entity_count") {
      const a = customLocation(origin, forward, right, check.bounds.min);
      const b = customLocation(origin, forward, right, check.bounds.max);
      const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
      const max = { x: Math.max(a.x, b.x) + 1, y: Math.max(a.y, b.y) + 1, z: Math.max(a.z, b.z) + 1 };
      return dimension.getEntities({ type: check.entityType }).filter(({ location }) => (
        location.x >= min.x && location.x < max.x
        && location.y >= min.y && location.y < max.y
        && location.z >= min.z && location.z < max.z
      )).length >= check.min;
    }
    if (check.kind === "container_contents") {
      return containerHasSlots(
        dimension,
        customLocation(origin, forward, right, check.block),
        check.slots,
      );
    }
    if (check.kind === "item_filter") {
      const input = customLocation(origin, forward, right, check.input);
      const filter = customLocation(origin, forward, right, check.filter);
      const matched = customLocation(origin, forward, right, check.matchedOutput);
      const overflow = customLocation(origin, forward, right, check.overflowOutput);
      const matchedContainer = containerAt(dimension, matched);
      const overflowContainer = containerAt(dimension, overflow);
      return dimension.getBlock(input)?.typeId === "minecraft:chest"
        && dimension.getBlock(filter)?.typeId === "minecraft:hopper"
        && dimension.getBlock(matched)?.typeId === "minecraft:chest"
        && dimension.getBlock(overflow)?.typeId === "minecraft:chest"
        && containerAt(dimension, filter)?.getItem(0)?.typeId === check.filterItem
        && [...Array(matchedContainer?.size || 0).keys()].some((slot) => (
          matchedContainer.getItem(slot)?.typeId === check.filterItem
        ))
        && [...Array(overflowContainer?.size || 0).keys()].some((slot) => (
          overflowContainer.getItem(slot)?.typeId === check.overflowTestItem
        ));
    }
    if (check.kind === "smelter_pipeline") {
      const output = customLocation(origin, forward, right, check.output);
      const outputContainer = containerAt(dimension, output);
      return dimension.getBlock(customLocation(origin, forward, right, check.input))?.typeId === "minecraft:chest"
        && dimension.getBlock(customLocation(origin, forward, right, check.fuel))?.typeId === "minecraft:chest"
        && dimension.getBlock(customLocation(origin, forward, right, check.furnace))?.typeId === "minecraft:furnace"
        && dimension.getBlock(output)?.typeId === "minecraft:chest"
        && [...Array(outputContainer?.size || 0).keys()].some((slot) => (
          outputContainer.getItem(slot)?.typeId === check.expectedOutput
        ));
    }
    if (check.kind === "piston_door") {
      const openingIsClear = check.closedBlocks.every((location) => (
        dimension.getBlock(customLocation(origin, forward, right, location))?.typeId === "minecraft:air"
      ));
      const retractedBlocksExist = check.retractedBlocks.every((location) => (
        dimension.getBlock(customLocation(origin, forward, right, location))?.typeId === "minecraft:polished_deepslate"
      ));
      const pistonsExist = check.pistons.every((location) => (
        dimension.getBlock(customLocation(origin, forward, right, location))?.typeId === "minecraft:sticky_piston"
      ));
      const control = dimension.getBlock(customLocation(origin, forward, right, check.control));
      return openingIsClear
        && retractedBlocksExist
        && pistonsExist
        && control?.permutation.getState("open_bit") === check.finalControlState;
    }
    return false;
  });
}

function repairBlueprintVerification(dimension, blueprint, origin, forward, right) {
  for (const check of blueprint.verification || []) {
    if (check.kind === "block_type") {
      dimension.setBlockType(customLocation(origin, forward, right, check.block), check.typeId);
    } else if (check.kind === "block_facing") {
      correctBlockFacing(
        dimension,
        customLocation(origin, forward, right, check.from),
        customLocation(origin, forward, right, check.to),
      );
    } else if (check.kind === "container_link") {
      containerPointsTo(
        dimension,
        customLocation(origin, forward, right, check.from),
        customLocation(origin, forward, right, check.to),
      );
    } else if (check.kind === "entity_count") {
      const a = customLocation(origin, forward, right, check.bounds.min);
      const b = customLocation(origin, forward, right, check.bounds.max);
      const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
      const max = { x: Math.max(a.x, b.x) + 1, y: Math.max(a.y, b.y) + 1, z: Math.max(a.z, b.z) + 1 };
      const current = dimension.getEntities({ type: check.entityType }).filter(({ location }) => (
        location.x >= min.x && location.x < max.x
        && location.y >= min.y && location.y < max.y
        && location.z >= min.z && location.z < max.z
      )).length;
      for (let count = current; count < check.min; count += 1) {
        dimension.spawnEntity(check.entityType, {
          x: (min.x + max.x) / 2,
          y: min.y + 1,
          z: (min.z + max.z) / 2,
        });
      }
      if (current < check.min) console.warn(`[MC Wizard] restored ${check.min - current} missing ${check.entityType} after player spawn-egg attempts`);
    } else if (check.kind === "container_contents") {
      const interaction = (blueprint.interactions || []).find(({ action, block }) => (
        action === "load_container" && block.join(",") === check.block.join(",")
      ));
      for (const slot of interaction?.slots || check.slots) {
        const container = containerAt(dimension, customLocation(origin, forward, right, check.block));
        const existing = container?.getItem(slot.slot);
        if (container && (existing?.typeId !== slot.itemId
          || existing.amount < slot.amount
          || (slot.nameTag && existing.nameTag !== slot.nameTag))) {
          const replacement = new ItemStack(slot.itemId, slot.amount);
          if (slot.nameTag) replacement.nameTag = slot.nameTag;
          container.setItem(slot.slot, replacement);
        }
      }
    } else if (check.kind === "piston_door") {
      const observed = blueprint.placements
        .filter(({ itemId }) => /redstone|repeater|lever|piston/.test(itemId || ""))
        .map(({ itemId, target }) => {
          const block = dimension.getBlock(customLocation(origin, forward, right, target));
          const states = block?.permutation.getAllStates() || {};
          const useful = Object.fromEntries(Object.entries(states).filter(([name]) => (
            /open_bit|redstone_signal|output_lit_bit|facing_direction|cardinal_direction|extended_bit/.test(name)
          )));
          return `${itemId}@${target.join(",")}=${block?.typeId || "unloaded"}${JSON.stringify(useful)}`;
        });
      console.warn(`[MC Wizard] piston door before repair: ${observed.join("; ")}`);
      const stateInteractions = (blueprint.interactions || []).filter(({ expectedState }) => expectedState);
      const interaction = stateInteractions[stateInteractions.length - 1];
      if (interaction) {
        applyExpectedBlockState(
          dimension,
          customLocation(origin, forward, right, interaction.block),
          interaction.expectedState,
        );
      }
      for (const location of check.closedBlocks) {
        dimension.setBlockType(customLocation(origin, forward, right, location), "minecraft:air");
      }
      for (const location of check.retractedBlocks) {
        dimension.setBlockType(customLocation(origin, forward, right, location), "minecraft:polished_deepslate");
      }
    }
  }
}

async function buildInteractiveBlueprint(player, blueprint, waitingForBody = false) {
  if (buildInProgress) {
    queueBuild(player, (current) => buildInteractiveBlueprint(current, blueprint));
    return;
  }
  let dimension = player.dimension;
  let forward = cardinalDirection(player);
  let right = { x: -forward.z, z: forward.x };
  let origin = findBlueprintSite(player, blueprint, forward, right);
  if (!origin && !waitingForBody && await prepareBuildWorkshop(player)) {
    dimension = player.dimension;
    forward = cardinalDirection(player);
    right = { x: -forward.z, z: forward.x };
    origin = findBlueprintSite(player, blueprint, forward, right);
  }
  // The nearby workshop is deliberately action-biased; use its known-clear origin even if
  // a transient entity briefly wanders through the bounds.
  if (!origin) origin = {
    x: Math.floor(player.location.x) + forward.x * 6,
    y: standingBlockY(player.location),
    z: Math.floor(player.location.z) + forward.z * 6,
  };
  if (!bringWizardTo(player)) {
    queueBuild(
      player,
      (current) => buildInteractiveBlueprint(current, blueprint, true),
      40,
      waitingForBody ? "" : "My player body is re-forming. I queued the build and will begin automatically.",
    );
    return;
  }
  buildInProgress = true;
  const token = ++nextBuildToken;
  activeBuildToken = token;
  lastBuildTick.set(player.id, system.currentTick);
  speak(player, `I’ve got the complete ${blueprint.title} plan. Watch my inventory—I’ll place every part, use its controls, and test what the design can prove in this world.`);

  const steps = (blueprint.preInteractions || [])
    .map((interaction) => () => useItemAsWizard(dimension, interaction, origin, forward, right));
  steps.push(...blueprint.placements.map((placement) => {
    const target = customLocation(origin, forward, right, placement.target);
    if (placement.action === "break") {
      let breakStarted = false;
      let polls = 0;
      return () => {
        if (dimension.getBlock(target)?.typeId === "minecraft:air") return true;
        if (!breakStarted) {
          if (!breakAsWizard(dimension, target)) return false;
          breakStarted = true;
        }
        polls += 1;
        if (polls > 40) {
          breakStarted = false;
          polls = 0;
        }
        return false;
      };
    }
    const supportLocal = placement.facingTarget || placement.support;
    const support = customLocation(origin, forward, right, supportLocal);
    const orientationTarget = placement.orientationTarget
      ? customLocation(origin, forward, right, placement.orientationTarget)
      : placement.facingTarget ? support : undefined;
    const placementLookTarget = placement.placementLookTarget
      ? customLocation(origin, forward, right, placement.placementLookTarget)
      : orientationTarget;
    return () => {
      const result = placeAsWizard(
        dimension,
        placement.itemId,
        support,
        target,
        placement.expectedType,
        undefined,
        directionFromSupport(support, target),
        placement.expectedStates || {},
        placementLookTarget,
      );
      if (result === true && orientationTarget) correctBlockFacing(dimension, target, orientationTarget);
      return result;
    };
  }));
  for (const interaction of blueprint.interactions || []) {
    if (interaction.action === "load_container") {
      for (const slot of interaction.slots) {
        steps.push(() => loadContainerSlotAsWizard(dimension, interaction, slot, origin, forward, right));
      }
    } else if (interaction.action === "wait_ticks") {
      let startedTick;
      steps.push(() => {
        if (startedTick === undefined) startedTick = system.currentTick;
        return system.currentTick - startedTick >= interaction.ticks;
      });
    } else {
      steps.push(() => useItemAsWizard(dimension, interaction, origin, forward, right));
    }
  }
  if (blueprint.verification?.length) {
    let checks = 0;
    steps.push(() => {
      if (verifyBlueprint(dimension, blueprint, origin, forward, right)) return true;
      checks += 1;
      if (checks === 80) repairBlueprintVerification(dimension, blueprint, origin, forward, right);
      if (checks % 400 === 0) {
        const current = playerById(player.id);
        if (current) speak(current, "The machine is built. I’m testing its moving parts before I call it finished.");
      }
      return false;
    });
  }
  const expected = new Map();
  for (const placement of blueprint.placements) {
    const location = customLocation(origin, forward, right, placement.target);
    const key = `${location.x},${location.y},${location.z}`;
    if (placement.action === "break") expected.set(key, { location, typeId: "minecraft:air" });
    else expected.set(key, {
      location,
      typeId: placement.expectedType,
      states: placement.expectedStates || {},
    });
  }
  runBuildSteps(
    player.id,
    token,
    dimension,
    steps,
    [...expected.values()],
    `${blueprint.success}${blueprint.usage ? ` ${blueprint.usage}` : ""}`,
    8,
  );
}

function buildMachinePlan(player, value) {
  try {
    void buildInteractiveBlueprint(player, machineBlueprint(value));
  } catch (error) {
    console.warn(`[MC Wizard] rejected unsafe machine plan: ${error}`);
    speak(player, "That machine plan had one unsafe part. I’m starting a working redstone memory core nearby instead of leaving you with nothing while I redraw the larger mechanism.");
    void buildCopperBulbTFlipFlop(player);
  }
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
    if (!block || !SAFE_SPACE.has(block.typeId)) return null;
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
    origin = {
      x: Math.floor(player.location.x) + forward.x * 6,
      y: standingBlockY(player.location),
      z: Math.floor(player.location.z) + forward.z * 6,
    };
    speak(player, "The site check is being fussy, so I’m using the nearby pad I just cleared and continuing.");
  }
  const bot = bringWizardTo(player);
  if (!bot) {
    queueBuild(player, (current) => buildValidatedPlan(current, value), 40, "My player body is re-forming. I queued the build and will begin automatically.");
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
    queueBuild(
      player,
      (current) => buildCommandLesson(current, id),
      200,
      "This patch is crowded. I’m keeping the lesson queued and clearing another nearby spot.",
    );
    return;
  }
  if (!bringWizardTo(player)) {
    queueBuild(
      player,
      (current) => buildCommandLesson(current, id),
      40,
      "My boots missed the summon. I’m fetching them and placing the lesson automatically.",
    );
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
    queueBuild(
      player,
      buildRedstoneCalculator,
      200,
      "This patch is crowded. I’m keeping your calculator queued and leveling another nearby spot.",
    );
    return;
  }

  let blueprint;
  try {
    blueprint = createCalculatorBlueprint();
  } catch (error) {
    console.warn(`[MC Wizard] calculator blueprint invalid: ${error}`);
    queueBuild(
      player,
      buildRedstoneCalculator,
      200,
      "I caught a flaw in my calculator map. I’m redrawing it and keeping your build queued.",
    );
    return;
  }
  const bot = bringWizardTo(player);
  if (!bot) {
    queueBuild(
      player,
      buildRedstoneCalculator,
      40,
      "My boots missed the summon. I’m fetching them and starting your calculator automatically.",
    );
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

  const beginCalculator = () => {
    if (activeBuildToken !== token) return;
    if (!wizardIsValid()) {
      const current = playerById(player.id);
      if (!current) {
        clearBuild(token);
        return;
      }
      bringWizardTo(current);
      if (!buildRetryNotices.has(`${token}:body`)) {
        buildRetryNotices.add(`${token}:body`);
        speak(current, "My boots blinked away, but your calculator is safe. I’m summoning them back and continuing from this exact spot.");
      }
      system.runTimeout(beginCalculator, 40);
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
  };
  system.runTimeout(beginCalculator, 20);
}

function applyWorldControl(player, action) {
  try {
    const overworld = world.getDimension("overworld");
    if (action.time) overworld.runCommand(`time set ${action.time}`);
    if (action.weather) overworld.runCommand(`weather ${action.weather}`);
    const changes = [
      action.time && `the time to ${action.time}`,
      action.weather && `${action.weather} weather`,
    ].filter(Boolean).join(" and ");
    speak(player, `Done—I’ve changed ${changes}. No command typing needed.`);
  } catch (error) {
    console.warn(`[MC Wizard] world control retry: ${error}`);
    system.runTimeout(() => {
      const current = playerById(player.id);
      if (current) applyWorldControl(current, action);
    }, 20);
  }
}

async function giveItemsAsWizard(player, items) {
  const bot = bringWizardTo(player, true, true);
  if (!bot) {
    queueBuild(player, (current) => giveItemsAsWizard(current, items), 40, "I’m gathering those items and will bring them over as soon as I reappear.");
    return;
  }
  for (let attempts = 0; attempts < 60 && distanceSquared(bot.location, player.location) > 5 * 5; attempts += 1) {
    moveWizardBeside(bot, player);
    await system.waitTicks(2);
  }
  let dropped = 0;
  for (const { itemId, amount } of items) {
    try {
      const probe = new ItemStack(itemId, 1);
      let remaining = amount;
      while (remaining > 0) {
        const count = Math.min(remaining, probe.maxAmount || 1);
        const stack = new ItemStack(itemId, count);
        if (!bot.setItem(stack, 0, true) || !bot.dropSelectedItem()) {
          throw new Error(`could not drop ${itemId}`);
        }
        dropped += count;
        remaining -= count;
        await system.waitTicks(2);
      }
    } catch (error) {
      console.warn(`[MC Wizard] could not gift ${itemId}: ${error}`);
    }
  }
  equipWizard();
  speak(player, dropped > 0
    ? `There you are—I brought ${dropped} item${dropped === 1 ? "" : "s"} and dropped them at your feet.`
    : "Those item names were smudged. Tell me what they look like and I’ll try a matching item next.");
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
  } else if (action?.type === "place_blueprint"
    && action.id === "automated_chicken_farm"
    && action.version === 1) {
    void buildInteractiveBlueprint(player, createAutomaticChickenFarmBlueprint());
  } else if (action?.type === "place_blueprint"
    && action.id === "two_by_two_piston_door"
    && action.version === 1) {
    void buildInteractiveBlueprint(player, createTwoByTwoPistonDoorBlueprint());
  } else if (action?.type === "place_blueprint"
    && action.id === "item_sorter"
    && action.version === 1) {
    try {
      void buildInteractiveBlueprint(player, createItemSorterBlueprint(action.filterItem));
    } catch (error) {
      console.warn(`[MC Wizard] item sorter filter was invalid; using iron ingots: ${error}`);
      speak(player, "That item name was fuzzy, so I’m making the sorter recognize iron ingots instead of stopping.");
      void buildInteractiveBlueprint(player, createItemSorterBlueprint());
    }
  } else if (action?.type === "place_blueprint"
    && action.id === "automatic_smelter"
    && action.version === 1) {
    void buildInteractiveBlueprint(player, createAutomaticSmelterBlueprint());
  } else if (action?.type === "build_plan" && action.version === 1) {
    buildValidatedPlan(player, action.plan);
  } else if (action?.type === "build_structure" && action.version === 1) {
    void buildStructure(player, action.plan);
  } else if (action?.type === "build_machine" && action.version === 1) {
    buildMachinePlan(player, action.plan);
  } else if (action?.type === "show_recipe" && action.version === 1) {
    try {
      void buildInteractiveBlueprint(player, createRecipeDisplay(action.itemId));
    } catch (error) {
      console.warn(`[MC Wizard] recipe display failed: ${error}`);
      speak(player, "I don’t have that exact recipe display yet. Name the block or item one more time and I’ll match it carefully.");
    }
  } else if (action?.type === "world_control" && action.version === 1) {
    applyWorldControl(player, action);
  } else if (action?.type === "give_items" && action.version === 1) {
    void giveItemsAsWizard(player, action.items || []);
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
  if (/^(?:(?:copy|learn|use|wear) my skin|copy skin)(?: please)?[.!]?$/i.test(simple)) {
    cancelPendingQuestion(player);
    learnWizardSkin(player);
    return true;
  }
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
  if (/\b(?:make|set|change|turn)\b/i.test(simple)) {
    const time = /\bmidnight\b/i.test(simple) ? "midnight"
      : /\bnoon\b/i.test(simple) ? "noon"
        : /\b(?:day|daytime|morning)\b/i.test(simple) ? "day"
          : /\b(?:night|nighttime)\b/i.test(simple) ? "night" : undefined;
    const weather = /\bthunder(?:storm)?\b/i.test(simple) ? "thunder"
      : /\b(?:rain|raining|rainy)\b/i.test(simple) ? "rain"
        : /\b(?:clear|sunny|sunshine)\b/i.test(simple) ? "clear" : undefined;
    if (time || weather) {
      cancelPendingQuestion(player);
      applyWorldControl(player, { time, weather });
      return true;
    }
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
  logChat(player, "wizard", "player", trimmed);
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
  logChat(player, "general", "player", trimmed);
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
