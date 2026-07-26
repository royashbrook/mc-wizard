// Travel detector role (#44).
//
// MEASURED GAP. Four ordinary child phrasings reached classifyAction and came
// back with no action at all — "bring me home", "send me to spawn", "teleport
// me to the village", "get me out of this cave" — even though the wizard
// demonstrably owns the powers behind three of them. The existing builders are
// correct but narrow: localTravelAction only recognises a structure when the
// child says "nearest"/"closest", and only recognises an escape when the child
// says the word "surface". A child says "the village" and "out of this cave".
//
// CONTRACT
//   createTravelDetector(deps) -> { travelIntent, travelAction }
//
// Every dependency is INJECTED. This module must never import src/wizard.mjs:
// localTravelAction and dimensionTravelAction live there and importing them
// would create a cycle (wizard.mjs wires this detector into classifyAction).
// Injection also keeps the detector independently unit-testable with no server,
// no provider and no world.
//
// SAFETY POSTURE. This module authors NO action of its own. It recognises a
// travel intent, normalises it into a canonical phrase, and hands that phrase
// to the SAME validated builder the ladder already calls. Nothing about the
// travel surface widens:
//   * The only action types that can leave here are the ones those builders
//     already emit — local_travel and dimension_travel. Both are
//     requester-scoped in the pack, both are covered by main.js
//     actionMovesRequester, so needsTeleportConsent still gates them exactly as
//     before.
//   * A request to move SOMEBODY ELSE is refused outright (OTHER_PLAYER), so
//     this rung can never move another player outside the existing consent path
//     and can never produce an action that actionMovesOptedOutPlayer would have
//     to catch.
//   * The result of the builder is re-validated through the injected
//     allowedWizardAction before it is returned. The raw candidate never
//     escapes.
//   * localTravelAction can return an INVALID_LOCAL_TRAVEL sentinel that must
//     hard-stop the whole ladder (classifyAction: `if (localTravel ===
//     INVALID_LOCAL_TRAVEL) return null;`). That sentinel is passed straight
//     through by travelAction and suppresses the intent entirely. The wiring
//     site MUST therefore check for a symbol before treating the result as an
//     action — see WIRING below. The sentinel is detected structurally
//     (`typeof value === "symbol"`) so the private symbol needs no export.
//
// WIRING (for the caller, which owns src/wizard.mjs):
//   const travel = travelAction(question);
//   if (typeof travel === "symbol") return null;   // hard stop, as today
//   if (travel) return travel;
//
// NEVER DO NOTHING. Two destinations a child names — the world spawn and
// "home" — have no builder behind them: the allowlist has no such destination
// and script.teleport needs literal coordinates the server does not know. Those
// still produce an INTENT (supported: false, plus a caveat and one concrete
// alternative step), so the recovery floor can say something true and useful
// instead of "my spellbook has nothing on that yet". They never produce an
// action, and they are never silently substituted with a different destination.

// Conversational lead-ins that sit in front of an imperative. Stripping them is
// what turns "wiz can you take me to the village" into an imperative.
const LEADERS = [
  /^(?:hey|hi|yo)\b[,\s]*/i,
  /^(?:wizard|wiz)\b[,:\s]*/i,
  /^(?:can|could|would|will)\s+you\s+/i,
  /^(?:i|we)\s+(?:really\s+)?(?:want|need)\s+(?:you\s+)?to\s+/i,
  /^please\s+/i,
  /^just\s+/i,
  /^(?:go\s+ahead\s+and|go\s+and)\s+/i,
  /^(?:now|first|next|then)\s+/i,
  /^help\s+(?:me|us)\s+/i,
];

// Question framing: "what is the nether like" is curiosity, not a work order.
// Checked AFTER the lead-ins are stripped, so "can you take me ..." (a request)
// is not mistaken for an interrogative.
const INTERROGATIVE = /^(?:what|whats|what['’]s|why|how|when|where|who|whose|which|is|are|was|were|do|does|did|should|shall|may|might|must|am|can|could|would|will|if)\b/i;

// A lesson about travelling is not travelling. Mirrors the requestsDirections
// bail inside localTravelAction, and deliberately scans the WHOLE question so
// "sure, but first explain how to get to the nether" stays a lesson.
const DIRECTIONS_LESSON = /\b(?:tell|show|explain|teach)\s+(?:me\s+)?how\s+to\b|\bhow\s+(?:do|can|could|would|should)\b|\bhow\s+to\b|\bjust\s+(?:explain|describe|tell)\b/i;

// Travel entangled with construction belongs to the build path: "build a nether
// portal and take me through" must reach the build route, not this rung.
const BUILD_ENTANGLED = /\b(?:build|builds|building|built|construct|constructs|constructing|erect|erects|rebuild|rebuilds|rebuilding)\b/i;
const BUILD_DELIVERY = /\b(?:make|makes|making)\s+(?:me|us)\s+(?:an?|some)\b/i;

// Moving somebody else is NOT this rung's business. The existing consent path
// (main.js needsTeleportConsent / actionMovesOptedOutPlayer) owns that, and it
// owns it through the routes that already exist. Recognising more intent must
// never grant more authority, so any third-party subject refuses outright.
const OTHER_PLAYER = /\b(?:my\s+(?:friend|friends|brother|sister|buddy|buddies|pal|pals|cousin|cousins|mom|mum|dad)|him|her|them|they|everyone\s+else|everybody\s+else|the\s+other\s+(?:player|players|kids?)|another\s+player)\b/i;

// FORM A: an imperative that moves the speaker. The object must be first person
// (or the whole party) and must sit directly after the verb, which is what
// keeps "send me some diamonds" (a gift) and "take me through how redstone
// works" (a lesson) from ever looking like travel — neither reaches a
// destination anyway, but the object rule closes the door twice.
const MOVE_ME = /^(?:tp|teleport|transport|take|bring|send|move|get|lead|escort|guide|carry|warp|beam|whisk|return|fly)\s+(?:me|us|myself|ourselves|everyone|everybody|all\s+of\s+us|the\s+(?:party|players?))\b/i;

// FORM B: the speaker moving themselves. "i want to go home", "let's go to
// spawn", "go back to the overworld".
const SELF_GO = /^(?:(?:i|we)\s+(?:really\s+)?(?:just\s+)?(?:want|wanna|need|gotta|have)\s*(?:to\s+)?(?:go|get|head|travel|be)\b|let(?:'|’)?s\s+(?:go|head|travel|get)\b|let\s+us\s+(?:go|head|travel|get)\b|(?:go|head|travel)\s+(?:back\s+)?(?:to|home|out|up)\b)/i;

// FORM C: a bare escape imperative, reached via the "help me ..." lead-in.
// "get out of this cave", "climb back up out of the mine". A destination cue is
// still required, so "get out of here" alone stays unrecognised.
const ESCAPE = /^(?:get|go|climb|head|dig)\s+(?:me\s+|us\s+)?(?:back\s+)?(?:out|up)\b/i;

// Structures the wizard can actually locate. The captured text is handed back
// to the injected builder verbatim, which is safe because each pattern matches
// only a fixed vocabulary — no free child text is ever forwarded. The desert /
// jungle temple entry is listed FIRST and on purpose: the builder answers it
// with its hard-stop sentinel, and that must keep happening.
const STRUCTURES = [
  [/\b(?:desert|jungle)\s+temple\b/i, "temple"],
  [/\bwitch\s+hut\b/i, "witch_hut"],
  [/\bigloo\b/i, "igloo"],
  [/\bancient\s+city\b/i, "ancient_city"],
  [/\bbastion(?:\s+remnant)?\b/i, "bastion_remnant"],
  [/\bburied\s+treasure\b/i, "buried_treasure"],
  [/\bend\s+city\b/i, "end_city"],
  [/\b(?:nether\s+)?fortress\b/i, "fortress"],
  [/\b(?:woodland\s+)?mansion\b/i, "mansion"],
  [/\b(?:abandoned\s+)?mineshaft\b/i, "mineshaft"],
  [/\b(?:ocean\s+)?monument\b/i, "monument"],
  [/\b(?:pillager\s+)?outpost\b/i, "pillager_outpost"],
  [/\bruined\s+portal\b/i, "ruined_portal"],
  [/\bocean\s+ruins?\b/i, "ruins"],
  [/\btrail\s+ruins?\b/i, "trail_ruins"],
  [/\btrial\s+chambers?\b/i, "trial_chambers"],
  [/\bshipwreck\b/i, "shipwreck"],
  [/\bstronghold\b/i, "stronghold"],
  [/\btemple\b/i, "temple"],
  [/\bvillage\b/i, "village"],
];

// Leaving a dimension is a request for the Overworld.
const LEAVE_DIMENSION = /\b(?:out\s+of|away\s+from|leave|escape)\s+(?:the\s+)?(?:nether|end)\b/i;
// A dimension is only a destination when it is the object of "to"/"into".
const DIMENSION_TARGET = /\b(?:to|into)\s+(?:the\s+)?(nether|end(?:\s+dimension)?|overworld|normal\s+world)\b/i;

const SURFACE_CUE = /\b(?:surface|above\s*ground|top\s*side|daylight|sunlight)\b/i;
const UNDERGROUND_ESCAPE = /\b(?:out|up|back)\s+(?:of\s+|from\s+|to\s+|onto\s+)?(?:this\s+|the\s+|these\s+|that\s+|a\s+|my\s+)?(?:cave|caves|cavern|caverns|mine|mines|mineshaft|hole|pit|tunnel|tunnels|ravine|underground|deep\s*dark)\b/i;

const SPAWN_CUE = /\b(?:world\s+)?spawn(?:\s*point)?\b/i;
// "spawn a zombie", "spawn egg", "spawner" are not destinations.
const SPAWN_NOT_A_PLACE = /\bspawn(?:er|ers|\s*eggs?)\b|\bspawn\s+(?:a|an|some|me|us|the|in)\b/i;

const HOME_CUE = /\bhome\b|\b(?:my|our)\s+(?:base|house|bed)\b/i;
// "build me a home" is a build; the build bails already catch it, but a bare
// article in front of "home" is never a destination either.
const HOME_NOT_A_PLACE = /\b(?:a|an|another|new)\s+home\b/i;

const DIMENSIONS = new Map([
  ["nether", { destination: "nether", label: "the Nether", phrase: "take me to the nether" }],
  ["end", { destination: "the_end", label: "the End", phrase: "take me to the end" }],
  ["end dimension", { destination: "the_end", label: "the End", phrase: "take me to the end" }],
  ["overworld", { destination: "overworld", label: "the Overworld", phrase: "take me to the overworld" }],
  ["normal world", { destination: "overworld", label: "the Overworld", phrase: "take me to the overworld" }],
]);

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
      throw new TypeError(`createTravelDetector requires a ${name} function`);
    }
  }
}

// The destination a travel clause names, or null. Order is load-bearing:
// leaving a dimension beats the bare dimension words, and a named structure
// ("end city", "nether fortress") beats the dimension it lives in.
function destinationOf(clause) {
  if (LEAVE_DIMENSION.test(clause)) {
    return {
      mode: "dimension",
      destination: "overworld",
      label: "the Overworld",
      step: "open a doorway and walk you back out into the Overworld",
      supported: true,
      phrase: "take me to the overworld",
      route: "dimension",
    };
  }
  const structure = STRUCTURES.find(([pattern]) => pattern.test(clause));
  if (structure) {
    const words = clause.match(structure[0])[0].toLowerCase().replace(/\s+/g, " ");
    return {
      mode: "structure",
      destination: structure[1],
      label: `the nearest ${words}`,
      step: `search out the nearest ${words} and set you down right beside it`,
      supported: true,
      phrase: `take me to the nearest ${words}`,
      route: "local",
    };
  }
  const dimensionWord = clause.match(DIMENSION_TARGET)?.[1]?.toLowerCase().replace(/\s+/g, " ");
  const dimension = dimensionWord && DIMENSIONS.get(dimensionWord);
  if (dimension) {
    return {
      mode: "dimension",
      destination: dimension.destination,
      label: dimension.label,
      step: `open a doorway and take you straight to ${dimension.label}`,
      supported: true,
      phrase: dimension.phrase,
      route: "dimension",
    };
  }
  if (SURFACE_CUE.test(clause) || UNDERGROUND_ESCAPE.test(clause)) {
    return {
      mode: "surface",
      destination: "surface",
      label: "the surface",
      step: "lift you straight up out of the dark and onto the surface",
      supported: true,
      phrase: "take me to the surface",
      route: "local",
    };
  }
  // Recognised, but no builder can express it. Named, never substituted.
  if (SPAWN_CUE.test(clause) && !SPAWN_NOT_A_PLACE.test(clause)) {
    return {
      mode: "spawn",
      destination: "spawn",
      label: "the world spawn",
      step: "lift you up to the surface, which is the closest thing I can aim at",
      supported: false,
      caveat: "My travel magic has no marker for the world spawn — it only knows the surface, landmarks like the nearest village, and the Nether, the End and the Overworld. Say the word and I will lift you up to the surface instead.",
      route: "none",
    };
  }
  if (HOME_CUE.test(clause) && !HOME_NOT_A_PLACE.test(clause)) {
    return {
      mode: "home",
      destination: "home",
      label: "your home",
      step: "take you to the nearest village, which is the closest thing I can aim at",
      supported: false,
      caveat: "My travel magic cannot see where your home is — it only knows the surface, landmarks like the nearest village, and the Nether, the End and the Overworld. Say the word and I will take you to the nearest village instead.",
      route: "none",
    };
  }
  return null;
}

export function createTravelDetector(deps = {}) {
  requireFunctions(deps, [
    "localTravelAction",
    "dimensionTravelAction",
    "allowedWizardAction",
    "explicitlyRequestsBuild",
    "explicitlyRequestsCommand",
    "isRecipeRequest",
    "isOrdinaryConversation",
  ]);
  const {
    localTravelAction,
    dimensionTravelAction,
    allowedWizardAction,
    explicitlyRequestsBuild,
    explicitlyRequestsCommand,
    isRecipeRequest,
    isOrdinaryConversation,
  } = deps;

  // The one place that decides "this clause is a travel order".
  function travelClause(question) {
    for (const clause of clausesOf(question)) {
      const direct = stripLeaders(clause);
      if (!direct || INTERROGATIVE.test(direct)) continue;
      if (MOVE_ME.test(direct) || SELF_GO.test(direct) || ESCAPE.test(direct)) return direct;
    }
    return null;
  }

  // history is accepted for signature parity with the other detectors and is
  // deliberately unused: a bare "yes" that resumes a travel offer is already
  // owned by classifyAction's pending-confirmation replay.
  function plan(question, _history) {
    const text = String(question || "");
    if (!text.trim()) return null;
    // Bails, in cheapest-first order. Each one hands the turn to a route that
    // already owns it: conversation, recipes, command lessons, builds,
    // directions lessons, and the consent path for other players.
    if (isOrdinaryConversation(text)) return null;
    if (isRecipeRequest(text)) return null;
    if (explicitlyRequestsCommand(text)) return null;
    if (explicitlyRequestsBuild(text)) return null;
    if (BUILD_ENTANGLED.test(text) || BUILD_DELIVERY.test(text)) return null;
    if (DIRECTIONS_LESSON.test(text)) return null;
    if (OTHER_PLAYER.test(text)) return null;

    const clause = travelClause(text);
    if (!clause) return null;
    return destinationOf(clause);
  }

  // Hand a request to the builder that owns this route. The ORIGINAL wording is
  // tried first so any detail the builder can already read (a dimension
  // qualifier, for instance) survives; the canonical phrase is the fallback
  // that turns a phrasing the builder cannot read into one it can.
  function build(travel, question) {
    if (!travel || travel.route === "none") return null;
    const builder = travel.route === "dimension" ? dimensionTravelAction : localTravelAction;
    const direct = builder(question);
    if (typeof direct === "symbol") return direct;
    if (direct) return direct;
    const normalised = builder(travel.phrase);
    if (typeof normalised === "symbol") return normalised;
    return normalised || null;
  }

  // Resolve once; both exported functions read the same answer.
  function resolve(question, history) {
    const travel = plan(question, history);
    if (!travel) return { travel: null, action: null };
    const candidate = build(travel, String(question || ""));
    // The sentinel is a hard stop, not an action: it passes straight through.
    if (typeof candidate === "symbol") return { travel, action: candidate };
    // The allowlist has the last word on every field; the raw candidate never
    // leaves this module.
    const action = candidate ? allowedWizardAction(candidate) || null : null;
    return { travel, action };
  }

  // travelIntent(question, history)
  //   -> frozen { mode, destination, label, step, supported, caveat? } | null
  function travelIntent(question, history = []) {
    const { travel, action } = resolve(question, history);
    if (!travel) return null;
    // A sentinel means the ladder must stop dead: promising nothing is the
    // whole point, so no offer is made either.
    if (typeof action === "symbol") return null;
    const supported = travel.supported && Boolean(action);
    const caveat = supported ? undefined : travel.caveat
      || `I could not find ${travel.label} to aim at from here. Say the word and I will lift you up to the surface instead.`;
    return Object.freeze({
      mode: travel.mode,
      destination: travel.destination,
      label: travel.label,
      step: travel.step,
      supported,
      ...(caveat ? { caveat } : {}),
    });
  }

  // travelAction(question, history) -> the value allowedWizardAction returns,
  // the builder's hard-stop sentinel, or null. Never a raw candidate.
  function travelAction(question, history = []) {
    return resolve(question, history).action;
  }

  return { travelIntent, travelAction };
}
