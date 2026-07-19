import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyEdition, normalizeChannel } from "./edition.mjs";
import { buildKnowledgeGraph, createKnowledgeGraph, validateKnowledgeGraph } from "./knowledge-graph.mjs";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "but", "by", "can",
  "could", "do", "does", "for", "from", "how", "i", "if", "in", "is", "it",
  "me", "my", "of", "on", "one", "ones", "or", "please", "something", "tell",
  "that", "the", "thing", "this", "to", "was", "what", "when", "with", "work",
  "would", "you", "your",
]);

const BASE_ROOTS = [
  ["knowledge", "mechanic-card"],
  [".cache/minecraft-creator/creator/Documents", "official-doc"],
  [".cache/minecraft-creator/creator/Commands", "official-doc"],
  [".cache/minecraft-creator/creator/Reference", "official-doc"],
  [".cache/minecraft-creator/creator/ScriptAPI", "official-doc"],
  [".cache/patch-notes", "patch-note"],
].map(([relative, kind]) => ({ dir: path.join(PROJECT_ROOT, relative), kind, id: relative }));

async function defaultRoots() {
  try {
    const active = JSON.parse(await readFile(path.join(PROJECT_ROOT, ".cache", "active-release.json"), "utf8"));
    if (!/^[a-zA-Z0-9._/-]+$/.test(active.release) || active.release.includes("..")) throw new Error("invalid active release path");
    const release = path.join(PROJECT_ROOT, ".cache", active.release);
    return [
      { dir: path.join(PROJECT_ROOT, "knowledge"), kind: "mechanic-card", id: "knowledge" },
      ...["Documents", "Commands", "Reference", "ScriptAPI"].map((folder) => ({
        dir: path.join(release, "minecraft-creator", "creator", folder),
        kind: "official-doc",
        id: `minecraft-creator/creator/${folder}`,
      })),
      { dir: path.join(release, "patch-notes"), kind: "patch-note", id: "patch-notes" },
    ];
  } catch (error) {
    if (error.code !== "ENOENT" && !/invalid active release/.test(error.message)) throw error;
    return BASE_ROOTS;
  }
}

async function activeGraphFile() {
  try {
    const active = JSON.parse(await readFile(path.join(PROJECT_ROOT, ".cache", "active-release.json"), "utf8"));
    if (!/^[a-zA-Z0-9._/-]+$/.test(active.release) || active.release.includes("..")) return undefined;
    return path.join(PROJECT_ROOT, ".cache", active.release, "knowledge-graph.json");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function activeCreatorRef() {
  try {
    const active = JSON.parse(await readFile(path.join(PROJECT_ROOT, ".cache", "active-release.json"), "utf8"));
    if (!/^[a-zA-Z0-9._/-]+$/.test(active.release) || active.release.includes("..")) return undefined;
    const manifest = JSON.parse(await readFile(path.join(PROJECT_ROOT, ".cache", active.release, "manifest.json"), "utf8"));
    return /^[0-9a-f]{40}$/i.test(manifest.creatorCommit) ? manifest.creatorCommit : undefined;
  } catch (error) {
    if (error.code === "ENOENT" || error.name === "SyntaxError") return undefined;
    throw error;
  }
}

function normalizeWord(value) {
  let word = value.replace(/'s$/, "");
  if (word.length > 4 && word.endsWith("ies")) word = `${word.slice(0, -3)}y`;
  else if (word.length > 4 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) word = word.slice(0, -1);
  return word;
}

function tokenize(value) {
  return (value.normalize("NFKD").toLowerCase().match(/[a-z0-9][a-z0-9_']*/g) || [])
    .map(normalizeWord)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) return [{}, markdown];
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) return [{}, markdown];

  const metadata = {};
  for (const line of markdown.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      const key = line.slice(0, separator).trim();
      metadata[key] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return [metadata, markdown.slice(end + 5)];
}

function titleFrom(markdown, file) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(file, path.extname(file));
}

function sourcePolicy(metadata, kind) {
  if (typeof metadata.source_policy === "string" && metadata.source_policy.length <= 120) {
    return metadata.source_policy;
  }
  if (kind === "official-doc") return "creator-docs-cc-by-4.0";
  if (kind === "patch-note") return "private-reference-cache";
  return "authored-local";
}

function sourceFor(file, metadata, creatorRef) {
  if (metadata.source) return metadata.source;
  const marker = `${path.sep}minecraft-creator${path.sep}`;
  const index = file.lastIndexOf(marker);
  if (index !== -1) {
    const relative = file.slice(index + marker.length).split(path.sep).join("/");
    return `https://github.com/MicrosoftDocs/minecraft-creator/blob/${creatorRef}/${relative}`;
  }
  return `local:${path.relative(PROJECT_ROOT, file).split(path.sep).join("/")}`;
}

function splitLongText(text, maxLength = 1800) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    if (current && current.length + paragraph.length + 2 > maxLength) {
      chunks.push(current.trim());
      current = "";
    }
    if (paragraph.length > maxLength) {
      if (current) chunks.push(current.trim());
      current = "";
      for (let offset = 0; offset < paragraph.length; offset += maxLength) {
        chunks.push(paragraph.slice(offset, offset + maxLength).trim());
      }
    } else {
      current += `${current ? "\n\n" : ""}${paragraph}`;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function chunkMarkdown(markdown) {
  return markdown
    .split(/\n(?=#{1,4}\s)/)
    .flatMap((section) => splitLongText(section.trim()))
    .filter((section) => section.length >= 60);
}

async function expandCodeSources(markdown, file, realRoot) {
  const matches = [...markdown.matchAll(/:::code\b[^\n]*\bsource="([^"]+\.json)"[^\n]*:::/g)];
  if (!matches.length) return markdown;
  let output = "";
  let offset = 0;
  for (const match of matches) {
    output += markdown.slice(offset, match.index);
    let replacement = "";
    try {
      const target = await realpath(path.resolve(path.dirname(file), match[1]));
      const relative = path.relative(realRoot, target);
      if (relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        const source = await readFile(target, "utf8");
        if (source.length <= 250_000) replacement = `\n\`\`\`json\n${source}\n\`\`\`\n`;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    output += replacement;
    offset = match.index + match[0].length;
  }
  return output + markdown.slice(offset);
}

async function markdownFiles(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "PriorScriptAPI") continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(target);
    }
  }
  await walk(root);
  return files;
}

// Matches "/"-prefixed command text (e.g. "/give", "`/tp`") so extraction stays prose-only.
const COMMAND_TEXT = /(^|[\s(`"'[])\/[a-z]/i;
const ANSWER_LIMIT = 420;

export function extractiveAnswer(question, hits) {
  const top = Array.isArray(hits) ? hits[0] : undefined;
  if (!top || typeof top.text !== "string" || !top.text) return null;
  const questionWords = new Set(tokenize(question || ""));
  if (!questionWords.size) return null;

  const title = top.title || "spellbook";
  const budget = ANSWER_LIMIT - `Here's what my spellbook says:  (from my ${title} notes)`.length;

  const sentences = [];
  for (const paragraph of top.text.split(/\n+/)) {
    if (/^#{1,6}\s/.test(paragraph.trim())) continue;
    for (const raw of paragraph.split(/(?<=[.!?])\s+/)) {
      const sentence = raw.trim();
      if (sentence) sentences.push(sentence);
    }
  }

  // Short child questions ("what is redstone", "creepers?") reduce to 1-2 content
  // tokens after stopword removal, so a 2-token floor can never fire for them; allow
  // single-token matches there while keeping the floor for longer questions (precision).
  const requiredOverlap = questionWords.size <= 2 ? 1 : 2;
  const sentenceTokens = sentences.map((sentence) => new Set(tokenize(sentence)));
  // Term weight: question words appearing in fewer of the card's sentences are more
  // discriminating, so matches on them rank higher than matches on ubiquitous words.
  const termWeight = new Map([...questionWords].map((word) => {
    const appearances = sentenceTokens.reduce((count, tokens) => count + (tokens.has(word) ? 1 : 0), 0);
    return [word, 1 + 1 / Math.max(1, appearances)];
  }));

  const scored = sentences
    .map((sentence, index) => {
      let overlap = 0;
      let weight = 0;
      for (const word of sentenceTokens[index]) {
        if (!questionWords.has(word)) continue;
        overlap += 1;
        weight += termWeight.get(word);
      }
      return { sentence, index, overlap, score: weight + Math.max(0, 3 - index) * 0.25 };
    })
    .filter(({ sentence, overlap }) => overlap >= requiredOverlap && sentence.length <= budget && !COMMAND_TEXT.test(sentence))
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;

  const picked = [scored[0]];
  if (scored[1] && scored[0].sentence.length + scored[1].sentence.length + 1 <= budget) picked.push(scored[1]);
  picked.sort((a, b) => a.index - b.index);
  return `Here's what my spellbook says: ${picked.map(({ sentence }) => sentence).join(" ")} (from my ${title} notes)`;
}

export async function loadCorpus({ roots, graphArtifact, graphFile, creatorRef: suppliedCreatorRef } = {}) {
  const usingDefaultRoots = !roots;
  roots ||= await defaultRoots();
  const chunks = [];
  let creatorRef = /^[0-9a-f]{40}$/i.test(suppliedCreatorRef || "") ? suppliedCreatorRef : undefined;
  if (!creatorRef && usingDefaultRoots) creatorRef = await activeCreatorRef();
  if (!creatorRef) {
    try {
      const manifest = JSON.parse(await readFile(path.join(PROJECT_ROOT, ".cache", "sync-manifest.json"), "utf8"));
      if (/^[0-9a-f]{40}$/i.test(manifest.creatorCommit)) creatorRef = manifest.creatorCommit;
    } catch (error) {
      if (error.code !== "ENOENT" && error.name !== "SyntaxError") throw error;
    }
  }
  creatorRef ||= "main";
  let syncedFilesLoaded = false;
  for (const root of roots) {
    const files = await markdownFiles(root.dir);
    if (!files.length) continue;
    if (root.kind !== "mechanic-card") syncedFilesLoaded = true;
    const realRoot = await realpath(root.dir);
    for (const file of files) {
      const raw = await readFile(file, "utf8");
      const [metadata, originalMarkdown] = parseFrontmatter(raw);
      const markdown = await expandCodeSources(originalMarkdown, file, realRoot);
      const title = metadata.title || titleFrom(markdown, file);
      for (const [part, text] of chunkMarkdown(markdown).entries()) {
        const words = tokenize(`${title} ${text}`);
        const frequencies = new Map();
        for (const word of words) frequencies.set(word, (frequencies.get(word) || 0) + 1);
        const fileId = root.id
          ? `${root.id}/${path.relative(root.dir, file)}`
          : path.relative(PROJECT_ROOT, file);
        chunks.push({
          id: `${fileId.split(path.sep).join("/")}#${part}`,
          title,
          text,
          source: sourceFor(file, metadata, creatorRef),
          edition: classifyEdition({
            title,
            body: markdown,
            url: metadata.source,
            channel: metadata.channel,
            kind: metadata.kind || root.kind,
            declared: metadata.edition,
          }),
          channel: normalizeChannel(metadata.channel),
          version: metadata.version || "current",
          updated: metadata.updated || null,
          kind: metadata.kind || root.kind,
          sourcePolicy: sourcePolicy(metadata, root.kind),
          quickAnswer: metadata.quick_answer || null,
          quickQuestions: String(metadata.quick_questions || "").split("|").map((value) => value.trim()).filter(Boolean),
          frequencies,
        });
      }
    }
  }

  const baseOnly = !syncedFilesLoaded;
  if (baseOnly) {
    console.warn(
      "[rag] WARNING: corpus contains only the base knowledge/ cards — official docs and patch notes are missing. "
      + "Run scripts/sync-docs.mjs to download the full corpus into .cache/.",
    );
  }

  const documentFrequency = new Map();
  for (const chunk of chunks) {
    for (const word of chunk.frequencies.keys()) {
      documentFrequency.set(word, (documentFrequency.get(word) || 0) + 1);
    }
  }

  let artifact = graphArtifact;
  if (!artifact && (graphFile || usingDefaultRoots)) {
    try {
      const file = graphFile || await activeGraphFile();
      if (file) artifact = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && error.name !== "SyntaxError") throw error;
    }
  }
  artifact = validateKnowledgeGraph(artifact, chunks) || buildKnowledgeGraph(chunks);
  const graph = createKnowledgeGraph(artifact);

  function search(query, { limit = 4, includePreview = false } = {}) {
    const queryWords = [...new Set(tokenize(query))];
    const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const wantsHistory = /\b(changelog|changed|fixed|patch|release|version|update)\b/i.test(query);
    const graphMatches = new Map(graph.search(query, { limit: Math.max(limit * 4, 12), includePreview })
      .map((entry) => [entry.id, entry]));
    return chunks
      .filter((chunk) => chunk.edition === "bedrock")
      .filter((chunk) => chunk.channel === "stable" || (includePreview && chunk.channel === "preview"))
      .map((chunk) => {
        let score = 0;
        let matchedWords = 0;
        for (const word of queryWords) {
          const frequency = chunk.frequencies.get(word);
          if (!frequency) continue;
          matchedWords += 1;
          const idf = Math.log((chunks.length + 1) / ((documentFrequency.get(word) || 0) + 1)) + 1;
          score += idf * (1 + Math.log(frequency));
          if (chunk.title.toLowerCase().includes(word)) score += idf;
        }
        const normalizedText = chunk.text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
        if (normalizedQuery.length > 5 && normalizedText.includes(normalizedQuery)) score += 8;
        if (chunk.kind === "mechanic-card") score *= 1.35;
        if (chunk.kind === "official-doc") score *= 1.15;
        if (chunk.kind === "patch-note") score *= wantsHistory ? 1.2 : 0.75;
        const graphMatch = graphMatches.get(chunk.id);
        const graphScore = graphMatch?.score || 0;
        return { chunk, score: score + graphScore, matchedWords, graphScore, graphEntities: graphMatch?.entities || [] };
      })
      .filter(({ score, matchedWords }) => {
        const requiredMatches = queryWords.length <= 1
          ? 1
          : queryWords.length <= 4
            ? 2
          : Math.min(3, Math.ceil(queryWords.length * 0.3));
        // Graph evidence ranks lexical matches; it never turns an unrelated mention into an answer.
        return score > 0 && matchedWords >= requiredMatches;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ chunk, score, graphScore, graphEntities }) => ({
        id: chunk.id,
        title: chunk.title,
        text: chunk.text,
        source: chunk.source,
        edition: chunk.edition,
        channel: chunk.channel,
        version: chunk.version,
        updated: chunk.updated,
        kind: chunk.kind,
        quickAnswer: chunk.quickAnswer,
        quickQuestions: chunk.quickQuestions,
        score: Number(score.toFixed(3)),
        ...(graphScore && { graphScore: Number(graphScore.toFixed(3)), graphEntities }),
      }));
  }

  return {
    size: chunks.length,
    baseOnly,
    search,
    graph: { revision: graph.revision, ...graph.stats },
    graphArtifact: artifact,
  };
}
