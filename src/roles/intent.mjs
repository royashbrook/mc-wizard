// #35/#44 role extraction — TurnIntent.
//
// A verbatim relocation of the turn-mode classification block in
// src/wizard.mjs's ask() (the answerOnlyRequest / reviewRequest / recipeRequest
// / satisfied / instantAnswer / projectFeedback / buildRequest / conversational
// / retrievalQuery / researchRequired / askModel cascade). Every predicate is
// INJECTED — this module owns no regex of its own beyond the two literal
// residue checks that were already inline — so nothing here can widen a safety
// gate and there is no import cycle with src/wizard.mjs.
//
// It adds exactly two fields to that cascade:
//
//   actionableIntent — the generalization of buildRequest that unlocks the
//     never-empty floor for terrain / admin / travel / gift / effect turns.
//     Deliberately FALSE on review and answer-only turns: "do something anyway"
//     on a review would silently replace a child's build, and an honest "I
//     don't know" on a knowledge question must stay honest.
//
//   consultModel — the askModel expression, copied character for character. It
//     is the sole cost gate (a greeting, a thanks, a joke, a canned blueprint
//     and a canned gift must all make ZERO provider calls) and it is computed
//     in exactly ONE place so it cannot fork.
//
// describe() returns a FROZEN record; every downstream role reads it and no
// role writes it.

/** Canned closing line for a satisfied goal (relocated verbatim). */
export const SATISFIED_GOAL_ANSWER =
  "Brilliant. I’ll mark this project complete and stay nearby for your next idea.";

/** Canned clarification for an unbound "yes" (relocated verbatim). */
export const UNBOUND_CONFIRMATION_ANSWER =
  "Happy to! Tell me exactly which one—say something like “build a small castle”, “explain how a piston works”, or “sculpt a blocky dolphin”—and I’ll start right away.";

const PREVIEW_PATTERN = /\b(beta|preview|experimental)\b/i;

const never = () => null;
const requireFn = (deps, name) => {
  const fn = deps[name];
  if (typeof fn !== "function") throw new TypeError(`createIntent requires a ${name} function`);
  return fn;
};

/**
 * @param {object} deps every validated predicate, injected from src/wizard.mjs.
 */
export function createIntent(deps = {}) {
  const isBuildRequest = requireFn(deps, "isBuildRequest");
  const isProjectFeedback = requireFn(deps, "isProjectFeedback");
  const isRecipeRequest = requireFn(deps, "isRecipeRequest");
  const isGoalSatisfaction = requireFn(deps, "isGoalSatisfaction");
  const isOrdinaryConversation = requireFn(deps, "isOrdinaryConversation");
  const instantConversationAnswer = requireFn(deps, "instantConversationAnswer");
  const groundedQuickAnswer = requireFn(deps, "groundedQuickAnswer");
  const retrievalQuestion = requireFn(deps, "retrievalQuestion");
  const wantsModelAuthoredStructure = requireFn(deps, "wantsModelAuthoredStructure");
  const hasUnmatchedDescriptors = requireFn(deps, "hasUnmatchedDescriptors");
  const historyWithObservedStructure = requireFn(deps, "historyWithObservedStructure");
  const isTFlipFlopQuestion = deps.isTFlipFlopQuestion || (() => false);
  const isCalculatorQuestion = deps.isCalculatorQuestion || (() => false);
  const boundPendingOffer = deps.boundPendingOffer;
  const isActionConfirmation = deps.isActionConfirmation;
  const pendingActionTurn = deps.pendingActionTurn;
  // The non-build actionable detectors. Each is optional and defaults to "no",
  // so an integration that has not wired one yet behaves exactly like today.
  const terrainIntent = deps.terrainIntent || never;
  const adminIntent = deps.adminIntent || never;
  const travelIntent = deps.travelIntent || never;
  const giftIntent = deps.giftIntent || never;
  const effectIntent = deps.effectIntent || never;
  const tFlipFlopQuery = deps.tFlipFlopQuery
    || ((question) => `${question} copper bulb t flip flop comparator toggle`);
  const calculatorQuery = deps.calculatorQuery
    || ((question) => `${question} binary redstone calculator two bit full adder carry lamps`);

  return {
    /**
     * @param {object} input
     * @param {string} input.question    the (possibly offer-resolved) question
     * @param {Array}  input.history     the persisted session history
     * @param {object} [input.context]   the live world snapshot
     * @param {boolean} [input.general]
     * @param {Array}  [input.actionHistory] override for historyWithObservedStructure
     * @param {object} [input.flags]     late-computed turn inputs:
     *   answerOnly, goalReview, confirmationOffer, unboundConfirmation,
     *   action (deterministic ladder result), learnedAction, hits,
     *   groundedAnswer, providerEnabled, aiEnabled
     * @returns {Readonly<object>} the frozen turn intent
     */
    describe({
      question,
      history = [],
      context,
      general = false,
      actionHistory: actionHistoryOverride,
      flags = {},
    }) {
      const {
        answerOnly,
        goalReview,
        action = null,
        learnedAction = null,
        hits = [],
        providerEnabled = false,
        aiEnabled = false,
      } = flags;
      const answerOnlyRequest = !general && Boolean(answerOnly);
      const reviewRequest = !general && Boolean(goalReview?.goalId);
      const recipeRequest = !general && !reviewRequest && !answerOnlyRequest && isRecipeRequest(question);
      const actionHistory = actionHistoryOverride
        || (general ? history : historyWithObservedStructure(history, context));
      const confirmationOffer = Object.hasOwn(flags, "confirmationOffer")
        ? flags.confirmationOffer
        : general || typeof boundPendingOffer !== "function"
          ? undefined : boundPendingOffer(question, history);
      const unboundConfirmation = Object.hasOwn(flags, "unboundConfirmation")
        ? Boolean(flags.unboundConfirmation)
        : !general && !confirmationOffer
          && typeof isActionConfirmation === "function" && typeof pendingActionTurn === "function"
          && isActionConfirmation(question) && Boolean(pendingActionTurn(history));
      const satisfied = !general && !reviewRequest && !answerOnlyRequest
        && isGoalSatisfaction(question, actionHistory);
      const instantAnswer = general || reviewRequest ? undefined : satisfied
        ? SATISFIED_GOAL_ANSWER
        : answerOnlyRequest ? undefined
          : unboundConfirmation
            ? UNBOUND_CONFIRMATION_ANSWER
            : instantConversationAnswer(question);
      const projectFeedback = !general && !answerOnlyRequest
        && (reviewRequest || isProjectFeedback(question, actionHistory));
      const buildRequest = !general && !reviewRequest && !answerOnlyRequest
        && isBuildRequest(question, actionHistory);
      const includePreview = PREVIEW_PATTERN.test(question);
      const conversational = !general && !reviewRequest && !answerOnlyRequest
        && isOrdinaryConversation(question);
      const contextualQuestion = answerOnly?.originalQuestion
        || retrievalQuestion(question, actionHistory);
      const retrievalQuery = general || conversational ? "" : isTFlipFlopQuestion(question)
        ? tFlipFlopQuery(question)
        : isCalculatorQuestion(question)
          ? calculatorQuery(question)
          : contextualQuestion;
      const groundedAnswer = Object.hasOwn(flags, "groundedAnswer")
        ? flags.groundedAnswer
        : reviewRequest || answerOnlyRequest ? undefined : groundedQuickAnswer(question, hits);
      const researchRequired = !general && buildRequest && !learnedAction
        && (!action || wantsModelAuthoredStructure(action, buildRequest, question));
      const actionable = buildRequest || projectFeedback;
      // COST GATE — copied character for character from ask(). Any edit here is
      // an edit to how many provider calls a child's turn costs.
      const consultModel = providerEnabled && aiEnabled && !learnedAction
        && !((instantAnswer || groundedAnswer) && (!actionable || satisfied))
        && (answerOnlyRequest || reviewRequest || !action
          || wantsModelAuthoredStructure(action, buildRequest, question)
          || (buildRequest && hasUnmatchedDescriptors(question, action)));

      // The non-build actionable detectors never run on turns whose ladder must
      // stay empty (general, review, answer-only, recipe, plain conversation,
      // or a goal the child just declared satisfied).
      const detectorsAllowed = !general && !reviewRequest && !answerOnlyRequest
        && !recipeRequest && !conversational && !satisfied;
      const terrain = detectorsAllowed ? terrainIntent(question, actionHistory) || null : null;
      const admin = detectorsAllowed ? adminIntent(question, actionHistory) || null : null;
      const travel = detectorsAllowed ? travelIntent(question, actionHistory) || null : null;
      const gift = detectorsAllowed ? giftIntent(question, actionHistory) || null : null;
      const effect = detectorsAllowed ? effectIntent(question, actionHistory) || null : null;
      // THE GENERALIZATION OF buildRequest. Review and answer-only turns are
      // excluded on purpose: projectFeedback is true for every review turn, and
      // a review that neither completes nor corrects must fail closed rather
      // than fall down the ladder into an unrequested build.
      const actionableIntent = !general && !reviewRequest && !answerOnlyRequest
        && Boolean(buildRequest || projectFeedback || terrain || admin || travel || gift || effect);

      const intentClass = general ? "general"
        : reviewRequest ? "review"
          : answerOnlyRequest ? "answer-only"
            : satisfied ? "satisfied"
              : projectFeedback ? "project-feedback"
                : buildRequest ? "build"
                  : terrain ? "terrain"
                    : admin ? "admin"
                      : travel ? "travel"
                        : gift ? "gift"
                          : effect ? "effect"
                            : recipeRequest ? "recipe"
                              : conversational ? "conversation"
                                : "question";

      return Object.freeze({
        question,
        general,
        history,
        actionHistory,
        context,
        answerOnlyRequest,
        reviewRequest,
        recipeRequest,
        confirmationOffer,
        unboundConfirmation,
        satisfied,
        instantAnswer,
        groundedAnswer,
        projectFeedback,
        buildRequest,
        includePreview,
        conversational,
        contextualQuestion,
        retrievalQuery,
        hits,
        action,
        learnedAction,
        researchRequired,
        actionable,
        terrainIntent: terrain,
        adminIntent: admin,
        travelIntent: travel,
        giftIntent: gift,
        effectIntent: effect,
        actionableIntent,
        consultModel,
        intentClass,
      });
    },
  };
}
