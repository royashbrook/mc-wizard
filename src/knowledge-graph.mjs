import { createHash } from "node:crypto";

export const KNOWLEDGE_GRAPH_SCHEMA_VERSION = 2;
export const KNOWLEDGE_GRAPH_EXTRACTION_VERSION = 3;

const MAX_CHUNK_ENTITIES = 24;
const MAX_ENTITY_EVIDENCE = 96;
const MAX_EDGE_EVIDENCE = 24;

const CONCEPTS = [
  ["entity", "cat", ["cat", "cats"]],
  ["entity", "chicken", ["chicken", "chickens"]],
  ["entity", "cow", ["cow", "cows"]],
  ["entity", "sheep", ["sheep"]],
  ["entity", "horse", ["horse", "horses"]],
  ["entity", "creeper", ["creeper", "creepers"]],
  ["entity", "phantom", ["phantom", "phantoms"]],
  ["entity", "villager", ["villager", "villagers"]],
  ["entity", "bee", ["bee", "bees"]],
  ["entity", "goat", ["goat", "goats"]],
  ["entity", "iron_golem", ["iron golem", "iron_golem"]],
  ["item", "raw_cod", ["raw cod", "cod"]],
  ["item", "raw_salmon", ["raw salmon", "salmon"]],
  ["item", "flint_and_steel", ["flint and steel"]],
  ["item", "redstone", ["redstone"]],
  ["block", "command_block", ["command block", "command blocks"]],
  ["block", "redstone_comparator", ["redstone comparator", "comparator"]],
  ["block", "copper_bulb", ["copper bulb", "copper bulbs"]],
  ["block", "redstone_lamp", ["redstone lamp", "redstone lamps"]],
  ["block", "obsidian", ["obsidian"]],
  ["component", "minecraft_tameable", ["minecraft:tameable", "tameable component"]],
  ["component", "minecraft_behavior_follow_owner", ["minecraft:behavior.follow_owner", "follow owner component"]],
  ["component", "minecraft_behavior_tempt", ["minecraft:behavior.tempt", "tempt component"]],
  ["mechanic", "taming", ["tame", "taming"]],
  ["mechanic", "redstone", ["redstone"]],
  ["mechanic", "crafting", ["craft", "crafting", "recipe", "recipes"]],
  ["mechanic", "farming", ["farm", "farming", "automatic farm"]],
  ["mechanic", "spawning", ["spawn", "spawning"]],
  ["mechanic", "breeding", ["breed", "breeding"]],
  ["mechanic", "teleportation", ["teleport", "teleporting", "travel"]],
  ["biome", "village", ["village", "villages"]],
  ["biome", "swamp", ["swamp", "swamps", "swamp hut"]],
  ["biome", "nether", ["nether"]],
  ["biome", "the_end", ["the end"]],
];

const COMMANDS = [
  "give", "summon", "teleport", "tp", "effect", "fill", "setblock", "execute", "gamemode", "gamerule", "weather", "time",
];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9_]+/g, " ").trim();
const stableHash = (value) => createHash("sha256").update(value).digest("hex");
const entityId = (kind, label) => `${kind}:${label}`;

function unique(values, max = Infinity) {
  return [...new Set(values)].slice(0, max);
}

function sourceDocument(chunk) {
  return {
    id: chunk.id,
    title: String(chunk.title || "").slice(0, 240),
    source: String(chunk.source || "").slice(0, 1_000),
    sourcePolicy: String(chunk.sourcePolicy || "unknown").slice(0, 120),
    edition: chunk.edition === "bedrock" ? "bedrock" : chunk.edition === "java" ? "java" : "unknown",
    channel: chunk.channel === "preview" ? "preview" : chunk.channel === "stable" ? "stable" : "unknown",
    version: String(chunk.version || "unknown").slice(0, 80),
    updated: chunk.updated || null,
    kind: String(chunk.kind || "unknown").slice(0, 80),
    contentHash: stableHash(`${chunk.title || ""}\0${chunk.text || ""}`),
  };
}

function conceptsFor(text) {
  const normalized = normalize(text);
  const matches = [];
  for (const [kind, label, aliases] of CONCEPTS) {
    if (aliases.some((alias) => new RegExp(`(?:^| )${escapeRegExp(normalize(alias))}(?: |$)`).test(normalized))) {
      matches.push({ id: entityId(kind, label), kind, label });
    }
  }
  for (const command of COMMANDS) {
    if (new RegExp(`(?:^|[ /])${escapeRegExp(command)}(?: |$)`).test(` ${normalized} `)) {
      matches.push({ id: entityId("command", command), kind: "command", label: command });
    }
  }
  for (const identifier of String(text || "").match(/\bminecraft:[a-z0-9_.]+\b/gi) || []) {
    const label = identifier.toLowerCase();
    const kind = inferredIdentifierKind(label, text);
    matches.push({ id: entityId("identifier", label.replace(/[:.]/g, "_")), kind: "identifier", label });
    if (kind !== "identifier") matches.push({ id: entityId(kind, label.replace(/[:.]/g, "_")), kind, label });
  }
  for (const match of String(text || "").matchAll(/(?:^|[\s`(])\/([a-z][a-z0-9_-]{1,48})\b/gim)) {
    const label = match[1].toLowerCase();
    matches.push({ id: entityId("command", label), kind: "command", label });
  }
  return unique(matches.map((entry) => JSON.stringify(entry)), MAX_CHUNK_ENTITIES).map((entry) => JSON.parse(entry));
}

function inferredIdentifierKind(label, text) {
  if (label.includes(".") || /:(?:tameable|health|inventory|movement|breathable|rideable|equippable|family)$/.test(label)) {
    return "component";
  }
  const lower = String(text || "").toLowerCase();
  const index = lower.indexOf(label);
  const before = index >= 0 ? lower.slice(Math.max(0, index - 48), index) : "";
  const after = index >= 0 ? lower.slice(index + label.length, index + label.length + 48) : "";
  if (/\b(?:block|blocks|blockstate)\s*$/.test(before) || /^\s+(?:block|blocks|blockstate)\b/.test(after)) return "block";
  if (/\b(?:entity|entities|mob|mobs)\s*$/.test(before) || /^\s+(?:entity|entities|mob|mobs)\b/.test(after)) return "entity";
  if (/\b(?:item|items)\s*$/.test(before) || /^\s+(?:item|items)\b/.test(after)) return "item";
  return "identifier";
}

function sentences(text) {
  return String(text || "").toLowerCase().split(/[.!?]+/).map((value) => value.trim()).filter(Boolean);
}

function verifiedTaming(text, food) {
  const foodPattern = new RegExp(`\\b${escapeRegExp(food)}\\b`);
  return sentences(text).some((sentence) => (
    /\bcats?\b/.test(sentence) && /\btam(?:e|ed|ing)\b/.test(sentence) && foodPattern.test(sentence)
    && !/\b(?:cannot|can't|can not|never|not|without)\b/.test(sentence)
  ));
}

function verifiedCommandExecution(text, command) {
  const commandPattern = new RegExp(`(?:\\/${escapeRegExp(command)}|\\b${escapeRegExp(command)}\\b)`);
  return sentences(text).some((sentence) => (
    /\bcommand blocks?\b/.test(sentence)
    && /\b(?:can|may|will|lets? you|used to)\b[^.]{0,120}\b(?:run|execute)\b/.test(sentence)
    && commandPattern.test(sentence)
    && !/\b(?:cannot|can't|can not|never|not|without)\b/.test(sentence)
  ));
}

function verifiedPatchChange(text, label) {
  const words = normalize(label).split(" ").filter(Boolean);
  if (!words.length) return false;
  return sentences(text).some((sentence) => {
    const mentionsSubject = words.every((word) => new RegExp(`\\b${escapeRegExp(word)}s?\\b`).test(sentence));
    const describesChange = /\b(?:changed|fixed|added|removed|updated|improved|introduced|resolved)\b/.test(sentence);
    const negated = /\b(?:no|not|without)\b[^.]{0,24}\b(?:change|changes|changed|fix|fixed|update|updated)\b/.test(sentence);
    return mentionsSubject && describesChange && !negated;
  });
}

function relationCandidates(concepts, document, text) {
  const ids = new Set(concepts.map(({ id }) => id));
  const relations = [];
  const add = (from, type, to) => {
    if (ids.has(from) && ids.has(to)) relations.push({ from, type, to });
  };
  if (verifiedTaming(text, "raw cod")) add("entity:cat", "TAMED_WITH", "item:raw_cod");
  if (verifiedTaming(text, "raw salmon")) add("entity:cat", "TAMED_WITH", "item:raw_salmon");
  for (const command of COMMANDS) {
    if (verifiedCommandExecution(text, command)) add("block:command_block", "RUNS_COMMAND", entityId("command", command));
  }
  if (document.kind === "patch-note" && document.version !== "unknown") {
    const release = entityId("release", document.version.replace(/[^a-z0-9_.-]/gi, "_").toLowerCase());
    for (const concept of concepts) {
      if (verifiedPatchChange(text, concept.label)) relations.push({ from: concept.id, type: "CHANGED_IN", to: release });
    }
  }
  return relations;
}

function graphRevision(documents) {
  return `kg-${KNOWLEDGE_GRAPH_SCHEMA_VERSION}-${KNOWLEDGE_GRAPH_EXTRACTION_VERSION}-${stableHash(documents
    .map(documentFingerprint)
    .sort().join("\n")).slice(0, 16)}`;
}

function documentFingerprint(document) {
  return JSON.stringify([
    document.id, document.title, document.source, document.sourcePolicy, document.edition,
    document.channel, document.version, document.updated, document.kind, document.contentHash,
  ]);
}

export function buildKnowledgeGraph(chunks, { revision } = {}) {
  const sortedChunks = [...chunks].sort((left, right) => left.id.localeCompare(right.id));
  const documents = sortedChunks.map(sourceDocument);
  const documentById = new Map(documents.map((document) => [document.id, document]));
  const nodes = new Map();
  const entityChunks = new Map();
  const edgeEvidence = new Map();

  for (const chunk of sortedChunks) {
    const document = documentById.get(chunk.id);
    if (!document) continue;
    const evidenceText = `${document.title}\n${chunk.text || ""}\n${document.source}`;
    const concepts = conceptsFor(evidenceText);
    for (const concept of concepts) {
      if (!nodes.has(concept.id)) nodes.set(concept.id, concept);
      const evidence = entityChunks.get(concept.id) || [];
      if (evidence.length < MAX_ENTITY_EVIDENCE) evidence.push(document.id);
      entityChunks.set(concept.id, evidence);
    }
    for (const relation of relationCandidates(concepts, document, evidenceText)) {
      if (relation.type === "CHANGED_IN" && !nodes.has(relation.to)) {
        nodes.set(relation.to, { id: relation.to, kind: "release", label: document.version });
      }
      const key = `${relation.from}\0${relation.type}\0${relation.to}`;
      const evidence = edgeEvidence.get(key) || { ...relation, evidence: [] };
      if (evidence.evidence.length < MAX_EDGE_EVIDENCE) evidence.evidence.push(document.id);
      edgeEvidence.set(key, evidence);
    }
  }

  const artifact = {
    schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION,
    extractionVersion: KNOWLEDGE_GRAPH_EXTRACTION_VERSION,
    revision: revision || graphRevision(documents),
    documents,
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edgeEvidence.values()].sort((left, right) => (
      `${left.from}\0${left.type}\0${left.to}`.localeCompare(`${right.from}\0${right.type}\0${right.to}`)
    )),
    entityChunks: Object.fromEntries([...entityChunks.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, ids]) => [id, unique(ids, MAX_ENTITY_EVIDENCE)])),
  };
  return {
    ...artifact,
    stats: {
      documents: documents.length,
      nodes: artifact.nodes.length,
      edges: artifact.edges.length,
      sources: Object.fromEntries(Object.entries(documents.reduce((counts, document) => {
        counts[document.kind] = (counts[document.kind] || 0) + 1;
        return counts;
      }, {})).sort(([left], [right]) => left.localeCompare(right))),
    },
  };
}

export function validateKnowledgeGraph(value, chunks = []) {
  if (!value || typeof value !== "object" || value.schemaVersion !== KNOWLEDGE_GRAPH_SCHEMA_VERSION
    || value.extractionVersion !== KNOWLEDGE_GRAPH_EXTRACTION_VERSION
    || typeof value.revision !== "string" || !Array.isArray(value.documents)
    || !Array.isArray(value.nodes) || !Array.isArray(value.edges)
    || !value.entityChunks || typeof value.entityChunks !== "object" || Array.isArray(value.entityChunks)) return undefined;
  const expectedDocuments = new Map(chunks.map((chunk) => {
    const document = sourceDocument(chunk);
    return [document.id, document];
  }));
  if (value.documents.length !== expectedDocuments.size) return undefined;
  const seenDocuments = new Set();
  for (const document of value.documents) {
    const expected = document && expectedDocuments.get(document.id);
    if (!expected || seenDocuments.has(document.id) || documentFingerprint(document) !== documentFingerprint(expected)) return undefined;
    seenDocuments.add(document.id);
  }
  const documents = [...value.documents].sort((left, right) => left.id.localeCompare(right.id));
  const nodeIds = new Set();
  const nodes = value.nodes.filter((node) => {
    if (!node || typeof node.id !== "string" || typeof node.kind !== "string" || typeof node.label !== "string"
      || nodeIds.has(node.id)) return false;
    nodeIds.add(node.id);
    return true;
  });
  if (nodes.length !== value.nodes.length) return undefined;
  const documentIds = new Set(documents.map(({ id }) => id));
  const edges = value.edges.filter((edge) => (
    edge && nodeIds.has(edge.from) && nodeIds.has(edge.to) && typeof edge.type === "string"
    && Array.isArray(edge.evidence) && edge.evidence.every((id) => documentIds.has(id))
  ));
  if (edges.length !== value.edges.length) return undefined;
  const entityChunks = {};
  for (const [id, ids] of Object.entries(value.entityChunks)) {
    if (!nodeIds.has(id) || !Array.isArray(ids)) return undefined;
    const evidence = unique(ids.filter((chunkId) => documentIds.has(chunkId)), MAX_ENTITY_EVIDENCE);
    if (!evidence.length || evidence.length !== ids.length) return undefined;
    entityChunks[id] = evidence;
  }
  const artifact = { ...value, documents, nodes, edges, entityChunks };
  return { ...artifact, stats: value.stats || buildKnowledgeGraph(chunks, { revision: value.revision }).stats };
}

export function createKnowledgeGraph(artifact) {
  const documents = new Map(artifact.documents.map((document) => [document.id, document]));
  const entityChunks = new Map(Object.entries(artifact.entityChunks));
  const edgeNeighbors = new Map();
  for (const edge of artifact.edges) {
    const neighbors = edgeNeighbors.get(edge.from) || new Set();
    neighbors.add(edge.to);
    edgeNeighbors.set(edge.from, neighbors);
  }
  return {
    revision: artifact.revision,
    stats: artifact.stats,
    search(query, { limit = 4, includePreview = false } = {}) {
      const entities = conceptsFor(query);
      const scores = new Map();
      const scoreEntity = (id, amount) => {
        for (const chunkId of entityChunks.get(id) || []) {
          const document = documents.get(chunkId);
          if (!document || document.edition !== "bedrock"
            || (document.channel !== "stable" && !(includePreview && document.channel === "preview"))) continue;
          scores.set(chunkId, (scores.get(chunkId) || 0) + amount);
        }
      };
      for (const { id } of entities) {
        scoreEntity(id, 5);
        for (const neighbor of edgeNeighbors.get(id) || []) scoreEntity(neighbor, 1.5);
      }
      return [...scores.entries()].sort(([, left], [, right]) => right - left).slice(0, limit)
        .map(([id, score]) => ({ id, score: Number(score.toFixed(3)), entities: entities.map(({ id: entity }) => entity) }));
    },
  };
}
