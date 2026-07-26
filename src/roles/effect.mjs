// Effect detector role (#44 / WP-E).
//
// Measured gap: of six ordinary child phrasings for "put a status effect on
// me", three produced NO action at all end-to-end — "make me fly", "i want to
// be fast", "heal me" — and the child got "my spellbook has nothing on that
// yet". The Wizard demonstrably can do two of the three today: commandAction in
// src/wizard.mjs already emits `effect @s <id> 999999 0 true` for twelve
// effects. It simply never recognised the words a child actually uses ("fast"
// instead of "speed", "heal" instead of "regeneration"). This module is the
// deterministic rung that closes that gap.
//
// CONTRACT
//   createEffectDetector(deps) -> { effectIntent, effectAction }
//
// Every dependency is INJECTED. This module must never import src/wizard.mjs:
// the existing effect builder (commandAction) lives there and importing it
// would create a cycle, since wizard.mjs is what wires this detector in.
//
// SAFETY POSTURE — NOTHING HERE WIDENS AUTHORITY.
//   * The effect vocabulary is a CLOSED allowlist (ALLOWED_EFFECTS) whose
//     twelve ids are exactly the ids LOCAL_EFFECTS in src/wizard.mjs already
//     emits. No new effect, no new command verb, no new selector.
//   * The command shape is byte-for-byte the one already shipped:
//     `effect @s <id> 999999 0 true`. Always @s — the requester and only the
//     requester. Any phrasing aimed at another player, at "us", or at everyone
//     is REFUSED outright (OTHER_TARGET), never quietly retargeted.
//   * The preferred path is to hand a normalised request ("give me night
//     vision") to the INJECTED existing builder, so recognised turns run
//     through the very same validated code today's turns run through. The
//     composed fallback exists only for the one multi-effect case below, and it
//     still returns whatever allowedWizardAction returns, never a raw object.
//
// THE ONE SUBSTITUTION, AND IT IS NEVER SILENT. "make me fly" names a power no
// status effect grants (real flight is a creative-mode ability, i.e. a NEW
// command surface, which is forbidden). Rather than do nothing, the detector
// grants jump boost + slow falling — both already in the allowlist — and puts a
// plain-language `caveat` on the intent so the caller must tell the child what
// was actually cast. The intent is returned either way, so even if a caller
// declines the action the never-empty floor still has something concrete to
// offer.

/** Exactly the effect ids LOCAL_EFFECTS (src/wizard.mjs) already emits. */
export const ALLOWED_EFFECTS = Object.freeze([
  "night_vision",
  "fire_resistance",
  "water_breathing",
  "slow_falling",
  "jump_boost",
  "conduit_power",
  "regeneration",
  "resistance",
  "invisibility",
  "strength",
  "haste",
  "speed",
]);

const ALLOWED = new Set(ALLOWED_EFFECTS);

/** The command shape already shipped: long duration, level 0, hidden particles. */
export const effectCommand = (id) => `effect @s ${id} 999999 0 true`;

export const FLY_CAVEAT =
  "Real flying is a creative-mode power my wand cannot hand out, so I am casting a huge jump boost and slow falling instead: leap up high and drift back down safely.";

// The vocabulary. Ordered: the most specific reading of a word wins, so
// "mine faster" reaches haste before the generic "faster" reaches speed.
// `label` is the child-facing name a bound offer can say out loud; `request` is
// the normalised phrasing handed to the INJECTED existing builder.
const VOCABULARY = [
  {
    pattern: /\bnight\s*vision\b|\bsee\s+(?:in|through)\s+the\s+dark\b|\bsee\s+at\s+night\b/i,
    effects: ["night_vision"],
    label: "night vision",
  },
  {
    pattern: /\bwater\s*breathing\b|\bbreathe?\s+(?:under\s*water|underwater)\b|\bbreathe\s+under\s+the\s+(?:water|sea|ocean)\b/i,
    effects: ["water_breathing"],
    label: "water breathing",
  },
  {
    pattern: /\bfire\s*(?:resistance|proof)\b|\bfireproof\b|\bimmune\s+to\s+(?:fire|lava)\b|\bsurvive\s+(?:in\s+)?(?:the\s+)?lava\b|\b(?:not|never|don'?t|dont|stop)\s+burn(?:ing)?\b/i,
    effects: ["fire_resistance"],
    label: "fire resistance",
  },
  {
    pattern: /\bhaste\b|\b(?:mine|dig|break)\s+(?:blocks?\s+)?(?:really\s+|super\s+|way\s+)?(?:fast(?:er)?|quick(?:er)?)\b|\bfaster\s+(?:at\s+)?(?:mining|digging)\b/i,
    effects: ["haste"],
    label: "haste",
  },
  {
    pattern: /\bjump\s*boost\b|\b(?:super|high|big)\s+jump\b|\bjump\s+(?:really\s+|super\s+|way\s+)?(?:high(?:er)?|far(?:ther)?)\b/i,
    effects: ["jump_boost"],
    label: "jump boost",
  },
  {
    pattern: /\bslow\s*fall(?:ing)?\b|\bfall\s+(?:slowly|safely)\b|\bfloat\s+(?:back\s+)?down\b|\b(?:no|without|not\s+take)\s+fall\s+damage\b/i,
    effects: ["slow_falling"],
    label: "slow falling",
  },
  {
    // No status effect grants flight. See FLY_CAVEAT.
    pattern: /\bfly(?:ing)?\b|\bflight\b|\bhover\b/i,
    effects: ["jump_boost", "slow_falling"],
    label: "a huge jump boost and slow falling",
    // A bare "fly" is never a bare effect NAME, so this substitution always
    // needs a real grant frame ("make me fly"). /(?!)/ never matches.
    canonical: /(?!)/,
    caveat: FLY_CAVEAT,
  },
  {
    pattern: /\binvisib(?:ility|le)\b|\bdisappear\b|\bnot\s+be\s+seen\b/i,
    effects: ["invisibility"],
    label: "invisibility",
  },
  {
    pattern: /\bstrength\b|\bstrong(?:er)?\b|\b(?:hit|punch)\s+(?:really\s+|way\s+)?harder\b|\bmore\s+damage\b/i,
    effects: ["strength"],
    label: "strength",
  },
  {
    pattern: /\bresistance\b|\btough(?:er)?\b|\btanky\b|\b(?:take\s+less|not\s+take)\s+damage\b|\bstop\s+getting\s+hurt\b/i,
    effects: ["resistance"],
    label: "resistance",
  },
  {
    pattern: /\bregenerat(?:ion|e)\b|\bregen\b|\bheal(?:ed|ing)?\b|\bhealth\s+back\b|\bfull\s+health\b|\bpatch\s+me\s+up\b/i,
    effects: ["regeneration"],
    label: "regeneration",
  },
  {
    pattern: /\bconduit\s+power\b/i,
    effects: ["conduit_power"],
    label: "conduit power",
  },
  {
    pattern: /\bspeed(?:y)?\b|\b(?:really\s+|super\s+|way\s+|so\s+)?fast(?:er)?\b|\bquick(?:er)?\b|\bswift(?:ness)?\b|\bzoom\b|\brun\s+(?:really\s+)?fast\b/i,
    effects: ["speed"],
    label: "speed",
  },
];

// `canonical` is the effect's own NAME — the only spelling that may stand alone
// as a whole request. Derived from the label unless the entry names its own.
const EFFECT_VOCABULARY = VOCABULARY.map((entry) => Object.freeze({
  ...entry,
  effects: Object.freeze([...entry.effects]),
  canonical: entry.canonical || new RegExp(`\\b${entry.label.replace(/[^a-z ]/gi, "")}\\b`, "i"),
}));

// Conversational lead-ins that sit in front of an imperative, copied from the
// terrain planner so the two rungs see the same sentence shape. Deliberately
// WITHOUT terrain's "i want to" stripper: "i want to be fast" must keep its
// head so the I_WANT grant frame can see it.
const LEADERS = [
  /^(?:hey|hi|yo)\b[,\s]*/i,
  /^(?:wizard|wiz)\b[,:\s]*/i,
  /^(?:can|could|would|will)\s+you\s+/i,
  /^please\s+/i,
  /^just\s+/i,
  /^(?:go\s+ahead\s+and|go\s+and)\s+/i,
  /^(?:now|first|next|then)\s+/i,
];

// "can i have night vision" is a request, not a question. It is stripped BEFORE
// the interrogative guard and counts as its own grant frame — the same reading
// commandAction in src/wizard.mjs already gives it.
const CAN_I_HAVE = /^(?:can|could|may)\s+i\s+(?:please\s+)?(?:get|have|receive)\s+(?:some\s+)?/i;

// Question framing: "what does night vision do" is curiosity, not a work order.
// Checked after the lead-ins are stripped, so "can you make me fast" survives.
const INTERROGATIVE = /^(?:what|whats|what['’]s|why|how|when|where|who|whose|which|is|are|was|were|do|does|did|should|shall|may|might|must|am|can|could|would|will|if)\b/i;

// The grant frames. Every one is FIRST PERSON SINGULAR on purpose: the emitted
// command is `effect @s ...`, which reaches the requester and nobody else.
const GRANT_FRAMES = [
  /^(?:give|grant|add|gimme|hand)\s+me\b/i,
  /^(?:apply|cast|put)\b.{0,80}\b(?:to|on|for)\s+me\b/i,
  /^cast\s+me\b/i,
  /^(?:make|let|help)\s+me\b/i,
  /^i\s+(?:really\s+)?(?:want|need|wanna)\b/i,
  /^(?:heal|cure|fix)\s+me\b/i,
  /^(?:use|turn\s+on)\b.{0,80}\b(?:on|for)\s+me\b/i,
];

// Anything aimed at somebody other than the requester. The builder can only
// reach @s, so these turns are REFUSED rather than quietly retargeted.
const OTHER_TARGET = /\b(?:us|we|everyone|everybody|every\s+player|all\s+of\s+us|the\s+(?:whole\s+)?server|my\s+(?:friend|friends|brother|sister|mom|mum|dad|buddy|pal|team|cousin)|him|her|them|they)\b/i;

// An item request is a GIFT turn, not an effect turn: "give me a speed potion"
// must reach giveItemsAction and its allowlist, never this rung. Mirrors the
// item guard already inside commandAction (src/wizard.mjs).
const ITEM_NOUN = /\b(?:potions?|arrows?|swords?|axes?|pickaxes?|shovels?|hoes?|helmets?|chestplates?|leggings|boots?|elytra|beacons?|totems?|books?|bottles?|ingots?|blocks?|items?|enchant(?:ed|ment|ments|ing)?)\b/i;
const EFFECT_WORD = /\b(?:effect|buff|apply|cast)\b/i;

// Construction and travel keep their own rungs. Both guards can only make this
// detector fire LESS.
const BUILD_ENTANGLED = /\b(?:build|builds|building|built|construct|constructs|constructing|erect|erects|rebuild|rebuilds|rebuilding)\b/i;
const BUILD_DELIVERY = /\b(?:make|makes|making)\s+me\s+(?:an?|some|\d)\b/i;
const TRAVEL_ENTANGLED = /\b(?:teleport|tp)\b|\b(?:take|send|bring|get|move)\s+me\s+(?:to|home|back|out|up|down)\b|\bto\s+(?:spawn|my\s+(?:house|home|base|bed)|the\s+(?:village|nether|end|surface))\b/i;

// Mirrors requestClauses in src/wizard.mjs: sentence enders and "then" split a
// request into clauses. Commas deliberately do NOT split.
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
      throw new TypeError(`createEffectDetector requires a ${name} function`);
    }
  }
}

// True when the clause is nothing but the effect words (plus politeness):
// "night vision", "speed please". commandAction reads bare effect names the
// same way. Deliberately restricted to the CANONICAL name: a bare "night
// vision" is a request, but a bare "fast" is just a word a child said, and it
// still needs a grant frame ("make me fast") to become a work order.
function isEffectOnly(clause, entry) {
  if (!entry.canonical.test(clause)) return false;
  return clause
    .replace(entry.pattern, " ")
    .replace(/\bplease\b/gi, " ")
    .replace(/[.!?,]/g, " ")
    .trim() === "";
}

export function createEffectDetector(deps = {}) {
  requireFunctions(deps, [
    "commandAction",
    "allowedWizardAction",
    "explicitlyRequestsBuild",
    "explicitlyRequestsCommand",
    "isRecipeRequest",
    "isOrdinaryConversation",
  ]);
  const {
    commandAction,
    allowedWizardAction,
    explicitlyRequestsBuild,
    explicitlyRequestsCommand,
    isRecipeRequest,
    isOrdinaryConversation,
  } = deps;

  // The one place that decides "this clause asks for an effect on ME".
  function effectClause(question) {
    for (const clause of clausesOf(question)) {
      let direct = stripLeaders(clause);
      if (!direct) continue;
      let granted = false;
      if (CAN_I_HAVE.test(direct)) {
        direct = direct.replace(CAN_I_HAVE, "").trim();
        granted = true;
      }
      if (!direct) continue;
      if (!granted && INTERROGATIVE.test(direct)) continue;
      const entry = EFFECT_VOCABULARY.find(({ pattern }) => pattern.test(direct));
      if (!entry) continue;
      // The grant frame and the effect must live in the SAME clause.
      const framed = granted
        || GRANT_FRAMES.some((frame) => frame.test(direct))
        || isEffectOnly(direct, entry);
      if (framed) return entry;
    }
    return null;
  }

  function plan(question) {
    const text = String(question || "");
    if (!text.trim()) return null;
    // Bails, in cheapest-first order. Each hands the turn to a route that
    // already owns it: conversation, recipes, command lessons, builds, travel,
    // gifts, and anything aimed at another player.
    if (isOrdinaryConversation(text)) return null;
    if (isRecipeRequest(text)) return null;
    if (explicitlyRequestsCommand(text)) return null;
    if (explicitlyRequestsBuild(text)) return null;
    if (BUILD_ENTANGLED.test(text) || BUILD_DELIVERY.test(text)) return null;
    if (TRAVEL_ENTANGLED.test(text)) return null;
    if (OTHER_TARGET.test(text)) return null;
    if (ITEM_NOUN.test(text) && !EFFECT_WORD.test(text)) return null;

    const entry = effectClause(text);
    if (!entry) return null;
    // Belt and braces: the vocabulary may only ever name allowlisted effects.
    if (!entry.effects.every((id) => ALLOWED.has(id))) return null;
    return entry;
  }

  // effectIntent(question, history) -> frozen record | null.
  // `history` is accepted for signature parity with the other detectors; an
  // effect request is self-contained, so nothing here reads it.
  function effectIntent(question, _history = []) {
    const entry = plan(question);
    if (!entry) return null;
    return Object.freeze({
      mode: "grant",
      effects: Object.freeze([...entry.effects]),
      label: entry.label,
      // The normalised phrasing for the existing builder. Only single-effect
      // grants have one; the fly substitution is composed instead.
      request: entry.effects.length === 1 ? `give me ${entry.effects[0].replace(/_/g, " ")}` : null,
      ...(entry.caveat ? { caveat: entry.caveat } : {}),
    });
  }

  // effectAction(question, history) -> whatever allowedWizardAction returns, or
  // null. Never a raw candidate: the allowlist always has the last word.
  function effectAction(question, _history = []) {
    const entry = plan(question);
    if (!entry) return null;
    // PREFERRED PATH: hand a normalised request to the existing, already
    // validated builder so this rung runs the same code today's turns run.
    if (entry.effects.length === 1) {
      const built = commandAction(`give me ${entry.effects[0].replace(/_/g, " ")}`);
      if (built) return built;
    }
    // FALLBACK: the multi-effect substitution the single-effect builder cannot
    // express. Same command shape, same allowlist, re-validated all the same.
    const commands = entry.effects.map((id) => effectCommand(id));
    return allowedWizardAction({ type: "run_commands", version: 1, commands });
  }

  return { effectIntent, effectAction };
}
