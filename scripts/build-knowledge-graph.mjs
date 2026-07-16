import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCorpus } from "../src/rag.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CACHE = path.join(ROOT, ".cache");

async function main() {
  const active = JSON.parse(await readFile(path.join(CACHE, "active-release.json"), "utf8"));
  if (!/^[a-zA-Z0-9._/-]+$/.test(active.release) || active.release.includes("..")) {
    throw new Error("active release path is invalid");
  }
  const release = path.join(CACHE, active.release);
  const corpus = await loadCorpus();
  const destination = path.join(release, "knowledge-graph.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(release, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(corpus.graphArtifact)}\n`);
  await rename(temporary, destination);
  console.log(`[graph] wrote ${corpus.graph.revision}: ${corpus.graph.documents} documents, ${corpus.graph.nodes} nodes, ${corpus.graph.edges} edges`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
