const CHILD_UNSAFE_PATTERNS = Object.freeze([
  /\b(?:porn(?:ography|ographic)?|sexual(?:ly)?|sex\s+(?:act|toy)|dildo)\b/i,
  /\b(?:penis|vagina|vulva|genitals?)\b/i,
  /\b(?:nude|naked)\s+(?:person|people|body|statue|picture|image)\b/i,
  /\b(?:swastika|nazi\s+(?:flag|symbol|logo))\b/i,
]);

export function isKidAppropriateText(value) {
  const text = String(value || "").normalize("NFKC");
  return !CHILD_UNSAFE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isKidAppropriateAction(action) {
  if (!action || typeof action !== "object") return false;
  let serialized;
  try {
    serialized = JSON.stringify(action);
  } catch {
    return false;
  }
  return serialized.length <= 200_000 && isKidAppropriateText(serialized);
}

export function kidSafeRefusal() {
  return "That one isn’t kid-friendly, so I won’t make it. Give me a different Minecraft challenge and I’ll jump right in.";
}
