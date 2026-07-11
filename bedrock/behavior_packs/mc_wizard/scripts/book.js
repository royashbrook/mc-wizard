export function bookTitle(question) {
  let subject = String(question || "")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:please )?(?:make|write|create|give)(?: me)? (?:a |an )?(?:guide|book)(?: on| about| for)? /i, "")
    .replace(/^how (?:to|do i) /i, "");
  const words = (subject || "AI Answer").split(" ");
  let title = "";
  for (const word of words) {
    const next = title ? `${title} ${word}` : word;
    if (next.length > 16) break;
    title = next;
  }
  return (title || "AI Answer").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function wrapBookLine(text, width = 30) {
  const lines = [];
  let remaining = text.trim();
  while (remaining.length > width) {
    const space = remaining.lastIndexOf(" ", width);
    const cut = space > 0 ? space : width;
    lines.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines;
}

export function bookPages(answer) {
  const cleaned = String(answer || "")
    .replace(/```(?:\w+)?/g, "")
    .replace(/\[([^\]]+)]\([^\)]+\)/g, "$1")
    .replace(/[*_`>#]/g, "")
    .replace(/\r/g, "")
    .trim();
  const lines = [];
  for (const rawLine of cleaned.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    const bullet = /^[-+]\s+/.test(trimmed);
    const content = trimmed.replace(/^[-+]\s+/, "");
    const wrapped = wrapBookLine(content, bullet ? 28 : 30);
    wrapped.forEach((line, index) => lines.push(bullet && index === 0 ? `• ${line}` : line));
  }
  const pages = [];
  for (let index = 0; index < lines.length && pages.length < 50; index += 8) {
    pages.push(lines.slice(index, index + 8).join("\n").trim());
  }
  return pages.filter(Boolean);
}
