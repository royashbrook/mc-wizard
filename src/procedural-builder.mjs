// Procedural silhouette engine (#35): turns a child's free-form build request into a
// build_structure plan that passes the real pack validator by construction. Imports only
// limit constants and material checks from the behavior-pack module wizard.mjs already uses.
import {
  STRUCTURE_LIMITS,
  STRUCTURE_PHASES,
  STRUCTURE_PRIMITIVE_LIMIT,
  isAllowedStructureMaterial,
} from "../bedrock/behavior_packs/mc_wizard/scripts/build-structure.js";

const PHASE_INDEX = Object.fromEntries(STRUCTURE_PHASES.map((phase, index) => [phase, index]));

// Longer names first so light_blue wins over blue.
const COLOR_NAMES = [
  "light_blue", "light_gray", "magenta", "orange", "yellow", "purple", "brown",
  "white", "black", "green", "pink", "gray", "cyan", "blue", "lime", "red",
];

const RAINBOW_BLOCKS = [
  "minecraft:red_concrete",
  "minecraft:orange_concrete",
  "minecraft:yellow_concrete",
  "minecraft:lime_concrete",
  "minecraft:light_blue_concrete",
  "minecraft:purple_concrete",
];

// Mirrors the FEATURES set in build-structure.js (not exported there); the validator
// matrix test keeps this list honest.
const ALLOWED_FEATURES = new Set([
  "floor", "walls", "door", "windows", "roof", "lighting", "battlements", "towers",
  "supports", "walkway", "railings", "rooms", "second_floor", "decorations", "rainbow",
]);

const ALLOWED_ENTITY_TYPES = new Set([
  "minecraft:villager_v2",
  "minecraft:goat",
  "minecraft:iron_golem",
]);

const SIZE_SCALES = [
  [/\b(?:tiny|mini|miniature)\b/i, 0.5, "tiny"],
  [/\b(?:small|little)\b/i, 0.75, "small"],
  [/\b(?:giant|huge|massive|enormous|gigantic)\b/i, 2.5, "giant"],
  [/\b(?:big|large)\b/i, 1.5, "big"],
];

const SOFT_DIMENSION_CAP = 48;

export const SILHOUETTES = [
  {
    template: "quadruped",
    nouns: [
      "dog", "puppy", "pup", "cat", "kitten", "kitty", "wolf", "horse", "pony", "pig",
      "cow", "sheep", "goat", "bear", "fox", "lion", "tiger", "elephant", "dinosaur",
      "dino", "dragon", "bunny", "rabbit", "hamster",
    ],
  },
  { template: "unicorn", nouns: ["unicorn", "pegasus"] },
  { template: "bird", nouns: ["bird", "duck", "ducky", "chicken", "penguin", "owl", "parrot", "eagle"] },
  { template: "fish", nouns: ["fish", "shark", "whale", "dolphin", "orca"] },
  { template: "humanoid", nouns: ["robot", "snowman", "golem", "alien", "statue", "sculpture", "zombie", "skeleton"] },
  { template: "creeper", nouns: ["creeper"] },
  { template: "vehicle", nouns: ["car", "truck", "train", "bus", "tractor"] },
  { template: "airplane", nouns: ["plane", "airplane", "aeroplane", "jet", "helicopter"] },
  { template: "coaster", nouns: ["rollercoaster", "coaster", "slide"] },
  { template: "boat", nouns: ["boat", "ship", "sailboat", "canoe"] },
  { template: "rocket", nouns: ["rocket", "rocketship", "spaceship"] },
  { template: "arch", nouns: ["rainbow", "arch", "archway"] },
  { template: "heart", nouns: ["heart"] },
  { template: "furniture", nouns: ["couch", "sofa", "chair", "table", "bed", "bench", "throne"] },
];

// Checked after the noun regexes as a plain substring so compounds like "doghouse"
// and "birdhouse" resolve to a building, never an animal.
const HOUSE_WORDS = ["house", "home", "cottage", "cabin", "hut"];

const SILHOUETTE_MATCHERS = SILHOUETTES.map(({ template, nouns }) => ({
  template,
  pattern: new RegExp(`\\b(${nouns.join("|")})s?\\b`, "i"),
}));

const concrete = (color) => `minecraft:${color}_concrete`;

const TEMPLATES = {
  quadruped: {
    base: [10, 6, 7],
    min: [6, 5, 5],
    palette: { primary: concrete("brown"), accent: concrete("black"), roof: concrete("brown") },
    parts: "four sturdy legs, a big body, a raised head, eyes, and a tail",
  },
  bird: {
    base: [7, 5, 7],
    min: [5, 4, 5],
    palette: { primary: concrete("yellow"), accent: concrete("orange"), roof: concrete("yellow") },
    parts: "two legs, a round body, a head up top, a beak, and little wings",
  },
  fish: {
    base: [11, 4, 7],
    min: [6, 3, 5],
    palette: { primary: concrete("cyan"), accent: concrete("white"), roof: concrete("cyan") },
    parts: "a long body, a top fin, a tail fin, and an eye",
  },
  humanoid: {
    base: [7, 4, 10],
    min: [5, 3, 6],
    palette: { primary: concrete("white"), accent: concrete("light_gray"), roof: concrete("white") },
    parts: "two legs, a torso, two arms, and a head with eyes",
  },
  creeper: {
    base: [5, 4, 10],
    min: [3, 3, 6],
    palette: { primary: concrete("lime"), accent: concrete("black"), roof: concrete("green") },
    parts: "four stubby feet, a tall body, a big square head, and a famous frowny face",
  },
  unicorn: {
    base: [10, 6, 8],
    min: [6, 5, 6],
    palette: { primary: concrete("white"), accent: concrete("pink"), roof: concrete("yellow") },
    parts: "four sturdy legs, a big body, a raised head, a shiny horn, and a tail",
  },
  airplane: {
    base: [13, 9, 6],
    min: [7, 5, 4],
    palette: { primary: concrete("white"), accent: concrete("red"), roof: concrete("white") },
    parts: "a long fuselage, two wide wings, a tail fin, a cockpit window, and landing gear",
  },
  coaster: {
    base: [14, 5, 8],
    min: [7, 3, 5],
    palette: { primary: concrete("red"), accent: concrete("gray"), roof: concrete("red") },
    parts: "support columns, a track that rises and falls over a big hill, and railings at both ends",
  },
  vehicle: {
    base: [11, 6, 6],
    min: [6, 4, 4],
    palette: { primary: concrete("red"), accent: concrete("black"), roof: concrete("red") },
    parts: "four wheels, a chassis, a cabin, windows, and headlights",
  },
  boat: {
    base: [12, 5, 8],
    min: [6, 4, 5],
    palette: { primary: "minecraft:oak_planks", accent: concrete("white"), roof: "minecraft:spruce_planks" },
    parts: "a hull, railings, a mast, and a sail",
  },
  rocket: {
    base: [7, 7, 14],
    min: [5, 5, 7],
    palette: { primary: concrete("white"), accent: concrete("red"), roof: concrete("red") },
    parts: "four fins, a tall body, round windows, and a nose cone",
  },
  arch: {
    base: [15, 3, 10],
    min: [7, 3, 6],
    palette: { primary: concrete("red"), accent: concrete("white"), roof: concrete("red") },
    parts: "banded arcs standing on two feet with puffy cloud bases",
  },
  heart: {
    base: [11, 4, 9],
    min: [7, 3, 6],
    palette: { primary: concrete("red"), accent: concrete("pink"), roof: concrete("red") },
    parts: "a pointed bottom, a wide middle, two round lobes, and a shine spot",
  },
  furniture: {
    base: [7, 4, 5],
    min: [5, 3, 4],
    palette: { primary: concrete("blue"), accent: concrete("white"), roof: concrete("blue") },
    parts: "a base, a seat, a backrest, armrests, and cushions",
  },
  house: {
    base: [9, 9, 6],
    min: [5, 5, 4],
    palette: { primary: "minecraft:oak_planks", accent: "minecraft:oak_log", roof: "minecraft:spruce_planks" },
    parts: "a floor, four walls, a doorway, windows, a lantern, and a roof",
  },
  abstract: {
    base: [8, 8, 8],
    min: [4, 4, 4],
    palette: { primary: "minecraft:quartz_block", accent: concrete("light_blue"), roof: "minecraft:quartz_block" },
    parts: "a pedestal, a sculpted core, corner studs, a glow stone, and a cap",
  },
};

const DEFAULT_FEATURES = {
  house: ["floor", "walls", "door", "windows", "roof", "lighting"],
  furniture: ["decorations", "supports"],
  arch: ["decorations", "supports"],
};

const sanitizeKind = (value) => String(value || "")
  .replace(/[^a-zA-Z0-9 _-]/g, "")
  .trim()
  .slice(0, 48)
  .toLowerCase();

function matchTemplate(text) {
  for (const { template, pattern } of SILHOUETTE_MATCHERS) {
    const match = text.match(pattern);
    if (match) return { template, noun: match[1].toLowerCase() };
  }
  const lowered = text.toLowerCase();
  const houseWord = HOUSE_WORDS.find((word) => lowered.includes(word));
  if (houseWord) return { template: "house", noun: undefined };
  return { template: "abstract", noun: undefined };
}

function subjectPhrase(question) {
  // #35: misspelled build verbs and "i want a <noun>" carry a subject too.
  const phrase = (question.match(
    /\b(?:build|bild|buld|biuld|buid|construct|create|make|mak|mke|mk|shape)\s+(?:me\s+)?(?:us\s+)?(?:an?\s+|the\s+|my\s+)?(.+?)(?:\s+(?:that|which|with|using|made|sized|out\s+of|please)\b|[?.!,]|$)/i,
  ) || question.match(
    /\b(?:i|we)\s+(?:really\s+)?(?:want|need)\s+an?\s+(.+?)(?:\s+(?:that|which|with|using|made|sized|out\s+of|please)\b|[?.!,]|$)/i,
  ))?.[1];
  if (!phrase) return undefined;
  return sanitizeKind(phrase
    .replace(/\b\d+\s*(?:x|×|by)\s*\d+(?:\s*(?:x|×|by)\s*\d+)?\b/gi, "")
    .replace(/\b(?:tiny|mini|miniature|small|little|big|large|giant|huge|massive|enormous|gigantic|working|complete|entire|whole|cool|awesome|epic|pretty|cute|blocky)\b/gi, "")
    .replace(new RegExp(`\\b(?:${COLOR_NAMES.join("|").replace(/_/g, "[ _]")}|grey)\\b`, "gi"), "")
    .replace(/\s{2,}/g, " ")) || undefined;
}

function questionColor(text) {
  const spaced = COLOR_NAMES.map((name) => name.replace(/_/g, "[ _]"));
  const match = text.match(new RegExp(`\\b(${spaced.join("|")}|grey)\\b`, "i"));
  if (!match) return undefined;
  const name = match[1].toLowerCase().replace(/[ ]/g, "_");
  return name === "grey" ? "gray" : name;
}

function coerceMaterial(value, fallback) {
  const id = String(value || "").trim().toLowerCase();
  if (!id) return fallback;
  if (isAllowedStructureMaterial(id)) return id;
  const bare = id.replace(/^minecraft:/, "");
  const color = COLOR_NAMES.find((name) => bare === name || bare.startsWith(`${name}_`));
  if (color && isAllowedStructureMaterial(concrete(color))) return concrete(color);
  return fallback;
}

function parseQuestionDimensions(text) {
  const size = text.match(/\b(\d{1,3})\s*(?:x|×|by)\s*(\d{1,3})(?:\s*(?:x|×|by)\s*(\d{1,2}))?\b/i);
  if (!size) return undefined;
  return {
    width: Number(size[1]),
    depth: Number(size[2]),
    ...(size[3] ? { height: Number(size[3]) } : {}),
  };
}

const AXIS_NAMES = ["width", "depth", "height"];

function resolveDimensions(template, scale, explicit) {
  const spec = TEMPLATES[template];
  return Object.fromEntries(AXIS_NAMES.map((axis, index) => {
    const limit = STRUCTURE_LIMITS[axis];
    const explicitValue = Number(explicit?.[axis]);
    if (Number.isInteger(explicitValue) && explicitValue > 0) {
      // Explicit requests are respected up to the hard pack limits.
      return [axis, Math.min(limit, Math.max(spec.min[index], explicitValue))];
    }
    const scaled = Math.round(spec.base[index] * scale);
    return [axis, Math.min(limit, SOFT_DIMENSION_CAP, Math.max(spec.min[index], scaled))];
  }));
}

export function extractDescriptor(question, overrides = {}) {
  const text = String(question || "");
  const subjectText = overrides.kind ? String(overrides.kind) : text;
  const { template, noun } = matchTemplate(subjectText);
  let kind = sanitizeKind(overrides.kind) || subjectPhrase(text) || noun || "sculpture";
  // The city-geometry gate in the pack validator is meant for authored multi-building
  // plans; a procedural diorama must not claim those kinds.
  if (["city", "village", "settlement"].includes(kind)) kind = `${kind} model`.slice(0, 48);
  const sizeEntry = SIZE_SCALES.find(([pattern]) => pattern.test(text));
  const rainbow = /\brainbow\b/i.test(text) || template === "arch" && /\brainbow\b/i.test(subjectText);
  const color = questionColor(text);
  const spec = TEMPLATES[template];
  const primary = coerceMaterial(
    overrides.material || (color ? concrete(color) : undefined),
    spec.palette.primary,
  );
  const accent = primary === spec.palette.accent ? spec.palette.primary : spec.palette.accent;
  const features = new Set(DEFAULT_FEATURES[template] || ["decorations"]);
  if (rainbow) features.add("rainbow");
  for (const feature of overrides.features || []) {
    if (ALLOWED_FEATURES.has(String(feature))) features.add(String(feature));
  }
  const entities = [];
  for (const entry of overrides.entities || []) {
    const typeId = typeof entry === "string" ? entry : String(entry?.typeId || "");
    if (!ALLOWED_ENTITY_TYPES.has(typeId) || entities.length >= 8) continue;
    entities.push({ typeId, location: Array.isArray(entry?.location) ? entry.location : undefined });
  }
  return {
    kind,
    template,
    size: sizeEntry?.[2] || "medium",
    dimensions: resolveDimensions(template, sizeEntry?.[1] || 1, overrides.dimensions || parseQuestionDimensions(text)),
    palette: {
      primary,
      accent,
      roof: coerceMaterial(overrides.material || (color ? concrete(color) : undefined), spec.palette.roof),
    },
    rainbow,
    features: [...features],
    entities,
  };
}

const box = (phase, blockId, from, to) => ({ shape: "box", phase, blockId, from, to });

function buildQuadruped({ width: w, depth: d, height: h }, { primary, accent }) {
  const legH = Math.max(1, Math.round(h * 0.3));
  const bodyTop = Math.max(legH, h - 1 - Math.max(1, Math.round(h * 0.25)));
  const legW = Math.max(1, Math.floor(w / 8));
  const legD = Math.max(1, Math.floor(d / 8));
  const xA = 1;
  const xB = w - 1 - legW;
  const zA = 1;
  const zB = d - 1 - legD;
  const headLen = Math.max(2, Math.round(w * 0.3));
  const hz0 = Math.max(0, Math.floor((d - 3) / 2));
  const hz1 = Math.min(d - 1, hz0 + 2);
  const midZ = Math.floor(d / 2);
  return [
    box("foundation", primary, [xA, 0, zA], [xA + legW - 1, legH - 1, zA + legD - 1]),
    box("foundation", primary, [xA, 0, zB], [xA + legW - 1, legH - 1, zB + legD - 1]),
    box("foundation", primary, [xB, 0, zA], [xB + legW - 1, legH - 1, zA + legD - 1]),
    box("foundation", primary, [xB, 0, zB], [xB + legW - 1, legH - 1, zB + legD - 1]),
    box("shell", primary, [0, legH, 0], [w - 1, bodyTop, d - 1]),
    box("roof", primary, [w - headLen, bodyTop + 1, hz0], [w - 1, h - 1, hz1]),
    box("details", accent, [w - 1, h - 1, hz0], [w - 1, h - 1, hz0]),
    box("details", accent, [w - 1, h - 1, hz1], [w - 1, h - 1, hz1]),
    box("details", accent, [0, Math.min(bodyTop + 1, h - 1), midZ], [0, Math.min(bodyTop + 1, h - 1), midZ]),
  ];
}

function buildBird({ width: w, depth: d, height: h }, { primary, accent }) {
  const legH = Math.max(1, Math.round(h * 0.2));
  const bodyTop = Math.max(legH, h - 1 - Math.max(1, Math.round(h * 0.3)));
  const headLen = Math.max(2, Math.round(w * 0.35));
  const hz0 = Math.max(0, Math.floor((d - 3) / 2));
  const hz1 = Math.min(d - 1, hz0 + 2);
  const midZ = Math.floor(d / 2);
  return [
    box("foundation", accent, [Math.floor(w / 3), 0, midZ], [Math.floor(w / 3), legH - 1, midZ]),
    box("foundation", accent, [Math.min(w - 1, Math.ceil((2 * w) / 3)), 0, midZ], [Math.min(w - 1, Math.ceil((2 * w) / 3)), legH - 1, midZ]),
    box("shell", primary, [0, legH, 0], [w - 1, bodyTop, d - 1]),
    box("roof", primary, [w - headLen, bodyTop + 1, hz0], [w - 1, h - 1, hz1]),
    box("details", accent, [w - 1, Math.min(bodyTop + 1, h - 1), midZ], [w - 1, Math.min(bodyTop + 1, h - 1), midZ]),
    box("details", accent, [w - 1, h - 1, hz0], [w - 1, h - 1, hz0]),
    box("details", accent, [1, bodyTop, 0], [Math.max(1, w - 2), bodyTop, 0]),
    box("details", accent, [1, bodyTop, d - 1], [Math.max(1, w - 2), bodyTop, d - 1]),
    box("details", accent, [0, bodyTop, midZ], [0, bodyTop, midZ]),
  ];
}

function buildFish({ width: w, depth: d, height: h }, { primary, accent }) {
  const bodyTop = Math.max(1, h - 1 - Math.max(1, Math.round(h * 0.25)));
  const midZ = Math.floor(d / 2);
  return [
    box("foundation", accent, [0, 0, 0], [w - 1, 0, d - 1]),
    box("shell", primary, [0, 1, 0], [w - 1, bodyTop, d - 1]),
    box("roof", primary, [Math.floor(w * 0.4), bodyTop + 1, midZ], [Math.min(w - 1, Math.floor(w * 0.6)), h - 1, midZ]),
    box("details", accent, [0, 1, midZ], [0, Math.min(bodyTop + 1, h - 1), midZ]),
    box("details", accent, [w - 1, bodyTop, midZ], [w - 1, bodyTop, midZ]),
    box("details", accent, [Math.floor(w / 2), 1, 0], [Math.floor(w / 2), bodyTop, 0]),
    box("details", accent, [Math.floor(w / 2), 1, d - 1], [Math.floor(w / 2), bodyTop, d - 1]),
    box("details", accent, [Math.max(0, w - 2), 1, 0], [Math.max(0, w - 2), bodyTop, 0]),
  ];
}

function buildHumanoid({ width: w, depth: d, height: h }, { primary, accent }) {
  const legTop = Math.max(0, Math.round(h * 0.35) - 1);
  const headH = Math.max(2, Math.round(h * 0.25));
  const torsoTop = Math.max(legTop + 1, h - 1 - headH);
  const midZ = Math.floor(d / 2);
  const hx0 = Math.max(1, Math.floor((w - 3) / 2));
  const hx1 = Math.min(w - 2, hx0 + 2);
  return [
    box("foundation", primary, [1, 0, midZ], [1, legTop, midZ]),
    box("foundation", primary, [w - 2, 0, midZ], [w - 2, legTop, midZ]),
    box("shell", primary, [1, legTop + 1, 0], [w - 2, torsoTop, d - 1]),
    box("roof", primary, [hx0, torsoTop + 1, 0], [hx1, h - 1, d - 1]),
    box("details", accent, [0, legTop + 1, midZ], [0, torsoTop, midZ]),
    box("details", accent, [w - 1, legTop + 1, midZ], [w - 1, torsoTop, midZ]),
    box("details", accent, [hx0, h - 1, 0], [hx0, h - 1, 0]),
    box("details", accent, [hx1, h - 1, 0], [hx1, h - 1, 0]),
  ];
}

function buildCreeper({ width: w, depth: d, height: h }, { primary, accent }) {
  const feetH = Math.max(1, Math.round(h * 0.15));
  const headH = Math.max(2, Math.round(h * 0.3));
  const bodyTop = Math.max(feetH, h - 1 - headH);
  const footD = Math.max(1, Math.floor(d / 3));
  const bz0 = Math.min(1, d - 2);
  const bz1 = Math.max(bz0, d - 2);
  const eyeY = Math.min(h - 1, bodyTop + Math.max(1, Math.floor(headH / 2)));
  const mouthY = Math.min(h - 1, Math.max(bodyTop + 1, eyeY - 1));
  const ex0 = Math.max(0, Math.floor(w / 4));
  const ex1 = Math.min(w - 1, w - 1 - Math.floor(w / 4));
  return [
    box("foundation", primary, [0, 0, 0], [w - 1, feetH - 1, footD - 1]),
    box("foundation", primary, [0, 0, d - footD], [w - 1, feetH - 1, d - 1]),
    box("shell", primary, [0, feetH, bz0], [w - 1, bodyTop, bz1]),
    box("roof", primary, [0, bodyTop + 1, 0], [w - 1, h - 1, d - 1]),
    box("details", accent, [ex0, eyeY, 0], [ex0, eyeY, 0]),
    box("details", accent, [ex1, eyeY, 0], [ex1, eyeY, 0]),
    box("details", accent, [Math.floor(w / 2), mouthY, 0], [Math.floor(w / 2), mouthY, 0]),
  ];
}

function buildUnicorn(dimensions, palette) {
  const { width: w, depth: d, height: h } = dimensions;
  // The horn takes the top row, so the quadruped body sculpts one block shorter.
  const body = buildQuadruped({ width: w, depth: d, height: h - 1 }, palette);
  const hornX = Math.max(0, w - 2);
  return [
    ...body,
    box("details", palette.roof, [hornX, h - 1, Math.floor(d / 2)], [hornX, h - 1, Math.floor(d / 2)]),
  ];
}

function buildAirplane({ width: w, depth: d, height: h }, { primary, accent }) {
  const midZ = Math.floor(d / 2);
  const fw = Math.max(1, Math.min(3, Math.floor(d / 3)));
  const fz0 = Math.max(0, midZ - Math.floor(fw / 2));
  const fz1 = Math.min(d - 1, fz0 + fw - 1);
  const bodyTop = Math.max(1, h - 1 - Math.max(1, Math.round(h * 0.35)));
  const wingY = Math.min(bodyTop, Math.max(1, Math.round(h * 0.4)));
  const wingX0 = Math.max(0, Math.floor(w * 0.35));
  const wingX1 = Math.min(w - 1, wingX0 + Math.max(0, Math.floor(w * 0.15)));
  return [
    box("foundation", accent, [2, 0, midZ], [2, 0, midZ]),
    box("foundation", accent, [w - 3, 0, fz0], [w - 3, 0, fz0]),
    box("foundation", accent, [w - 3, 0, fz1], [w - 3, 0, fz1]),
    box("shell", primary, [0, 1, fz0], [w - 1, bodyTop, fz1]),
    box("shell", primary, [wingX0, wingY, 0], [wingX1, wingY, d - 1]),
    box("roof", primary, [0, bodyTop + 1, midZ], [Math.min(1, w - 1), h - 1, midZ]),
    box("roof", accent, [0, bodyTop, Math.max(0, midZ - 2)], [Math.min(1, w - 1), bodyTop, Math.min(d - 1, midZ + 2)]),
    box("details", "minecraft:glass", [w - 2, bodyTop, fz0], [w - 2, bodyTop, fz1]),
    box("details", accent, [w - 1, Math.max(1, bodyTop - 1), midZ], [w - 1, Math.max(1, bodyTop - 1), midZ]),
  ];
}

function buildCoaster({ width: w, depth: d, height: h }, { primary, accent }) {
  const midZ = Math.floor(d / 2);
  const tw = Math.max(1, Math.min(3, Math.floor(d / 2)));
  const z0 = Math.max(0, midZ - Math.floor(tw / 2));
  const z1 = Math.min(d - 1, z0 + tw - 1);
  const peakX = Math.floor((w - 1) / 2);
  const trackY = (x) => (x === peakX
    ? h - 1
    : Math.min(h - 1, 1 + Math.round((h - 2) * Math.sin((Math.PI * x) / (w - 1)))));
  const primitives = [box("foundation", accent, [0, 0, 0], [w - 1, 0, d - 1])];
  for (let x = 0; x < w; x += 1) {
    const y = trackY(x);
    primitives.push(box(y === h - 1 ? "roof" : "shell", primary, [x, y, z0], [x, y, z1]));
    if (x % 3 === 0 && y > 1) primitives.push(box("foundation", accent, [x, 1, midZ], [x, y - 1, midZ]));
  }
  primitives.push(
    box("details", accent, [0, Math.min(2, h - 1), z0], [0, Math.min(2, h - 1), z1]),
    box("details", accent, [w - 1, Math.min(2, h - 1), z0], [w - 1, Math.min(2, h - 1), z1]),
  );
  return primitives;
}

function buildVehicle({ width: w, depth: d, height: h }, { primary, accent }) {
  const chassisTop = Math.max(1, h - 1 - Math.max(1, Math.round(h * 0.35)));
  const cabX0 = Math.max(0, Math.floor(w * 0.3));
  const cabX1 = Math.min(w - 1, Math.max(cabX0, Math.floor(w * 0.7)));
  const cz0 = Math.min(d - 1, 1);
  const cz1 = Math.max(cz0, d - 2);
  return [
    box("foundation", accent, [1, 0, 0], [1, 0, 0]),
    box("foundation", accent, [1, 0, d - 1], [1, 0, d - 1]),
    box("foundation", accent, [w - 2, 0, 0], [w - 2, 0, 0]),
    box("foundation", accent, [w - 2, 0, d - 1], [w - 2, 0, d - 1]),
    box("shell", primary, [0, 1, 0], [w - 1, chassisTop, d - 1]),
    box("roof", primary, [cabX0, chassisTop + 1, cz0], [cabX1, h - 1, cz1]),
    box("details", "minecraft:glass", [cabX1, chassisTop + 1, cz0], [cabX1, h - 1, cz1]),
    box("details", accent, [w - 1, 1, 0], [w - 1, 1, 0]),
    box("details", accent, [w - 1, 1, d - 1], [w - 1, 1, d - 1]),
  ];
}

function buildBoat({ width: w, depth: d, height: h }, { primary, accent, roof }) {
  const hullTop = Math.max(1, Math.round(h * 0.35));
  const midX = Math.floor(w / 2);
  const midZ = Math.floor(d / 2);
  const sailX0 = Math.max(0, midX - 3);
  return [
    box("foundation", primary, [0, 0, midZ], [w - 1, 0, midZ]),
    box("shell", primary, [0, 0, 0], [w - 1, hullTop, d - 1]),
    box("roof", roof, [midX, hullTop + 1, midZ], [midX, h - 1, midZ]),
    box("details", accent, [sailX0, Math.min(hullTop + 1, h - 1), midZ], [Math.max(sailX0, midX - 1), Math.max(hullTop + 1, h - 2), midZ]),
    box("details", accent, [0, hullTop, midZ], [0, hullTop, midZ]),
    box("details", accent, [w - 1, hullTop, midZ], [w - 1, hullTop, midZ]),
    box("details", accent, [0, hullTop, 0], [w - 1, hullTop, 0]),
    box("details", accent, [0, hullTop, d - 1], [w - 1, hullTop, d - 1]),
  ];
}

function buildRocket({ width: w, depth: d, height: h }, { primary, accent }) {
  const finTop = Math.max(1, Math.round(h * 0.2));
  const noseH = Math.max(2, Math.round(h * 0.25));
  const bodyTop = Math.max(finTop, h - 1 - noseH);
  const midX = Math.floor(w / 2);
  const midZ = Math.floor(d / 2);
  const nx0 = Math.max(1, midX - 1);
  const nx1 = Math.min(w - 2, midX + 1);
  const nz0 = Math.max(1, midZ - 1);
  const nz1 = Math.min(d - 2, midZ + 1);
  return [
    box("foundation", accent, [0, 0, midZ], [0, finTop, midZ]),
    box("foundation", accent, [w - 1, 0, midZ], [w - 1, finTop, midZ]),
    box("foundation", accent, [midX, 0, 0], [midX, finTop, 0]),
    box("foundation", accent, [midX, 0, d - 1], [midX, finTop, d - 1]),
    box("shell", primary, [1, 0, 1], [w - 2, bodyTop, d - 2]),
    box("roof", accent, [nx0, bodyTop + 1, nz0], [nx1, h - 1, nz1]),
    box("details", "minecraft:glass", [midX, Math.max(1, Math.floor(bodyTop * 0.6)), 1], [midX, Math.max(1, Math.floor(bodyTop * 0.6)), 1]),
    box("details", "minecraft:glass", [midX, Math.max(1, Math.floor(bodyTop * 0.3)), 1], [midX, Math.max(1, Math.floor(bodyTop * 0.3)), 1]),
  ];
}

function buildArch({ width: w, depth: d, height: h }, { primary, accent }, rainbow) {
  const bands = Math.max(2, Math.min(RAINBOW_BLOCKS.length, Math.floor(w / 2) - 1, h - 2));
  const primitives = [];
  for (let band = 0; band < bands; band += 1) {
    const blockId = rainbow ? RAINBOW_BLOCKS[band % RAINBOW_BLOCKS.length] : (band % 2 === 0 ? primary : accent);
    const topY = h - 1 - band;
    const columnPhase = band === 0 ? "foundation" : "shell";
    primitives.push(
      box(columnPhase, blockId, [band, 0, 0], [band, topY - 1, d - 1]),
      box(columnPhase, blockId, [w - 1 - band, 0, 0], [w - 1 - band, topY - 1, d - 1]),
      box(band === 0 ? "roof" : "shell", blockId, [band, topY, 0], [w - 1 - band, topY, d - 1]),
    );
  }
  primitives.push(
    box("details", "minecraft:white_concrete", [0, 0, 0], [Math.min(1, w - 1), 0, d - 1]),
    box("details", "minecraft:white_concrete", [Math.max(0, w - 2), 0, 0], [w - 1, 0, d - 1]),
  );
  return primitives;
}

function buildHeart({ width: w, depth: d, height: h }, { primary, accent }) {
  const midX = (w - 1) / 2;
  const yWide = Math.max(1, Math.round((h - 1) * 0.55));
  const rowStep = Math.max(1, Math.ceil(h / 24));
  const primitives = [];
  for (let y = 0; y < h; y += rowStep) {
    const top = Math.min(h - 1, y + rowStep - 1);
    if (y <= yWide) {
      const half = midX * (y / yWide);
      const x0 = Math.max(0, Math.round(midX - half));
      const x1 = Math.min(w - 1, Math.round(midX + half));
      primitives.push(box(y === 0 ? "foundation" : "shell", primary, [x0, y, 0], [x1, Math.min(top, h - 1), d - 1]));
    } else {
      const inset = Math.min(y - yWide - 1, Math.max(0, Math.floor(midX) - 1));
      const leftEnd = Math.max(inset, Math.floor(midX) - 1);
      const rightStart = Math.min(w - 1 - inset, Math.ceil(midX) + 1);
      primitives.push(
        box("roof", primary, [inset, y, 0], [leftEnd, top, d - 1]),
        box("roof", primary, [rightStart, y, 0], [w - 1 - inset, top, d - 1]),
      );
    }
  }
  primitives.push(box("details", accent, [Math.max(0, Math.floor(midX / 2)), Math.min(h - 1, yWide + 1), 0], [Math.max(0, Math.floor(midX / 2)), Math.min(h - 1, yWide + 1), 0]));
  return primitives;
}

function buildFurniture({ width: w, depth: d, height: h }, { primary, accent }) {
  const seatTop = Math.max(1, Math.round(h * 0.45));
  const midX = Math.floor(w / 2);
  return [
    box("foundation", primary, [0, 0, 0], [w - 1, 0, d - 1]),
    box("shell", primary, [0, 1, 0], [w - 1, seatTop, d - 1]),
    box("roof", primary, [0, seatTop + 1, d - 1], [w - 1, h - 1, d - 1]),
    box("details", accent, [0, Math.min(seatTop + 1, h - 1), 0], [0, Math.min(seatTop + 1, h - 1), d - 1]),
    box("details", accent, [w - 1, Math.min(seatTop + 1, h - 1), 0], [w - 1, Math.min(seatTop + 1, h - 1), d - 1]),
    box("details", accent, [1, seatTop, 1], [Math.max(1, midX - 1), seatTop, Math.max(1, d - 2)]),
    box("details", accent, [Math.min(w - 2, midX + 1), seatTop, 1], [Math.max(1, w - 2), seatTop, Math.max(1, d - 2)]),
    box("details", accent, [1, Math.min(seatTop + 1, h - 1), d - 1], [1, Math.min(seatTop + 1, h - 1), d - 1]),
  ];
}

function buildHouse({ width: w, depth: d, height: h }, { primary, accent, roof }) {
  const midX = Math.floor(w / 2);
  const midZ = Math.floor(d / 2);
  return [
    box("foundation", accent, [0, 0, 0], [w - 1, 0, d - 1]),
    { shape: "hollow_box", phase: "shell", blockId: primary, from: [0, 0, 0], to: [w - 1, h - 2, d - 1] },
    box("roof", roof, [0, h - 1, 0], [w - 1, h - 1, d - 1]),
    box("details", "minecraft:air", [midX, 1, 0], [midX, Math.min(2, h - 2), 0]),
    box("details", "minecraft:glass", [1, 1, 0], [1, Math.min(2, h - 2), 0]),
    box("details", "minecraft:glass", [w - 2, 1, 0], [w - 2, Math.min(2, h - 2), 0]),
    box("details", "minecraft:sea_lantern", [midX, Math.min(1, h - 2), midZ], [midX, Math.min(1, h - 2), midZ]),
    box("details", accent, [0, 1, 0], [0, Math.max(1, h - 2), 0]),
  ];
}

function buildAbstract({ width: w, depth: d, height: h }, { primary, accent }) {
  const bodyTop = Math.max(1, h - 2);
  const inX = Math.min(1, w - 2);
  const inZ = Math.min(1, d - 2);
  const capIn = Math.min(Math.floor(w / 4), Math.floor(d / 4));
  return [
    box("foundation", accent, [0, 0, 0], [w - 1, 0, d - 1]),
    box("shell", primary, [inX, 1, inZ], [w - 1 - inX, bodyTop, d - 1 - inZ]),
    box("roof", primary, [capIn, h - 1, capIn], [w - 1 - capIn, h - 1, d - 1 - capIn]),
    box("details", accent, [0, 1, 0], [0, 1, 0]),
    box("details", accent, [w - 1, 1, 0], [w - 1, 1, 0]),
    box("details", accent, [0, 1, d - 1], [0, 1, d - 1]),
    box("details", accent, [w - 1, 1, d - 1], [w - 1, 1, d - 1]),
    box("details", "minecraft:glowstone", [Math.floor(w / 2), bodyTop, Math.floor(d / 2)], [Math.floor(w / 2), bodyTop, Math.floor(d / 2)]),
  ];
}

const BUILDERS = {
  quadruped: buildQuadruped,
  bird: buildBird,
  fish: buildFish,
  humanoid: buildHumanoid,
  creeper: buildCreeper,
  unicorn: buildUnicorn,
  airplane: buildAirplane,
  coaster: buildCoaster,
  vehicle: buildVehicle,
  boat: buildBoat,
  rocket: buildRocket,
  arch: buildArch,
  heart: buildHeart,
  furniture: buildFurniture,
  house: buildHouse,
  abstract: buildAbstract,
};

function applyRainbowBands(primitives) {
  let index = 0;
  return primitives.map((primitive) => {
    if (primitive.phase !== "shell" || primitive.blockId === "minecraft:air") return primitive;
    const banded = { ...primitive, blockId: RAINBOW_BLOCKS[index % RAINBOW_BLOCKS.length] };
    index += 1;
    return banded;
  });
}

const isSolid = ({ blockId }) => blockId !== "minecraft:air";

function solidBounds(primitives) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { from, to } of primitives.filter(isSolid)) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], from[axis]);
      max[axis] = Math.max(max[axis], to[axis]);
    }
  }
  return { min, max };
}

// Translate solids so min=[0,0,0] and clamp everything inside the solid bbox; the
// returned dimensions equal the bbox extents, so the validator's exact-bounds check
// passes by construction.
function normalizeBounds(primitives) {
  const { min, max } = solidBounds(primitives);
  const extents = max.map((value, axis) => value - min[axis] + 1);
  const clampAxis = (value, axis) => Math.min(extents[axis] - 1, Math.max(0, value - min[axis]));
  const normalized = primitives
    .map((primitive) => ({
      ...primitive,
      from: primitive.from.map(clampAxis),
      to: primitive.to.map(clampAxis),
    }))
    .filter((primitive) => primitive.shape !== "hollow_box"
      || primitive.from.every((value, axis) => primitive.to[axis] - value >= 2));
  return {
    primitives: normalized,
    dimensions: { width: extents[0], height: extents[1], depth: extents[2] },
  };
}

function mergeAdjacent(primitives) {
  const merged = [...primitives];
  let changed = true;
  while (changed && merged.length > 1) {
    changed = false;
    outer: for (let a = 0; a < merged.length; a += 1) {
      for (let b = a + 1; b < merged.length; b += 1) {
        const first = merged[a];
        const second = merged[b];
        if (first.shape !== "box" || second.shape !== "box"
          || first.phase !== second.phase || first.blockId !== second.blockId) continue;
        for (let axis = 0; axis < 3; axis += 1) {
          const others = [0, 1, 2].filter((other) => other !== axis);
          const aligned = others.every((other) => (
            first.from[other] === second.from[other] && first.to[other] === second.to[other]
          ));
          const touching = first.to[axis] + 1 === second.from[axis] || second.to[axis] + 1 === first.from[axis];
          if (aligned && touching) {
            first.from[axis] = Math.min(first.from[axis], second.from[axis]);
            first.to[axis] = Math.max(first.to[axis], second.to[axis]);
            merged.splice(b, 1);
            changed = true;
            break outer;
          }
        }
      }
    }
  }
  return merged;
}

const volumeOf = ({ from, to }) => from.reduce((total, value, axis) => total * (to[axis] - value + 1), 1);

function budget(primitives) {
  let result = primitives;
  if (result.length > STRUCTURE_PRIMITIVE_LIMIT) result = mergeAdjacent(result);
  while (result.length > STRUCTURE_PRIMITIVE_LIMIT - 4) {
    const solidsByPhase = new Map();
    for (const primitive of result.filter(isSolid)) {
      solidsByPhase.set(primitive.phase, (solidsByPhase.get(primitive.phase) || 0) + 1);
    }
    const droppable = result
      .filter((primitive) => !isSolid(primitive) || solidsByPhase.get(primitive.phase) > 1)
      .sort((a, b) => volumeOf(a) - volumeOf(b))[0];
    if (!droppable) break;
    result = result.filter((primitive) => primitive !== droppable);
  }
  return result;
}

function ensurePhases(primitives, dimensions, accent) {
  const present = new Set(primitives.filter(isSolid).map(({ phase }) => phase));
  const spots = {
    foundation: [0, 0, 0],
    shell: [Math.floor(dimensions.width / 2), Math.floor((dimensions.height - 1) / 2), Math.floor(dimensions.depth / 2)],
    roof: [Math.floor(dimensions.width / 2), dimensions.height - 1, Math.floor(dimensions.depth / 2)],
    details: [0, 0, dimensions.depth - 1],
  };
  const additions = STRUCTURE_PHASES
    .filter((phase) => !present.has(phase))
    .map((phase) => box(phase, accent, [...spots[phase]], [...spots[phase]]));
  return [...primitives, ...additions];
}

function padToFloor(primitives, dimensions, accent) {
  const result = [...primitives];
  let index = 0;
  while (result.length < 8 && index < dimensions.width * dimensions.depth) {
    const x = index % dimensions.width;
    const z = Math.floor(index / dimensions.width) % dimensions.depth;
    result.push(box("details", accent, [x, 0, z], [x, 0, z]));
    index += 1;
  }
  return result;
}

function placeEntities(entities, dimensions) {
  const clamp = (value, limit) => Math.min(limit - 1, Math.max(0, Math.round(Number(value) || 0)));
  return entities.slice(0, 8).map(({ typeId, location }, index) => ({
    typeId,
    location: location
      ? [clamp(location[0], dimensions.width), clamp(location[1], dimensions.height), clamp(location[2], dimensions.depth)]
      : [clamp(1 + index * 2, dimensions.width), 0, clamp(1, dimensions.depth)],
  }));
}

export function composeStructurePlan(descriptor) {
  const builder = BUILDERS[descriptor.template] || BUILDERS.abstract;
  let primitives = builder(descriptor.dimensions, descriptor.palette, descriptor.rainbow);
  if (descriptor.rainbow && descriptor.template !== "arch") primitives = applyRainbowBands(primitives);
  primitives = budget(primitives);
  const normalized = normalizeBounds(primitives);
  primitives = ensurePhases(normalized.primitives, normalized.dimensions, descriptor.palette.accent);
  primitives = padToFloor(primitives, normalized.dimensions, descriptor.palette.accent);
  primitives.sort((a, b) => PHASE_INDEX[a.phase] - PHASE_INDEX[b.phase]);
  const title = `Blocky ${descriptor.kind}`.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 32).trim();
  const plan = {
    title,
    kind: descriptor.kind,
    dimensions: {
      width: normalized.dimensions.width,
      depth: normalized.dimensions.depth,
      height: normalized.dimensions.height,
    },
    materials: {
      primary: descriptor.palette.primary,
      accent: descriptor.palette.accent,
      roof: descriptor.palette.roof,
    },
    features: descriptor.features.length ? descriptor.features : ["decorations"],
    phases: [...STRUCTURE_PHASES],
    primitives,
  };
  if (descriptor.entities.length) plan.entities = placeEntities(descriptor.entities, normalized.dimensions);
  return plan;
}

export function describeProceduralBuild(descriptor) {
  const spec = TEMPLATES[descriptor.template] || TEMPLATES.abstract;
  const { width, depth, height } = descriptor.dimensions;
  const sizeNote = descriptor.size === "medium" ? "" : ` ${descriptor.size}`;
  return `I don't keep an exact blueprint for a ${descriptor.kind}, so I sculpted my best${sizeNote} blocky ${descriptor.kind} `
    + `about ${width} by ${depth} blocks and ${height} tall, with ${spec.parts}. `
    + "Take a look and give it a grade so I can learn how you like it, or tell me what to change.";
}
