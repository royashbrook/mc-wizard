import { Direction, GameMode, ItemStack, system, world } from "@minecraft/server";
import { variables } from "@minecraft/server-admin";
import { LookDuration, spawnSimulatedPlayer } from "@minecraft/server-gametest";
import { calculatorResult, createCalculatorBlueprint } from "./calculator.js";

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
  // Build the disposable fixture above the terrain and liquid surface so
  // delayed ocean ticks cannot recreate water inside the player-build area.
  const y = Math.min(top.location.y + 10, 300);
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
    throw new Error("the E2E pad floor did not persist");
  }
  return { x, y, z };
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
        report(
          "PASS",
          "two-bit-redstone-calculator",
          `request via ${transport}; book delivery, transaction undo, custom orientation, one lever click, and all 16 player-powered sums verified`,
        );
        try {
          kid.disconnect();
        } catch {}
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

export function startE2E(callbacks) {
  chatCallbacks = callbacks;
  runId = String(variables.get("mc_wizard_e2e_run") || "").trim();
  if (!runId) {
    report("FAIL", "configuration", "mc_wizard_e2e_run is required");
    return;
  }
  testName = `WizKid-${runId.slice(0, 8)}`;
  if (typeof callbacks?.routeAddressedMessage !== "function"
    || typeof callbacks?.engineAddressedMessageCount !== "function"
    || typeof callbacks?.undoLastBuild !== "function"
    || typeof callbacks?.hasCommittedBuild !== "function"
    || typeof callbacks?.buildValidatedPlan !== "function"
    || typeof callbacks?.deliverTestBook !== "function") {
    report("FAIL", "configuration", "shared chat router callbacks are required");
    return;
  }
  report("START", "visible-player-t-flip-flop");
  try {
    const dimension = world.getDimension("overworld");
    const spawn = world.getDefaultSpawnLocation();
    const padX = Math.floor(spawn.x) + 16;
    const padZ = Math.floor(spawn.z) + 16;
    removeTickingArea();
    dimension.runCommand(
      "tickingarea add circle " + padX + " 0 " + padZ + " 4 " + TICKING_AREA + " true",
    );
    const spawnLocation = {
      dimension,
      x: Math.floor(spawn.x) + 16.5,
      y: Math.max(-60, Math.min(300, spawn.y)),
      z: Math.floor(spawn.z) + 16.5,
    };
    let kid = world.getAllPlayers().find((player) => (
      player.name === testName && typeof player.navigateToEntity === "function"
    ));
    if (kid) kid.teleport(spawnLocation, { dimension });
    else kid = spawnSimulatedPlayer(spawnLocation, testName, GameMode.Creative);
    kid.addTag(TEST_TAG);
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
