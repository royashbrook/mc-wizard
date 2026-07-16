const EDITIONS = new Set(["bedrock", "java", "unknown"]);

function signals(value) {
  const text = String(value || "").toLowerCase();
  return {
    bedrock: /\bbedrock(?:\s+edition)?\b|\bminecraft\s+preview\b|\bbedrock\s+preview\b/.test(text),
    java: /\bminecraft\s*[:\-]?\s*java\b|\bjava\s+edition\b/.test(text),
  };
}

export function normalizeChannel(value) {
  const channel = String(value || "stable").trim().toLowerCase();
  return channel === "preview" || channel === "stable" ? channel : "unknown";
}

// The title and source URL identify a release note more reliably than prose that may compare editions.
// Conflicting evidence is deliberately excluded from default Bedrock retrieval until a later sync resolves it.
export function classifyEdition({ title = "", body = "", url = "", channel, kind = "official-doc", declared } = {}) {
  const heading = signals(`${title}\n${url}`);
  const prose = signals(body);
  if ((heading.bedrock && heading.java) || (heading.bedrock && prose.java) || (heading.java && prose.bedrock)) return "unknown";
  if (heading.java) return "java";
  if (heading.bedrock) return "bedrock";
  if (prose.bedrock && prose.java) return "unknown";
  if (prose.java) return "java";
  if (prose.bedrock) return "bedrock";
  const normalizedDeclared = String(declared || "").trim().toLowerCase();
  if (EDITIONS.has(normalizedDeclared)) return normalizedDeclared;
  // Microsoft Creator roots are Bedrock-specific. Changelogs without explicit evidence stay out.
  return kind === "patch-note" || normalizeChannel(channel) === "unknown" ? "unknown" : "bedrock";
}
