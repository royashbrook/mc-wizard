export const TERRAIN_WORK_LIMITS = Object.freeze({
  width: 64,
  depth: 64,
  height: 32,
  fillDepth: 4,
});

const TREE_OR_FOLIAGE = /(?:^|_)(?:air|leaves|log|wood|stem|hyphae|vine|roots|grass|fern|flower|sapling|snow_layer)$/;

const boundedInteger = (value, name, min, max) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min}-${max}`);
  }
  return number;
};

export function validateTerrainWorkAction(value) {
  if (!value || value.type !== "terrain_work" || value.version !== 1) {
    throw new Error("terrain work must be a version 1 terrain_work action");
  }
  const mode = ["clear", "level"].includes(value.mode) ? value.mode : undefined;
  if (!mode) throw new Error("terrain mode must be clear or level");
  const keys = ["type", "version", "mode", "width", "depth", "height", "fillDepth"];
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error("terrain work contains an unsupported field");
  }
  const width = boundedInteger(value.width, "width", 1, TERRAIN_WORK_LIMITS.width);
  const depth = boundedInteger(value.depth, "depth", 1, TERRAIN_WORK_LIMITS.depth);
  const height = boundedInteger(value.height, "height", 1, TERRAIN_WORK_LIMITS.height);
  const fillDepth = mode === "level"
    ? boundedInteger(value.fillDepth ?? TERRAIN_WORK_LIMITS.fillDepth, "fillDepth", 1, TERRAIN_WORK_LIMITS.fillDepth)
    : 0;
  return { type: "terrain_work", version: 1, mode, width, depth, height, fillDepth };
}

export function findTerrainAnchor(dimension, location) {
  const range = dimension?.heightRange || { min: -64, max: 320 };
  const x = Math.floor(Number(location?.x));
  const z = Math.floor(Number(location?.z));
  const startY = Math.min(range.max - 1, Math.floor(Number(location?.y)));
  if (![x, z, startY].every(Number.isFinite)) throw new Error("terrain anchor location is invalid");
  for (let y = startY; y >= range.min; y -= 1) {
    const block = dimension.getBlock({ x, y, z });
    if (!block) continue;
    const shortId = String(block.typeId || "").replace(/^minecraft:/, "");
    if (TREE_OR_FOLIAGE.test(shortId)) continue;
    if (block.isSolid !== false) return { x, y, z, typeId: block.typeId };
  }
  throw new Error("could not find solid ground below the requester");
}

export function terrainWorkBounds(anchor, action) {
  const checked = validateTerrainWorkAction(action);
  const minX = anchor.x - Math.floor((checked.width - 1) / 2);
  const minZ = anchor.z - Math.floor((checked.depth - 1) / 2);
  const maxX = minX + checked.width - 1;
  const maxZ = minZ + checked.depth - 1;
  return {
    clear: {
      from: { x: minX, y: anchor.y + 1, z: minZ },
      to: { x: maxX, y: anchor.y + checked.height, z: maxZ },
    },
    snapshot: {
      from: {
        x: minX,
        y: checked.mode === "level" ? anchor.y - checked.fillDepth + 1 : anchor.y + 1,
        z: minZ,
      },
      to: { x: maxX, y: anchor.y + checked.height, z: maxZ },
    },
    ...(checked.mode === "level" && {
      level: {
        from: { x: minX, y: anchor.y - checked.fillDepth + 1, z: minZ },
        to: { x: maxX, y: anchor.y, z: maxZ },
      },
    }),
  };
}
