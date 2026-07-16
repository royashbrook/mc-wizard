import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_RUNTIME_SETTINGS = Object.freeze({
  aiEnabled: true,
  wizardPromptAddendum: "",
  generalPromptAddendum: "",
  wizardMaxOutputTokens: null,
  generalMaxOutputTokens: null,
});

export function validateRuntimeSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settings must be a JSON object");
  }
  const settings = { ...DEFAULT_RUNTIME_SETTINGS };
  if (typeof value.aiEnabled !== "boolean") throw new Error("aiEnabled must be true or false");
  settings.aiEnabled = value.aiEnabled;
  for (const key of ["wizardPromptAddendum", "generalPromptAddendum"]) {
    if (typeof value[key] !== "string" || value[key].length > 8_000) {
      throw new Error(`${key} must be at most 8,000 characters`);
    }
    settings[key] = value[key].trim();
  }
  for (const key of ["wizardMaxOutputTokens", "generalMaxOutputTokens"]) {
    if (value[key] === null || value[key] === "") continue;
    const number = Number(value[key]);
    if (!Number.isInteger(number) || number < 64 || number > 3_000) {
      throw new Error(`${key} must be blank or an integer from 64 to 3,000`);
    }
    settings[key] = number;
  }
  return settings;
}

export async function readRuntimeSettings(filePath, logger = console) {
  try {
    return validateRuntimeSettings(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") logger.warn(`[settings] ${error.message}; using defaults`);
    return { ...DEFAULT_RUNTIME_SETTINGS };
  }
}

export async function writeRuntimeSettings(filePath, value) {
  const settings = validateRuntimeSettings(value);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
  return settings;
}
