// Admin detector role (#44 / WP-E).
//
// MEASURED GAP. Three ordinary child phrasings reach the wizard and produce
// nothing at all — action null and "my spellbook has nothing on that yet":
//
//   "turn on keep inventory"   (a world rule)
//   "make it peaceful"         (difficulty)
//   "stop the rain"            (weather — which the wizard demonstrably CAN do:
//                               world_control already supports clear/rain/thunder)
//
// classifyAction has no rung that recognises the settings vocabulary a child
// actually uses. worldControlAction only fires on "make/set/change/turn"
// framing, so every "stop the ..." / "no more ..." phrasing falls off the end.
// This module is the deterministic detector that closes that.
//
// CONTRACT
//   createAdminDetector(deps) -> { adminIntent, adminAction }
//
// Every dependency is INJECTED. This module must never import src/wizard.mjs:
// worldControlAction and trustedAdminAction live there and importing them would
// create a cycle (wizard.mjs wires this detector in). Injection also keeps the
// detector unit-testable with no server, no provider and no world.
//
// SAFETY POSTURE — THIS IS THE MOST SENSITIVE CATEGORY, SO READ THIS FIRST.
// Detecting more admin phrasings must never grant more authority. Concretely:
//
//   * This module AUTHORS NO COMMANDS. It never emits a `gamerule`, a
//     `difficulty`, a `gamemode`, an `op` or any other console string. There is
//     no new privileged path here and no new command surface.
//   * The only two things it can turn into an action are (a) a world_control
//     produced by the INJECTED worldControlAction, and (b) the op/deop program
//     produced by the INJECTED trustedAdminAction. Both are the existing,
//     already-validated builders, called unchanged.
//   * Everything it hands those builders is a FIXED LITERAL from a table in
//     this file (or the child's own question, verbatim). Nothing is spliced
//     from user text into a command, so nothing can be smuggled through.
//   * OPERATOR PHRASINGS ARE NEVER NORMALISED. trustedAdminAction sees the
//     question exactly as asked. "make me an admin" is therefore RECOGNISED
//     (so the wizard can answer honestly) but produces NO action, because
//     widening which utterances trigger an op grant would be widening
//     server.console authority. Recognition and authority are kept apart.
//   * GAMERULE, DIFFICULTY and GAMEMODE HAVE NO LOCAL BUILDER. There is no
//     deterministic builder in src/wizard.mjs that can express them; the only
//     place those verbs appear is providerPowerMatchesRequest, which POLICES
//     model-authored plans. Writing a builder here would be exactly the new
//     privileged path the brief forbids. So those intents are returned with
//     `deliverable: false` and adminAction returns null for them. The intent
//     record still exists, which is what the never-empty floor needs: the
//     wizard can say what the child asked for and what the grown-up step is,
//     instead of saying nothing.
//   * Every action leaving this module is re-validated through the injected
//     allowedWizardAction and THAT value is returned, never a raw object. On
//     top of the allowlist there is a fidelity check: a weather intent must
//     come back as that weather, a time intent as that time, and an operator
//     intent as a single server.console step whose one command is exactly
//     `op {{requester}}` or `deop {{requester}}`. Those checks can only make
//     the detector deliver LESS.
//
// NOT STEALING TURNS. The bail structure mirrors src/roles/terrain.mjs:
// interrogative framing, lesson framing, embedded questions, build
// entanglement, and the injected recipe / command-lesson / conversation /
// potion-rain bails. A question about a setting ("what does keep inventory
// do", "how do I make it peaceful") is a question, and stays one.

// Conversational lead-ins that sit in front of an imperative. Stripping them is
// what turns "wiz can you stop the rain" into an imperative.
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

// An explicit ask. "can i have keep inventory on" and "i want peaceful mode"
// are requests, not questions, so they are allowed past the interrogative bail.
// This is the same shape explicitItemRequestClause already treats as a request
// in src/wizard.mjs, so the two rungs read child phrasing the same way.
const REQUEST_FRAME = /^(?:(?:hey|hi)[, ]+)?(?:(?:wizard|wiz)[,:]?\s*)?(?:(?:can|could|may)\s+(?:i|we)\s+(?:please\s+)?(?:have|get)\b|(?:i|we)\s+(?:really\s+)?(?:want|need)\b)/i;

// Question framing: "what does keep inventory do" is curiosity, not a work
// order. Checked after the lead-ins are stripped so "can you stop the rain"
// (a request) is not mistaken for an interrogative.
const INTERROGATIVE = /^(?:what|whats|what['’]s|why|how|when|where|who|whose|which|is|are|was|were|do|does|did|should|shall|may|might|must|am|can|could|would|will|if)\b/i;

// A question hiding mid-clause: "i want to know what keep inventory does".
const EMBEDDED_QUESTION = /\b(?:how|what|what['’]s|whats|why|when|where|which|whether|who)\b/i;

// Lesson framing. These belong to the teaching route, not to a settings change.
const LESSON = /^(?:tell|teach|show|explain|describe|remind|help\s+me\s+understand)\b/i;
const KNOWLEDGE = /\b(?:know|knows|learn|learns|learning|understand|explain|explains|mean|means|meaning|works?|working|about)\b/i;

// A settings clause entangled with construction belongs to the build path.
// Deliberately conservative: it can only make this detector fire LESS.
const BUILD_ENTANGLED = /\b(?:build|builds|building|built|construct|constructs|constructing|erect|erects|rebuild|rebuilds|rebuilding)\b/i;
const BUILD_DELIVERY = /\b(?:make|makes|making)\s+(?:me|us)\s+(?:an?|some)\b/i;

/* ------------------------------ vocabulary ------------------------------ */

// World rules. Every label here already appears in the gamerule intent pairing
// in providerPowerMatchesRequest, so this detector recognises exactly the rules
// the existing policy already knows about — no wider.
const GAMERULES = [
  { setting: "keepInventory", label: "keep inventory", pattern: /\bkeep\s*inventor(?:y|ies)\b/i },
  { setting: "mobGriefing", label: "mob griefing", pattern: /\bmob\s*grief(?:ing)?\b/i },
  { setting: "doDaylightCycle", label: "the daylight cycle", pattern: /\bdaylight\s*cycle\b/i },
  { setting: "doWeatherCycle", label: "the weather cycle", pattern: /\bweather\s*cycle\b/i },
  { setting: "fireSpread", label: "fire spread", pattern: /\bfire\s*(?:spread|spreading|tick)\b/i },
  { setting: "immediateRespawn", label: "immediate respawn", pattern: /\b(?:immediate|instant)\s*respawn\b/i },
];

// Operator phrasings. Every one is anchored at BOTH ends: the clause has to be
// the request and nothing else, so "make me an operator's tower" is a build and
// "op steve" (a request about somebody else) matches nothing here at all. Only
// the requester's own badge is ever in scope, which is the same scope the
// existing builder has.
const OPERATOR_ROLE = "(?:operator|op|admin(?:istrator)?)";
const OPERATOR_TAIL = "(?:\\s+(?:please|now|too|status|powers?|permissions?|rights?|access|level))*[.!?]*$";
const OPERATOR_GRANT = [
  new RegExp(`^(?:make|promote)\\s+(?:me|us)\\s+(?:an?\\s+)?${OPERATOR_ROLE}${OPERATOR_TAIL}`, "i"),
  new RegExp(`^op\\s+(?:me|us)${OPERATOR_TAIL}`, "i"),
  new RegExp(`^give\\s+(?:me|us)\\s+(?:the\\s+)?${OPERATOR_ROLE}${OPERATOR_TAIL}`, "i"),
  new RegExp(`^(?:i|we)\\s+(?:want|need)\\s+(?:to\\s+be\\s+)?(?:an?\\s+)?${OPERATOR_ROLE}${OPERATOR_TAIL}`, "i"),
  new RegExp(`^let\\s+(?:me|us)\\s+be\\s+(?:an?\\s+)?${OPERATOR_ROLE}${OPERATOR_TAIL}`, "i"),
  // What "i want to be an operator" leaves behind once the lead-in is stripped.
  new RegExp(`^be\\s+(?:an?\\s+)?${OPERATOR_ROLE}${OPERATOR_TAIL}`, "i"),
];
const OPERATOR_REMOVE = [
  new RegExp(`^(?:deop|demote)\\s+(?:me|us)${OPERATOR_TAIL}`, "i"),
  new RegExp(`^remove\\s+(?:my|our)\\s+${OPERATOR_ROLE}${OPERATOR_TAIL}`, "i"),
];

const DIFFICULTIES = ["peaceful", "easy", "normal", "hard"];
const GAME_MODES = ["creative", "survival", "adventure", "spectator"];

// Polarity. OFF is checked first so "turn off keep inventory" cannot be read as
// an ON by the bare "on" fallback.
const TOGGLE_OFF = /\b(?:turn(?:ed|s)?\s+off|switch(?:ed|es)?\s+off|shut\s+off|disable[ds]?|deactivate[ds]?|stop|stops|stopped|end|ends|cancel|get\s+rid\s+of|no\s+more|off)\b/i;
const TOGGLE_ON = /\b(?:turn(?:ed|s)?\s+on|switch(?:ed|es)?\s+on|enable[ds]?|activate[ds]?|allow|on)\b/i;

// Weather and time vocabulary.
const RAIN_NOUN = /\b(?:rain|rains|raining|rainy|rainstorm|storm|storms|storming|thunder|thunderstorm|lightning)\b/i;
const THUNDER_NOUN = /\b(?:thunder|thunderstorm|lightning|storm|storms|storming)\b/i;
// A BARE "sun" is not a weather order: measured while wiring this detector into
// the ladder (#44 WP-F), "make the sun explode" — a fantasy request the
// never-empty matrix deliberately marks NON-actionable — matched it through the
// setting frame and came back as "I'll clear the sky", a wrong-subject answer.
// The word only names the weather in a phrase that is about the weather.
const SUN_NOUN = /\b(?:sunny|sunshine)\b|\bsun\s+(?:come\s+|comes\s+)?(?:out|up|back)\b/i;
// "night vision" is an EFFECT, not a time of day. Measured while wiring this
// detector into the ladder (#44 WP-F): "give everyone night vision" — which the
// effect rung correctly refuses, because it can only reach the requester — fell
// through to here and turned the sky dark instead.
const NIGHT_NOUN = /\b(?:night(?!\s*vision)|nighttime|dark|darkness)\b/i;
const DAY_NOUN = /\b(?:day|daytime|morning|sunrise)\b/i;
const NOON_NOUN = /\bnoon\b/i;
const MIDNIGHT_NOUN = /\bmidnight\b/i;

// "stop the rain", "make the rain stop", "no more rain", "i want the night to
// be over". Any of these is a request to END whatever noun shares the clause.
const STOPPING = /^(?:stop|end|halt|cancel|shut\s+off|turn\s+off|get\s+rid\s+of|no\s+more)\b/i;
const STOPPING_TAIL = /\b(?:stop|stops|stopped|stopping|go\s+away|goes\s+away|went\s+away|be\s+over|quit|quits)\b/i;

// "make it night", "set the weather to rain", "bring the rain in".
const SETTING_FRAME = /^(?:make|set|change|turn|switch|start|begin|bring|call|put|give|let)\b/i;

// The literal requests handed to the injected worldControlAction when the
// child's own phrasing is one it cannot read. FIXED STRINGS — nothing is ever
// spliced in from the question.
const NORMALIZED_WORLD = {
  weather: {
    clear: "make the weather clear",
    rain: "make the weather rain",
    thunder: "make the weather thunder",
  },
  time: {
    day: "make it day",
    night: "make it night",
    noon: "make it noon",
    midnight: "make it midnight",
  },
};

const WORLD_STEP = {
  weather: {
    clear: "clear the sky above you",
    rain: "call the rain in",
    thunder: "roll a thunderstorm in",
  },
  time: {
    day: "turn the sky to day",
    night: "turn the sky to night",
    noon: "push the sun round to noon",
    midnight: "push the clock round to midnight",
  },
};

// Said whenever an intent is recognised but no existing builder can carry it
// out. Honest, and it still names one concrete next step.
function grownUpCaveat(what) {
  return `${what} is a world setting, and the switch for it lives with a grown-up rather than in my wand. I can tell you exactly which switch it is so a grown-up can flip it in one go.`;
}

/* -------------------------------- helpers ------------------------------- */

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
      throw new TypeError(`createAdminDetector requires a ${name} function`);
    }
  }
}

// True when the clause is nothing but the named phrase (plus politeness), the
// way "night vision" alone is an effect request in commandAction.
function isBarePhrase(direct, pattern) {
  return direct
    .replace(pattern, " ")
    .replace(/\b(?:please|mode|setting|rule|gamerule|game\s+rule)\b/gi, " ")
    .replace(/[^a-z0-9]+/gi, "")
    .length === 0;
}

/* -------------------------------- factory ------------------------------- */

export function createAdminDetector(deps = {}) {
  requireFunctions(deps, [
    "worldControlAction",
    "trustedAdminAction",
    "allowedWizardAction",
    "explicitlyRequestsBuild",
    "explicitlyRequestsCommand",
    "isRecipeRequest",
    "isOrdinaryConversation",
    "isPotionRainRequest",
  ]);
  const {
    worldControlAction,
    trustedAdminAction,
    allowedWizardAction,
    explicitlyRequestsBuild,
    explicitlyRequestsCommand,
    isRecipeRequest,
    isOrdinaryConversation,
    isPotionRainRequest,
  } = deps;

  // A clause that survives every framing bail, or null.
  function readClause(clause) {
    const direct = stripLeaders(clause);
    if (!direct) return null;
    const asked = REQUEST_FRAME.test(clause) || REQUEST_FRAME.test(direct);
    if (!asked && INTERROGATIVE.test(direct)) return null;
    if (LESSON.test(direct)) return null;
    if (EMBEDDED_QUESTION.test(direct)) return null;
    if (KNOWLEDGE.test(direct)) return null;
    return { direct, asked };
  }

  /* ----------------------------- the branches ---------------------------- */

  function operatorBranch({ direct }) {
    const grant = OPERATOR_GRANT.some((pattern) => pattern.test(direct));
    const remove = OPERATOR_REMOVE.some((pattern) => pattern.test(direct));
    if (!grant && !remove) return null;
    const value = remove ? "remove" : "grant";
    return {
      kind: "operator",
      setting: "operator",
      value,
      label: "operator",
      step: value === "grant" ? "make you an operator" : "take your operator badge back",
    };
  }

  function gameruleBranch({ direct, asked }) {
    const rule = GAMERULES.find(({ pattern }) => pattern.test(direct));
    if (!rule) return null;
    const value = TOGGLE_OFF.test(direct) ? "off"
      : TOGGLE_ON.test(direct) ? "on"
        : (asked || isBarePhrase(direct, rule.pattern)) ? "on" : null;
    if (!value) return null;
    return {
      kind: "gamerule",
      setting: rule.setting,
      value,
      label: rule.label,
      step: `switch ${rule.label} ${value}`,
      caveat: grownUpCaveat(`${rule.label.replace(/^the /, "")}`),
    };
  }

  function difficultyBranch({ direct, asked }) {
    const named = /\bdifficult(?:y|ies)\b/i.test(direct);
    const value = DIFFICULTIES.find((level) => new RegExp(`\\b${level}\\b`, "i").test(direct));
    if (!value) return null;
    // "easy", "normal" and "hard" are ordinary words, so outside an explicit
    // "difficulty" or "<level> mode" frame they are not a settings change.
    // "peaceful" names nothing else in Minecraft, so it stands on its own.
    const framed = named
      || new RegExp(`\\b${value}\\s+mode\\b`, "i").test(direct)
      || (value === "peaceful" && (SETTING_FRAME.test(direct) || asked || isBarePhrase(direct, /\bpeaceful\b/i)));
    if (!framed) return null;
    if (!SETTING_FRAME.test(direct) && !asked && !isBarePhrase(direct, new RegExp(`\\b${value}\\b`, "i"))) return null;
    return {
      kind: "difficulty",
      setting: "difficulty",
      value,
      label: "difficulty",
      step: `set the difficulty to ${value}`,
      caveat: grownUpCaveat("Difficulty"),
    };
  }

  function gameModeBranch({ direct, asked }) {
    const value = GAME_MODES.find((mode) => new RegExp(`\\b${mode}\\b`, "i").test(direct));
    if (!value) return null;
    const framed = /\bgame\s*mode\b/i.test(direct)
      || new RegExp(`\\b${value}\\s+mode\\b`, "i").test(direct)
      || new RegExp(`\\bput\\s+(?:me|us)\\s+(?:in|into|on)\\s+(?:the\\s+)?${value}\\b`, "i").test(direct);
    if (!framed) return null;
    if (!SETTING_FRAME.test(direct) && !asked) return null;
    return {
      kind: "gamemode",
      setting: "gamemode",
      value,
      label: "game mode",
      step: `put you in ${value} mode`,
      caveat: grownUpCaveat("Game mode"),
    };
  }

  // The weather/time phrasings worldControlAction cannot read: every "stop the
  // ..." / "no more ..." / "make it stop raining" form.
  function worldBranch({ direct, asked }) {
    const stopping = STOPPING.test(direct) || STOPPING_TAIL.test(direct);
    const setting = SETTING_FRAME.test(direct) || asked;
    const make = (settingName, value) => ({
      kind: "world",
      setting: settingName,
      value,
      label: settingName === "weather" ? "the weather" : "the time of day",
      step: WORLD_STEP[settingName][value],
    });
    if (RAIN_NOUN.test(direct)) {
      if (stopping) return make("weather", "clear");
      if (setting) return make("weather", THUNDER_NOUN.test(direct) ? "thunder" : "rain");
    }
    if (SUN_NOUN.test(direct) && (setting || stopping)) return make("weather", "clear");
    if (NIGHT_NOUN.test(direct)) {
      if (stopping) return make("time", "day");
      if (setting) return make("time", "night");
    }
    if (MIDNIGHT_NOUN.test(direct) && setting) return make("time", "midnight");
    if (NOON_NOUN.test(direct) && setting) return make("time", "noon");
    if (DAY_NOUN.test(direct)) {
      if (stopping) return make("time", "night");
      if (setting) return make("time", "day");
    }
    return null;
  }

  /* ------------------------------- the plan ------------------------------ */

  function plan(question) {
    const text = String(question || "");
    if (!text.trim()) return null;
    // Bails, cheapest first. Each hands the turn to a route that already owns
    // it: potion rain, command lessons, conversation, recipes, builds.
    if (isPotionRainRequest(text)) return null;
    if (explicitlyRequestsCommand(text)) return null;

    const clauses = clausesOf(text).map(readClause).filter(Boolean);
    if (!clauses.length) return null;

    // Operator first, and ahead of the build/recipe/conversation bails, because
    // that is exactly where trustedAdminAction already sits in classifyAction's
    // ladder. Its patterns are anchored at both ends, so it can only match a
    // clause that is the whole request.
    for (const clause of clauses) {
      const found = operatorBranch(clause);
      if (found) return decorate(found, text);
    }

    if (isOrdinaryConversation(text)) return null;
    if (isRecipeRequest(text)) return null;
    if (explicitlyRequestsBuild(text)) return null;
    if (BUILD_ENTANGLED.test(text) || BUILD_DELIVERY.test(text)) return null;

    for (const clause of clauses) {
      const found = gameruleBranch(clause)
        || difficultyBranch(clause)
        || gameModeBranch(clause)
        || worldBranch(clause);
      if (found) return decorate(found, text);
    }

    // Last: anything the existing world builder already understands is admin
    // intent too, read straight off the action it produced. This keeps the
    // intent record in step with the builder instead of re-deriving it, so a
    // combined change ("make it a clear day") is never split.
    const literal = allowedWizardAction(worldControlAction(text));
    if (literal?.type === "world_control") {
      const setting = literal.weather ? "weather" : "time";
      const value = literal.weather || literal.time;
      return decorate({
        kind: "world",
        setting,
        value,
        label: setting === "weather" ? "the weather" : "the time of day",
        step: WORLD_STEP[setting][value],
      }, text);
    }
    return null;
  }

  // Attach the action (if any builder can carry the intent out) and the
  // deliverable flag the caller needs to phrase a bound offer.
  function decorate(found, text) {
    const action = found.kind === "world" ? worldAction(found, text)
      : found.kind === "operator" ? operatorAction(found, text)
        : null;
    return { ...found, action, deliverable: Boolean(action) };
  }

  function worldAction(found, text) {
    const { setting, value } = found;
    const literal = worldControlAction(text);
    // Only reuse the child's own phrasing when the builder read it the way we
    // did. "make it stop raining" reads as rain to the builder and as clear
    // here, and the child asked for it to STOP — so the literal is discarded.
    const agrees = literal && literal[setting] === value;
    const raw = agrees ? literal : worldControlAction(NORMALIZED_WORLD[setting][value]);
    const action = allowedWizardAction(raw);
    if (action?.type !== "world_control") return null;
    if (action[setting] !== value) return null;
    return action;
  }

  // The question is handed to trustedAdminAction VERBATIM — never normalised.
  // Recognising a phrasing the existing builder does not accept must not turn
  // into an op grant, so a near-miss ("make me an admin") is recognised and
  // simply carries no action.
  function operatorAction(found, text) {
    const action = allowedWizardAction(trustedAdminAction(text));
    if (action?.type !== "execute_program") return null;
    const steps = action.program?.steps;
    if (!Array.isArray(steps) || steps.length !== 1) return null;
    const [step] = steps;
    if (step.capability !== "server.console") return null;
    const commands = step.arguments?.commands;
    if (!Array.isArray(commands) || commands.length !== 1) return null;
    const expected = found.value === "grant" ? "op {{requester}}" : "deop {{requester}}";
    return commands[0] === expected ? action : null;
  }

  // adminIntent(question) -> frozen record | null.
  // `deliverable` says whether adminAction can carry it out; when it is false
  // `caveat` says, in plain words, what actually has to happen instead.
  function adminIntent(question, _history = []) {
    const found = plan(question);
    if (!found) return null;
    return Object.freeze({
      kind: found.kind,
      setting: found.setting,
      value: found.value,
      label: found.label,
      step: found.step,
      deliverable: found.deliverable,
      ...(found.deliverable ? {} : { caveat: found.caveat || grownUpCaveat(found.label) }),
    });
  }

  // adminAction(question) -> the value allowedWizardAction returns, or null.
  // Never a raw candidate: the allowlist has the last word on every field.
  function adminAction(question, _history = []) {
    return plan(question)?.action || null;
  }

  return { adminIntent, adminAction };
}
