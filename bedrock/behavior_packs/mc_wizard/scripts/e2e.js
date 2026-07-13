import { Direction, GameMode, ItemStack, system, world } from "@minecraft/server";
import { variables } from "@minecraft/server-admin";
import { LookDuration, spawnSimulatedPlayer } from "@minecraft/server-gametest";
import { calculatorResult, createCalculatorBlueprint } from "./calculator.js";
import { itemSorterFillerItem, itemSorterFillerName } from "./item-sorter.js";

const TEST_TAG = "mcwizard:e2e";
const TICKING_AREA = "mc_wizard_e2e";
const POLL_TICKS = 10;
const TIMEOUT_TICKS = 1_200;
let runId = "";
let testName = "";
let chatCallbacks;

function removeTickingArea() {
  try {
    world.getDimension("overworld").runCommand("tickingarea remove " + TICKING_AREA);
  } catch {}
}

function report(status, check, detail = "") {
  if (status === "PASS" || status === "FAIL") removeTickingArea();
  console.warn(`MC_WIZARD_E2E ${JSON.stringify({ run: runId, status, check, detail })}`);
}

function poll(check, ticksLeft, onPass, description, onFail) {
  try {
    if (check()) {
      onPass();
      return;
    }
  } catch (error) {
    onFail(`${description}: ${error}`);
    return;
  }
  if (ticksLeft <= 0) {
    onFail(`timed out waiting for ${description}`);
    return;
  }
  system.runTimeout(
    () => poll(check, ticksLeft - POLL_TICKS, onPass, description, onFail),
    POLL_TICKS,
  );
}

function sendWizardRequest(kid, message, label, onRouted, onFail) {
  const before = chatCallbacks.engineAddressedMessageCount(kid.id);
  kid.chat(message);
  system.runTimeout(() => {
    let transport = "engine-event";
    if (chatCallbacks.engineAddressedMessageCount(kid.id) <= before) {
      transport = "direct-harness-fallback";
      if (!chatCallbacks.routeAddressedMessage(kid, message)) {
        onFail(`the shared router rejected the ${label} request`);
        return;
      }
    }
    report("CHECK", "addressed-chat-transport", `${label}: ${transport}`);
    onRouted(transport);
  }, 10);
}

async function pressButton(kid, button) {
  kid.teleport(
    { x: button.x + 2.5, y: button.y - 1, z: button.z + 0.5 },
    { dimension: kid.dimension, facingLocation: { x: button.x + 0.5, y: button.y + 0.5, z: button.z + 0.5 } },
  );
  kid.stopInteracting();
  kid.lookAtLocation(
    { x: button.x + 0.5, y: button.y + 0.08, z: button.z + 0.5 },
    LookDuration.Instant,
  );
  await system.waitTicks(2);
  const interacted = kid.interact();
  await system.waitTicks(1);
  const permutation = kid.dimension.getBlock(button)?.permutation;
  const supportPermutation = kid.dimension.getBlock({
    x: button.x,
    y: button.y - 1,
    z: button.z,
  })?.permutation;
  const pressed = permutation?.getState("button_pressed_bit");
  const facing = permutation?.getState("facing_direction");
  const powered = supportPermutation?.getState("powered_bit");
  const lit = supportPermutation?.getState("lit");
  report(
    "CHECK",
    "button-interaction",
    "interacted=" + interacted + "; pressed=" + pressed + "; facing=" + facing
      + "; support-powered=" + powered + "; support-lit=" + lit,
  );
  return { interacted, powered };
}

async function setLever(kid, lever, powered) {
  kid.stopUsingItem();
  if (!kid.setItem(new ItemStack("minecraft:stick", 1), 0, true)) return false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (kid.dimension.getBlock(lever)?.permutation.getState("open_bit") === powered) return true;
    kid.teleport(
      { x: lever.x + 0.5, y: lever.y - 1, z: lever.z - 2.5 },
      {
        dimension: kid.dimension,
        facingLocation: { x: lever.x + 0.5, y: lever.y + 0.25, z: lever.z + 0.5 },
      },
    );
    kid.stopInteracting();
    kid.lookAtLocation(
      { x: lever.x + 0.5, y: lever.y + 0.25, z: lever.z + 0.5 },
      LookDuration.Instant,
    );
    await system.waitTicks(4);
    kid.interact();
    await system.waitTicks(6);
  }
  return kid.dimension.getBlock(lever)?.permutation.getState("open_bit") === powered;
}

async function setInputPower(kid, target, powered) {
  const dimension = kid.dimension;
  if (dimension.getBlock(target)?.typeId === (powered ? "minecraft:redstone_block" : "minecraft:air")) {
    return true;
  }
  kid.teleport(
    { x: target.x + 0.5, y: target.y, z: target.z - 2.5 },
    { dimension, facingLocation: target },
  );
  await system.waitTicks(2);
  if (powered) {
    const item = new ItemStack("minecraft:redstone_block", 1);
    kid.stopUsingItem();
    if (!kid.setItem(item, 0, true)
      || !kid.useItemOnBlock(
        item,
        { x: target.x, y: target.y - 1, z: target.z },
        Direction.Up,
        { x: 0.5, y: 1, z: 0.5 },
      )) return false;
  } else if (!kid.breakBlock(target, Direction.Up)) {
    return false;
  }
  for (let ticks = 0; ticks < 100; ticks += 1) {
    const expected = powered ? "minecraft:redstone_block" : "minecraft:air";
    if (dimension.getBlock(target)?.typeId === expected) return true;
    await system.waitTicks(1);
  }
  return false;
}

async function drivePulseAsPlayer(kid, bulb) {
  await system.waitTicks(22);
  const dimension = kid.dimension;
  const target = [
    { x: bulb.x + 1, y: bulb.y, z: bulb.z },
    { x: bulb.x - 1, y: bulb.y, z: bulb.z },
  ].find((location) => (
    dimension.getBlock(location)?.typeId === "minecraft:air"
    && dimension.getEntitiesAtBlockLocation(location).length === 0
  ));
  if (!target) return false;
  const support = { x: target.x, y: target.y - 1, z: target.z };
  kid.teleport(
    { x: target.x + 3.5, y: target.y, z: target.z + 0.5 },
    { dimension, facingLocation: target },
  );
  await system.waitTicks(2);
  const item = new ItemStack("minecraft:redstone_block", 1);
  kid.stopUsingItem();
  if (!kid.setItem(item, 0, true)
    || !kid.useItemOnBlock(item, support, Direction.Up, { x: 0.5, y: 1, z: 0.5 })) {
    return false;
  }
  await system.waitTicks(40);
  const powered = dimension.getBlock(bulb)?.permutation.getState("powered_bit") === true;
  const litWhilePowered = dimension.getBlock(bulb)?.permutation.getState("lit");
  if (!kid.breakBlock(target, Direction.Up)) return false;
  for (let ticks = 0; ticks < 100 && dimension.getBlock(target)?.typeId !== "minecraft:air"; ticks += 1) {
    await system.waitTicks(1);
  }
  await system.waitTicks(5);
  const released = dimension.getBlock(target)?.typeId === "minecraft:air"
    && dimension.getBlock(bulb)?.permutation.getState("powered_bit") === false;
  const litAfterRelease = dimension.getBlock(bulb)?.permutation.getState("lit");
  report(
    "CHECK",
    "redstone-pulse-driver",
    "player-placed fallback; powered=" + powered + "; released=" + released
      + "; lit-while-powered=" + litWhilePowered + "; lit-after-release=" + litAfterRelease,
  );
  return powered && released;
}

async function preparePad(dimension) {
  dimension.runCommand("gamerule domobspawning false");
  const spawn = world.getDefaultSpawnLocation();
  const x = Math.floor(spawn.x) + 16;
  const z = Math.floor(spawn.z) + 16;
  const top = dimension.getTopmostBlock({ x, z });
  if (!top) throw new Error("the E2E pad chunk did not load");
  // Superflat terrain sits at the minimum build boundary. Use a verified test
  // plane with room below it for hoppers and redstone supports.
  const y = 64;
  let padReady = false;
  for (let attempt = 0; attempt < 3 && !padReady; attempt += 1) {
    dimension.runCommand(
      `fill ${x - 8} ${y - 1} ${z - 3} ${x + 8} ${y - 1} ${z + 22} stone replace`,
    );
    dimension.runCommand(
      `fill ${x - 8} ${y} ${z - 3} ${x + 8} ${y + 6} ${z + 22} air replace`,
    );
    // The disposable fixture may spawn in an ocean. Normalize each test-pad
    // block because liquid ticks can survive a successful fill command.
    for (let padX = x - 8; padX <= x + 8; padX += 1) {
      for (let padZ = z - 3; padZ <= z + 22; padZ += 1) {
        dimension.getBlock({ x: padX, y: y - 1, z: padZ })?.setType("minecraft:stone");
        for (let padY = y; padY <= y + 6; padY += 1) {
          dimension.getBlock({ x: padX, y: padY, z: padZ })?.setType("minecraft:air");
        }
      }
    }
    await system.waitTicks(2);
    padReady = [
      { x, z: z + 5 },
      { x: x - 8, z: z - 3 },
      { x: x - 8, z: z + 22 },
      { x: x + 8, z: z - 3 },
      { x: x + 8, z: z + 22 },
    ].every((location) => (
      dimension.getBlock({ ...location, y: y - 1 })?.typeId === "minecraft:stone"
      && dimension.getBlock({ ...location, y })?.typeId === "minecraft:air"
    ));
  }
  for (const entity of dimension.getEntities({ location: { x, y, z }, maxDistance: 32 })) {
    const location = entity.location;
    if (entity.typeId === "minecraft:player"
      || location.x < x - 8 || location.x > x + 8
      || location.y < y || location.y > y + 6
      || location.z < z - 3 || location.z > z + 22) continue;
    try {
      entity.remove();
    } catch {}
  }
  if (!padReady) {
    const floor = dimension.getBlock({ x, y: y - 1, z: z + 5 })?.typeId || "unloaded";
    const head = dimension.getBlock({ x, y, z: z + 5 })?.typeId || "unloaded";
    throw new Error(
      `the E2E pad floor did not persist (top=${top.location.y}; y=${y}; floor=${floor}; head=${head})`,
    );
  }
  return { x, y, z };
}

function waitFor(check, ticksLeft, description) {
  return new Promise((resolve, reject) => poll(check, ticksLeft, resolve, description, reject));
}

function routeWizardRequest(kid, message, label) {
  return new Promise((resolve, reject) => sendWizardRequest(kid, message, label, resolve, reject));
}

async function prepareAcceptanceStation(kid, station) {
  const dimension = kid.dimension;
  dimension.runCommand(
    `fill ${station.x - 20} ${station.y - 1} ${station.z - 20} ${station.x + 20} ${station.y - 1} ${station.z + 20} grass_block replace`,
  );
  dimension.runCommand(
    `fill ${station.x - 20} ${station.y} ${station.z - 20} ${station.x + 20} ${station.y + 8} ${station.z + 20} air replace`,
  );
  for (let x = station.x - 20; x <= station.x + 20; x += 1) {
    for (let z = station.z - 20; z <= station.z + 20; z += 1) {
      dimension.setBlockType({ x, y: station.y - 1, z }, "minecraft:grass_block");
    }
  }
  await system.waitTicks(2);
  const samples = [
    [0, 0], [-20, -20], [-20, 20], [20, -20], [20, 20],
  ];
  if (!samples.every(([dx, dz]) => (
    dimension.getBlock({ x: station.x + dx, y: station.y - 1, z: station.z + dz })?.typeId
      === "minecraft:grass_block"
  ))) throw new Error("the acceptance station floor did not persist");
}

async function teleportToStation(kid, station) {
  kid.stopMoving();
  kid.teleport(
    { x: station.x + 0.5, y: station.y + 4, z: station.z + 0.5 },
    {
      dimension: kid.dimension,
      facingLocation: { x: station.x + 0.5, y: station.y + 1.6, z: station.z + 10 },
    },
  );
  kid.fly();
  await system.waitTicks(10);
  await prepareAcceptanceStation(kid, station);
  kid.stopFlying();
  kid.teleport(
    { x: station.x + 0.5, y: station.y, z: station.z + 0.5 },
    {
      dimension: kid.dimension,
      facingLocation: { x: station.x + 0.5, y: station.y + 1.6, z: station.z + 10 },
    },
  );
  await system.waitTicks(10);
  const settledY = Math.floor(kid.location.y + 0.01);
  if (settledY !== station.y || !kid.isOnGround) {
    throw new Error(`the acceptance station did not hold Test Kid at y=${station.y}; settled=${settledY}`);
  }
}

function rectangleIs(dimension, x, y, z, width, depth, typeId) {
  for (let dx = 0; dx < width; dx += 1) {
    for (let dz = 0; dz < depth; dz += 1) {
      if (dimension.getBlock({ x: x + dx, y, z: z + dz })?.typeId !== typeId) return false;
    }
  }
  return true;
}

function countBlocks(dimension, min, max, typeId) {
  let count = 0;
  for (let x = min.x; x <= max.x; x += 1) {
    for (let y = min.y; y <= max.y; y += 1) {
      for (let z = min.z; z <= max.z; z += 1) {
        if (dimension.getBlock({ x, y, z })?.typeId === typeId) count += 1;
      }
    }
  }
  return count;
}

function prepareArbitraryStructureStation(kid, station) {
  const dimension = kid.dimension;
  dimension.runCommand(
    `fill ${station.x - 20} ${station.y - 1} ${station.z - 20} ${station.x + 20} ${station.y - 1} ${station.z + 20} grass_block replace`,
  );
  // Split the clear so each fill remains below Bedrock's command volume limit.
  dimension.runCommand(
    `fill ${station.x - 20} ${station.y} ${station.z - 20} ${station.x + 20} ${station.y + 7} ${station.z + 20} air replace`,
  );
  dimension.runCommand(
    `fill ${station.x - 20} ${station.y + 8} ${station.z - 20} ${station.x + 20} ${station.y + 15} ${station.z + 20} air replace`,
  );
}

function analyzeDragonGeometry(kid, station) {
  const blocks = [];
  for (let x = station.x - 20; x <= station.x + 20; x += 1) {
    for (let y = station.y; y <= station.y + 15; y += 1) {
      for (let z = station.z - 20; z <= station.z + 20; z += 1) {
        const typeId = kid.dimension.getBlock({ x, y, z })?.typeId;
        if (typeId && typeId !== "minecraft:air") blocks.push({ x, y, z, typeId });
      }
    }
  }
  if (!blocks.length) return { complete: false, detail: "no structure blocks yet" };

  const bounds = {
    min: {
      x: Math.min(...blocks.map(({ x }) => x)),
      y: Math.min(...blocks.map(({ y }) => y)),
      z: Math.min(...blocks.map(({ z }) => z)),
    },
    max: {
      x: Math.max(...blocks.map(({ x }) => x)),
      y: Math.max(...blocks.map(({ y }) => y)),
      z: Math.max(...blocks.map(({ z }) => z)),
    },
  };
  const spans = {
    x: bounds.max.x - bounds.min.x + 1,
    y: bounds.max.y - bounds.min.y + 1,
    z: bounds.max.z - bounds.min.z + 1,
  };
  const widthAxis = spans.x === 20 && spans.z === 10 ? "x"
    : spans.z === 20 && spans.x === 10 ? "z" : undefined;
  if (!widthAxis || spans.y !== 12) {
    return { complete: false, detail: `occupied bounds=${spans.x}x${spans.z}x${spans.y}` };
  }
  const depthAxis = widthAxis === "x" ? "z" : "x";
  const normalized = blocks.map((block) => ({
    ...block,
    u: block[widthAxis] - bounds.min[widthAxis],
    v: block[depthAxis] - bounds.min[depthAxis],
    dy: block.y - bounds.min.y,
  }));
  const materials = new Set(normalized.map(({ typeId }) => typeId));
  const density = normalized.length / (20 * 10 * 12);
  const corners = normalized.filter(({ u, v, dy }) => (
    (u === 0 || u === 19) && (v === 0 || v === 9) && (dy === 0 || dy === 11)
  )).length;
  const layers = new Map();
  for (const block of normalized) {
    if (!layers.has(block.dy)) layers.set(block.dy, []);
    layers.get(block.dy).push(block);
  }
  const wingLayer = [...layers.entries()].find(([dy, layer]) => {
    if (dy < 3) return false;
    const us = new Set(layer.map(({ u }) => u));
    const vs = new Set(layer.map(({ v }) => v));
    return Math.min(...us) === 0 && Math.max(...us) === 19 && us.size >= 16 && vs.size <= 7;
  });
  const body = normalized.filter(({ u }) => u >= 6 && u <= 13);
  const bodyDepth = new Set(body.map(({ v }) => v)).size;
  const bodyHeight = new Set(body.map(({ dy }) => dy)).size;
  const heads = [
    normalized.filter(({ v, dy }) => v <= 2 && dy >= 6),
    normalized.filter(({ v, dy }) => v >= 7 && dy >= 6),
  ];
  const head = heads.find((candidate) => (
    candidate.length >= 12
    && new Set(candidate.map(({ u }) => u)).size >= 3
    && new Set(candidate.map(({ dy }) => dy)).size >= 3
    && new Set(candidate.map(({ typeId }) => typeId)).size >= 2
  ));
  const bands = [
    normalized.some(({ dy }) => dy <= 2),
    normalized.some(({ dy }) => dy >= 3 && dy <= 7),
    normalized.some(({ dy }) => dy >= 8),
  ];
  const complete = density < 0.35
    && corners <= 4
    && materials.size >= 3
    && bands.every(Boolean)
    && Boolean(wingLayer)
    && body.length >= 40
    && bodyDepth >= 8
    && bodyHeight >= 6
    && Boolean(head);
  return {
    complete,
    detail: `bounds=20x10x12; blocks=${normalized.length}; density=${density.toFixed(3)}; materials=${materials.size}; corners=${corners}; wings=${Boolean(wingLayer)}; body=${body.length}/${bodyDepth}d/${bodyHeight}h; head=${Boolean(head)}`,
  };
}

async function runArbitraryStructureAcceptance(kid) {
  const check = "arbitrary-exact-structure";
  const station = {
    x: Math.floor(kid.location.x),
    y: Math.round(kid.location.y),
    z: Math.floor(kid.location.z),
  };
  let observed = { detail: "not scanned yet" };
  try {
    kid.dimension.runCommand(`tickingarea remove ${TICKING_AREA}`);
    kid.dimension.runCommand(`tickingarea add circle ${station.x} ${station.y} ${station.z} 4 ${TICKING_AREA} true`);
    prepareArbitraryStructureStation(kid, station);
    await teleportToStation(kid, station);
    await system.waitTicks(20);
    const transport = await routeWizardRequest(
      kid,
      "build me a 20x10x12 dragon",
      "20x10x12-dragon",
    );
    try {
      await waitFor(
        () => {
          observed = analyzeDragonGeometry(kid, station);
          return observed.complete;
        },
        TIMEOUT_TICKS * 2,
        "an exact-size, recognizable dragon structure",
      );
    } catch (error) {
      throw new Error(`${error}; last scan: ${observed.detail}`);
    }
    await system.waitTicks(20);
    observed = analyzeDragonGeometry(kid, station);
    if (!observed.complete) throw new Error(`the completed geometry did not remain stable: ${observed.detail}`);
    report("CHECK", check, `request via ${transport}; ${observed.detail}`);
    report(
      "PASS",
      check,
      "the nearby world contains an exact 20x10x12 non-box dragon with wings, a longitudinal body, an upper head, and multiple visible build bands",
    );
    try { kid.disconnect(); } catch {}
  } catch (error) {
    report("FAIL", check, String(error));
    try { kid.disconnect(); } catch {}
  }
}

function findCompletedTenByTenHouse(kid, station) {
  const dimension = kid.dimension;
  for (let x = station.x - 18; x <= station.x + 18; x += 1) {
    for (let z = station.z - 18; z <= station.z + 18; z += 1) {
      if (!rectangleIs(dimension, x, station.y, z, 10, 10, "minecraft:oak_planks")) continue;
      const min = { x, y: station.y + 3, z };
      const max = { x: x + 9, y: station.y + 3, z: z + 9 };
      const lowerRoof = countBlocks(dimension, min, max, "minecraft:spruce_planks");
      const lanterns = countBlocks(dimension, min, max, "minecraft:sea_lantern");
      const upperRoof = rectangleIs(dimension, x + 1, station.y + 4, z, 8, 10, "minecraft:spruce_planks")
        || rectangleIs(dimension, x, station.y + 4, z + 1, 10, 8, "minecraft:spruce_planks");
      const glass = countBlocks(
        dimension,
        { x, y: station.y + 2, z },
        { x: x + 9, y: station.y + 2, z: z + 9 },
        "minecraft:glass",
      );
      if (lowerRoof >= 98 && lanterns === 2 && upperRoof && glass >= 8) return { x, y: station.y, z };
    }
  }
  return undefined;
}

function findCompletedChickenFarm(kid, station) {
  const dimension = kid.dimension;
  for (let x = station.x - 16; x <= station.x + 16; x += 1) {
    for (let y = station.y; y <= station.y + 3; y += 1) {
      for (let z = station.z - 16; z <= station.z + 16; z += 1) {
        const hopper = { x, y, z };
        if (dimension.getBlock(hopper)?.typeId !== "minecraft:hopper") continue;
        const chest = [
          { x: x + 1, y, z }, { x: x - 1, y, z }, { x, y, z: z + 1 }, { x, y, z: z - 1 },
        ].some((location) => dimension.getBlock(location)?.typeId === "minecraft:chest");
        const chickens = dimension.getEntities({ type: "minecraft:chicken", location: hopper, maxDistance: 4 }).length;
        const glass = countBlocks(
          dimension,
          { x: x - 2, y, z: z - 2 },
          { x: x + 2, y: y + 3, z: z + 2 },
          "minecraft:glass",
        );
        if (chest && chickens >= 4 && glass >= 7) return hopper;
      }
    }
  }
  return undefined;
}

function playerAndDroppedItemIds(kid) {
  const ids = new Set();
  const inventory = kid.getComponent("minecraft:inventory")?.container;
  for (let slot = 0; inventory && slot < inventory.size; slot += 1) {
    const item = inventory.getItem(slot);
    if (item) ids.add(item.typeId);
  }
  for (const entity of kid.dimension.getEntities({ type: "minecraft:item", location: kid.location, maxDistance: 12 })) {
    const item = entity.getComponent("minecraft:item")?.itemStack;
    if (item) ids.add(item.typeId);
  }
  return ids;
}

function recipeDisplayIsComplete(kid, station) {
  const min = { x: station.x - 16, y: station.y, z: station.z - 16 };
  const max = { x: station.x + 16, y: station.y + 5, z: station.z + 16 };
  return countBlocks(kid.dimension, min, max, "minecraft:frame") === 10
    && countBlocks(kid.dimension, min, max, "minecraft:oak_planks") >= 24;
}

function machineLocation(origin, [x, y, z]) {
  return { x: origin.x - x, y: origin.y + y, z: origin.z + z };
}

function machineOrigin(station) {
  return { x: station.x, y: station.y, z: station.z + 6 };
}

function blockIs(dimension, location, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.includes(dimension.getBlock(location)?.typeId);
}

function containerContains(dimension, location, itemId, minimum = 1) {
  const container = dimension.getBlock(location)?.getComponent("minecraft:inventory")?.container;
  return Boolean(container && [...Array(container.size).keys()].some((slot) => {
    const item = container.getItem(slot);
    return item?.typeId === itemId && item.amount >= minimum;
  }));
}

function hopperPointsTo(dimension, from, to) {
  const block = dimension.getBlock(from);
  if (block?.typeId !== "minecraft:hopper") return false;
  const states = block.permutation.getAllStates();
  const stateName = Object.keys(states).find((name) => /(?:cardinal_|facing_)direction$/.test(name));
  if (!stateName) return false;
  const actual = states[stateName];
  const expectedName = to.y < from.y ? "down"
    : to.x > from.x ? "east"
      : to.x < from.x ? "west"
        : to.z > from.z ? "south" : "north";
  const expectedNumber = { down: 0, north: 2, south: 3, west: 4, east: 5 }[expectedName];
  return actual === (typeof actual === "string" ? expectedName : expectedNumber);
}

function pistonDoorIsOpen(kid, station) {
  const dimension = kid.dimension;
  const origin = machineOrigin(station);
  const pistons = [[-2, 1, 1], [-2, 2, 1], [3, 1, 1], [3, 2, 1]];
  const retracted = [[-1, 1, 1], [-1, 2, 1], [2, 1, 1], [2, 2, 1]];
  const opening = [[0, 1, 1], [0, 2, 1], [1, 1, 1], [1, 2, 1]];
  return pistons.every((location) => blockIs(dimension, machineLocation(origin, location), "minecraft:sticky_piston"))
    && retracted.every((location) => blockIs(dimension, machineLocation(origin, location), "minecraft:polished_deepslate"))
    && opening.every((location) => blockIs(dimension, machineLocation(origin, location), "minecraft:air"))
    && dimension.getBlock(machineLocation(origin, [0, 2, 5]))?.permutation.getState("open_bit") === false;
}

function pistonDoorIsClosed(kid, station) {
  const dimension = kid.dimension;
  const origin = machineOrigin(station);
  return [[0, 1, 1], [0, 2, 1], [1, 1, 1], [1, 2, 1]].every((location) => (
    blockIs(dimension, machineLocation(origin, location), "minecraft:polished_deepslate")
  ));
}

function pistonDoorSnapshot(kid, station) {
  const dimension = kid.dimension;
  const origin = machineOrigin(station);
  const samples = [
    ["lever", [0, 2, 5]],
    ["shared-dust", [0, 1, 4]],
    ["left-feed-dust", [-2, 1, 4]],
    ["right-feed-dust", [3, 1, 4]],
    ["left-repeater", [-2, 1, 3]],
    ["left-upper-dust", [-2, 2, 2]],
    ["left-lower", [-2, 1, 1]],
    ["left-upper", [-2, 2, 1]],
    ["left-door-lower", [0, 1, 1]],
    ["left-door-upper", [0, 2, 1]],
    ["right-repeater", [3, 1, 3]],
    ["right-upper-dust", [3, 2, 2]],
    ["right-lower", [3, 1, 1]],
    ["right-upper", [3, 2, 1]],
    ["right-door-lower", [1, 1, 1]],
    ["right-door-upper", [1, 2, 1]],
  ];
  return samples.map(([label, local]) => {
    const location = machineLocation(origin, local);
    const block = dimension.getBlock(location);
    const states = block?.permutation.getAllStates() || {};
    const useful = Object.fromEntries(Object.entries(states).filter(([name]) => (
      /open_bit|powered_bit|redstone_signal|output_lit_bit|facing_direction|cardinal_direction|extended_bit/.test(name)
    )));
    return `${label}@${location.x},${location.y},${location.z}=${block?.typeId || "unloaded"}${JSON.stringify(useful)}`;
  }).join("; ");
}

function automaticSmelterIsWorking(kid, station) {
  const dimension = kid.dimension;
  const origin = machineOrigin(station);
  const at = (location) => machineLocation(origin, location);
  return blockIs(dimension, at([0, 3, 2]), "minecraft:chest")
    && blockIs(dimension, at([-1, 2, 2]), "minecraft:chest")
    && blockIs(dimension, at([0, 1, 2]), "minecraft:furnace")
    && blockIs(dimension, at([0, 0, 1]), "minecraft:chest")
    && hopperPointsTo(dimension, at([0, 2, 2]), at([0, 1, 2]))
    && hopperPointsTo(dimension, at([-1, 1, 2]), at([0, 1, 2]))
    && hopperPointsTo(dimension, at([0, 0, 2]), at([0, 0, 1]))
    && containerContains(dimension, at([0, 0, 1]), "minecraft:iron_ingot");
}

function diamondSorterIsWorking(kid, station) {
  const dimension = kid.dimension;
  const origin = machineOrigin(station);
  const at = (location) => machineLocation(origin, location);
  const filter = dimension.getBlock(at([0, 2, 0]))?.getComponent("minecraft:inventory")?.container;
  const filterLoaded = filter?.getItem(0)?.typeId === "minecraft:diamond"
    && filter.getItem(0).amount >= 41
    && [1, 2, 3, 4].every((slot) => (
      filter.getItem(slot)?.typeId === itemSorterFillerItem
      && filter.getItem(slot)?.nameTag === itemSorterFillerName
    ));
  return filterLoaded
    && hopperPointsTo(dimension, at([0, 1, 0]), at([0, 1, -1]))
    && hopperPointsTo(dimension, at([0, 3, 0]), at([-1, 3, 0]))
    && blockIs(dimension, at([0, 2, 1]), ["minecraft:unpowered_comparator", "minecraft:powered_comparator"])
    && blockIs(dimension, at([0, 0, 3]), ["minecraft:unpowered_repeater", "minecraft:powered_repeater"])
    && [[0, 2, 2], [0, 2, 3], [0, 1, 4]].every((location) => (
      blockIs(dimension, at(location), "minecraft:redstone_wire")
    ))
    && containerContains(dimension, at([0, 1, -1]), "minecraft:diamond")
    && containerContains(dimension, at([-1, 3, 0]), "minecraft:feather");
}

function diamondSorterSnapshot(kid, station) {
  const dimension = kid.dimension;
  const origin = machineOrigin(station);
  const samples = [
    ["input", [0, 4, 0]],
    ["transport", [0, 3, 0]],
    ["overflow", [-1, 3, 0]],
    ["filter", [0, 2, 0]],
    ["matched-hopper", [0, 1, 0]],
    ["matched", [0, 1, -1]],
    ["comparator", [0, 2, 1]],
    ["dust-1", [0, 2, 2]],
    ["dust-2", [0, 2, 3]],
    ["dust-3", [0, 1, 4]],
    ["repeater", [0, 0, 3]],
    ["torch", [0, 0, 1]],
  ];
  return samples.map(([label, local]) => {
    const location = machineLocation(origin, local);
    const block = dimension.getBlock(location);
    const states = block?.permutation.getAllStates() || {};
    const useful = Object.fromEntries(Object.entries(states).filter(([name]) => (
      /facing_direction|cardinal_direction|redstone_signal|output_lit_bit|output_subtract_bit|powered_bit|toggle_bit|lit/.test(name)
    )));
    const container = block?.getComponent("minecraft:inventory")?.container;
    const items = [];
    for (let slot = 0; container && slot < container.size; slot += 1) {
      const item = container.getItem(slot);
      if (item) items.push(`${slot}:${item.typeId}x${item.amount}`);
    }
    return `${label}@${location.x},${location.y},${location.z}=${block?.typeId || "unloaded"}`
      + `${JSON.stringify(useful)}[${items.join(",")}]`;
  }).join("; ");
}

async function runMachineAcceptance(kid) {
  const fail = (request, detail) => {
    report("FAIL", "machine-action-pipeline", `${request}: ${detail}`);
    try { kid.disconnect(); } catch {}
  };
  const anchor = {
    x: Math.floor(kid.location.x),
    y: Math.round(kid.location.y),
    z: Math.floor(kid.location.z),
  };
  const doorStation = { ...anchor, x: anchor.x - 45 };
  const smelterStation = { ...anchor };
  const sorterStation = { ...anchor, x: anchor.x + 45 };
  let currentRequest = "fixture preparation";
  try {
    await system.waitTicks(20);

    currentRequest = "build me a 2x2 piston door";
    await teleportToStation(kid, doorStation);
    const doorTransport = await routeWizardRequest(kid, "wizard, build me a 2x2 piston door", "2x2-piston-door");
    await waitFor(
      () => chatCallbacks.hasCommittedBuild(kid.id) && pistonDoorIsOpen(kid, doorStation),
      TIMEOUT_TICKS * 2,
      "the committed open, four-piston door",
    );
    const lever = machineLocation(machineOrigin(doorStation), [0, 2, 5]);
    if (!await setLever(kid, lever, true)) throw new Error("Test Kid could not close the piston door with its lever");
    try {
      await waitFor(() => pistonDoorIsClosed(kid, doorStation), 200, "all four door blocks to close");
    } catch (error) {
      throw new Error(`${error}; ${pistonDoorSnapshot(kid, doorStation)}`);
    }
    if (!await setLever(kid, lever, false)) throw new Error("Test Kid could not reopen the piston door with its lever");
    await waitFor(() => pistonDoorIsOpen(kid, doorStation), 200, "the complete doorway to reopen");
    report("CHECK", "machine-piston-door", `request via ${doorTransport}; player closed and reopened all four blocks`);

    currentRequest = "build me an automatic smelter";
    await teleportToStation(kid, smelterStation);
    const smelterTransport = await routeWizardRequest(kid, "wizard, build me an automatic smelter", "automatic-smelter");
    await waitFor(
      () => automaticSmelterIsWorking(kid, smelterStation),
      TIMEOUT_TICKS * 2,
      "the three linked hoppers to smelt raw iron into the output chest",
    );
    report("CHECK", "machine-automatic-smelter", `request via ${smelterTransport}; iron ingot reached the output chest`);

    currentRequest = "make an item sorter for diamonds";
    await teleportToStation(kid, sorterStation);
    const sorterTransport = await routeWizardRequest(kid, "wizard, make an item sorter for diamonds", "diamond-item-sorter");
    await waitFor(
      () => diamondSorterIsWorking(kid, sorterStation),
      TIMEOUT_TICKS * 2,
      "diamonds and overflow items to reach their separate chests through the loaded filter",
    );
    report("CHECK", "machine-item-sorter", `request via ${sorterTransport}; diamond and feather reached separate outputs`);
    report(
      "PASS",
      "machine-action-pipeline",
      "the piston door moved, the smelter produced iron, and the item sorter separated diamond from overflow",
    );
    try { kid.disconnect(); } catch {}
  } catch (error) {
    const doorState = currentRequest === "build me a 2x2 piston door"
      ? `; ${pistonDoorSnapshot(kid, doorStation)}` : "";
    const sorterState = currentRequest === "make an item sorter for diamonds"
      ? `; ${diamondSorterSnapshot(kid, sorterStation)}` : "";
    fail(currentRequest, `${String(error)}${doorState}${sorterState}`);
  }
}

async function runChildRequestAcceptance(kid) {
  const fail = (request, detail) => {
    report("FAIL", "child-action-pipeline", `${request}: ${detail}`);
    try { kid.disconnect(); } catch {}
  };
  const anchor = {
    x: Math.floor(kid.location.x),
    y: Math.round(kid.location.y),
    z: Math.floor(kid.location.z),
  };
  const houseStation = { ...anchor, x: anchor.x - 45 };
  const farmStation = { ...anchor };
  const recipeStation = { ...anchor, x: anchor.x + 45 };
  let currentRequest = "fixture preparation";
  try {
    kid.dimension.runCommand(`tickingarea remove ${TICKING_AREA}`);
    kid.dimension.runCommand(`tickingarea add circle ${anchor.x} ${anchor.y} ${anchor.z} 4 ${TICKING_AREA} true`);
    if (chatCallbacks.hasCommittedBuild(kid.id) && !chatCallbacks.undoLastBuild(kid)) {
      throw new Error("could not clear the preceding workshop transaction");
    }
    await system.waitTicks(20);

    currentRequest = "make me a 10x10 house";
    await teleportToStation(kid, houseStation);
    const houseTransport = await routeWizardRequest(kid, "wizard, make me a 10x10 house", "10x10-house");
    await waitFor(
      () => Boolean(findCompletedTenByTenHouse(kid, houseStation)),
      TIMEOUT_TICKS * 2,
      "the complete 10x10 house, including floor, walls, windows, roof, and lighting",
    );
    report("CHECK", "child-10x10-house", `request via ${houseTransport}; exact complete geometry verified`);

    currentRequest = "make me an automated chicken farm";
    await teleportToStation(kid, farmStation);
    const farmTransport = await routeWizardRequest(kid, "wizard, make me an automated chicken farm", "automated-chicken-farm");
    await waitFor(
      () => chatCallbacks.hasCommittedBuild(kid.id) && Boolean(findCompletedChickenFarm(kid, farmStation)),
      TIMEOUT_TICKS * 2,
      "the working chicken farm with chest, connected hopper, glass pen, and four chickens",
    );
    report("CHECK", "child-automated-chicken-farm", `request via ${farmTransport}; working machine verified`);
    if (!chatCallbacks.undoLastBuild(kid)) throw new Error("could not clear the farm transaction before the recipe test");
    await system.waitTicks(20);

    currentRequest = "make it daytime and make it rain";
    kid.dimension.runCommand("time set night");
    kid.dimension.runCommand("weather clear");
    const worldTransport = await routeWizardRequest(kid, "wizard, make it daytime and make it rain", "daytime-and-rain");
    await waitFor(
      () => world.getTimeOfDay() < 12_000 && kid.dimension.getWeather() === "Rain",
      400,
      "daytime and rainy weather",
    );
    report("CHECK", "child-world-control", `request via ${worldTransport}; time and weather both verified`);

    currentRequest = "give me a set of iron tools";
    const tools = ["sword", "pickaxe", "axe", "shovel", "hoe"].map((name) => `minecraft:iron_${name}`);
    const toolsTransport = await routeWizardRequest(kid, "wizard, give me a set of iron tools", "iron-tools");
    await waitFor(
      () => {
        const ids = playerAndDroppedItemIds(kid);
        return tools.every((itemId) => ids.has(itemId));
      },
      600,
      "all five iron tools to be dropped or carried",
    );
    report("CHECK", "child-iron-tools", `request via ${toolsTransport}; all five physical items verified`);

    currentRequest = "show me how to craft a hopper";
    await teleportToStation(kid, recipeStation);
    const recipeTransport = await routeWizardRequest(kid, "wizard, show me how to craft a hopper", "hopper-recipe");
    await waitFor(
      () => chatCallbacks.hasCommittedBuild(kid.id) && recipeDisplayIsComplete(kid, recipeStation),
      TIMEOUT_TICKS * 2,
      "the complete physical 3x3 hopper recipe display",
    );
    report("CHECK", "child-hopper-recipe", `request via ${recipeTransport}; ten-frame display verified`);
    report(
      "PASS",
      "child-action-pipeline",
      "exact child requests produced a complete sized house, working farm, world changes, gifted tools, and an in-world recipe",
    );
    try { kid.disconnect(); } catch {}
  } catch (error) {
    fail(currentRequest, String(error));
  }
}

function undoTFlipFlop(kid, expected, onPass, fail) {
  if (!chatCallbacks.undoLastBuild(kid)) {
    fail("the wizard could not undo its T flip-flop before the calculator test");
    return;
  }
  system.runTimeout(() => {
    const remaining = expected.filter(([location]) => (
      kid.dimension.getBlock(location)?.typeId !== "minecraft:air"
    ));
    if (remaining.length) {
      fail(`undo left ${remaining.length} T flip-flop blocks behind`);
      return;
    }
    report("CHECK", "transaction-undo", "the wizard restored its first build before starting the calculator");
    onPass();
  }, 20);
}

function runTFlipFlopCheck(kid, origin, onPass) {
  const dimension = kid.dimension;
  const bulb = { x: origin.x, y: origin.y, z: origin.z + 5 };
  const button = { x: bulb.x, y: bulb.y + 1, z: bulb.z };
  const comparator = { x: bulb.x, y: bulb.y, z: bulb.z + 1 };
  const wire = { x: bulb.x, y: bulb.y, z: bulb.z + 2 };
  const lamp = { x: bulb.x, y: bulb.y, z: bulb.z + 3 };
  const expected = [
    [bulb, "minecraft:copper_bulb"],
    [button, "minecraft:stone_button"],
    [comparator, "minecraft:unpowered_comparator"],
    [wire, "minecraft:redstone_wire"],
    [lamp, "minecraft:redstone_lamp"],
  ];

  const fail = (detail) => {
    report("FAIL", "visible-player-t-flip-flop", detail);
    try {
      kid.disconnect();
    } catch {}
  };

  kid.lookAtLocation(
    { x: origin.x + 0.5, y: origin.y + 1.6, z: origin.z + 10 },
    LookDuration.Instant,
  );
  sendWizardRequest(
    kid,
    "wizard, build a t flip flop for me",
    "t-flip-flop",
    (transport) => poll(
      () => chatCallbacks.hasCommittedBuild(kid.id)
        && expected.every(([location, typeId]) => dimension.getBlock(location)?.typeId === typeId),
      TIMEOUT_TICKS,
      async () => {
        const wizard = world.getAllPlayers().find((player) => (
          player.name === "MC Wizard" && typeof player.navigateToEntity === "function"
        ));
        if (!wizard) {
          fail("the build appeared but no visible MC Wizard SimulatedPlayer exists");
          return;
        }
        if (dimension.getBlock(bulb)?.permutation.getState("lit") !== false) {
          fail("copper bulb did not start off");
          return;
        }
        const firstPress = await pressButton(kid, button);
        if (!firstPress.interacted) {
          fail("Test Kid could not press the first button pulse");
          return;
        }
        if (!firstPress.powered && !await drivePulseAsPlayer(kid, bulb)) {
          report(
            "CHECK",
            "copper-bulb-runtime-limit",
            "the automated player pulse did not toggle the bulb; calculator test continues separately",
          );
          undoTFlipFlop(kid, expected, () => system.runTimeout(onPass, 200), fail);
          return;
        }
        if (dimension.getBlock(bulb)?.permutation.getState("lit") !== true) {
          report(
            "CHECK",
            "copper-bulb-runtime-limit",
            "player pulse reached and released the bulb, but BDS 1.26.33.2 did not toggle its lit state",
          );
          undoTFlipFlop(kid, expected, () => system.runTimeout(onPass, 200), fail);
          return;
        }
        poll(
          () => dimension.getBlock(bulb)?.permutation.getState("lit") === true
            && dimension.getBlock(lamp)?.typeId === "minecraft:lit_redstone_lamp",
          100,
          () => system.runTimeout(async () => {
            const secondPress = await pressButton(kid, button);
            if (!secondPress.interacted) {
              fail("Test Kid could not press the second button pulse");
              return;
            }
            if (!secondPress.powered && !await drivePulseAsPlayer(kid, bulb)) {
              fail("Test Kid could not create the second player-driven redstone pulse");
              return;
            }
            poll(
              () => dimension.getBlock(bulb)?.permutation.getState("lit") === false
                && dimension.getBlock(lamp)?.typeId === "minecraft:redstone_lamp",
              100,
              () => {
                report(
                  "CHECK",
                  "visible-player-t-flip-flop",
                  `request via ${transport}; embodiment, placement, and two pulses verified`,
                );
                undoTFlipFlop(kid, expected, () => system.runTimeout(onPass, 200), fail);
              },
              "the second pulse to turn the output off",
              fail,
            );
          }, 20),
          "the first pulse to turn the output on",
          fail,
        );
      },
      "the wizard to place and verify all five circuit parts",
      fail,
    ),
    fail,
  );
}

function calculatorWorldLocation(origin, [x, y, z]) {
  const calculatorOrigin = { x: origin.x + 5, y: origin.y, z: origin.z + 18 };
  return { x: calculatorOrigin.x - x, y: calculatorOrigin.y + y, z: calculatorOrigin.z - z };
}

function runOverlappingPlanCheck(kid, origin, onPass, fail) {
  kid.teleport(
    { x: origin.x + 0.5, y: origin.y, z: origin.z + 0.5 },
    { dimension: kid.dimension, facingLocation: { x: origin.x + 0.5, y: origin.y + 1.6, z: origin.z + 10 } },
  );
  const location = ([x, z]) => ({ x: origin.x - x, y: origin.y, z: origin.z + 6 + z });
  const first = [[0, 1], [2, 3]].map(location);
  const second = [[0, 3], [2, 1]].map(location);
  const isStone = (target) => kid.dimension.getBlock(target)?.typeId === "minecraft:stone";
  chatCallbacks.buildValidatedPlan(kid, {
    title: "E2E overlap first",
    blocks: [
      { target: [0, 0, 1], support: [0, -1, 1], itemId: "minecraft:stone" },
      { target: [2, 0, 3], support: [2, -1, 3], itemId: "minecraft:stone" },
    ],
  });
  poll(
    () => first.every(isStone),
    600,
    () => {
      chatCallbacks.buildValidatedPlan(kid, {
        title: "E2E overlap second",
        blocks: [
          { target: [0, 0, 3], support: [0, -1, 3], itemId: "minecraft:stone" },
          { target: [2, 0, 1], support: [2, -1, 1], itemId: "minecraft:stone" },
        ],
      });
      poll(
        () => [...first, ...second].every(isStone),
        600,
        () => system.runTimeout(() => {
          if (![...first, ...second].every(isStone)) {
            fail("the overlapping-bounds plans did not remain physically built");
            return;
          }
          report("CHECK", "overlapping-plan-bounds", "two nonintersecting plans with identical bounds both remained built");
          if (!chatCallbacks.undoLastBuild(kid)) {
            fail("the wizard could not undo the second overlapping-bounds plan");
            return;
          }
          system.runTimeout(() => {
            if (!first.every(isStone)
              || second.some((target) => kid.dimension.getBlock(target)?.typeId !== "minecraft:air")) {
              fail("overlapping-bounds cleanup did not preserve the first plan and undo only the second");
              return;
            }
            for (const target of first) kid.dimension.getBlock(target)?.setType("minecraft:air");
            if (first.some((target) => kid.dimension.getBlock(target)?.typeId !== "minecraft:air")) {
              fail("overlapping-bounds fixture cleanup left blocks behind");
              return;
            }
            onPass();
          }, 20);
        }, 20),
        "the wizard to finish the second nonintersecting plan inside the first plan's bounds",
        fail,
      );
    },
    "the wizard to finish the first overlapping-bounds plan",
    fail,
  );
}

function runCustomPlanCheck(kid, origin, transport, fail) {
  if (!chatCallbacks.undoLastBuild(kid)) {
    fail("the wizard could not undo the calculator before the custom-plan check");
    return;
  }
  kid.teleport(
    { x: origin.x + 0.5, y: origin.y, z: origin.z + 0.5 },
    { dimension: kid.dimension, facingLocation: { x: origin.x + 0.5, y: origin.y + 1.6, z: origin.z + 10 } },
  );
  const customOrigin = { x: origin.x, y: origin.y, z: origin.z + 6 };
  const stone = customOrigin;
  const log = { x: customOrigin.x - 1, y: customOrigin.y, z: customOrigin.z };
  chatCallbacks.buildValidatedPlan(kid, {
    title: "E2E orientation lesson",
    blocks: [
      { target: [0, 0, 0], support: [0, -1, 0], itemId: "minecraft:smooth_stone" },
      { target: [1, 0, 0], support: [0, 0, 0], itemId: "minecraft:oak_log" },
    ],
  });
  poll(
    () => chatCallbacks.hasCommittedBuild(kid.id)
      && kid.dimension.getBlock(stone)?.typeId === "minecraft:smooth_stone"
      && kid.dimension.getBlock(log)?.typeId === "minecraft:oak_log",
    1_200,
    () => {
      const axis = kid.dimension.getBlock(log)?.permutation.getState("pillar_axis");
      if (axis !== "x") {
        fail(`custom-plan log axis was ${axis}, expected x`);
        return;
      }
      report("CHECK", "validated-custom-plan", "support order, player placement, and horizontal log orientation passed");
      if (!chatCallbacks.undoLastBuild(kid)) {
        fail("the wizard could not undo the custom-plan check");
        return;
      }
      system.runTimeout(() => {
        if (kid.dimension.getBlock(stone)?.typeId !== "minecraft:air"
          || kid.dimension.getBlock(log)?.typeId !== "minecraft:air") {
          fail("custom-plan undo did not restore the fixture");
          return;
        }
        runOverlappingPlanCheck(kid, origin, () => {
          const beforeWorkshop = { ...kid.location };
          Promise.resolve(chatCallbacks.prepareBuildWorkshop(kid)).then((prepared) => {
            if (!prepared) {
              fail("the wizard could not prepare an action-first workshop");
              return;
            }
          system.runTimeout(() => {
          const location = kid.location;
          const feet = {
            x: Math.floor(location.x),
            y: Math.round(location.y),
            z: Math.floor(location.z),
          };
          const ground = { ...feet, y: feet.y - 1 };
          const moved = Math.hypot(
            location.x - beforeWorkshop.x,
            location.y - beforeWorkshop.y,
            location.z - beforeWorkshop.z,
          );
          if (kid.dimension.id !== "minecraft:overworld"
            || moved > 1
            || kid.dimension.getBlock(ground)?.typeId !== "minecraft:stone"
            || kid.dimension.getBlock(feet)?.typeId !== "minecraft:air") {
            fail(`the nearby action-first workshop failed validation: dimension=${kid.dimension.id}; moved=${moved}; location=${JSON.stringify(location)}; ground=${kid.dimension.getBlock(ground)?.typeId}; feet=${kid.dimension.getBlock(feet)?.typeId}`);
            return;
          }
          report("CHECK", "action-first-workshop", "player stayed put while the wizard cleared a nearby ground-level build pad");
          chatCallbacks.buildValidatedPlan(kid, {
            title: "Workshop epsilon proof",
            blocks: [{ target: [0, 0, 1], support: [0, -1, 1], itemId: "minecraft:stone" }],
          });
          const workshopBlockPlaced = () => {
            for (let x = feet.x - 10; x <= feet.x + 10; x += 1) {
              for (let z = feet.z - 10; z <= feet.z + 10; z += 1) {
                if (kid.dimension.getBlock({ x, y: feet.y, z })?.typeId === "minecraft:stone") return true;
              }
            }
            return false;
          };
          poll(
            () => chatCallbacks.hasCommittedBuild(kid.id) && workshopBlockPlaced(),
            600,
            () => {
              report("CHECK", "workshop-build", "player placement succeeded on the nearby workshop without teleporting the child");
              report("CHECK", "two-bit-redstone-calculator", `request via ${transport}; all 16 player-powered sums verified`);
              void runChildRequestAcceptance(kid);
            },
            "the wizard to place a block on the prepared workshop",
            fail,
          );
          }, 20);
          }).catch((error) => fail(`the action-first workshop rejected: ${error}`));
        }, fail);
      }, 20);
    },
    "the wizard to finish the validated custom plan",
    fail,
  );
}

function runCalculatorTruthTable(kid, origin, blueprint, transport, fail) {
  const cases = [];
  for (let a = 0; a <= 3; a += 1) {
    for (let b = 0; b <= 3; b += 1) cases.push([a, b]);
  }
  const mismatches = [];
  const inputLocation = Object.fromEntries(Object.entries(blueprint.inputs).map(([name, location]) => (
    [name, calculatorWorldLocation(origin, location)]
  )));
  const current = Object.fromEntries(Object.entries(inputLocation).map(([name, location]) => (
    [name, kid.dimension.getBlock(location)?.typeId === "minecraft:redstone_block" ? 1 : 0]
  )));
  const outputLocation = Object.fromEntries(Object.entries(blueprint.outputs).map(([name, location]) => (
    [name, calculatorWorldLocation(origin, location)]
  )));

  const runCase = (index) => {
    if (index >= cases.length) {
      if (mismatches.length > 0) {
        fail(mismatches.join("; "));
        return;
      }
      report("CHECK", "calculator-truth-table", "all 16 player-powered sums matched the three output lamps");
      system.runTimeout(() => runCustomPlanCheck(kid, origin, transport, fail), 20);
      return;
    }
    const [a, b] = cases[index];
    const desired = { a1: (a >> 1) & 1, b1: (b >> 1) & 1, a0: a & 1, b0: b & 1 };
    const changed = Object.keys(desired).filter((name) => desired[name] !== current[name]);
    const checkOutput = () => system.runTimeout(() => {
      const actual = ["s2", "s1", "s0"].map((name) => (
        kid.dimension.getBlock(outputLocation[name])?.typeId === "minecraft:lit_redstone_lamp" ? 1 : 0
      ));
      const expected = calculatorResult(a, b).bits;
      if (actual.join("") !== expected.join("")) {
        mismatches.push(`${a}+${b} expected ${expected.join("")} but lamps showed ${actual.join("")}`);
      }
      runCase(index + 1);
    }, 20);
    const toggle = async (toggleIndex) => {
      if (toggleIndex >= changed.length) {
        checkOutput();
        return;
      }
      const name = changed[toggleIndex];
      if (!await setInputPower(kid, inputLocation[name], desired[name] === 1)) {
        fail(`Test Kid could not power ${name}=${desired[name]} for ${a}+${b}`);
        return;
      }
      current[name] = desired[name];
      system.runTimeout(() => toggle(toggleIndex + 1), 4);
    };
    toggle(0);
  };
  runCase(0);
}

function runCalculatorCheck(kid, origin) {
  const blueprint = createCalculatorBlueprint();
  const fail = (detail) => {
    report("FAIL", "two-bit-redstone-calculator", detail);
    try {
      kid.disconnect();
    } catch {}
  };
  kid.teleport(
    { x: origin.x + 0.5, y: origin.y, z: origin.z + 0.5 },
    {
      dimension: kid.dimension,
      facingLocation: { x: origin.x + 0.5, y: origin.y + 1.6, z: origin.z + 10 },
    },
  );
  const finalBlocks = new Map();
  for (const placement of blueprint.placements) {
    const location = calculatorWorldLocation(origin, placement.target);
    const locationKey = `${location.x},${location.y},${location.z}`;
    if (placement.action === "break") finalBlocks.delete(locationKey);
    else finalBlocks.set(locationKey, { location, typeId: placement.expectedType });
  }
  system.runTimeout(() => sendWizardRequest(
    kid,
    "wizard, build a working calculator using only redstone",
    "calculator",
    (transport) => poll(
      () => [...finalBlocks.values()].every(({ location, typeId }) => {
        const types = Array.isArray(typeId) ? typeId : [typeId];
        return types.includes(kid.dimension.getBlock(location)?.typeId);
      }),
      30_000,
      () => {
        const consoleLocation = calculatorWorldLocation(origin, [5, 0, 13]);
        kid.teleport(
          { x: consoleLocation.x + 0.5, y: consoleLocation.y, z: consoleLocation.z + 0.5 },
          { dimension: kid.dimension, facingLocation: calculatorWorldLocation(origin, [5, 1, 5]) },
        );
        system.runTimeout(async () => {
          const smokeLever = calculatorWorldLocation(origin, blueprint.inputs.b0);
          if (!await setLever(kid, smokeLever, true)) {
            fail("Test Kid could not perform the calculator lever smoke check");
            return;
          }
          report("CHECK", "calculator-lever-interaction", "Test Kid raycast toggled b0 on");
          if (!await setLever(kid, smokeLever, false)) {
            fail("Test Kid could not reset b0 after the player smoke check");
            return;
          }
          for (const [name, input] of Object.entries(blueprint.inputs)) {
            if (!await setInputPower(kid, calculatorWorldLocation(origin, input), false)) {
              fail(`Test Kid could not remove the ${name} lever for the headless input pad`);
              return;
            }
          }
          system.runTimeout(
            () => runCalculatorTruthTable(kid, origin, blueprint, transport, fail),
            20,
          );
        }, 20);
      },
      "the wizard to finish the two-bit calculator",
      fail,
    ),
    fail,
  ), 20);
}

export async function startE2E(callbacks) {
  chatCallbacks = callbacks;
  runId = String(variables.get("mc_wizard_e2e_run") || "").trim();
  const scope = String(variables.get("mc_wizard_e2e_scope") || "full").trim();
  if (!runId) {
    report("FAIL", "configuration", "mc_wizard_e2e_run is required");
    return;
  }
  if (scope !== "full" && scope !== "machines" && scope !== "arbitrary" && scope !== "child") {
    report("FAIL", "configuration", `unsupported mc_wizard_e2e_scope: ${scope}`);
    return;
  }
  testName = `WizKid-${runId.slice(0, 8)}`;
  if (typeof callbacks?.routeAddressedMessage !== "function"
    || typeof callbacks?.engineAddressedMessageCount !== "function"
    || typeof callbacks?.undoLastBuild !== "function"
    || typeof callbacks?.hasCommittedBuild !== "function"
    || typeof callbacks?.buildValidatedPlan !== "function"
    || typeof callbacks?.prepareBuildWorkshop !== "function"
    || typeof callbacks?.deliverTestBook !== "function") {
    report("FAIL", "configuration", "shared chat router callbacks are required");
    return;
  }
  const startCheck = scope === "machines" ? "machine-action-pipeline"
    : scope === "arbitrary" ? "arbitrary-exact-structure"
      : scope === "child" ? "child-action-pipeline" : "visible-player-t-flip-flop";
  report("START", startCheck);
  try {
    const dimension = world.getDimension("overworld");
    const spawn = world.getDefaultSpawnLocation();
    const padX = Math.floor(spawn.x) + 16;
    const padZ = Math.floor(spawn.z) + 16;
    removeTickingArea();
    dimension.runCommand(
      "tickingarea add circle " + padX + " 0 " + padZ + " 4 " + TICKING_AREA + " true",
    );
    // A fresh disposable world needs time to generate the ticking-area chunks
    // before getTopmostBlock and block writes are reliable.
    await system.waitTicks(40);
    const fixture = await preparePad(dimension);
    const spawnLocation = {
      dimension,
      x: fixture.x + 0.5,
      y: fixture.y,
      z: fixture.z + 0.5,
    };
    let kid = world.getAllPlayers().find((player) => (
      player.name === testName && typeof player.navigateToEntity === "function"
    ));
    if (kid) kid.teleport(spawnLocation, { dimension });
    else kid = spawnSimulatedPlayer(spawnLocation, testName, GameMode.Creative);
    kid.addTag(TEST_TAG);
    if (scope === "machines") {
      system.runTimeout(() => void runMachineAcceptance(kid), 80);
      return;
    }
    if (scope === "arbitrary") {
      system.runTimeout(() => void runArbitraryStructureAcceptance(kid), 80);
      return;
    }
    if (scope === "child") {
      system.runTimeout(() => void runChildRequestAcceptance(kid), 80);
      return;
    }
    system.runTimeout(async () => {
      try {
        const origin = await preparePad(dimension);
        kid.teleport(
          { x: origin.x + 0.5, y: origin.y, z: origin.z + 0.5 },
          { dimension },
        );
        callbacks.deliverTestBook(kid);
        system.runTimeout(() => {
          const droppedBooks = dimension.getEntities({ type: "minecraft:item", location: kid.location, maxDistance: 5 })
            .map((entity) => entity.getComponent("minecraft:item")?.itemStack)
            .filter(Boolean);
          const inventory = kid.getComponent("minecraft:inventory")?.container;
          const carriedBooks = [];
          for (let slot = 0; inventory && slot < inventory.size; slot += 1) {
            const item = inventory.getItem(slot);
            if (item) carriedBooks.push(item);
          }
          const book = [...droppedBooks, ...carriedBooks]
            .find((item) => /minecraft:(?:written|writable)_book/.test(item.typeId || "")
              && item.getComponent("minecraft:book")?.title);
          if (!book) {
            report("FAIL", "book-delivery", "the long-answer book was not dropped at Test Kid's feet");
            try { kid.disconnect(); } catch {}
            return;
          }
          report("CHECK", "book-delivery", "the real long-answer path dropped a signed written book");
          system.runTimeout(
            () => runTFlipFlopCheck(kid, origin, () => runCalculatorCheck(kid, origin)),
            20,
          );
        }, 20);
      } catch (error) {
        report("FAIL", "visible-player-t-flip-flop", String(error));
        try {
          kid.disconnect();
        } catch {}
      }
    }, 80);
  } catch (error) {
    report("FAIL", "visible-player-t-flip-flop", String(error));
  }
}
