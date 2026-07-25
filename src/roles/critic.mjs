// WP-C — the tiered Critic role.
//
// One job: look at a candidate turn outcome ({action, answer, goal}) plus the
// frozen TurnIntent and say, in four fixed tiers, whether it may ship. It is a
// pure function of its inputs: zero I/O, zero closure over ask() state, zero
// provider consultation, and EVERY validated predicate is injected. That is why
// this module never imports src/wizard.mjs — no import cycle exists, and the
// safety gates stay defined exactly where they are today.
//
// The tiers run in a fixed order and short-circuit on the first non-"none"
// severity, so a candidate that fails both C0 and C3 always reports C0:
//
//   C0 SAFETY       severity "fatal"     never repaired toward, never hinted
//   C1 EXISTENCE    severity "contract"  the never-empty gate that does not exist today
//   C2 FIDELITY     severity "contract"  providerActionMatchesRequest, WHOLE
//   C3 COMPLETENESS "warning" | "contract" — the build contract's tri-state
//
// THREE INVARIANTS THIS FILE EXISTS TO PROTECT:
//
//  1. C1 is keyed on intent.actionableIntent FIRST and on the promise/refusal
//     prose regexes only as defence in depth. The never-empty property is
//     therefore a property of how the CHILD'S REQUEST was classified, not of
//     whether some future refusal phrasing happens to match a regex.
//
//  2. C2 calls providerActionMatchesRequest WHOLE AND UNCHANGED. It is NOT
//     physically split into a "safety half" and a "phrasing half". The Critic
//     only records WHICH sub-gate a rejection came from, as a telemetry label
//     derived from action.type — no gate is re-run to produce it. Splitting the
//     real gate across call sites risks a candidate being safety-checked twice
//     and fidelity-checked zero times.
//
//  3. A C0 verdict NEVER carries a repair hint. Coaching a model past a safety
//     gate is the one thing a repair loop must be structurally unable to do.
//
// There is deliberately NO model critic tier: it would cost a provider call per
// turn and would make the never-empty property unprovable offline.

export const CRITIC_SEVERITIES = Object.freeze(["fatal", "contract", "warning", "none"]);
export const CRITIC_TIERS = Object.freeze(["C0", "C1", "C2", "C3"]);

// Verbatim, byte-for-byte, from wizard.mjs:4998. The pack, the telemetry gate
// names and the operator-facing rejection all key on this exact sentence.
export const RESEARCH_RESTRICTION_REASON =
  "web-researched build plans cannot contain server administration or arbitrary commands";
// Verbatim from wizard.mjs:4999.
export const INTENT_MISMATCH_REASON = "action does not match the player's explicit request";
export const REVIEW_VERDICT_REASON =
  "goal review returned neither verified completion nor a related corrective action";
export const ACTION_ALLOWLIST_REASON = "action is not registered or its arguments are invalid";
export const UNUSABLE_ANSWER_REASON = "answer is a capability disclaimer or otherwise unusable prose";

const REQUIRED_DEPENDENCIES = Object.freeze([
  "allowedWizardAction",
  "safeNovelAction",
  "providerActionMatchesRequest",
  "actionCompletesBuildRequest",
  "actionAdvancesBuildRequest",
  "correctiveActionContinuesGoal",
  "unusableWizardAnswer",
  "answerPromisesAction",
  "answerRefusesAction",
  "plannerRepairDetail",
]);

// Telemetry label ONLY. Derived from action.type alone; it calls nothing and
// changes no decision. providerActionMatchesRequest stays one indivisible gate.
const FIDELITY_SUB_GATES = new Map([
  ["execute_program", "provider-power-match"],
  ["build_structure", "build-contract"],
  ["build_machine", "build-contract"],
  ["build_plan", "build-contract"],
  ["place_blueprint", "build-contract"],
  ["run_commands", "command-intent-match"],
  ["give_items", "gift-match"],
  ["show_recipe", "recipe-match"],
  ["command_lesson", "command-lesson-match"],
]);

const fidelitySubGate = (action) => FIDELITY_SUB_GATES.get(action?.type) || "deterministic-equality";

function verdict({ severity, tier = null, gate = null, reason = "", subGate, warning, repairDetail, advances }) {
  return Object.freeze({
    // `ok` means SHIPPABLE AS-IS (possibly with a caveat), not "flawless".
    // "warning" is shippable on purpose: accept-with-warning keeps a
    // rough-but-real authored plan instead of burning a repair round and
    // falling back to a corner guide. `severity` is the authoritative value —
    // never re-derive a decision from `ok` alone.
    ok: severity === "none" || severity === "warning",
    severity,
    tier,
    gate,
    reason,
    ...(subGate === undefined ? {} : { subGate }),
    ...(warning === undefined ? {} : { warning }),
    ...(repairDetail === undefined ? {} : { repairDetail }),
    ...(advances === undefined ? {} : { advances }),
  });
}

const PASS = verdict({ severity: "none" });

function readCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return { action: null, answer: "", hasAnswer: false, goal: undefined };
  }
  // A bare action object is accepted as a convenience; it simply carries no
  // prose, so the prose tier is skipped rather than judging "" as unusable.
  if (typeof candidate.type === "string" && candidate.action === undefined && candidate.answer === undefined) {
    return { action: candidate, answer: "", hasAnswer: false, goal: undefined };
  }
  return {
    action: candidate.action || null,
    answer: typeof candidate.answer === "string" ? candidate.answer : "",
    hasAnswer: typeof candidate.answer === "string",
    goal: candidate.goal,
  };
}

function readIntent(intent) {
  const source = intent && typeof intent === "object" ? intent : {};
  const history = Array.isArray(source.actionHistory) ? source.actionHistory
    : Array.isArray(source.history) ? source.history : [];
  return {
    question: typeof source.question === "string" ? source.question : "",
    history,
    buildRequest: Boolean(source.buildRequest),
    projectFeedback: Boolean(source.projectFeedback),
    reviewRequest: Boolean(source.reviewRequest),
    answerOnlyRequest: Boolean(source.answerOnlyRequest),
    researchRequired: Boolean(source.researchRequired),
    actionableIntent: Boolean(source.actionableIntent),
    // Supplied by the caller (wizard.mjs:5090-5092 computes it from the latest
    // action turn). Defaulting to false keeps a plain "goal complete, no
    // action" review acceptable, exactly as it is today.
    reviewingStagedProgress: Boolean(source.reviewingStagedProgress),
  };
}

export function createCritic(dependencies = {}) {
  const missing = REQUIRED_DEPENDENCIES.filter((name) => typeof dependencies[name] !== "function");
  if (missing.length) {
    throw new TypeError(`createCritic requires injected functions: ${missing.join(", ")}`);
  }
  const {
    allowedWizardAction,
    safeNovelAction,
    providerActionMatchesRequest,
    actionCompletesBuildRequest,
    actionAdvancesBuildRequest,
    correctiveActionContinuesGoal,
    unusableWizardAnswer,
    answerPromisesAction,
    answerRefusesAction,
    plannerRepairDetail,
  } = dependencies;

  // ---- C0 SAFETY ---------------------------------------------------------
  // Fatal, unrepairable, and never accompanied by a repair hint. The
  // orchestrator's adjudication rule is "C0 wins unconditionally": the action
  // is dropped and the turn escalates to a locally-authored rung instead.
  function safetyTier(candidate, intent) {
    const { action, answer, hasAnswer } = candidate;
    if (action) {
      let allowed = null;
      try {
        allowed = allowedWizardAction(action);
      } catch {
        allowed = null;
      }
      if (!allowed) {
        return verdict({
          severity: "fatal", tier: "C0", gate: "action-allowlist",
          reason: ACTION_ALLOWLIST_REASON, subGate: "allowed-wizard-action",
        });
      }
      if (intent.researchRequired && !safeNovelAction(action)) {
        return verdict({
          severity: "fatal", tier: "C0", gate: "research-restriction",
          reason: RESEARCH_RESTRICTION_REASON, subGate: "safe-novel-action",
        });
      }
    }
    if (hasAnswer && unusableWizardAnswer(answer, intent.question)) {
      return verdict({
        severity: "fatal", tier: "C0", gate: "unusable-answer",
        reason: UNUSABLE_ANSWER_REASON, subGate: "unusable-wizard-answer",
      });
    }
    return null;
  }

  // ---- C1 EXISTENCE ------------------------------------------------------
  // The gate that does not exist in the shipped turn loop. Its FIRST disjunct
  // is intent.actionableIntent, so it fires on a live terrain turn whose answer
  // is neutral prose that trips neither the promise nor the refusal regex.
  function existenceTier(candidate, intent) {
    const { action, answer, hasAnswer, goal } = candidate;
    if (intent.reviewRequest) {
      // wizard.mjs:5089-5098, expressed with injected dependencies only.
      const complete = goal?.status === "complete" && !action && !intent.reviewingStagedProgress;
      const corrective = goal?.status === "active" && correctiveActionContinuesGoal(action, intent.history);
      if (!complete && !corrective) {
        return verdict({
          severity: "contract", tier: "C1", gate: "review-verdict",
          reason: REVIEW_VERDICT_REASON, subGate: "review-verdict",
          repairDetail: plannerRepairDetail(intent.question, action, intent.history, REVIEW_VERDICT_REASON),
        });
      }
      return null;
    }
    // An answer-only refinement is an honest knowledge gap by construction:
    // it is never allowed to grow an action (wizard.mjs:4974-4981), so the
    // existence gate must stay silent for it.
    if (intent.answerOnlyRequest || action) return null;
    // Note the short-circuit: when the request itself was classified as
    // actionable, NEITHER prose regex is consulted. The never-empty property
    // therefore cannot be undone by a refusal phrasing that escapes them.
    const promises = !intent.actionableIntent && hasAnswer && answerPromisesAction(answer);
    const refuses = !intent.actionableIntent && !promises && hasAnswer && answerRefusesAction(answer);
    if (!intent.actionableIntent && !promises && !refuses) return null;
    const subGate = intent.actionableIntent ? "actionable-intent"
      : promises ? "answer-promise" : "answer-refusal";
    const reason = intent.actionableIntent
      ? "an actionable request produced no executable action"
      : promises
        ? "the answer promised an in-world action without an executable action"
        : "the answer refused an achievable request without an executable action";
    return verdict({
      severity: "contract", tier: "C1", gate: "action-existence", reason, subGate,
      repairDetail: plannerRepairDetail(intent.question, null, intent.history, reason),
    });
  }

  // ---- C2 FIDELITY -------------------------------------------------------
  // providerActionMatchesRequest, called once, whole, unchanged.
  function fidelityTier(candidate, intent) {
    const { action } = candidate;
    if (!action) return null;
    const matches = providerActionMatchesRequest(action, intent.question, intent.history, {
      buildRequest: intent.buildRequest,
      projectFeedback: intent.projectFeedback,
      reviewRequest: intent.reviewRequest,
    });
    if (matches) return null;
    return verdict({
      severity: "contract", tier: "C2", gate: "intent-match",
      reason: INTENT_MISMATCH_REASON, subGate: fidelitySubGate(action),
      repairDetail: plannerRepairDetail(intent.question, action, intent.history, INTENT_MISMATCH_REASON),
    });
  }

  // ---- C3 COMPLETENESS ---------------------------------------------------
  // TRI-STATE IS LOAD-BEARING. true -> "none"; {complete:false, warning} ->
  // "warning" with the warning string carried verbatim so the caller can set
  // contractCaveat and downgrade a "complete" goal to "active"; false ->
  // "contract". Any boundary that coerces this to a boolean turns every
  // rough-but-acceptable authored plan into a repair round plus a corner guide.
  function completenessTier(candidate, intent) {
    const { action } = candidate;
    if (!action || intent.reviewRequest) return null;
    if (!intent.buildRequest && !intent.projectFeedback) return null;
    const contract = actionCompletesBuildRequest(action, intent.question, intent.history);
    if (contract === true) return null;
    if (contract && typeof contract === "object" && contract.warning) {
      // advances is true by construction here: actionAdvancesBuildRequest is
      // `actionCompletesBuildRequest(...) || ...`, and this branch already
      // holds a truthy contract object. No second call, no repair hint — a
      // warning ships, it does not get repaired.
      return verdict({
        severity: "warning", tier: "C3", gate: "build-contract",
        reason: "the action was accepted with a contract caveat",
        subGate: "accept-with-warning", warning: contract.warning, advances: true,
      });
    }
    // `advances` is reported, never decided on here: an action that merely
    // advances (staged progress on a build turn) is what the escalation rungs
    // are allowed to ship today (wizard.mjs:5140), while a provider action that
    // only advances still earns a repair round.
    const advances = Boolean(actionAdvancesBuildRequest(action, intent.question, intent.history));
    return verdict({
      severity: "contract", tier: "C3", gate: "build-contract",
      reason: "the action does not complete the requested build",
      subGate: "build-contract", advances,
      repairDetail: plannerRepairDetail(intent.question, action, intent.history, undefined),
    });
  }

  const TIERS = [safetyTier, existenceTier, fidelityTier, completenessTier];

  function critique(candidateValue, intentValue) {
    const candidate = readCandidate(candidateValue);
    const intent = readIntent(intentValue);
    for (const tier of TIERS) {
      const result = tier(candidate, intent);
      if (result) return result;
    }
    return PASS;
  }

  return { critique };
}

export default createCritic;
