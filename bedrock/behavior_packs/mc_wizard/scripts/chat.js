const SENTENCE = /.+?(?:[.!?]+(?:["'’”)\]]+)?(?=\s|$)|$)/g;

export function splitMessage(message, maxLength = 240) {
  const sentences = String(message || "")
    .replace(/\s+/g, " ")
    .trim()
    .match(SENTENCE)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [];
  const lines = [];
  for (const sentence of sentences) {
    const next = lines.length ? `${lines[lines.length - 1]} ${sentence}` : sentence;
    if (lines.length && next.length <= maxLength) lines[lines.length - 1] = next;
    else lines.push(sentence);
  }
  return lines;
}
