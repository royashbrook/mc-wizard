const DANGEROUS_COMMAND = /\/(?:kill|clear|fill|setblock|clone|summon|tickingarea|gamerule|difficulty)\b/i;
const BROAD_SELECTOR = /@[ae](?:\b|\[)/i;
const REPEATING = /\brepeating command block\b/i;
const SLASH_COMMAND = /(?:^|[^a-z0-9_/])\/(?!\/)[a-z][a-z0-9_-]*\b/i;
const NAMED_COMMAND_REQUEST = /(?:^|[^a-z0-9_/])\/(?!\/)[a-z][a-z0-9_-]*\b/i;
const DIRECT_COMMAND_REQUEST = /\b(?:show|teach|explain|write|provide|give me|tell me|learn|what is|which|how (?:do|can|should) i (?:use|run|type|enter|paste))\b.{0,60}\b(?:minecraft |bedrock |slash )?commands?\b/i;
const COMMAND_BLOCK_LESSON = /\b(?:show|teach|build|make|create|demo(?:nstrate)?|lesson|example|how (?:do|can|does)|what (?:is|are|does))\b.{0,60}\bcommand[- ]blocks?\b|\bcommand[- ]blocks?\b.{0,60}\b(?:lesson|demo|example|teach|show|build|make|create|how (?:it|they) work)\b/i;

export function explicitlyRequestsCommand(question) {
  const text = String(question || "");
  return NAMED_COMMAND_REQUEST.test(text)
    || DIRECT_COMMAND_REQUEST.test(text)
    || COMMAND_BLOCK_LESSON.test(text);
}

export function unsafeCommandAnswer(answer, question = "") {
  const text = String(answer || "");
  if (REPEATING.test(text)) return true;
  if (!SLASH_COMMAND.test(text)) return false;
  if (!explicitlyRequestsCommand(question)) return true;
  return DANGEROUS_COMMAND.test(text) || BROAD_SELECTOR.test(text);
}

export function safeCommandRefusal(hasTypedAction = false) {
  return hasTypedAction
    ? "I’m keeping that slash spell off the chat scroll. My safe in-world action is ready, so I’ll do the job with my wand instead. If you want to learn the command itself, ask me for a command-block lesson."
    : "That slash spell is staying in my spellbook. Tell me the result you want and I’ll handle it safely in the world—or ask me to teach the exact command in a command-block lesson.";
}
