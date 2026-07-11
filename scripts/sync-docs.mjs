import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CACHE = path.join(ROOT, ".cache");
const CREATOR_REPO = path.join(CACHE, "minecraft-creator");
const CHANGELOGS = [
  ["stable", "360001186971"],
  ["preview", "360001185332"],
];

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit" });
    let output = "";
    if (options.capture) child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(output.trim())
      : reject(new Error(`${command} exited with code ${code}`)));
  });
}

function decodeEntities(value) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

export function htmlToMarkdown(html) {
  const withoutTags = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<h[1-6][^>]*>/gi, "\n## ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|ul|ol|pre)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(withoutTags)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeMetadata(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/"/g, "'");
}

async function fetchArticles(section) {
  let next = `https://feedback.minecraft.net/api/v2/help_center/en-us/sections/${section}/articles.json?per_page=100`;
  const articles = [];
  while (next) {
    const pageUrl = new URL(next);
    const expectedPath = `/api/v2/help_center/en-us/sections/${section}/articles.json`;
    if (pageUrl.protocol !== "https:" || pageUrl.hostname !== "feedback.minecraft.net" || pageUrl.pathname !== expectedPath) {
      throw new Error(`refusing unexpected changelog page URL: ${pageUrl}`);
    }
    const response = await fetch(pageUrl, {
      headers: { "user-agent": "mc-wizard-doc-sync/0.1" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`changelog API returned ${response.status}`);
    const page = await response.json();
    articles.push(...page.articles);
    next = page.next_page;
  }
  return articles;
}

async function syncChangelog(channel, section) {
  const destination = path.join(CACHE, "patch-notes", channel);
  await mkdir(destination, { recursive: true });
  const articles = await fetchArticles(section);
  const current = new Set();
  for (const article of articles) {
    const articleId = String(article.id);
    if (!/^\d+$/.test(articleId)) throw new Error(`invalid changelog article id: ${articleId}`);
    const filename = `${articleId}.md`;
    current.add(filename);
    const body = htmlToMarkdown(article.body || "");
    const version = article.title.match(/\b(?:1\.)?\d+(?:\.\d+){1,2}\b/)?.[0] || "unknown";
    const hash = createHash("sha256").update(body).digest("hex");
    const markdown = `---\n` +
      `title: "${safeMetadata(article.title)}"\n` +
      `source: "${safeMetadata(article.html_url)}"\n` +
      `edition: bedrock\nchannel: ${channel}\nkind: patch-note\n` +
      `version: "${version}"\nupdated: "${article.updated_at}"\n` +
      `article_id: "${articleId}"\ncontent_sha256: "${hash}"\n---\n\n` +
      `# ${article.title}\n\n${body}\n`;
    await writeFile(path.join(destination, filename), markdown);
  }
  for (const filename of await readdir(destination)) {
    if (/^\d+\.md$/.test(filename) && !current.has(filename)) await rm(path.join(destination, filename));
  }
  console.log(`[sync] ${channel}: ${articles.length} release notes`);
  return articles.length;
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  if (await exists(path.join(CREATOR_REPO, ".git"))) {
    await run("git", ["-C", CREATOR_REPO, "pull", "--ff-only"]);
  } else {
    await run("git", ["clone", "--depth", "1", "--filter=blob:none", "https://github.com/MicrosoftDocs/minecraft-creator.git", CREATOR_REPO]);
  }
  const creatorCommit = await run("git", ["-C", CREATOR_REPO, "rev-parse", "HEAD"], { capture: true });
  const counts = {};
  for (const [channel, section] of CHANGELOGS) counts[channel] = await syncChangelog(channel, section);
  await writeFile(path.join(CACHE, "sync-manifest.json"), JSON.stringify({
    syncedAt: new Date().toISOString(),
    creatorCommit,
    releaseNotes: counts,
  }, null, 2));
  console.log(`[sync] minecraft-creator: ${creatorCommit}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
