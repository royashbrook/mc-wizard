import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const resourceTextures = path.join(ROOT, "bedrock", "resource_packs", "mc_wizard", "textures");
const skinPack = path.join(ROOT, "bedrock", "skin_packs", "mc_wizard");
const docsAssets = path.join(ROOT, "docs", "assets");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}

function png(width, height, pixel) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      row.set(pixel(x, y), 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const transparent = [0, 0, 0, 0];
const navy = [20, 22, 58, 255];
const indigo = [44, 34, 104, 255];
const purple = [76, 48, 136, 255];
const purpleLight = [110, 72, 166, 255];
const teal = [31, 166, 170, 255];
const tealLight = [68, 214, 207, 255];
const gold = [230, 176, 58, 255];
const goldLight = [255, 220, 102, 255];
const silver = [207, 215, 224, 255];
const silverShadow = [129, 143, 164, 255];
const skin = [186, 132, 95, 255];
const skinShadow = [138, 88, 68, 255];
const cyan = [75, 226, 245, 255];

const legacyPurple = [72, 30, 116, 255];
const legacyPurpleLight = [124, 70, 170, 255];
const legacyGold = [245, 192, 61, 255];
const oldStars = (x, y) => ((x * 13 + y * 7) % 47 < 2
  ? legacyGold
  : ((x + y) % 9 < 3 ? legacyPurpleLight : legacyPurple));

function makeCanvas(width, height, background = transparent) {
  const pixels = Array.from({ length: width * height }, () => [...background]);
  const set = (x, y, color) => {
    if (x >= 0 && x < width && y >= 0 && y < height) pixels[y * width + x] = [...color];
  };
  const fill = (x, y, w, h, color) => {
    for (let py = y; py < y + h; py += 1) {
      for (let px = x; px < x + w; px += 1) set(px, py, color);
    }
  };
  return { width, height, pixels, set, fill, pixel: (x, y) => pixels[y * width + x] };
}

function buildWizardSkin() {
  const c = makeCanvas(64, 64);

  // Head base: a warm face framed by an indigo cloth hood.
  c.fill(8, 0, 8, 8, indigo);
  c.fill(16, 0, 8, 8, navy);
  c.fill(0, 8, 8, 8, indigo);
  c.fill(8, 8, 8, 8, skin);
  c.fill(16, 8, 8, 8, indigo);
  c.fill(24, 8, 8, 8, navy);
  c.fill(8, 8, 8, 2, indigo);
  c.set(9, 10, cyan);
  c.set(14, 10, cyan);
  c.set(9, 11, navy);
  c.set(14, 11, navy);
  c.set(11, 12, skinShadow);
  c.set(12, 12, skinShadow);
  c.fill(8, 13, 8, 3, silver);
  c.set(8, 13, silverShadow);
  c.set(15, 13, silverShadow);
  c.set(10, 15, silverShadow);
  c.set(13, 15, silverShadow);

  // Hood overlay: a readable silhouette without a janky fake 3-D hat.
  c.fill(40, 0, 8, 8, navy);
  c.fill(48, 0, 8, 8, navy);
  c.fill(32, 8, 8, 8, navy);
  c.fill(48, 8, 8, 8, navy);
  c.fill(56, 8, 8, 8, navy);
  c.fill(40, 8, 8, 1, purple);
  c.fill(40, 9, 1, 7, purple);
  c.fill(47, 9, 1, 7, purple);
  c.set(42, 8, gold);
  c.set(45, 8, goldLight);
  c.set(34, 11, gold);
  c.set(52, 13, tealLight);
  c.set(60, 10, gold);

  // Torso and cloak.
  c.fill(20, 16, 8, 4, purple);
  c.fill(28, 16, 8, 4, navy);
  c.fill(16, 20, 4, 12, indigo);
  c.fill(20, 20, 8, 12, purple);
  c.fill(28, 20, 4, 12, indigo);
  c.fill(32, 20, 8, 12, navy);
  c.fill(20, 20, 1, 12, gold);
  c.fill(27, 20, 1, 12, gold);
  c.fill(21, 26, 6, 2, teal);
  c.set(23, 22, goldLight);
  c.set(24, 21, gold);
  c.set(24, 23, gold);
  c.set(25, 24, tealLight);
  c.set(35, 22, goldLight);
  c.set(34, 23, gold);
  c.set(36, 24, tealLight);
  c.set(37, 27, gold);
  c.fill(20, 36, 8, 12, transparent);
  c.set(22, 38, gold);
  c.set(25, 40, tealLight);
  c.set(23, 42, goldLight);
  c.set(26, 45, gold);

  // Right arm, with gold cuff and a tiny teal stitch.
  c.fill(44, 16, 4, 4, purple);
  c.fill(48, 16, 4, 4, navy);
  c.fill(40, 20, 4, 12, indigo);
  c.fill(44, 20, 4, 12, purple);
  c.fill(48, 20, 4, 12, indigo);
  c.fill(52, 20, 4, 12, navy);
  c.fill(40, 29, 16, 2, gold);
  c.set(45, 24, tealLight);

  // Right leg: long robe panel with an asymmetric constellation hem.
  c.fill(4, 16, 4, 4, purple);
  c.fill(8, 16, 4, 4, navy);
  c.fill(0, 20, 4, 12, indigo);
  c.fill(4, 20, 4, 12, purple);
  c.fill(8, 20, 4, 12, indigo);
  c.fill(12, 20, 4, 12, navy);
  c.fill(0, 29, 16, 2, teal);
  c.fill(0, 31, 16, 1, gold);
  c.set(6, 23, gold);
  c.set(5, 24, goldLight);

  // Left leg.
  c.fill(20, 48, 4, 4, purple);
  c.fill(24, 48, 4, 4, navy);
  c.fill(16, 52, 4, 12, indigo);
  c.fill(20, 52, 4, 12, purple);
  c.fill(24, 52, 4, 12, indigo);
  c.fill(28, 52, 4, 12, navy);
  c.fill(16, 61, 16, 2, teal);
  c.fill(16, 63, 16, 1, gold);
  c.set(21, 56, tealLight);
  c.set(22, 55, gold);

  // Left arm.
  c.fill(36, 48, 4, 4, purple);
  c.fill(40, 48, 4, 4, navy);
  c.fill(32, 52, 4, 12, indigo);
  c.fill(36, 52, 4, 12, purple);
  c.fill(40, 52, 4, 12, indigo);
  c.fill(44, 52, 4, 12, navy);
  c.fill(32, 61, 16, 2, gold);
  c.set(37, 55, tealLight);

  return c;
}

function buildPreview(skinCanvas) {
  const preview = makeCanvas(256, 256, [13, 15, 31, 255]);
  const scale = 6;
  const drawTexture = (sx, sy, w, h, dx, dy) => {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const color = skinCanvas.pixel(sx + x, sy + y);
        if (color[3] === 0) continue;
        preview.fill(dx + x * scale, dy + y * scale, scale, scale, color);
      }
    }
  };
  const x = 68;
  const y = 24;
  drawTexture(8, 8, 8, 8, x + 24, y);
  drawTexture(40, 8, 8, 8, x + 24, y);
  drawTexture(20, 20, 8, 12, x + 24, y + 48);
  drawTexture(20, 36, 8, 12, x + 24, y + 48);
  drawTexture(44, 20, 4, 12, x, y + 48);
  drawTexture(36, 52, 4, 12, x + 72, y + 48);
  drawTexture(4, 20, 4, 12, x + 24, y + 120);
  drawTexture(20, 52, 4, 12, x + 48, y + 120);
  return preview;
}

const wizardSkin = buildWizardSkin();
const preview = buildPreview(wizardSkin);

await mkdir(path.join(resourceTextures, "entity"), { recursive: true });
await mkdir(path.join(resourceTextures, "items"), { recursive: true });
await mkdir(skinPack, { recursive: true });
await mkdir(docsAssets, { recursive: true });

await writeFile(path.join(resourceTextures, "entity", "wizard_hat.png"), png(64, 64, oldStars));
await writeFile(path.join(resourceTextures, "entity", "wizard_robe.png"), png(64, 64, oldStars));
await writeFile(path.join(resourceTextures, "entity", "mc_wizard.png"), png(64, 64, wizardSkin.pixel));
await writeFile(path.join(resourceTextures, "items", "wizard_hat.png"), png(16, 16, (x, y) => (
  y > 12 || (y > 3 && x > 4 - Math.floor(y / 4) && x < 11 + Math.floor(y / 4)) ? oldStars(x, y) : transparent
)));
await writeFile(path.join(resourceTextures, "items", "wizard_robe.png"), png(16, 16, (x, y) => (
  y > 2 && y < 15 && x > (y < 7 ? 3 : 1) && x < (y < 7 ? 12 : 14) ? oldStars(x, y) : transparent
)));
await writeFile(path.join(skinPack, "mc_wizard.png"), png(64, 64, wizardSkin.pixel));
await writeFile(path.join(skinPack, "pack_icon.png"), png(256, 256, preview.pixel));
await writeFile(path.join(docsAssets, "mc-wizard-skin-preview.png"), png(256, 256, preview.pixel));

console.log(`Generated Wizard textures, original player skin, and preview under ${ROOT}`);
