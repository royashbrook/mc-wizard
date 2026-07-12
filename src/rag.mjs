import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
].map(([relative, kind]) => ({ dir: path.join(PROJECT_ROOT, relative), kind }));

async function defaultRoots() {
  try {
    const active = JSON.parse(await readFile(path.join(PROJECT_ROOT, ".cache", "active-release.json"), "utf8"));
    if (!/^[a-zA-Z0-9._/-]+$/.test(active.release) || active.release.includes("..")) throw new Error("invalid active release path");
    const release = path.join(PROJECT_ROOT, ".cache", active.release);
    return [
      { dir: path.join(PROJECT_ROOT, "knowledge"), kind: "mechanic-card" },
      ...["Documents", "Commands", "Reference", "ScriptAPI"].map((folder) => ({
        dir: path.join(release, "minecraft-creator", "creator", folder),
        kind: "official-doc",
      })),
      { dir: path.join(release, "patch-notes"), kind: "patch-note" },
    ];
  } catch (error) {
    if (error.code !== "ENOENT" && !/invalid active release/.test(error.message)) throw error;
    return BASE_ROOTS;
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

export async function loadCorpus({ roots } = {}) {
  roots ||= await defaultRoots();
  const chunks = [];
  let creatorRef = "main";
  try {
    const manifest = JSON.parse(await readFile(path.join(PROJECT_ROOT, ".cache", "sync-manifest.json"), "utf8"));
    if (/^[0-9a-f]{40}$/i.test(manifest.creatorCommit)) creatorRef = manifest.creatorCommit;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const root of roots) {
    const files = await markdownFiles(root.dir);
    if (!files.length) continue;
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
        chunks.push({
          id: `${path.relative(PROJECT_ROOT, file)}#${part}`,
          title,
          text,
          source: sourceFor(file, metadata, creatorRef),
          edition: /\bjava edition\b/i.test(title) ? "java" : (metadata.edition || "bedrock"),
          channel: metadata.channel || "stable",
          version: metadata.version || "current",
          updated: metadata.updated || null,
          kind: metadata.kind || root.kind,
          quickAnswer: metadata.quick_answer || null,
          quickQuestions: String(metadata.quick_questions || "").split("|").map((value) => value.trim()).filter(Boolean),
          frequencies,
        });
      }
    }
  }

  const documentFrequency = new Map();
  for (const chunk of chunks) {
    for (const word of chunk.frequencies.keys()) {
      documentFrequency.set(word, (documentFrequency.get(word) || 0) + 1);
    }
  }

  function search(query, { limit = 4, includePreview = false } = {}) {
    const queryWords = [...new Set(tokenize(query))];
    const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const wantsHistory = /\b(changelog|changed|fixed|patch|release|version|update)\b/i.test(query);
    return chunks
      .filter((chunk) => includePreview || chunk.channel !== "preview")
      .filter((chunk) => chunk.edition !== "java")
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
        return { chunk, score, matchedWords };
      })
      .filter(({ score, matchedWords }) => {
        const requiredMatches = queryWords.length <= 1
          ? 1
          : queryWords.length <= 4
            ? 2
          : Math.min(3, Math.ceil(queryWords.length * 0.3));
        return score > 0 && matchedWords >= requiredMatches;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ chunk, score }) => ({
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
      }));
  }

  return {
    size: chunks.length,
    search,
  };
}
