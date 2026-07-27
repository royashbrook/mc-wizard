// Terrain planner role (#44 / WP-B).
//
// A live child session asked the wizard to "clear a 50x50 area around me" and
// to "just level the ground, remove all blocks in a 50x50 area". Both turns
// shipped with no action at all: classifyAction had no terrain rung, and every
// recovery floor was lexically gated on isBuildRequest, which is false for
// terrain. This module is the deterministic rung that makes those turns real.
//
// CONTRACT
//   createTerrainPlanner(deps) -> { terrainIntent, terrainAction }
//
// Every dependency is INJECTED. This module must never import src/wizard.mjs:
// parseRequestedDimensions lives there and importing it would create a cycle
// (wizard.mjs wires this planner into classifyAction). Injection also keeps the
// planner independently unit-testable with no server, no provider and no world.
//
// SAFETY POSTURE. This is a DETERMINISTIC rung, not a model-authored plan, so
// none of the model-policing gates (providerActionMatchesRequest,
// providerPowerMatchesRequest, subject fidelity) apply to it and NONE of them
// is edited or widened by this work. The only safety surface it touches is the
// one it must pass: every candidate is re-validated through allowedWizardAction
// and the planner returns THAT value, never the raw object it authored. The
// emitted action is a typed terrain_work contract. Bedrock resolves the actual
// ground anchor, snapshots the world, performs the fill, and owns rollback.
//
// GEOMETRY. The footprint is centred on the player (`~` relative coordinates,
// which the pack resolves per-player via `execute as @a[tag=...] at @s run`).
// A requested N by M footprint becomes the half-extents floor(N/2), floor(M/2),
// so a 50 by 50 request fills 51x51 = 2601 blocks per y-layer. Bedrock's
// per-fill cap is 32768 blocks, so 12 layers of that footprint is 31212 blocks
// (one command) while 13 layers would be 33813 and fail in-world. Larger
// footprints are y-sliced into whole chunks of layers, never more than the 8
// commands src/skills.mjs allows for a run_commands action.
//
// CLAMPS ARE NEVER SILENT. Any clamp (footprint, vertical window, command
// count) puts a plain-language `caveat` string on the intent so the caller can
// tell the child what was actually done. terrainAction returns only the
// validated action, so the caveat rides on terrainIntent(question).caveat.

// Bedrock refuses a /fill whose box exceeds this many blocks.
// Largest footprint edge the wizard will clear in one turn.
export const MAX_FOOTPRINT = 64;
// Footprint used when the child names no size ("flatten this hill").
export const DEFAULT_FOOTPRINT = 16;
// Vertical window: feet (~0) up to ~+11, i.e. 12 layers.
export const DEFAULT_HEIGHT = 12;
// Tallest vertical window supported by the typed executor.
export const MAX_HEIGHT = 32;
export const LEVEL_FILL_DEPTH = 4;

const TERRAIN_VERBS = "clear|level|flatten|remove|dig|excavate|smooth|demolish|erase|wipe";
const IMPERATIVE_TERRAIN_VERB = new RegExp(`^(${TERRAIN_VERBS})\\b`, "i");
const LEVELLING_VERB = /^(?:level|flatten|smooth)$/i;

// A terrain/area noun. Without one in the SAME clause as the verb, "level with
// me, are villagers real" and "tell me about digging" are not terrain work.
// "hole"/"pit"/"mound"/"mountain" were missing, so ordinary child phrasings
// ("dig out a big hole here") produced no action at all. Excavation nouns name
// the same work the verbs already describe.
const TERRAIN_NOUN = /\b(?:areas?|ground|spaces?|patch(?:es)?|land|hills?|terrain|dirt|blocks?|trees?|regions?|plots?|holes?|pits?|mounds?|mountains?)\b/i;

// "make this flat" is a levelling order with a pronoun where a noun would go,
// so the verb+noun rule cannot see it. Deliberately narrow: only "make <this |
// it | that | here | the ground | the land> flat", never "make me a flat roof
// house", which BUILD_DELIVERY already bails on.
const MAKE_IT_FLAT = /^make\s+(?:this|it|that|here|the\s+(?:ground|land|area|terrain))\s+(?:area\s+)?(?:flat|level|even)\b/i;

// Conversational lead-ins that sit in front of an imperative. Stripping them is
// what turns "wiz can you clear the trees around here" into an imperative.
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

// Question framing: "what happens if I dig straight down" is curiosity, not a
// work order. Checked after the lead-ins are stripped, so "can you clear ..."
// (a request) is not mistaken for an interrogative.
const INTERROGATIVE = /^(?:what|whats|what['’]s|why|how|when|where|who|whose|which|is|are|was|were|do|does|did|should|shall|may|might|must|am|can|could|would|will|if)\b/i;

// A terrain clause entangled with construction belongs to the build path, not
// here: "clear the ground and build me a castle" must reach structureAction so
// subject fidelity still owns the castle. explicitlyRequestsBuild is anchored
// at the head of a clause and so misses the trailing-build form, hence this
// second, deliberately conservative guard. It can only make terrain fire LESS.
const BUILD_ENTANGLED = /\b(?:build|builds|building|built|construct|constructs|constructing|erect|erects|rebuild|rebuilds|rebuilding)\b/i;
const BUILD_DELIVERY = /\b(?:make|makes|making)\s+(?:me|us)\s+(?:an?|some)\b/i;

// Mirrors requestClauses in src/wizard.mjs: sentence enders and "then" split a
// request into clauses. Commas deliberately do NOT split, so "clear a 50x50
// area around me, starting at the ground beneath this tree" stays one clause.
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
      throw new TypeError(`createTerrainPlanner requires a ${name} function`);
    }
  }
}

function clampEdge(value) {
  const edge = Math.floor(Number(value));
  if (!Number.isFinite(edge) || edge < 1) return { edge: DEFAULT_FOOTPRINT, clamped: false };
  if (edge > MAX_FOOTPRINT) return { edge: MAX_FOOTPRINT, clamped: true };
  return { edge, clamped: false };
}

function clampHeight(value) {
  if (value === undefined || value === null) return { height: DEFAULT_HEIGHT, clamped: false };
  const height = Math.floor(Number(value));
  if (!Number.isFinite(height) || height < 1) return { height: DEFAULT_HEIGHT, clamped: false };
  if (height > MAX_HEIGHT) return { height: MAX_HEIGHT, clamped: true };
  return { height, clamped: false };
}

function caveatFor({ footprintClamped, requested, width, depth, heightClamped, height }) {
  const notes = [];
  if (footprintClamped) {
    notes.push(`${requested.width} by ${requested.depth} is a bigger patch than my wand can safely sweep in one spell, so I am clearing the biggest safe ${width} by ${depth} piece around you`);
  }
  if (heightClamped) {
    notes.push(`I am taking it ${height} blocks up from your feet this time`);
  }
  if (!notes.length) return undefined;
  return `${notes.join(", and ")}. Say the word and I will do the next piece.`;
}

export function createTerrainPlanner(deps = {}) {
  requireFunctions(deps, [
    "parseRequestedDimensions",
    "allowedWizardAction",
    "explicitlyRequestsBuild",
    "explicitlyRequestsCommand",
    "isRecipeRequest",
    "isOrdinaryConversation",
  ]);
  const {
    parseRequestedDimensions,
    allowedWizardAction,
    explicitlyRequestsBuild,
    explicitlyRequestsCommand,
    isRecipeRequest,
    isOrdinaryConversation,
  } = deps;

  // The one place that decides "this clause is a terrain work order".
  function terrainClause(question) {
    for (const clause of clausesOf(question)) {
      const direct = stripLeaders(clause);
      if (!direct || INTERROGATIVE.test(direct)) continue;
      const verb = direct.match(IMPERATIVE_TERRAIN_VERB)?.[1];
      // The verb and the noun must live in the SAME clause.
      if (verb && TERRAIN_NOUN.test(direct)) return { clause: direct, verb };
      // "make this flat": a levelling order carrying a pronoun, not a noun.
      if (MAKE_IT_FLAT.test(direct)) return { clause: direct, verb: "level" };
    }
    return null;
  }

  function plan(question) {
    const text = String(question || "");
    if (!text.trim()) return null;
    // Bails, in cheapest-first order. Each one hands the turn to a route that
    // already owns it: conversation, recipes, command lessons, builds.
    if (isOrdinaryConversation(text)) return null;
    if (isRecipeRequest(text)) return null;
    if (explicitlyRequestsCommand(text)) return null;
    if (explicitlyRequestsBuild(text)) return null;
    if (BUILD_ENTANGLED.test(text) || BUILD_DELIVERY.test(text)) return null;

    const found = terrainClause(text);
    if (!found) return null;

    // Dimensions are read from the WHOLE question: "just level the ground,
    // remove all blocks in a 50x50 area" names its size after the verb clause.
    const requestedRaw = parseRequestedDimensions(text) || {};
    const requestedWidth = requestedRaw.width ?? requestedRaw.depth ?? DEFAULT_FOOTPRINT;
    const requestedDepth = requestedRaw.depth ?? requestedRaw.width ?? DEFAULT_FOOTPRINT;
    const widthClamp = clampEdge(requestedWidth);
    const depthClamp = clampEdge(requestedDepth);
    const heightClamp = clampHeight(requestedRaw.height);

    const width = widthClamp.edge;
    const depth = depthClamp.edge;
    const height = heightClamp.height;

    return {
      mode: LEVELLING_VERB.test(found.verb) ? "level" : "clear",
      width,
      depth,
      height,
      fillDepth: LEVELLING_VERB.test(found.verb) ? LEVEL_FILL_DEPTH : 0,
      overLimit: widthClamp.clamped || depthClamp.clamped || heightClamp.clamped,
      caveat: caveatFor({
        footprintClamped: widthClamp.clamped || depthClamp.clamped,
        requested: { width: requestedWidth, depth: requestedDepth },
        width,
        depth,
        heightClamped: heightClamp.clamped,
        height,
      }),
    };
  }

  // terrainIntent(question) -> frozen { mode, width, depth, height, caveat? } | null
  function terrainIntent(question) {
    const terrain = plan(question);
    if (!terrain) return null;
    return Object.freeze({
      mode: terrain.mode,
      width: terrain.width,
      depth: terrain.depth,
      height: terrain.height,
      ...(terrain.caveat ? { caveat: terrain.caveat } : {}),
    });
  }

  // terrainAction(question) -> the value allowedWizardAction returns, or null.
  // Never the raw candidate: the allowlist has the last word on every field.
  function terrainAction(question) {
    const terrain = plan(question);
    if (!terrain || terrain.overLimit) return null;
    return allowedWizardAction({
      type: "terrain_work",
      version: 1,
      mode: terrain.mode,
      width: terrain.width,
      depth: terrain.depth,
      height: terrain.height,
      fillDepth: terrain.fillDepth,
    });
  }

  return { terrainIntent, terrainAction };
}
