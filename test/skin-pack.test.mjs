import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";

const packRoot = new URL("../bedrock/skin_packs/mc_wizard/", import.meta.url);
const resourceRoot = new URL("../bedrock/resource_packs/mc_wizard/", import.meta.url);
let manifest;
let skins;
let localization;
let texture;
let resourceManifest;
let resourceTexture;
let playerEntity;
let playerRenderController;

before(async () => {
  const [
    manifestText,
    skinsText,
    localizationText,
    textureBytes,
    resourceManifestText,
    resourceTextureBytes,
    playerEntityText,
    playerRenderControllerText,
  ] = await Promise.all([
    readFile(new URL("manifest.json", packRoot), "utf8"),
    readFile(new URL("skins.json", packRoot), "utf8"),
    readFile(new URL("texts/en_US.lang", packRoot), "utf8"),
    readFile(new URL("mc_wizard.png", packRoot)),
    readFile(new URL("manifest.json", resourceRoot), "utf8"),
    readFile(new URL("textures/entity/mc_wizard.png", resourceRoot)),
    readFile(new URL("entity/player.entity.json", resourceRoot), "utf8"),
    readFile(new URL("render_controllers/mc_wizard.player.render_controllers.json", resourceRoot), "utf8"),
  ]);
  manifest = JSON.parse(manifestText);
  skins = JSON.parse(skinsText);
  localization = localizationText;
  texture = textureBytes;
  resourceManifest = JSON.parse(resourceManifestText);
  resourceTexture = resourceTextureBytes;
  playerEntity = JSON.parse(playerEntityText);
  playerRenderController = JSON.parse(playerRenderControllerText);
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

test("ships the same original skin through the required world resource pack", () => {
  assert.equal(resourceManifest.header.name, "MC Wizard Appearance");
  assert.deepEqual(resourceManifest.header.version, [0, 4, 0]);
  assert.deepEqual(resourceTexture, texture);
});

test("renders only the MC Wizard name with the original texture", () => {
  const description = playerEntity["minecraft:client_entity"].description;
  assert.equal(description.identifier, "minecraft:player");
  assert.equal(description.textures.default, "textures/entity/steve");
  assert.equal(description.textures.wizard, "textures/entity/mc_wizard");

  const condition = (id) => description.render_controllers.find((entry) => entry[id])?.[id];
  assert.match(condition("controller.render.player.third_person"), /!query\.is_name_any\('MC Wizard'\)/);
  assert.match(condition("controller.render.mcwizard.third_person"), /query\.is_name_any\('MC Wizard'\)/);
  assert.equal(
    playerRenderController.render_controllers["controller.render.mcwizard.third_person"].textures[0],
    "Texture.wizard",
  );
});
