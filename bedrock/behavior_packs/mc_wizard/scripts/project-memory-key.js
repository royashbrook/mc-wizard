export function legacyPropertySuffix(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function stablePropertySuffix(value) {
  let first = 2166136261;
  let second = 2246822507;
  let third = 3266489909;
  let index = 0;
  for (const character of value) {
    const code = character.charCodeAt(0);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ (code + index), 1597334677);
    third = Math.imul(third ^ (code + Math.imul(index + 1, 97)), 668265263);
    index += 1;
  }
  return `${index.toString(36)}-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}-${(third >>> 0).toString(36)}`;
}
