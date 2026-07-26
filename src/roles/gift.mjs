// Gift detector role (#44).
//
// MEASURED GAP. Four ordinary child phrasings produced no action at all:
//   "i need 64 blocks of stone"       (no delivery verb at all)
//   "hand me an enchanted pickaxe"    ("enchanted" polluted the item terms and
//                                      a bare "pickaxe" names no material)
//   "gimme some food"                 ("gimme" is not a delivery verb here and
//                                      "food" is a category, not an item id)
//   "can you give my friend a bow"    (a third party, and "bow" is not stocked)
// Every one of them ended in "my spellbook has nothing on that yet" even though
// the Wizard demonstrably delivers items. This module is the deterministic rung
// that turns those turns into either a real delivery or an honest, bounded
// offer — never silence.
//
// CONTRACT
//   createGiftDetector(deps) -> { giftIntent, giftAction }
//
// Every dependency is INJECTED. This module must never import src/wizard.mjs:
// giveItemsAction lives there and importing it would create a cycle (wizard.mjs
// is what wires this detector into classifyAction). Injection also keeps the
// detector independently unit-testable with no server, no provider, no world.
//
// SAFETY POSTURE — DETECTION WIDENS, AUTHORITY DOES NOT.
//   * This module owns NO item allowlist. It never builds an itemId. It
//     normalises the child's phrasing into a canonical request string and hands
//     that string to the INJECTED builder, so LOCAL_GIFT_ITEMS in src/wizard.mjs
//     remains the single authority on what can be conjured. An item the builder
//     does not stock comes back null and stays null: the intent record reports
//     `deliverable: false` and giftAction returns null. Nothing is ever
//     substituted for a refused item.
//   * Quantity bounds are likewise the builder's. The only arithmetic here is a
//     clamp DOWN to MAX_GIFT_AMOUNT (the ceiling src/skills.mjs already
//     enforces), and a clamp is never silent — it lands on intent.caveat.
//   * A named recipient is passed as the existing `recipient` field, which
//     src/skills.mjs charset-validates and the pack resolves through its own
//     giftRecipient() exact-connected-player lookup. A relation with no name
//     ("my friend") is NOT guessed: the intent says so and giftAction returns
//     null rather than deliver to the wrong player.
//   * Every returned action is the value allowedWizardAction produced, never a
//     raw object this module authored. That matters doubly here: one branch of
//     the injected builder (the iron tool set) returns an unvalidated object,
//     and this rung re-validates it.
//
// The rung is CODE-authored, so none of the model-policing gates
// (providerActionMatchesRequest, providerPowerMatchesRequest, subject fidelity)
// apply to it, and none of them is edited or widened by this work.

// Mirrors the per-item ceiling src/skills.mjs already enforces; used only to
// clamp DOWN, and only with a caveat.
export const MAX_GIFT_AMOUNT = 10_000;

// Delivery verbs. "place"/"put down" are deliberately absent: those belong to
// simpleBlockPlacementAction. "summon"/"spawn" are absent: entities are not
// gifts. "make"/"craft" are present but sit behind the build bails below.
const GIFT_VERB = "give|gimme|gimmie|gimma|hand|bring|drop|deliver|send|pass|fetch|grab|get|make|craft|conjure";
const IMPERATIVE_GIFT_VERB = new RegExp(`^(${GIFT_VERB})\\b\\s*(.*)$`, "i");
// "gimme"/"lemme" already carry their own recipient.
const SELF_CONTRACTION = /^(?:gimme|gimmie|gimma)$/i;
// The verbs that describe MAKING a thing rather than handing one over. See
// giftClause: these only open a gift clause when the very next word says who
// the thing is for.
const CRAFT_VERB = /^(?:make|craft|conjure)$/i;
const SELF_OBJECT = /^(?:me|us|myself|ourselves)\b/i;

// Request framings that are grammatically interrogative but are plainly asks.
// Checked BEFORE the interrogative bail so "can i have some diamonds" survives
// while "what does a diamond pickaxe do" does not.
const ASK_FRAMING = /^(?:can|could|may|would|will)\s+(?:i|we)\s+(?:please\s+)?(?:have|get|grab)\b\s*(.*)$/i;
const NEED_FRAMING = /^(?:i|we)\s+(?:really\s+)?(?:want|need|could\s+use)\b\s*(.*)$/i;

// Conversational lead-ins that sit in front of an imperative. Stripping them is
// what turns "wiz can you give me a diamond" into an imperative.
const LEADERS = [
  /^(?:hey|hi|yo)\b[,\s]*/i,
  /^(?:wizard|wiz)\b[,:\s]*/i,
  /^(?:can|could|would|will)\s+you\s+/i,
  /^(?:i|we)\s+(?:really\s+)?(?:want|need)\s+(?:you\s+)?to\s+/i,
  /^please\s+/i,
  /^just\s+/i,
  /^(?:go\s+ahead\s+and|go\s+and)\s+/i,
  /^(?:now|first|next|then)\s+/i,
];

// Question framing: "what does an enchanted pickaxe do" is curiosity, not an
// order. Checked after the lead-ins are stripped, so "can you give me ..." (a
// request) is not mistaken for an interrogative.
const INTERROGATIVE = /^(?:what|whats|what['’]s|why|how|when|where|who|whose|which|is|are|was|were|do|does|did|should|shall|may|might|must|am|if)\b/i;

// A gift clause entangled with construction belongs to the build path.
const BUILD_ENTANGLED = /\b(?:build|builds|building|built|construct|constructs|constructing|erect|erects|rebuild|rebuilds|rebuilding)\b/i;

// "make" is a delivery verb here ("make me a diamond sword"), which puts this
// rung one word away from the build path. Naming anything the build ladder
// builds hands the turn straight back — the same vocabulary explicitlyRequestsBuild
// uses, kept local so the bail holds even when that predicate is not consulted.
const BUILD_SUBJECT = /\b(?:farm|machine|harvester|generator|elevator|engine|factory|smelter|sorter|door|contraption|circuit|calculator|adder|flip\s*flop|portal|castle|house|home|tower|bridge|barn|base|shop|school|wall|monument|city|village|settlement|treehouse|dragon|statue|sculpture|maze|pixel\s+art|vehicle|boat|ship|car|duck|animal|creature|furniture|sofa|couch|chair|desk|table|bed|room|roof|floor|fence|garden)\b/i;

// Travel destinations. "send me to spawn" and "get me out of this cave" use
// delivery verbs but are travel turns; they own their own rung.
const TRAVEL_TAIL = /\b(?:to|into|out\s+of|back\s+to)\s+(?:the\s+|this\s+|my\s+)?(?:nether|end|overworld|spawn|home|base|village|cave|surface|world|dimension|portal)\b/i;

// Words that carry no item identity. Stripped before the item phrase is read.
// "block"/"piece"/"stack" are NOT here on purpose — see PARTITIVE below.
const FILLER = new Set([
  "a", "an", "the", "some", "any", "more", "few", "couple", "bunch", "lot", "lots", "of",
  "dozen", "handful", "stack", "piece", "load", "pile",
  "my", "your", "our", "me", "us", "please", "pls", "plz", "thanks", "thank", "you", "ok", "okay",
  "right", "now", "here", "there", "real", "really", "very", "quick", "quickly", "extra",
  "whole", "entire", "big", "huge", "giant", "large", "tiny", "small", "little",
  "cool", "awesome", "epic", "super", "strong", "powerful", "sturdy", "good", "best", "better",
  "nice", "new", "fresh", "sharp", "fast", "shiny", "magic", "magical",
  "enchanted", "enchant", "enchantment", "enchanting",
  "and", "for", "to", "with", "so", "i", "we", "can", "could", "would", "will", "like", "love",
  "have", "want", "need", "wizard", "wiz", "hey", "hi", "is", "it", "that", "this", "them", "they",
  "gimme", "gimmie", "gimma", "give", "bring", "hand", "drop", "deliver", "send", "pass",
  "fetch", "grab", "get", "make", "craft", "conjure",
]);

// Partitive phrasing: "64 blocks of stone", "a stack of arrows". The head noun
// is what follows, so the measure word is dropped only in this exact shape.
const PARTITIVE = /\b(?:blocks?|pieces?|stacks?|bunch(?:es)?|lots?|loads?)\s+of\b/gi;

// A trailing bare "block" may be dropped ONLY for materials whose item form IS
// the block. "gold block" is a different item from a gold ingot and must stay
// unresolvable rather than be quietly downgraded.
const BLOCK_IS_THE_ITEM = new Set(["stone", "cobblestone", "oak plank", "oak log"]);

// Recognition vocabulary. This is NOT a delivery allowlist: it only decides
// "the child is asking for a thing". Deliverability is settled entirely by the
// injected builder. Social nouns (hug, hint, joke, minute, favor, ...) are
// absent on purpose so "give me a hug" is never read as a gift. Build nouns
// (boat, door, bed, table, ...) are absent so the build path keeps its turns.
const ITEM_NOUN = new Set([
  "arrow", "bow", "crossbow", "sword", "pickaxe", "pick", "axe", "shovel", "spade", "hoe",
  "shield", "armor", "armour", "helmet", "chestplate", "legging", "boot", "elytra", "trident",
  "diamond", "emerald", "gold", "golden", "iron", "copper", "redstone", "lapis", "netherite",
  "coal", "quartz", "ingot", "nugget",
  "stone", "cobblestone", "cobble", "rock", "dirt", "sand", "gravel", "glass", "obsidian",
  "wood", "lumber", "log", "plank", "stick", "brick",
  "torch", "lantern", "lever", "button", "hopper", "piston", "observer", "repeater",
  "comparator", "chest", "barrel", "furnace", "anvil", "bucket", "saddle",
  "bread", "food", "apple", "cake", "cookie", "steak", "meat", "carrot", "potion",
  "tool", "kit",
]);

// Child words for things the builder already stocks. The value is a phrase the
// builder resolves; it is never an item id and never reaches the world without
// the builder and the allowlist agreeing. Applied only to a phrase that is
// exactly the alias, so "gold block" is not folded into "gold ingot".
const ITEM_ALIAS = new Map([
  ["food", "bread"],
  ["rock", "stone"],
  ["cobble", "cobblestone"],
  ["wood", "oak log"],
  ["lumber", "oak log"],
  ["log", "oak log"],
  ["plank", "oak plank"],
  ["gold", "gold ingot"],
  ["golden", "gold ingot"],
  ["iron", "iron ingot"],
  ["copper", "copper ingot"],
  ["pickaxe", "iron pickaxe"],
  ["pick", "iron pickaxe"],
  ["sword", "iron sword"],
  ["axe", "iron axe"],
  ["shovel", "iron shovel"],
  ["spade", "iron shovel"],
  ["hoe", "iron hoe"],
]);

// Relations a child names instead of a player name.
const RELATION = new Set([
  "friend", "friends", "buddy", "buddies", "pal", "pals", "brother", "sister", "sibling",
  "mom", "mum", "dad", "cousin", "family", "everyone", "everybody", "team", "party",
  "him", "her", "them", "they", "someone", "somebody", "son", "daughter",
  "grandma", "grandpa", "teacher", "classmate", "player", "players",
]);
const SELF = new Set(["me", "us", "myself", "ourselves"]);

const NUMBER_WORD = new Map([
  ["sixty four", 64], ["thirty two", 32],
  ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6], ["seven", 7],
  ["eight", 8], ["nine", 9], ["ten", 10], ["eleven", 11], ["twelve", 12], ["thirteen", 13],
  ["fourteen", 14], ["fifteen", 15], ["sixteen", 16], ["seventeen", 17], ["eighteen", 18],
  ["nineteen", 19], ["twenty", 20], ["thirty", 30], ["forty", 40], ["fifty", 50], ["sixty", 60],
]);
const NUMBER_WORD_PATTERN = new RegExp(`\\b(${[...NUMBER_WORD.keys()]
  .map((word) => word.replace(/ /g, "[- ]")).join("|")})\\b`, "i");

// Mirrors normalizedWord in src/wizard.mjs (module-private there). A pure,
// three-line singulariser; duplicating it keeps this module import-free.
function singular(value) {
  const word = String(value || "").toLowerCase();
  if (word.endsWith("ches")) return word.slice(0, -2);
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

// Mirrors requestClauses in src/wizard.mjs.
function clausesOf(question) {
  return String(question || "")
    .split(/(?:[.!?;—]+|\b(?:and\s+)?then\b)/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function stripLeaders(clause) {
  let text = clause;
  for (let pass = 0; pass < LEADERS.length; pass += 1) {
    const before = text;
    for (const leader of LEADERS) text = text.replace(leader, "");
    text = text.trim();
    if (text === before) break;
  }
  return text;
}

function requireFunctions(deps, names) {
  for (const name of names) {
    if (typeof deps?.[name] !== "function") {
      throw new TypeError(`createGiftDetector requires a ${name} function`);
    }
  }
}

function looksLikePlayerName(token) {
  if (!/^[a-z][a-z0-9_]{2,15}$/i.test(token)) return false;
  const word = token.toLowerCase();
  return !SELF.has(word) && !RELATION.has(word) && !FILLER.has(word)
    && !ITEM_NOUN.has(singular(word)) && !ITEM_ALIAS.has(singular(word))
    && !NUMBER_WORD.has(word) && !/^(?:block|blocks|piece|pieces|stack|stacks)$/.test(word);
}

// Who the gift is for. Returns { recipient, hint, rest } where recipient is a
// player name, "requester", or null (a third party this rung cannot name).
function readRecipient(tail, selfImplied) {
  let text = String(tail || "").trim();

  // "a bow for my friend", "10 arrows to my brother alex" — the relation
  // trails the item. Lift it out first so it never pollutes the item phrase.
  let trailing;
  const trailed = text.match(/\b(?:for|to)\s+(?:my|our|the)\s+([a-z]+)\b\s*([a-z0-9_]*)/i);
  if (trailed && RELATION.has(trailed[1].toLowerCase())) {
    trailing = {
      recipient: looksLikePlayerName(trailed[2]) ? trailed[2] : null,
      hint: trailed[1].toLowerCase(),
    };
    text = text.replace(trailed[0], " ").replace(/\s+/g, " ").trim();
  }
  const settle = (result) => (trailing ? { ...result, ...trailing } : result);

  if (selfImplied) return settle({ recipient: "requester", rest: text });

  const self = text.match(/^(me|us|myself|ourselves)\b\s*(.*)$/i);
  if (self) return settle({ recipient: "requester", rest: self[2] });

  const related = text.match(/^(?:my|our|the)\s+([a-z]+)\b\s*(.*)$/i);
  if (related && RELATION.has(related[1].toLowerCase())) {
    const named = related[2].match(/^([a-z0-9_]+)\b\s*(.*)$/i);
    if (named && looksLikePlayerName(named[1])) {
      return { recipient: named[1], hint: related[1].toLowerCase(), rest: named[2] };
    }
    return { recipient: null, hint: related[1].toLowerCase(), rest: related[2] };
  }

  const bare = text.match(/^([a-z0-9_]+)\b\s*(.*)$/i);
  if (bare && RELATION.has(bare[1].toLowerCase())) {
    // "give everyone a diamond" — a third party with no name at all.
    return { recipient: null, hint: bare[1].toLowerCase(), rest: bare[2] };
  }
  if (bare && looksLikePlayerName(bare[1]) && bare[2].trim()) {
    return settle({ recipient: bare[1], rest: bare[2] });
  }
  return settle({ recipient: "requester", rest: text });
}

// How many. `null` means the child explicitly asked for none (refuse);
// `undefined` means they named no amount (the builder's own default wins).
function readAmount(text) {
  const tail = String(text || "");
  if (/\b(?:no|zero|none)\b/i.test(tail)) return { amount: null };
  // Signed, exactly as requestedItemAmount in src/wizard.mjs reads it, so an
  // impossible amount is refused here the same way it is refused there.
  const numeric = tail.match(/(?:^|\s)([+-]?\d{1,9})\b/);
  if (numeric) {
    const requested = Number(numeric[1]);
    if (!Number.isInteger(requested) || requested < 1) return { amount: null };
    return requested > MAX_GIFT_AMOUNT
      ? { amount: MAX_GIFT_AMOUNT, requested }
      : { amount: requested };
  }
  if (/\bstacks?\b/i.test(tail)) return { amount: 64 };
  if (/\bdozen\b/i.test(tail)) return { amount: 12 };
  if (/\bcouple\b/i.test(tail)) return { amount: 2 };
  const word = tail.match(NUMBER_WORD_PATTERN);
  if (word) return { amount: NUMBER_WORD.get(word[1].toLowerCase().replace(/-/g, " ")) };
  return { amount: undefined };
}

// The item phrase, as the child named it: filler and measure words removed,
// tokens singularised, order preserved. No identity is ever changed here.
function readItemPhrase(text) {
  const cleaned = String(text || "").replace(PARTITIVE, " ");
  const tokens = (cleaned.toLowerCase().match(/[a-z0-9_]+/g) || [])
    .filter((token) => !/^\d+$/.test(token))
    .map(singular)
    .filter((token) => !FILLER.has(token) && !NUMBER_WORD.has(token));
  if (tokens.length && tokens.at(-1) === "block") {
    // "stone block" is stone; "gold block" is NOT a gold ingot, so it keeps the
    // word and stays unresolvable rather than being quietly downgraded.
    const withoutBlock = tokens.slice(0, -1).join(" ");
    return BLOCK_IS_THE_ITEM.has(withoutBlock) ? withoutBlock : tokens.join(" ");
  }
  // Trailing words that name no item ("a torch to see") are purpose, not
  // identity. Cutting at the LAST item noun keeps every identity-bearing word
  // — "gold block", "diamond helmet" and "lava bucket" all stay whole and all
  // stay refusable — while "torch see" becomes "torch".
  const last = tokens.reduce((found, token, index) => (
    ITEM_NOUN.has(token) || ITEM_ALIAS.has(token) ? index : found), -1);
  return (last === -1 ? tokens : tokens.slice(0, last + 1)).join(" ");
}

export function createGiftDetector(deps = {}) {
  requireFunctions(deps, [
    "giveItemsAction",
    "allowedWizardAction",
    "explicitlyRequestsBuild",
    "explicitlyRequestsCommand",
    "isRecipeRequest",
    "isOrdinaryConversation",
  ]);
  const {
    giveItemsAction,
    allowedWizardAction,
    explicitlyRequestsBuild,
    explicitlyRequestsCommand,
    isRecipeRequest,
    isOrdinaryConversation,
  } = deps;

  // The one place that decides "this clause asks the wizard for a thing".
  function giftClause(question) {
    for (const clause of clausesOf(question)) {
      const direct = stripLeaders(clause);
      if (!direct) continue;
      if (TRAVEL_TAIL.test(direct)) continue;
      const asked = direct.match(ASK_FRAMING);
      if (asked) return { tail: asked[1], selfImplied: true };
      if (INTERROGATIVE.test(direct)) continue;
      const needed = direct.match(NEED_FRAMING);
      if (needed) return { tail: needed[1], selfImplied: true };
      const imperative = direct.match(IMPERATIVE_GIFT_VERB);
      if (imperative) {
        // A CRAFTING verb only hands something over when it names who gets it.
        // Measured while wiring this detector into the ladder (#44 WP-F): "make
        // a redstone lamp turn on" is a mechanism a child wants built, and it
        // came back as one redstone dust, because "make" opened a gift clause
        // whose head noun happened to be an item. "make me a diamond sword"
        // still delivers; a bare "make <thing> <do something>" belongs to the
        // build path, which is where it now stays.
        if (CRAFT_VERB.test(imperative[1]) && !SELF_OBJECT.test(imperative[2])) continue;
        return { tail: imperative[2], selfImplied: SELF_CONTRACTION.test(imperative[1]) };
      }
    }
    return null;
  }

  function plan(question) {
    const text = String(question || "");
    if (!text.trim()) return null;
    // Bails, cheapest first. Each hands the turn to a route that already owns
    // it: conversation, recipes, command lessons, builds.
    if (isOrdinaryConversation(text)) return null;
    if (isRecipeRequest(text)) return null;
    if (explicitlyRequestsCommand(text)) return null;
    if (explicitlyRequestsBuild(text)) return null;
    if (BUILD_ENTANGLED.test(text) || BUILD_SUBJECT.test(text)) return null;

    const found = giftClause(text);
    if (!found) return null;

    const { recipient, hint, rest } = readRecipient(found.tail, found.selfImplied);
    const { amount, requested } = readAmount(rest);
    if (amount === null) return null;

    const phrase = readItemPhrase(rest);
    if (!phrase) return null;
    // The clause must actually name a thing. Without this, "give me a hug" and
    // "give me a minute" would read as gift requests.
    const namesAnItem = phrase.split(" ").some((token) => ITEM_NOUN.has(token) || ITEM_ALIAS.has(token));
    if (!namesAnItem) return null;

    const ironToolSet = /\b(?:set|kit|all)\b.{0,20}\biron\b.{0,20}\btools?\b/i.test(rest)
      || /\biron\b.{0,20}\b(?:tool set|tool kit)\b/i.test(rest);
    const canonicalPhrase = ironToolSet ? "set of iron tools" : (ITEM_ALIAS.get(phrase) || phrase);
    // The tool-set branch of the builder is keyed off the whole phrase, so the
    // child's wording and the canonical wording are the same request.
    const requestedPhrase = ironToolSet ? canonicalPhrase : phrase;
    const canonicalRequest = `give me ${amount === undefined ? "" : `${amount} `}${canonicalPhrase}`;

    // The injected builder — and therefore the item allowlist and the quantity
    // bounds in src/wizard.mjs — has the only vote on what can be delivered.
    // The shape check before validation is deliberate: allowedWizardAction's
    // final clause falls back to a registered skill's EXAMPLE action when a
    // give_items object fails its item checks, which would turn a malformed
    // gift into an iron pickaxe nobody asked for. Nothing malformed reaches it.
    const built = giveItemsAction(canonicalRequest);
    const wellFormed = built?.type === "give_items" && built.version === 1
      && Array.isArray(built.items) && built.items.length >= 1 && built.items.length <= 16;
    const base = wellFormed ? allowedWizardAction(built) : null;

    return {
      recipient,
      hint,
      phrase: requestedPhrase,
      canonicalPhrase,
      amount,
      clampedFrom: requested,
      enchantRequested: /\benchant(?:ed|ing|ment)?\b/i.test(text),
      ironToolSet,
      base,
    };
  }

  function caveatFor(gift, action) {
    const notes = [];
    if (!action && gift.recipient === null) {
      // Phrased away from "I cannot ...": a caveat that rides along with a real
      // delivery must not read as a refusal to answerRefusesAction, or the
      // caller has to drop the whole honest sentence to stay shippable (#44).
      notes.push(`I do not know your ${gift.hint}'s exact player name, so my wand has nowhere to send it yet — tell me the name they play under and it goes straight over`);
    }
    if (!gift.base) {
      notes.push(`${gift.phrase} is not in my spellbook yet, so I will not pretend to conjure one`);
    } else {
      if (gift.canonicalPhrase !== gift.phrase && !gift.ironToolSet) {
        notes.push(`the closest thing my spellbook stocks for "${gift.phrase}" is ${gift.canonicalPhrase}, so that is what I am bringing`);
      }
      if (gift.enchantRequested) {
        notes.push("enchanting is beyond my wand, so it arrives plain and you can enchant it at a table");
      }
      if (gift.clampedFrom) {
        notes.push(`${gift.clampedFrom} is more than my wand can carry in one spell, so I am bringing ${MAX_GIFT_AMOUNT}`);
      }
    }
    return notes.length ? `${notes.join(", and ")}.` : undefined;
  }

  // giftIntent(question, history) -> frozen record | null. `history` is accepted
  // for contract symmetry with the other detectors; a gift turn carries no
  // follow-up state of its own.
  function giftIntent(question, history = []) {
    void history;
    const gift = plan(question);
    if (!gift) return null;
    const action = action_(gift);
    const delivered = action ? action.items.reduce((total, item) => total + item.amount, 0) : gift.amount;
    const caveat = caveatFor(gift, action);
    return Object.freeze({
      mode: action ? "deliver" : "unavailable",
      item: gift.base ? gift.canonicalPhrase : gift.phrase,
      ...(gift.canonicalPhrase !== gift.phrase ? { requested: gift.phrase } : {}),
      amount: delivered ?? 1,
      recipient: gift.recipient,
      ...(gift.recipient === null ? { recipientHint: gift.hint } : {}),
      deliverable: Boolean(action),
      ...(caveat ? { caveat } : {}),
    });
  }

  // Shared by giftIntent and giftAction so the record and the action can never
  // disagree about what is actually going to happen.
  function action_(gift) {
    if (!gift?.base) return null;
    // A third party this rung cannot name is never resolved by guessing, and
    // never quietly redirected to the requester.
    if (gift.recipient === null) return null;
    if (gift.recipient === "requester") return allowedWizardAction(gift.base);
    // A named recipient rides the EXISTING field: src/skills.mjs validates the
    // charset and the pack resolves it to an exact connected player or refuses.
    return allowedWizardAction({ ...gift.base, recipient: gift.recipient });
  }

  // giftAction(question, history) -> the value allowedWizardAction returns, or
  // null. Never the raw candidate: the allowlist has the last word.
  function giftAction(question, history = []) {
    void history;
    return action_(plan(question));
  }

  return { giftIntent, giftAction };
}
