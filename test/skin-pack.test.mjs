import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";

const packRoot = new URL("../bedrock/skin_packs/mc_wizard/", import.meta.url);
let manifest;
let skins;
let localization;
let texture;

before(async () => {
  const [manifestText, skinsText, localizationText, textureBytes] = await Promise.all([
    readFile(new URL("manifest.json", packRoot), "utf8"),
    readFile(new URL("skins.json", packRoot), "utf8"),
    readFile(new URL("texts/en_US.lang", packRoot), "utf8"),
    readFile(new URL("mc_wizard.png", packRoot)),
  ]);
  manifest = JSON.parse(manifestText);
  skins = JSON.parse(skinsText);
  localization = localizationText;
  texture = textureBytes;
});

test("declares a Bedrock skin-pack module", () => {
  assert.ok(manifest.modules.some((module) => module.type === "skin_pack"));
});

test("registers the classic MC Wizard skin and its localization", () => {
  const skin = skins.skins.find((candidate) => candidate.texture === "mc_wizard.png");
  assert.equal(skin?.geometry, "geometry.humanoid.custom");
  assert.match(localization, new RegExp(`^skinpack\\.${skins.serialize_name}=.+$`, "m"));
  assert.match(localization, new RegExp(`^skin\\.${skins.serialize_name}\\.${skin.localization_name}=.+$`, "m"));
});

test("ships a 64x64 8-bit RGBA PNG", () => {
  assert.deepEqual(texture.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(texture.readUInt32BE(8), 13);
  assert.equal(texture.toString("ascii", 12, 16), "IHDR");
  assert.equal(texture.readUInt32BE(16), 64);
  assert.equal(texture.readUInt32BE(20), 64);
  assert.deepEqual([...texture.subarray(24, 29)], [8, 6, 0, 0, 0]);
});
