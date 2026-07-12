const DANGEROUS_COMMAND = /\/(?:kill|clear|fill|setblock|clone|summon|tickingarea|gamerule|difficulty)\b/i;
const BROAD_SELECTOR = /@[ae](?:\b|\[)/i;
const REPEATING = /\brepeating command block\b/i;

export function unsafeCommandAnswer(answer) {
  const commands = String(answer || "").split(/\r?\n/).filter((line) => /(^|\s)\/[a-z]/i.test(line));
  return commands.some((line) => DANGEROUS_COMMAND.test(line) || BROAD_SELECTOR.test(line))
    || REPEATING.test(answer);
}

export function safeCommandRefusal() {
  return "That would produce a ready-to-run command that can affect many blocks, players, or repeating game ticks. I won’t hand that to a child in a shared world. In a disposable test world with an adult, use a tightly bounded selector such as @p[r=5] and fixed, small coordinates. I can build the safe hello or give-yourself-torches command-block lesson instead.";
}
