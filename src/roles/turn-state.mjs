// #35/#44 role extraction — TurnState.
//
// The turn body in src/wizard.mjs rewrites seven closure mutables out of order
// across ~350 lines (answer, selectedAction, providerGoal,
// providerActionAccepted, contractCaveat, title, responseMode) plus the
// gateTrace telemetry accumulator. This module makes that implicit blackboard
// explicit and enforces exactly ONE invariant on it:
//
//   `action` and `responseMode` are only ever written TOGETHER, through
//   adopt(). They cannot drift apart.
//
// The drift matters outside Node: the behaviour pack keys its planning-deferred
// retry on `mode === "planning-deferred" && !action`
// (bedrock/.../main.js applyResponse/askBackend), so a responseMode that no
// longer describes the action it shipped with changes in-world behaviour with
// no Node test able to catch it. Direct assignment to either field throws.
//
// Pure data. No Minecraft vocabulary, no regex, no allowlist, no imports.

/** Bound applied to every recorded rejection reason (matches ask()'s gateTrace). */
const REASON_LIMIT = 200;

function normalizeReason(reason) {
  return String(reason || "").replace(/\s+/g, " ").trim().slice(0, REASON_LIMIT);
}

/**
 * @param {object} [seed]
 * @param {string} [seed.answer]           the baseline local answer
 * @param {object|null} [seed.action]      the deterministic/learned action, if any
 * @param {string} [seed.responseMode]     the response mode that describes `action`
 * @param {string} [seed.title]
 * @param {object} [seed.providerGoal]
 * @param {boolean} [seed.providerActionAccepted]
 * @param {string} [seed.contractCaveat]
 * @param {boolean} [seed.providerConsulted]
 */
export function createTurnState({
  answer = "",
  action = null,
  responseMode = "offline",
  title = undefined,
  providerGoal = undefined,
  providerActionAccepted = false,
  contractCaveat = "",
  providerConsulted = false,
} = {}) {
  let currentAction = action ?? null;
  let currentResponseMode = responseMode;
  let escalationIndex = 0;
  const rejectedRungs = [];
  const transitions = [];
  const gateTrace = [];

  const state = {
    answer,
    title,
    providerGoal,
    providerActionAccepted,
    contractCaveat,
    providerConsulted,
    gateTrace,

    /**
     * The ONLY writer of action + responseMode. Both keys are required so a
     * caller can never move one without the other; `answer` is optional.
     */
    adopt(patch) {
      if (!patch || typeof patch !== "object") {
        throw new TypeError("adopt() requires an object with action and responseMode");
      }
      if (!Object.hasOwn(patch, "action") || !Object.hasOwn(patch, "responseMode")) {
        throw new TypeError("adopt() requires BOTH action and responseMode so they cannot drift");
      }
      currentAction = patch.action ?? null;
      currentResponseMode = patch.responseMode;
      if (Object.hasOwn(patch, "answer") && patch.answer !== undefined) state.answer = patch.answer;
      return state;
    },

    recordRejection(gate, reason) {
      gateTrace.push({ gate, reason: normalizeReason(reason) });
      return state;
    },

    /** Records the rejection AND returns a throwable already marked as traced. */
    gateError(gate, message) {
      state.recordRejection(gate, message);
      const error = new Error(message);
      error.gateRecorded = true;
      return error;
    },

    /**
     * Advances the escalation ladder. escalationIndex is strictly increasing and
     * rejectedRungs is append-only, so no rung is ever re-litigated.
     */
    recordEscalation(rungName, index) {
      const nextIndex = Math.max(
        escalationIndex + 1,
        Number.isInteger(index) ? index + 1 : 0,
      );
      escalationIndex = nextIndex;
      if (rungName && !rejectedRungs.includes(rungName)) rejectedRungs.push(rungName);
      return escalationIndex;
    },

    noteTransition(name) {
      transitions.push(name);
      return state;
    },

    /** A plain, frozen copy — handy for deep-equality assertions in tests. */
    snapshot() {
      return Object.freeze({
        answer: state.answer,
        action: currentAction,
        responseMode: currentResponseMode,
        title: state.title,
        providerGoal: state.providerGoal,
        providerActionAccepted: state.providerActionAccepted,
        contractCaveat: state.contractCaveat,
        providerConsulted: state.providerConsulted,
        escalationIndex,
        rejectedRungs: [...rejectedRungs],
        transitions: [...transitions],
        gateTrace: gateTrace.map((entry) => ({ ...entry })),
      });
    },
  };

  Object.defineProperty(state, "action", {
    enumerable: true,
    get: () => currentAction,
    set() {
      throw new TypeError("action is written through adopt({ action, responseMode }) only");
    },
  });
  Object.defineProperty(state, "responseMode", {
    enumerable: true,
    get: () => currentResponseMode,
    set() {
      throw new TypeError("responseMode is written through adopt({ action, responseMode }) only");
    },
  });
  Object.defineProperty(state, "escalationIndex", {
    enumerable: true,
    get: () => escalationIndex,
    set() {
      throw new TypeError("escalationIndex advances through recordEscalation() only");
    },
  });
  Object.defineProperty(state, "rejectedRungs", {
    enumerable: true,
    get: () => rejectedRungs,
    set() {
      throw new TypeError("rejectedRungs is append-only through recordEscalation()");
    },
  });
  Object.defineProperty(state, "transitions", {
    enumerable: true,
    get: () => transitions,
    set() {
      throw new TypeError("transitions is append-only through noteTransition()");
    },
  });

  return state;
}
