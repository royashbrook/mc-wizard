import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CACHE = path.join(ROOT, ".cache");
const CREATOR_REPO = path.join(CACHE, "sources", "minecraft-creator");
const RELEASES = path.join(CACHE, "releases");
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

async function syncChangelog(channel, section, releaseRoot) {
  const destination = path.join(releaseRoot, "patch-notes", channel);
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

async function evaluateRelease(releaseRoot) {
  const { loadCorpus } = await import("../src/rag.mjs");
  const corpus = await loadCorpus({ roots: [
    { dir: path.join(ROOT, "knowledge"), kind: "mechanic-card" },
    ...["Documents", "Commands", "Reference", "ScriptAPI"].map((folder) => ({
      dir: path.join(releaseRoot, "minecraft-creator", "creator", folder),
      kind: "official-doc",
    })),
    { dir: path.join(releaseRoot, "patch-notes"), kind: "patch-note" },
  ] });
  const checks = [
    ["how does a redstone comparator work", /comparator/i],
    ["how do I get a command block", /command/i],
    ["how does a t flip flop remember", /flip|bulb/i],
    ["how do I tame a cat", /raw (?:cod|salmon)/i],
  ];
  for (const [query, expected] of checks) {
    const results = corpus.search(query);
    if (!results.length || !expected.test(`${results[0].title} ${results[0].text}`)) {
      throw new Error(`retrieval evaluation failed before promotion: ${query}`);
    }
  }
  const { createWizard } = await import("../src/wizard.mjs");
  const wizard = createWizard({ corpus, env: {} });
  const greeting = await wizard.ask({ player: "release-eval", question: "hi", mode: "wizard" });
  if (!/hi|hello|hey|welcome/i.test(greeting.answer) || greeting.sources?.length) {
    throw new Error("dialogue evaluation failed before promotion: greeting");
  }
  return { chunks: corpus.size, retrievalChecks: checks.length, dialogueChecks: 1 };
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  if (await exists(path.join(CREATOR_REPO, ".git"))) {
    await run("git", ["-C", CREATOR_REPO, "pull", "--ff-only"]);
  } else {
    await run("git", ["clone", "--depth", "1", "--filter=blob:none", "https://github.com/MicrosoftDocs/minecraft-creator.git", CREATOR_REPO]);
  }
  const creatorCommit = await run("git", ["-C", CREATOR_REPO, "rev-parse", "HEAD"], { capture: true });
  await mkdir(RELEASES, { recursive: true });
  const staging = path.join(RELEASES, `.staging-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, "minecraft-creator", "creator"), { recursive: true });
  for (const folder of ["Documents", "Commands", "Reference", "ScriptAPI"]) {
    const source = path.join(CREATOR_REPO, "creator", folder);
    if (await exists(source)) await cp(source, path.join(staging, "minecraft-creator", "creator", folder), { recursive: true });
  }
  const counts = {};
  for (const [channel, section] of CHANGELOGS) counts[channel] = await syncChangelog(channel, section, staging);
  const evaluation = await evaluateRelease(staging);
  const revision = `${creatorCommit.slice(0, 12)}-${Date.now()}`;
  const release = path.join(RELEASES, revision);
  const manifest = {
    syncedAt: new Date().toISOString(),
    revision,
    creatorCommit,
    releaseNotes: counts,
    channels: ["stable", "preview"],
    edition: "bedrock",
    evaluation,
    attribution: {
      documentation: "Microsoft Minecraft Creator documentation; CC BY 4.0 (code samples MIT)",
      changelogs: "Minecraft Feedback release notes; cached privately and linked to original articles",
    },
  };
  await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(staging, release);
  const activeTemp = path.join(CACHE, `active-release.${process.pid}.json`);
  await writeFile(activeTemp, `${JSON.stringify({ revision, release: path.relative(CACHE, release) }, null, 2)}\n`);
  await rename(activeTemp, path.join(CACHE, "active-release.json"));
  await writeFile(path.join(CACHE, "sync-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[sync] promoted ${revision}: ${evaluation.chunks} chunks`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
