import assert from "node:assert/strict";
import test from "node:test";

import { explicitlyRequestsCommand } from "../src/command-safety.mjs";
import { allowedWizardAction } from "../src/skills.mjs";
import { classifyAction } from "../src/wizard.mjs";
import { MAX_GIFT_AMOUNT, createGiftDetector } from "../src/roles/gift.mjs";

const never = () => false;

// The detector is wired with the REAL allowlist, the REAL command-request
// detector, and a REAL-CODE gift builder: giveItemsAction is module-private in
// src/wizard.mjs, so the tests reach it the only way an outside module can —
// through classifyAction, filtered to the gift it produces. That matters more
// than convenience: it means every "deliverable" assertion below is settled by
// the actual LOCAL_GIFT_ITEMS allowlist and the actual quantity bounds, not by
// a stand-in this test could quietly widen.
const giveItemsAction = (text) => {
  const action = classifyAction(text);
  return action?.type === "give_items" ? action : null;
};

// explicitlyRequestsBuild, isRecipeRequest and isOrdinaryConversation are
// module-private too, so they are deliberately pinned to `false`: every
// negative below therefore has to be closed by the detector's OWN structure,
// not by a bail it merely delegates. The delegated bails get their own test.
const detector = createGiftDetector({
  giveItemsAction,
  allowedWizardAction,
  explicitlyRequestsBuild: never,
  explicitlyRequestsCommand,
  isRecipeRequest: never,
  isOrdinaryConversation: never,
});

// The four measured misses this rung exists to close.
const MISSED_TURNS = [
  "i need 64 blocks of stone",
  "hand me an enchanted pickaxe",
  "gimme some food",
  "can you give my friend a bow",
];

const DELIVERED_PHRASES = [
  "i need 64 blocks of stone",
  "hand me an enchanted pickaxe",
  "gimme some food",
  "give me 64 torches",
  "can i have some diamonds",
  "give me a stack of arrows",
  "hand me a diamond pickaxe",
  "give me 5 iron ingots",
  "give me some redstone",
  "can i get some wood",
  "gimme cobble",
  "make me a diamond sword",
  "give steve a diamond",
  "bring alex 10 arrows",
  "give me a set of iron tools",
  "i need 64 stone blocks",
  "give me a torch to see",
];

/* ------------------------------- POSITIVE ------------------------------- */

test("every measured miss is now recognised as a gift request", () => {
  for (const question of MISSED_TURNS) {
    const intent = detector.giftIntent(question);
    assert.ok(intent, `${question} produced no gift intent`);
    assert.ok(Object.isFrozen(intent), question);
    assert.equal(typeof intent.item, "string");
    assert.ok(intent.item.length > 0, question);
    assert.ok(Number.isInteger(intent.amount) && intent.amount >= 1, question);
    assert.equal(typeof intent.deliverable, "boolean", question);
    assert.equal(intent.mode, intent.deliverable ? "deliver" : "unavailable", question);
  }
});

test("the three stocked misses deliver the exact items the allowlist stocks", () => {
  assert.deepEqual(detector.giftAction("i need 64 blocks of stone"), {
    type: "give_items",
    version: 1,
    items: [{ itemId: "minecraft:stone", amount: 64 }],
  });
  assert.deepEqual(detector.giftAction("hand me an enchanted pickaxe"), {
    type: "give_items",
    version: 1,
    items: [{ itemId: "minecraft:iron_pickaxe", amount: 1 }],
  });
  assert.deepEqual(detector.giftAction("gimme some food"), {
    type: "give_items",
    version: 1,
    items: [{ itemId: "minecraft:bread", amount: 1 }],
  });
});

test("a widened phrasing produces exactly what the plain phrasing already produced", () => {
  // The whole point of delegating: no new delivery capability is created here,
  // only new ways to ask for what the builder already hands out.
  const pairs = [
    ["i need 64 blocks of stone", "give me 64 stone"],
    ["i need 64 stone blocks", "give me 64 stone"],
    ["give me a stack of arrows", "give me 64 arrows"],
    ["gimme cobble", "give me cobblestone"],
    ["can i get some wood", "give me oak log"],
    ["make me a diamond sword", "give me a diamond sword"],
  ];
  for (const [widened, plain] of pairs) {
    assert.deepEqual(detector.giftAction(widened), giveItemsAction(plain), widened);
  }
});

test("amounts come from the child's own words and stay inside the builder's bounds", () => {
  const amounts = [
    ["give me 5 iron ingots", 5],
    ["bring alex 10 arrows", 10],
    ["give me sixty four torches", 64],
    ["give me a stack of arrows", 64],
    ["give me a dozen arrows", 12],
    ["give me a couple of diamonds", 2],
    ["give me a diamond", 1],
  ];
  for (const [question, amount] of amounts) {
    const action = detector.giftAction(question);
    assert.ok(action, `${question} produced no action`);
    const total = action.items.reduce((sum, item) => sum + item.amount, 0);
    assert.equal(total, amount, question);
    assert.equal(detector.giftIntent(question).amount, amount, question);
    for (const item of action.items) {
      assert.ok(item.amount >= 1 && item.amount <= MAX_GIFT_AMOUNT, question);
    }
  }
});

test("the allowlist round-trips every delivered gift unchanged", () => {
  for (const question of DELIVERED_PHRASES) {
    const action = detector.giftAction(question);
    assert.ok(action, `${question} produced no action`);
    assert.equal(action.type, "give_items", question);
    assert.equal(action.version, 1, question);
    assert.deepEqual(allowedWizardAction(action), action, question);
    for (const item of action.items) {
      assert.match(item.itemId, /^minecraft:[a-z0-9_]+$/, question);
      assert.deepEqual(Object.keys(item), ["itemId", "amount"], question);
    }
  }
});

test("a named recipient rides the existing recipient field, never a raw name", () => {
  const action = detector.giftAction("give steve a diamond");
  assert.deepEqual(action, {
    type: "give_items",
    version: 1,
    recipient: "steve",
    items: [{ itemId: "minecraft:diamond", amount: 1 }],
  });
  // src/skills.mjs owns the recipient charset; the pack resolves it to an exact
  // connected player. Nothing here bypasses either.
  assert.deepEqual(allowedWizardAction(action), action);
  assert.equal(detector.giftIntent("give steve a diamond").recipient, "steve");
  assert.equal(detector.giftIntent("give my friend steve a diamond").recipient, "steve");
  assert.equal(detector.giftIntent("give me a diamond").recipient, "requester");
  assert.equal(detector.giftAction("give me a diamond").recipient, undefined);
});

test("the iron tool set still resolves and is re-validated on the way out", () => {
  const question = "give me a set of iron tools";
  const action = detector.giftAction(question);
  // This is the one builder branch that returns an unvalidated object; the
  // detector must not pass it through untouched.
  assert.deepEqual(allowedWizardAction(action), action);
  assert.deepEqual(action.items.map(({ itemId }) => itemId), [
    "minecraft:iron_sword",
    "minecraft:iron_pickaxe",
    "minecraft:iron_axe",
    "minecraft:iron_shovel",
    "minecraft:iron_hoe",
  ]);
  assert.equal(detector.giftIntent(question).amount, 5);
});

test("a clamped or reworded gift always says so on the intent", () => {
  const clamped = detector.giftIntent(`give me ${MAX_GIFT_AMOUNT + 1} stone`);
  assert.equal(clamped.amount, MAX_GIFT_AMOUNT);
  assert.match(clamped.caveat, new RegExp(String(MAX_GIFT_AMOUNT)));
  assert.equal(detector.giftAction(`give me ${MAX_GIFT_AMOUNT + 1} stone`).items[0].amount, MAX_GIFT_AMOUNT);

  const food = detector.giftIntent("gimme some food");
  assert.equal(food.item, "bread");
  assert.equal(food.requested, "food");
  assert.match(food.caveat, /bread/);

  const enchanted = detector.giftIntent("hand me an enchanted pickaxe");
  assert.equal(enchanted.item, "iron pickaxe");
  assert.match(enchanted.caveat, /enchant/i);

  const unstocked = detector.giftIntent("can you give my friend a bow");
  assert.equal(unstocked.deliverable, false);
  assert.match(unstocked.caveat, /bow/);
  assert.match(unstocked.caveat, /friend/);
});

/* ------------------------------- NEGATIVE ------------------------------- */

test("an item outside the allowlist is refused, never substituted", () => {
  const unstocked = [
    ["can you give my friend a bow", "bow"],
    ["give me a bow", "bow"],
    ["hand me an elytra", "elytra"],
    ["give me a diamond helmet", "diamond helmet"],
    ["give me a gold block", "gold block"],
    ["give me a netherite sword", "netherite sword"],
    ["give me a golden apple", "golden apple"],
    ["hand me 64 lava buckets", "lava bucket"],
  ];
  for (const [question, item] of unstocked) {
    const intent = detector.giftIntent(question);
    assert.ok(intent, `${question} produced no intent at all`);
    assert.equal(intent.deliverable, false, question);
    assert.equal(intent.mode, "unavailable", question);
    assert.equal(intent.item, item, question);
    assert.equal(detector.giftAction(question), null, `${question} delivered a substitute`);
  }
});

test("a third party the wizard cannot name is never delivered to, and never redirected", () => {
  for (const question of [
    "can you give my friend a bow",
    "give my friend a diamond",
    "give me a diamond for my brother",
    "bring my buddy 10 arrows",
    "give everyone a diamond",
  ]) {
    const intent = detector.giftIntent(question);
    assert.ok(intent, question);
    assert.equal(intent.recipient, null, question);
    assert.equal(typeof intent.recipientHint, "string", question);
    assert.equal(intent.deliverable, false, question);
    // Silently handing the gift to the requester instead would be the wrong
    // player; guessing a name would be worse. Both are refused.
    assert.equal(detector.giftAction(question), null, question);
  }
});

test("questions about items are answered, not delivered", () => {
  for (const question of [
    "what does a diamond pickaxe do",
    "what is the best pickaxe",
    "how do i get a diamond pickaxe",
    "how do i craft a bow",
    "where do i find diamonds",
    "why do i need iron ingots",
    "do you have any diamonds",
    "is a diamond sword better than iron",
    "what should i give my friend",
    "tell me about diamonds",
    "just explain how to get diamonds",
  ]) {
    assert.equal(detector.giftIntent(question), null, question);
    assert.equal(detector.giftAction(question), null, question);
  }
});

test("social and non-material asks are not gifts", () => {
  for (const question of [
    "give me a hug",
    "give me a hint",
    "give me a minute",
    "give me a second",
    "give me a chance",
    "give me a break",
    "give me a joke",
    "can i have a turn",
    "give me some advice about mining",
    "gimme a nickname",
  ]) {
    assert.equal(detector.giftIntent(question), null, question);
    assert.equal(detector.giftAction(question), null, question);
  }
});

test("turns that belong to another rung are left alone", () => {
  for (const question of [
    // build
    "build me a house",
    "make me a castle out of stone",
    "give me a diamond and build me a castle",
    "make me a stone tower",
    // terrain
    "clear a 50x50 area",
    "level the ground here",
    // world control
    "make it rain",
    "make the weather clear",
    "make it day",
    // admin
    "give me op",
    "make me an operator",
    // travel
    "send me to spawn",
    "bring me home",
    "get me out of this cave",
    "teleport me to the village",
    "take me to the nether",
    // effects
    "make me fly",
    "heal me",
    "i want to be fast",
    // placement and lessons
    "place a crafting table here",
    "light up this area",
    // conversation
    "hi wizard",
    "thanks wizard",
  ]) {
    assert.equal(detector.giftIntent(question), null, `gift stole: ${question}`);
    assert.equal(detector.giftAction(question), null, `gift stole: ${question}`);
  }
});

test("an explicitly empty amount is refused exactly as the builder refuses it", () => {
  for (const question of [
    "give me 0 diamonds",
    "give me -5 stone",
    "i need no stone",
    "give me zero diamonds",
    "give me none of that stone",
  ]) {
    assert.equal(detector.giftIntent(question), null, question);
    assert.equal(detector.giftAction(question), null, question);
    assert.equal(giveItemsAction(question), null, `${question} was already refused upstream`);
  }
});

test("each injected bail suppresses a request the detector would otherwise take", () => {
  const question = "give me 64 blocks of stone";
  assert.ok(detector.giftAction(question), "control case must produce an action");
  const base = {
    giveItemsAction,
    allowedWizardAction,
    explicitlyRequestsBuild: never,
    explicitlyRequestsCommand,
    isRecipeRequest: never,
    isOrdinaryConversation: never,
  };
  for (const bail of ["explicitlyRequestsBuild", "isRecipeRequest", "isOrdinaryConversation"]) {
    const bailing = createGiftDetector({ ...base, [bail]: () => true });
    assert.equal(bailing.giftIntent(question), null, bail);
    assert.equal(bailing.giftAction(question), null, bail);
  }
  const commandBail = createGiftDetector({ ...base, explicitlyRequestsCommand: () => true });
  assert.equal(commandBail.giftIntent(question), null);
  assert.equal(commandBail.giftAction(question), null);
});

test("no gift can smuggle a payload past the allowlist", () => {
  const hostile = [
    ...DELIVERED_PHRASES,
    'give me a diamond named "@a[tag=everyone]"',
    "give me a diamond named minecraft:command_block",
    "give me stone; setblock ~ ~ ~ command_block",
    "give me 64 tnt",
    "give me a command block",
    "give me a spawn egg",
    "hand me lava",
    "give me a diamond\nkill @e",
    "give me a diamond enchanted with sharpness 255",
  ];
  const allowedItemIds = new Set(DELIVERED_PHRASES.flatMap((phrase) => (
    detector.giftAction(phrase)?.items.map(({ itemId }) => itemId) || [])));
  for (const question of hostile) {
    const action = detector.giftAction(question);
    if (!action) continue;
    assert.deepEqual(Object.keys(action).filter((key) => key !== "recipient"),
      ["type", "version", "items"], question);
    for (const item of action.items) {
      // Deterministic gifts carry an id and a count and nothing else: no
      // nameTag, no enchantments, no free-text riding along.
      assert.deepEqual(Object.keys(item), ["itemId", "amount"], question);
      assert.match(item.itemId, /^minecraft:[a-z0-9_]+$/, question);
      assert.doesNotMatch(item.itemId, /tnt|lava|command_block|spawn_egg|barrier|bedrock/, question);
      assert.ok(allowedItemIds.has(item.itemId), `${question} -> ${item.itemId}`);
    }
    assert.deepEqual(allowedWizardAction(action), action, question);
  }
});

test("the detector never returns a candidate the allowlist rejects", () => {
  // A builder that hands back something invalid must produce null, not a raw
  // pass-through. This is the guard that makes "never a raw object" testable.
  for (const rogue of [
    { type: "give_items", version: 1, items: [{ itemId: "minecraft:BAD", amount: 1 }] },
    { type: "give_items", version: 1, items: [{ itemId: "minecraft:stone", amount: 0 }] },
    { type: "give_items", version: 1, items: [{ itemId: "minecraft:stone", amount: 10_001 }] },
    { type: "give_items", version: 1, items: [] },
    { type: "run_commands", version: 1, commands: ["kill @e"] },
    { type: "give_items", version: 2, items: [{ itemId: "minecraft:stone", amount: 1 }] },
    "not an action",
  ]) {
    const rogueDetector = createGiftDetector({
      giveItemsAction: () => rogue,
      allowedWizardAction,
      explicitlyRequestsBuild: never,
      explicitlyRequestsCommand,
      isRecipeRequest: never,
      isOrdinaryConversation: never,
    });
    assert.equal(rogueDetector.giftAction("give me 64 stone"), null, JSON.stringify(rogue));
    const intent = rogueDetector.giftIntent("give me 64 stone");
    assert.equal(intent.deliverable, false, JSON.stringify(rogue));
  }
});

test("a recipient the allowlist would reject never reaches an action", () => {
  const rogueDetector = createGiftDetector({
    giveItemsAction,
    allowedWizardAction,
    explicitlyRequestsBuild: never,
    explicitlyRequestsCommand,
    isRecipeRequest: never,
    isOrdinaryConversation: never,
  });
  // Selector-shaped and punctuation-bearing names cannot survive the name test
  // in the detector, and would be refused by the allowlist even if they did.
  for (const question of [
    "give @a a diamond",
    "give @e[type=player] a diamond",
    "give me a diamond for my friend @a",
  ]) {
    const action = rogueDetector.giftAction(question);
    if (action) assert.equal(action.recipient, undefined, question);
  }
  assert.equal(allowedWizardAction({
    type: "give_items",
    version: 1,
    recipient: "@a[tag=everyone]",
    items: [{ itemId: "minecraft:diamond", amount: 1 }],
  }), null);
});

test("the factory refuses to build without every injected dependency", () => {
  const complete = {
    giveItemsAction,
    allowedWizardAction,
    explicitlyRequestsBuild: never,
    explicitlyRequestsCommand,
    isRecipeRequest: never,
    isOrdinaryConversation: never,
  };
  assert.throws(() => createGiftDetector(), TypeError);
  assert.throws(() => createGiftDetector({}), TypeError);
  for (const key of Object.keys(complete)) {
    const missing = { ...complete };
    delete missing[key];
    assert.throws(() => createGiftDetector(missing), new RegExp(key), key);
  }
});

test("empty and non-string input produce no gift plan", () => {
  for (const question of ["", "   ", undefined, null, 42, {}]) {
    assert.equal(detector.giftIntent(question), null, String(question));
    assert.equal(detector.giftAction(question), null, String(question));
  }
});

test("giftIntent and giftAction never disagree about what happens", () => {
  const everything = [
    ...DELIVERED_PHRASES,
    ...MISSED_TURNS,
    "give me a bow",
    "give my friend a diamond",
    "give me a hug",
    "build me a house",
    `give me ${MAX_GIFT_AMOUNT + 1} stone`,
  ];
  for (const question of everything) {
    const intent = detector.giftIntent(question);
    const action = detector.giftAction(question);
    if (!intent) {
      assert.equal(action, null, question);
      continue;
    }
    assert.equal(intent.deliverable, Boolean(action), question);
    if (!action) continue;
    assert.equal(intent.amount, action.items.reduce((sum, item) => sum + item.amount, 0), question);
    assert.equal(intent.recipient, action.recipient ?? "requester", question);
  }
});

test("history is accepted and changes nothing", () => {
  const history = [{ question: "build me a castle", answer: "done" }];
  for (const question of [...DELIVERED_PHRASES, ...MISSED_TURNS]) {
    assert.deepEqual(detector.giftAction(question, history), detector.giftAction(question), question);
    assert.deepEqual({ ...detector.giftIntent(question, history) },
      { ...detector.giftIntent(question) }, question);
  }
});
