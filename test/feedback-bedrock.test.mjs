import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pack = await readFile(new URL(
  "../bedrock/behavior_packs/mc_wizard/scripts/main.js",
  import.meta.url,
), "utf8");
const manifest = JSON.parse(await readFile(new URL(
  "../bedrock/behavior_packs/mc_wizard/manifest.json",
  import.meta.url,
), "utf8"));
const permissions = JSON.parse(await readFile(new URL(
  "../bedrock/config/4e8790fe-18dc-46d1-aa31-ec78a924b717/permissions.json",
  import.meta.url,
), "utf8"));
const installer = await readFile(new URL("../scripts/install-pack.mjs", import.meta.url), "utf8");

function section(start, end) {
  const from = pack.indexOf(start);
  const to = pack.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source section ${start}`);
  return pack.slice(from, to);
}

test("the behavior pack declares and uses the native Bedrock feedback form", () => {
  assert.ok(manifest.dependencies.some(({ module_name: name, version }) => (
    name === "@minecraft/server-ui" && version === "2.1.0"
  )));
  assert.ok(permissions.allowed_modules.includes("@minecraft/server-ui"));
  assert.match(installer, /allowed_modules:[\s\S]+"@minecraft\/server-ui"/);
  assert.match(pack, /import \{ FormCancelationReason, ModalFormData \} from "@minecraft\/server-ui"/);
  assert.match(pack, /\.dropdown\("How did Wiz do\?", \[/);
  assert.match(pack, /\], \{ defaultValueIndex: 2 \}\)/);
  assert.match(pack, /\.textField\("What should Wiz change or do next\?", "Optional", \{ defaultValue: "" \}\)/);
  assert.match(pack, /\.submitButton\("Send to Wiz"\)/);
  assert.match(pack, /const FEEDBACK_FORMS_ENABLED = false/);
  const offer = section("function offerFeedbackPrompt", "function completeFeedbackPrompt");
  assert.match(offer, /if \(FEEDBACK_FORMS_ENABLED\) void showFeedbackForm\(prompt\)/);
  assert.match(offer, /else feedbackChatFallback\(prompt\)/);
});

test("chat fallback accepts only an explicit grade command", () => {
  const source = section("function parseGradeMessage", "function feedbackChatFallback");
  const parseGradeMessage = Function(`${source}; return parseGradeMessage;`)();
  assert.deepEqual(parseGradeMessage("grade 1"), { grade: 1, feedback: "" });
  assert.deepEqual(parseGradeMessage("GRADE 5: add a taller tower"), {
    grade: 5,
    feedback: "add a taller tower",
  });
  assert.deepEqual(parseGradeMessage("grade 4 add a roof"), {
    grade: 4,
    feedback: "add a roof",
  });
  assert.equal(parseGradeMessage(`grade 2: ${"x".repeat(600)}`).feedback.length, 500);
  for (const value of ["5", "grade five", "grade 0", "grade 6", "please grade 4"]) {
    assert.equal(parseGradeMessage(value), undefined, value);
  }
});

test("feedback is correlated, bounded, private in logs, and sent with fresh world context", () => {
  const submit = section("async function submitFeedback", "async function showFeedbackForm");
  assert.match(submit, /"\/v1\/feedback"/);
  assert.match(submit, /player: prompt\.playerName/);
  assert.match(submit, /requestId: prompt\.requestId/);
  assert.match(submit, /grade,\n\s+feedback,/);
  assert.match(submit, /context: liveWorldSnapshot\(player\)/);
  assert.match(submit, /request\.addHeader\("Authorization", AUTHORIZATION\)/);
  assert.match(submit, /const followUp = result\.followUp && typeof result\.followUp === "object"/);
  assert.match(submit, /\? result\.followUp : result\.refinement/);
  assert.match(submit, /applyResponse\(current\.id, followUp, feedback\)/);
  assert.doesNotMatch(submit, /console\.(?:log|warn|error)/);

  const queue = section("function queueFeedback", "function routeFeedbackMessage");
  assert.match(queue, /pendingQuestions\.has\(`\$\{report\.playerId\}:wizard`\)/);
  assert.match(queue, /hasNewerAction\(report\.playerId, report\.requestId\)/);
  assert.match(queue, /promptedFeedbackRequests\.has\(report\.requestId\)/);
  assert.match(queue, /promptedFeedbackRequests\.size > 256/);
  assert.match(queue, /pendingFeedback\.set\(report\.playerId, prompt\)/);
  assert.match(queue, /queue\.length < 16/);
  assert.match(queue, /queuedFeedback\.set\(report\.playerId, queue\)/);
  assert.match(queue, /function completeFeedbackPrompt/);
});

test("busy forms retry three times and every cancellation retains explicit chat fallback", () => {
  const form = section("async function showFeedbackForm", "function queueFeedback");
  assert.match(form, /FormCancelationReason\.UserBusy && busyRetries < 3/);
  assert.match(form, /showFeedbackForm\(prompt, busyRetries \+ 1\)/);
  assert.match(form, /else \{\n\s+feedbackChatFallback\(prompt\)/);
  assert.match(form, /catch \{\n\s+feedbackChatFallback\(prompt\)/);
  assert.match(pack, /grade 2: add more windows/);
});

test("action feedback waits through automatic continuation and prompts when the pass waits for the child", () => {
  const lifecycle = section("async function postActionResult", "function registerActionRequest");
  const replan = lifecycle.slice(
    lifecycle.indexOf("if (executableReplan)"),
    lifecycle.indexOf("const retry = actionResultRetry"),
  );
  const retry = lifecycle.slice(
    lifecycle.indexOf("if (retry)"),
    lifecycle.indexOf("if (result.reviewDeferred"),
  );
  const active = lifecycle.slice(
    lifecycle.indexOf("if (result.reviewDeferred"),
    lifecycle.indexOf('if (status === "failed")'),
  );
  assert.doesNotMatch(replan, /queueFeedback/);
  assert.doesNotMatch(retry, /queueFeedback/);
  assert.match(active, /queueFeedback\(report\)/);
  assert.match(lifecycle, /if \(result\.reviewDeferred \|\| result\.review\?\.goal\?\.status === "active"\)/);
  assert.match(lifecycle, /if \(retry\) \{\n\s+scheduleActionResultRetry\(report, retry\);\n\s+return;/);
  assert.match(lifecycle, /queueFeedback\(report\);\n\s+return;\n\s+\} catch/);
});

test("answer-only Wizard turns prompt once while general AI and local movement do not", () => {
  const response = section("function applyResponse", "async function askBackend");
  assert.match(response, /if \(payload\.kind === "general"\) \{\n\s+deliverModelAnswer[\s\S]+?return;/);
  assert.match(response, /if \(!action\) \{\n\s+queueFeedback\(\{/);

  const backend = section("async function askBackend", "function cancelPendingQuestion");
  const unavailable = backend.slice(backend.indexOf("} catch (error)"));
  assert.doesNotMatch(unavailable, /queueFeedback/);

  const local = section("function handleLocalCommand", "function routeAddressedMessage");
  assert.doesNotMatch(local, /queueFeedback/);
  assert.match(pack, /pendingFeedback\.delete\(event\.playerId\)/);
});

test("grade chat works at any distance without entering chat logs or stealing unrelated chat", () => {
  const feedbackRoute = section("function routeFeedbackMessage", "function worldSmallTalk");
  assert.match(feedbackRoute, /\^!\?\(\?:mc\\s\+\)\?wiz/);
  assert.match(feedbackRoute, /if \(!prompt\) return false/);
  assert.match(feedbackRoute, /system\.run\(\(\) => void submitFeedback/);
  assert.doesNotMatch(feedbackRoute, /logChat/);

  const chatEvent = section("world.beforeEvents.chatSend.subscribe", "world.afterEvents.playerSpawn.subscribe");
  assert.ok(chatEvent.indexOf("routeFeedbackMessage(event.sender, event.message)")
    < chatEvent.indexOf("routeAIMessage(event.sender, event.message)"));
  assert.match(pack, /startE2E\(\{[\s\S]+routeFeedbackMessage,/);
});

test("blank low grades ask for detail and blank high grades end with thanks", () => {
  const submit = section("async function submitFeedback", "async function showFeedbackForm");
  assert.match(submit, /Thanks—I’m saving your grade/);
  assert.match(submit, /result\.needsFeedback && !feedback/);
  assert.match(submit, /prompt\.submitting = false/);
  assert.match(submit, /Reply with ‘grade \$\{grade\}:’/);
  assert.ok(submit.indexOf("result.needsFeedback") < submit.indexOf("completeFeedbackPrompt(prompt)"));
});

test("feedback prompts queue and only matched terminal actions become gradable", () => {
  assert.match(pack, /const queuedFeedback = new Map\(\)/);
  const lifecycle = section("async function postActionResult", "function registerActionRequest");
  assert.match(lifecycle, /if \(result\.updated === false\) \{\n\s+if \(result\.matched\) queueFeedback\(report\)/);
  const exhausted = lifecycle.slice(lifecycle.indexOf("if (attempt === 2)"));
  assert.doesNotMatch(exhausted, /queueFeedback\(report\)/);
  assert.match(pack, /queuedFeedback\.delete\(event\.playerId\)/);
  assert.match(pack, /queuedFeedback\.clear\(\)/);
});
