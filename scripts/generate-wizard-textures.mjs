import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = path.join(ROOT, "bedrock", "resource_packs", "mc_wizard", "textures");

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
      const color = pixel(x, y);
      row.set(color, 1 + x * 4);
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

const purple = [72, 30, 116, 255];
const lightPurple = [124, 70, 170, 255];
const gold = [245, 192, 61, 255];
const stars = (x, y) => ((x * 13 + y * 7) % 47 < 2 ? gold : ((x + y) % 9 < 3 ? lightPurple : purple));

await mkdir(path.join(target, "entity"), { recursive: true });
await mkdir(path.join(target, "items"), { recursive: true });
await writeFile(path.join(target, "entity", "wizard_hat.png"), png(64, 64, stars));
await writeFile(path.join(target, "entity", "wizard_robe.png"), png(64, 64, stars));
await writeFile(path.join(target, "items", "wizard_hat.png"), png(16, 16, (x, y) => (
  y > 12 || (y > 3 && x > 4 - Math.floor(y / 4) && x < 11 + Math.floor(y / 4)) ? stars(x, y) : [0, 0, 0, 0]
)));
await writeFile(path.join(target, "items", "wizard_robe.png"), png(16, 16, (x, y) => (
  y > 2 && y < 15 && x > (y < 7 ? 3 : 1) && x < (y < 7 ? 12 : 14) ? stars(x, y) : [0, 0, 0, 0]
)));

console.log(`Generated wizard textures in ${target}`);
