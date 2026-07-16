export const CAPABILITY_PROGRAM_LIMITS = Object.freeze({
  steps: 48,
  argumentBytes: 8_000,
  totalBytes: 64_000,
});

const STEP_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const CAPABILITY = /^(?:artifact|control|knowledge|observe|player|script|server|verify|world)(?:\.[a-z][a-z0-9_-]*){1,3}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function cleanText(value, name, maxLength) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || clean.length > maxLength) throw new Error(`${name} must contain 1-${maxLength} characters`);
  return clean;
}

function cleanJson(value, name, depth = 0) {
  if (depth > 6) throw new Error(`${name} is nested too deeply`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${name} contains a non-finite number`);
    return value;
  }
  if (typeof value === "string") return cleanText(value, name, 2_000);
  if (Array.isArray(value)) {
    if (value.length > 512) throw new Error(`${name} contains too many values`);
    return value.map((entry, index) => cleanJson(entry, `${name}[${index}]`, depth + 1));
  }
  if (!value || typeof value !== "object") throw new Error(`${name} must contain JSON values only`);
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error(`${name} contains too many fields`);
  const clean = {};
  for (const [key, entry] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(key) || FORBIDDEN_KEYS.has(key)) {
      throw new Error(`${name} contains an unsafe field`);
    }
    clean[key] = cleanJson(entry, `${name}.${key}`, depth + 1);
  }
  return clean;
}

export function validateCapabilityProgram(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("program must be an object");
  if (Object.keys(value).some((key) => !["title", "site", "targetKind", "steps"].includes(key))) {
    throw new Error("program has an unsupported field");
  }
  const title = cleanText(value.title, "program.title", 80);
  const site = value.site === undefined ? undefined : cleanText(value.site, "program.site", 32);
  if (site && !["nearby", "active_project"].includes(site)) throw new Error("program.site is invalid");
  const targetKind = value.targetKind === undefined
    ? undefined : cleanText(value.targetKind, "program.targetKind", 80).toLowerCase();
  if (targetKind && site !== "active_project") throw new Error("program.targetKind requires active_project");
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > CAPABILITY_PROGRAM_LIMITS.steps) {
    throw new Error(`program.steps must contain 1-${CAPABILITY_PROGRAM_LIMITS.steps} steps`);
  }
  const ids = new Set();
  const steps = value.steps.map((step, index) => {
    const name = `program.steps[${index}]`;
    if (!step || typeof step !== "object" || Array.isArray(step)
      || Object.keys(step).some((key) => !["id", "capability", "arguments", "expect", "onFailure"].includes(key))) {
      throw new Error(`${name} has unsupported fields`);
    }
    if (!STEP_ID.test(step.id || "") || ids.has(step.id)) throw new Error(`${name}.id must be unique and safe`);
    if (!CAPABILITY.test(step.capability || "")) throw new Error(`${name}.capability is invalid`);
    ids.add(step.id);
    const args = cleanJson(step.arguments, `${name}.arguments`);
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error(`${name}.arguments must be an object`);
    }
    if (JSON.stringify(args).length > CAPABILITY_PROGRAM_LIMITS.argumentBytes) {
      throw new Error(`${name}.arguments is too large`);
    }
    const expect = cleanText(step.expect, `${name}.expect`, 500);
    const onFailure = step.onFailure === "continue" ? "continue" : "replan";
    return { id: step.id, capability: step.capability, arguments: args, expect, onFailure };
  });
  const program = { title, ...(site && { site }), ...(targetKind && { targetKind }), steps };
  if (JSON.stringify(program).length > CAPABILITY_PROGRAM_LIMITS.totalBytes) throw new Error("program is too large");
  return program;
}

export function capabilityProgramRequiredAuthority(program) {
  return program.steps.some(({ capability }) => capability.startsWith("server."))
    ? "owner"
    : program.steps.some(({ capability }) => capability === "world.admin" || capability.startsWith("world.admin."))
      ? "operator"
      : "player";
}

export function capabilityProgramPrompt() {
  return `For a novel or multi-step in-world goal, use execute_program with program={"title":"short plan name","site":"nearby|active_project","steps":[{"id":"unique_step","capability":"registered.capability","arguments":{},"expect":"observable result","onFailure":"replan"}]}. `
    + `Programs may contain 1-${CAPABILITY_PROGRAM_LIMITS.steps} ordered steps. Capability arguments are bounded JSON. Use only capabilities from the runtime manifest. `
    + `Use site="active_project" for every requested revision, decoration, addition, or repair so relative vectors modify the existing project instead of creating another one; trusted server code binds a named targetKind when the child names an older project. `
    + `A failed expectation is an observation: research or revise the remaining program and keep pursuing the active goal instead of abandoning it.`;
}
