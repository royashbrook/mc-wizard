const baseUrl = `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "3000"}`;
const token = process.env.BRIDGE_TOKEN || "dev-only-change-me";
const player = `DialogueEval-${Date.now()}`;
const cooldown = Number(process.env.REQUEST_COOLDOWN_MS) || 1_500;

async function ask(question, mode = "wizard") {
  const response = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ player, question, mode }),
  });
  if (!response.ok) throw new Error(`brain returned ${response.status}: ${await response.text()}`);
  const result = await response.json();
  await new Promise((resolve) => setTimeout(resolve, cooldown + 100));
  return result;
}

const checks = [
  ["greeting", "hi", (result) => /\b(?:hi|hey|hello|wizard)\b/i.test(result.answer)
    && !/check my|notes|source/i.test(result.answer)],
  ["joke", "tell me a short Minecraft joke", (result) => result.answer.length > 15
    && !/documentation|closest verified|source/i.test(result.answer)],
  ["remember", "Remember that my test word is emerald.", (result) => /emerald/i.test(result.answer)],
  ["follow-up", "What was my test word?", (result) => /emerald/i.test(result.answer)],
  ["described build", "Build me a switch whose output changes every time I press a button.", (result) => (
    result.action?.id === "copper_bulb_t_flip_flop"
  )],
  ["unsupported build", "Build me a giant castle right now.", (result) => result.action === null
    && /calculator|flip-flop/i.test(result.answer)],
];

let failed = 0;
for (const [name, question, check] of checks) {
  const result = await ask(question);
  const passed = check(result);
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} — ${result.answer.replace(/\s+/g, " ").slice(0, 160)}`);
  if (!passed) failed += 1;
}
const general = await ask(
  "Write a detailed beginner guide to surviving the first three Minecraft nights. Use complete sentences and finish the guide cleanly.",
  "general",
);
const generalPassed = typeof general.title === "string"
  && general.title.length >= 3
  && general.title.length <= 16
  && typeof general.answer === "string"
  && general.answer.length >= 500
  && /[.!?][\"')\]]?$/.test(general.answer.trim());
console.log(`${generalPassed ? "PASS" : "FAIL"}: structured-book — ${general.title}: ${general.answer.replace(/\s+/g, " ").slice(0, 120)}`);
if (!generalPassed) failed += 1;
for (const mode of ["wizard", "general"]) {
  await fetch(`${baseUrl}/v1/session`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ player, mode }),
  });
}
if (failed) process.exitCode = 1;
