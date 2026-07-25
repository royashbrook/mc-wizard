// #35/#44 role extraction — the Escalator.
//
// src/wizard.mjs today has TWO divergent floor sites (the repair-exhausted
// fallback and the trailing `buildRequest && !selectedAction` fallback). Both
// are lexically inside `if (buildRequest)`, which is exactly why a terrain,
// admin, travel or gift turn whose planner produced nothing shipped a bare
// refusal to a child. This module unifies them into ONE ordered ladder,
// preserving both existing orderings:
//
//   * provisionalRecipeAction OUTRANKS localStructureFallback (both sites do
//     `provisionalRecipeAction || localStructureFallback(...)`), and
//   * stagedBuildProgressAction stays reachable only as a CONTINUATION —
//     preserved by delegation, since it lives inside localStructureFallback's
//     priorStagedStructureProgress guard and this module never reimplements it.
//
// Every rung is injected. This module owns no regex, no allowlist and no
// Minecraft vocabulary of its own; it is ordering and bookkeeping only.
//
// LADDER CONTRACT
//   next(escalationIndex, intent, ctx, rejectedRungs) -> { rung, index, candidate } | null
//   * rungs are tried in order from `escalationIndex`;
//   * a rung already named in `rejectedRungs` is NEVER produced again;
//   * a rung whose applies() is false is skipped without consuming a turn;
//   * a rung that produces nothing (or throws) returns with candidate === null,
//     so the caller records it and escalates again — the walk is bounded by the
//     ladder length and no rung is ever re-litigated;
//   * a rung marked bypassCritique ships prose with no action (R5, R6) and is
//     therefore not sent through the Critic, whose existence tier would reject
//     any action-free candidate on an actionable turn.

export const RUNG = Object.freeze({
  PLANNER: "planner",
  CLASSIFY: "classify",
  PROVISIONAL_RECIPE: "provisional-recipe",
  LOCAL_STRUCTURE: "local-structure",
  TERRAIN: "terrain",
  BOUND_OFFER: "bound-offer",
  PLANNING_DEFERRED: "planning-deferred",
});

/** The ladder's fixed order, R0..R6. */
export const RUNG_ORDER = Object.freeze([
  RUNG.PLANNER,
  RUNG.CLASSIFY,
  RUNG.PROVISIONAL_RECIPE,
  RUNG.LOCAL_STRUCTURE,
  RUNG.TERRAIN,
  RUNG.BOUND_OFFER,
  RUNG.PLANNING_DEFERRED,
]);

const alwaysApplies = () => true;

function normalizeRung(rung, position) {
  if (!rung || typeof rung !== "object") throw new TypeError(`rung ${position} must be an object`);
  if (!rung.name) throw new TypeError(`rung ${position} needs a name`);
  if (typeof rung.produce !== "function") throw new TypeError(`rung ${rung.name} needs a produce() function`);
  return Object.freeze({
    name: rung.name,
    applies: typeof rung.applies === "function" ? rung.applies : alwaysApplies,
    produce: rung.produce,
    responseMode: rung.responseMode,
    bypassCritique: Boolean(rung.bypassCritique),
  });
}

/**
 * Normalizes a rung's raw output into an outcome the Orchestrator can adopt.
 * A raw action is recognized by its string `type` (every allowed wizard action
 * has one); anything else is treated as an already-shaped outcome.
 */
function normalizeCandidate(raw, rung, intent, ctx) {
  if (!raw) return null;
  const outcome = typeof raw.type === "string" ? { action: raw } : { ...raw };
  outcome.action = outcome.action ?? null;
  if (!outcome.action && (outcome.answer === undefined || outcome.answer === null)) return null;
  if (!outcome.responseMode) {
    outcome.responseMode = typeof rung.responseMode === "function"
      ? rung.responseMode(outcome.action, intent, ctx)
      : rung.responseMode;
  }
  outcome.rung = rung.name;
  return outcome;
}

/**
 * @param {Array<{name:string, produce:Function, applies?:Function,
 *   responseMode?:string|Function, bypassCritique?:boolean}>} rungs
 */
export function createEscalator(rungs = []) {
  const ladder = rungs.filter(Boolean).map(normalizeRung);
  const seen = new Set();
  for (const rung of ladder) {
    if (seen.has(rung.name)) throw new TypeError(`duplicate rung name ${rung.name}`);
    seen.add(rung.name);
  }
  return {
    length: ladder.length,
    names: Object.freeze(ladder.map((rung) => rung.name)),
    next(escalationIndex = 0, intent = {}, ctx = {}, rejectedRungs = []) {
      const rejected = new Set(rejectedRungs || []);
      for (let index = Math.max(0, escalationIndex | 0); index < ladder.length; index += 1) {
        const rung = ladder[index];
        if (rejected.has(rung.name)) continue;
        let applies = false;
        try {
          applies = Boolean(rung.applies(intent, ctx));
        } catch (error) {
          ctx?.recordRejection?.(`rung:${rung.name}`, error?.message || String(error));
          applies = false;
        }
        if (!applies) continue;
        let candidate = null;
        try {
          candidate = normalizeCandidate(rung.produce(intent, ctx), rung, intent, ctx);
        } catch (error) {
          // A throwing rung must never take the turn down with it — the ladder's
          // whole purpose is totality.
          ctx?.recordRejection?.(`rung:${rung.name}`, error?.message || String(error));
          candidate = null;
        }
        return { rung, index, candidate };
      }
      return null;
    },
  };
}

/**
 * Builds the canonical R0..R6 ladder from injected planners. Every dependency
 * is optional except the terminal one: R6 must always be able to ship, which is
 * what makes the ladder a total function.
 *
 * @param {object} deps
 * @param {Function} [deps.plannerAction]            R0 accepted planner/learned action
 * @param {Function} [deps.classifyAction]           R1 deterministic ladder
 * @param {Function} [deps.provisionalRecipeAction]  R2 graded-but-unproven recipe (build turns)
 * @param {Function} [deps.localStructureFallback]   R3 guaranteed local floor (build turns)
 * @param {Function} [deps.terrainAction]            R4 terrain rung
 * @param {Function} [deps.boundOffer]               R5 one concrete, bindable next step
 * @param {Function|string} deps.planningDeferred    R6 terminal deferred answer
 * @param {object} [deps.responseModes]              response mode per rung
 */
export function createStandardEscalator(deps = {}) {
  const {
    plannerAction,
    classifyAction,
    provisionalRecipeAction,
    localStructureFallback,
    terrainAction,
    boundOffer,
    planningDeferred,
    responseModes = {},
  } = deps;
  if (!planningDeferred) throw new TypeError("createStandardEscalator requires planningDeferred (R6 is terminal)");
  const buildish = (intent) => Boolean(intent?.buildRequest || intent?.projectFeedback);
  const call = (fn) => (intent, ctx) => (typeof fn === "function" ? fn(intent, ctx) : null);
  const deferred = typeof planningDeferred === "function"
    ? planningDeferred
    : () => ({ action: null, answer: planningDeferred });

  return createEscalator([
    plannerAction && {
      name: RUNG.PLANNER,
      produce: call(plannerAction),
      responseMode: responseModes.planner,
    },
    classifyAction && {
      name: RUNG.CLASSIFY,
      produce: call(classifyAction),
      responseMode: responseModes.classify || "local-action-recovery",
    },
    provisionalRecipeAction && {
      name: RUNG.PROVISIONAL_RECIPE,
      applies: buildish,
      produce: call(provisionalRecipeAction),
      responseMode: responseModes.provisionalRecipe || "learned-recipe-provisional",
    },
    localStructureFallback && {
      name: RUNG.LOCAL_STRUCTURE,
      applies: buildish,
      produce: call(localStructureFallback),
      responseMode: responseModes.localStructure || "local-structure-fallback",
    },
    terrainAction && {
      name: RUNG.TERRAIN,
      applies: (intent) => Boolean(intent?.terrainIntent),
      produce: call(terrainAction),
      responseMode: responseModes.terrain || "local-skill",
    },
    boundOffer && {
      name: RUNG.BOUND_OFFER,
      produce: call(boundOffer),
      responseMode: responseModes.boundOffer || "local-offer-floor",
      bypassCritique: true,
    },
    {
      name: RUNG.PLANNING_DEFERRED,
      produce: deferred,
      responseMode: responseModes.planningDeferred || "planning-deferred",
      bypassCritique: true,
    },
  ]);
}
