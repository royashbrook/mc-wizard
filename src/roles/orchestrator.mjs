// #35/#44 role extraction — the Orchestrator.
//
// The explicit turn state machine that replaces the straight-line 500-line body
// of ask(). It owns transitions, budgets, planner-vs-critic adjudication, and
// the single terminal assertion that makes "never give up and never do nothing"
// a structural property instead of a hope.
//
// It contains NO regex, NO Minecraft vocabulary and NO allowlist. Every domain
// decision arrives through an injected role, so this module can never widen a
// safety boundary and is fully unit-testable with fakes.
//
// ── EXTRACTION BOUNDARY (read before moving anything else in here) ───────────
// The Orchestrator deliberately does NOT own:
//   * sessions.reserve / isCurrent / appendIfCurrent and the requestSequence,
//   * goalForTurn and the goalId resolution ladder,
//   * player-preference application,
//   * the final unsafeCommandAnswer scrub, which MUST remain the last transform
//     applied to `answer`.
// All of those stay in ask(). Moving persistence or goalId in here would break
// recordActionResult silently: its supersede check, its 6-action automatic cap
// and its 3-failure cap are all keyed on the requestSequence/goalId coupling
// minted once per ask(), and the whole state machine below runs inside ONE
// reservation. A longer ladder therefore cannot mint extra sequences, and
// supersede semantics are provably unchanged.
// ─────────────────────────────────────────────────────────────────────────────
//
// STATE MACHINE
//   START      -> SHORTCUT (no consult) | CONSULT
//   SHORTCUT   -> CRITIQUE (an action, or an actionable turn with none) | FINALIZE
//   CONSULT    -> ANSWER_ONLY | REVIEW | CRITIQUE ; ANY throw -> ESCALATE
//   ANSWER_ONLY-> FINALIZE
//   REVIEW     -> FINALIZE (verified complete) | CRITIQUE (corrective) | ESCALATE
//   CRITIQUE   -> FINALIZE ('none' / 'warning') | REPAIR ('contract' + budget)
//                 | ESCALATE ('fatal', or 'contract' with no budget)
//   REPAIR     -> CRITIQUE (repaired actions are re-critiqued, never trusted)
//                 | ESCALATE (exhausted)
//   ESCALATE   -> CRITIQUE | ESCALATE (rung produced nothing) | FINALIZE
//   FINALIZE   -> terminal; its single back-edge to ESCALATE fires at most once.
//
// TERMINATION: escalationIndex and the repair counter are monotonically
// increasing integers with hard ceilings (7 and MC_WIZARD_REPAIR_ROUNDS <= 4),
// every transition either increments one of them or moves toward FINALIZE, the
// lone back-edge is boolean-guarded, and FINALIZE is the unique terminal state
// where assertUsefulOutcome runs unconditionally.

export const PHASE = Object.freeze({
  START: "START",
  SHORTCUT: "SHORTCUT",
  CONSULT: "CONSULT",
  ANSWER_ONLY: "ANSWER_ONLY",
  REVIEW: "REVIEW",
  CRITIQUE: "CRITIQUE",
  REPAIR: "REPAIR",
  ESCALATE: "ESCALATE",
  FINALIZE: "FINALIZE",
  DONE: "DONE",
});

/** The ladder is 7 rungs (R0..R6); the walk can never exceed it. */
export const MAX_ESCALATIONS = 7;
/** Belt-and-braces ceiling on total transitions. Never reached by design. */
const MAX_TRANSITIONS = 64;
/** The response mode the behaviour pack retries on its own. */
const DEFERRED_MODE = "planning-deferred";
/** Response mode stamped when the floor has to author a bound offer. */
const OFFER_FLOOR_MODE = "local-offer-floor";
/** Last-resort prose if an injected bound-offer builder is missing or throws. */
const FLOOR_ANSWER = "I don’t have a safe next step for that yet. Tell me one specific thing to change and I’ll start on it right away.";

/**
 * The ONE per-turn budget object. It is constructed here and passed BY
 * REFERENCE into the repair planner so a single wall clock governs every
 * provider round in the turn — repair rounds cannot stack extra minutes of dead
 * air in front of a child.
 *
 * Clamps mirror repairPlannerAction exactly: rounds 1..4 (default 2), wall
 * clock 1ms..600s (default 90s).
 */
export function createTurnBudget({ env = {}, repairRounds, budgetMs, now = () => Date.now() } = {}) {
  const rounds = Math.min(Math.max(Number(repairRounds ?? env.MC_WIZARD_REPAIR_ROUNDS) || 2, 1), 4);
  const wallClockMs = Math.min(
    Math.max(Number(budgetMs ?? env.MC_WIZARD_REPAIR_BUDGET_MS) || 90_000, 1),
    600_000,
  );
  const budget = {
    repairRounds: rounds,
    budgetMs: wallClockMs,
    startedAt: now(),
    providerCalls: 0,
    consults: 0,
    repairRoundsUsed: 0,
    now,
    elapsedMs() {
      return now() - budget.startedAt;
    },
    exhausted() {
      return budget.elapsedMs() >= budget.budgetMs;
    },
    remainingRepairRounds() {
      return Math.max(0, budget.repairRounds - budget.repairRoundsUsed);
    },
    canRepair() {
      return budget.remainingRepairRounds() > 0 && !budget.exhausted();
    },
    /** Decrements the shared budget. Called exactly once per provider call. */
    spendProviderCall(kind = "consult") {
      budget.providerCalls += 1;
      if (kind === "repair") budget.repairRoundsUsed += 1;
      else budget.consults += 1;
      return budget.providerCalls;
    },
  };
  return budget;
}

function applyOutcome(state, outcome) {
  if (!outcome || typeof outcome !== "object") return;
  const hasAction = Object.hasOwn(outcome, "action");
  const hasMode = Object.hasOwn(outcome, "responseMode") && outcome.responseMode;
  if (hasAction || hasMode) {
    state.adopt({
      action: hasAction ? outcome.action ?? null : state.action,
      responseMode: hasMode ? outcome.responseMode : state.responseMode,
      ...(outcome.answer !== undefined && outcome.answer !== null && { answer: outcome.answer }),
    });
  } else if (outcome.answer !== undefined && outcome.answer !== null) {
    state.answer = outcome.answer;
  }
  if (Object.hasOwn(outcome, "goal")) state.providerGoal = outcome.goal;
  if (Object.hasOwn(outcome, "providerGoal")) state.providerGoal = outcome.providerGoal;
  if (Object.hasOwn(outcome, "title") && outcome.title !== undefined) state.title = outcome.title;
  if (Object.hasOwn(outcome, "providerActionAccepted")) {
    state.providerActionAccepted = Boolean(outcome.providerActionAccepted);
  }
  if (Object.hasOwn(outcome, "contractCaveat")) state.contractCaveat = outcome.contractCaveat || "";
}

/**
 * @param {object} deps
 * @param {object} deps.planners  consult, repair, reviewVerdict, canonicalize,
 *   stillAdvances, onConsultError — every one optional, every one injected.
 * @param {{critique:Function}} [deps.critic]
 * @param {{next:Function}} [deps.escalator]
 * @param {object} [deps.budget]  the shared per-turn budget (see createTurnBudget)
 * @param {object} [deps.assertions] offersAction / isMenuShape / boundOffer
 * @param {string} [deps.rejectedResponseMode] mode stamped when an action is dropped
 */
export function createOrchestrator({
  planners = {},
  critic,
  escalator,
  budget = createTurnBudget(),
  assertions = {},
  logger = { warn() {}, log() {}, error() {} },
  rejectedResponseMode = "offline",
  maxEscalations = MAX_ESCALATIONS,
} = {}) {
  const satisfiesOffer = typeof assertions.satisfiesOffer === "function"
    ? assertions.satisfiesOffer
    : (answer) => Boolean(assertions.offersAction?.(answer))
      && !assertions.isMenuShape?.(answer);

  /**
   * The single terminal assertion. It runs unconditionally inside FINALIZE, and
   * FINALIZE is the unique terminal state — so no path out of runTurn skips it.
   */
  function assertUsefulOutcome(intent, state, ctx) {
    if (!intent.actionableIntent) return;
    if (state.action) return;
    if (state.responseMode === DEFERRED_MODE) return;
    if (satisfiesOffer(state.answer)) return;
    let offer;
    try {
      offer = assertions.boundOffer?.(intent, ctx);
    } catch (error) {
      logger.warn(`[orchestrator] bound-offer floor threw: ${error?.message || error}`);
      offer = undefined;
    }
    const answer = (typeof offer === "string" ? offer : offer?.answer)
      || assertions.floorAnswer || FLOOR_ANSWER;
    const responseMode = (typeof offer === "object" && offer?.responseMode) || OFFER_FLOOR_MODE;
    state.adopt({ action: null, responseMode, answer });
    state.recordRejection("offer-floor", "no rung produced an executable action; shipped a bound offer");
  }

  return {
    budget,
    /**
     * @param {Readonly<object>} intent  the frozen TurnIntent
     * @param {object} state             the TurnState, seeded with the
     *   deterministic/learned action and the baseline local answer
     * @returns {Promise<object>} the same TurnState, in its terminal form
     */
    async runTurn(intent, state) {
      const ctx = {
        intent,
        state,
        budget,
        recordRejection: (gate, reason) => state.recordRejection(gate, reason),
      };
      let phase = PHASE.START;
      let backEdgeUsed = false;
      let verdict = null;
      let steps = 0;

      while (phase !== PHASE.DONE) {
        if (steps >= MAX_TRANSITIONS) {
          // Unreachable by construction; if it ever trips, fail toward the
          // terminal state rather than spinning in front of a child.
          logger.warn("[orchestrator] transition ceiling reached; forcing FINALIZE");
          backEdgeUsed = true;
          phase = PHASE.FINALIZE;
        }
        steps += 1;
        state.noteTransition(phase);

        switch (phase) {
          case PHASE.START: {
            phase = intent.consultModel ? PHASE.CONSULT : PHASE.SHORTCUT;
            break;
          }

          case PHASE.SHORTCUT: {
            // Nothing to call: the deterministic and learned planners already
            // ran, and their result is what the state was seeded with. A turn
            // that reaches here makes ZERO provider calls.
            phase = state.action || intent.actionableIntent ? PHASE.CRITIQUE : PHASE.FINALIZE;
            break;
          }

          case PHASE.CONSULT: {
            let result;
            try {
              if (typeof planners.consult === "function") {
                budget.spendProviderCall("consult");
                state.providerConsulted = true;
                result = await planners.consult(intent, state, budget);
              }
            } catch (error) {
              // Envelope parse, unusable answer, transport, timeout — all of it
              // lands here. Unlike today's blanket reset, nothing is erased:
              // whatever deterministic action the turn already had survives and
              // the ladder gets its chance.
              if (!error?.gateRecorded) {
                state.recordRejection("provider-error", error?.message || String(error));
              }
              logger.warn(`[orchestrator] provider consult failed: ${error?.message || error}`);
              try {
                applyOutcome(state, planners.onConsultError?.(intent, state, error));
              } catch (hookError) {
                logger.warn(`[orchestrator] consult-error hook threw: ${hookError?.message || hookError}`);
              }
              // If the deterministic ladder already produced something, that
              // action is what survives the outage — it goes through the critic
              // like any other candidate rather than being escalated past (and
              // silently replaced by a lower rung). With no action to keep, the
              // ladder is the whole recovery.
              phase = state.action ? PHASE.CRITIQUE : PHASE.ESCALATE;
              break;
            }
            applyOutcome(state, result);
            phase = result?.finalize ? PHASE.FINALIZE
              : intent.answerOnlyRequest ? PHASE.ANSWER_ONLY
                : intent.reviewRequest ? PHASE.REVIEW
                  : PHASE.CRITIQUE;
            break;
          }

          case PHASE.ANSWER_ONLY: {
            phase = PHASE.FINALIZE;
            break;
          }

          case PHASE.REVIEW: {
            const review = planners.reviewVerdict?.(intent, state, ctx)
              || { complete: false, corrective: false };
            if (review.complete) phase = PHASE.FINALIZE;
            else if (review.corrective) phase = PHASE.CRITIQUE;
            else {
              // Fails closed: a review turn is not actionableIntent, so ESCALATE
              // finds an empty ladder and finalizes with prose. "Do something
              // anyway" on a review would silently replace a child's build.
              state.recordRejection(
                "review-verdict",
                review.reason || "review returned neither verified completion nor a corrective action",
              );
              phase = PHASE.ESCALATE;
            }
            break;
          }

          case PHASE.CRITIQUE: {
            verdict = await critic?.critique?.(state.action, intent, ctx) || { severity: "none" };
            const severity = verdict.severity
              || (verdict.ok === false ? "contract" : "none");
            if (severity !== "none") {
              state.recordRejection(
                verdict.gate || verdict.tier || "critic",
                verdict.reason || severity,
              );
            }
            if (severity === "none") { phase = PHASE.FINALIZE; break; }
            if (severity === "warning") {
              // ORCHESTRATOR OVERRULES THE CRITIC: an imperfect-but-usable plan
              // ships with an honest caveat and an active goal. Partial credit
              // goes to the world, where the post-execution evaluator finishes
              // the argument — not to another provider round.
              if (verdict.warning) state.contractCaveat = verdict.warning;
              if (state.providerGoal?.status === "complete") {
                state.providerGoal = { ...state.providerGoal, status: "active" };
              }
              phase = PHASE.FINALIZE;
              break;
            }
            if (severity === "fatal") {
              // C0 safety: the critic wins unconditionally. Never repaired
              // toward, never hinted at, never overridable.
              state.adopt({ action: null, responseMode: rejectedResponseMode });
              state.providerActionAccepted = false;
              phase = PHASE.ESCALATE;
              break;
            }
            // 'contract' (existence / fidelity / completeness). Repair is a
            // PROVIDER round, so it is gated on the cost gate, on the shared
            // budget, and on not having escalated yet: once the ladder is
            // walking, the candidates are locally authored and re-consulting the
            // model about them would spend a child's turn on nothing.
            phase = intent.consultModel && state.escalationIndex === 0
              && typeof planners.repair === "function" && budget.canRepair()
              ? PHASE.REPAIR : PHASE.ESCALATE;
            break;
          }

          case PHASE.REPAIR: {
            let repair;
            try {
              budget.spendProviderCall("repair");
              repair = await planners.repair(intent, state, budget, verdict);
            } catch (error) {
              if (!error?.gateRecorded) {
                state.recordRejection("repair-error", error?.message || String(error));
              }
              phase = PHASE.ESCALATE;
              break;
            }
            if (repair?.accepted) {
              applyOutcome(state, repair);
              if (!Object.hasOwn(repair, "providerActionAccepted")) state.providerActionAccepted = true;
              // A repaired action is NEVER trusted: it goes back through the
              // whole critic, safety tier first.
              phase = PHASE.CRITIQUE;
            } else {
              state.recordRejection("repair-failed", repair?.finalDetail || "planner repair exhausted");
              phase = PHASE.ESCALATE;
            }
            break;
          }

          case PHASE.ESCALATE: {
            if (!intent.actionableIntent || state.escalationIndex >= maxEscalations || !escalator) {
              phase = PHASE.FINALIZE;
              break;
            }
            const step = escalator.next(state.escalationIndex, intent, ctx, state.rejectedRungs);
            if (!step) { phase = PHASE.FINALIZE; break; }
            state.recordEscalation(step.rung.name, step.index);
            if (!step.candidate) { phase = PHASE.ESCALATE; break; }
            applyOutcome(state, step.candidate);
            phase = step.rung.bypassCritique ? PHASE.FINALIZE : PHASE.CRITIQUE;
            break;
          }

          case PHASE.FINALIZE: {
            if (state.action && typeof planners.canonicalize === "function") {
              const canonical = planners.canonicalize(state.action, intent, ctx);
              if (canonical && canonical !== state.action) {
                state.adopt({ action: canonical, responseMode: state.responseMode });
              }
            }
            if (state.action && typeof planners.stillAdvances === "function"
              && !planners.stillAdvances(state.action, intent, ctx)) {
              state.recordRejection("final-advance", "the final action no longer advanced the request");
              const emptied = planners.emptyAnswer?.(intent, state, ctx);
              state.adopt({
                action: null,
                responseMode: rejectedResponseMode,
                ...(emptied && { answer: emptied }),
              });
              if (!backEdgeUsed && intent.actionableIntent) {
                backEdgeUsed = true;
                phase = PHASE.ESCALATE;
                break;
              }
            }
            assertUsefulOutcome(intent, state, ctx);
            phase = PHASE.DONE;
            break;
          }

          default: {
            phase = PHASE.FINALIZE;
            break;
          }
        }
      }
      return state;
    },
  };
}

/** Convenience alias — the spec names this entry point planTurn in places. */
export function planTurn(orchestrator, intent, state) {
  return orchestrator.runTurn(intent, state);
}
