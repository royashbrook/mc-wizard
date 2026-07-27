import { test } from "node:test";
import assert from "node:assert/strict";

import {
  containerListHasRunning,
  diagnoseStartupFailure,
  startupHealthy,
} from "../scripts/supervisor.mjs";
import { diagnoseAdminFailure } from "../scripts/admin-service.mjs";

const RUNNING_LIST = [
  "ID                 IMAGE                       OS     ARCH   STATE    IP                 CPUS  MEMORY   STARTED",
  "mc-wizard-bedrock  docker.io/itzg/minecraft    linux  amd64  running  192.168.64.169/24  4     6144 MB  2026-07-19T23:39:23Z",
].join("\n");

const HEADER_ONLY = "ID                 IMAGE  OS  ARCH  STATE  IP  CPUS  MEMORY  STARTED";

test("reports a running container as running (booting containers appear here)", () => {
  assert.equal(containerListHasRunning(RUNNING_LIST, "mc-wizard-bedrock"), true);
});

test("reports absent when only the header row is present (container stopped)", () => {
  // Regression for issue #38: an exited/absent container is missing from
  // `container list`, which is the only condition that should trigger recreate.
  assert.equal(containerListHasRunning(HEADER_ONLY, "mc-wizard-bedrock"), false);
  assert.equal(containerListHasRunning("", "mc-wizard-bedrock"), false);
});

test("the header row alone never counts as our container running", () => {
  const differentContainerOnly = [
    "ID                 IMAGE  OS  ARCH  STATE  IP  CPUS  MEMORY  STARTED",
    "some-other-box     img    linux  amd64  running  10.0.0.9  2  1024 MB  now",
  ].join("\n");
  assert.equal(containerListHasRunning(differentContainerOnly, "mc-wizard-bedrock"), false);
});

test("requires an exact first-column match, not a substring", () => {
  const other = [
    "ID                 IMAGE  OS  ARCH  STATE  IP  CPUS  MEMORY  STARTED",
    "mc-wizard-bedrock-e2e  img  linux  amd64  running  10.0.0.2  4  6144 MB  now",
  ].join("\n");
  assert.equal(containerListHasRunning(other, "mc-wizard-bedrock"), false);
});

test("startup is healthy only when every required service is healthy", () => {
  const base = {
    supervisor: true,
    bedrock: true,
    brain: true,
    admin: true,
    provider: false,
    providerRequired: false,
  };
  assert.equal(startupHealthy(base), true);
  assert.equal(startupHealthy({ ...base, brain: false }), false);
  assert.equal(startupHealthy({ ...base, providerRequired: true }), false);
  assert.equal(startupHealthy({ ...base, providerRequired: true, provider: true }), true);
});

test("startup failures explain macOS permission denials instead of reporting a healthy pid", () => {
  const unhealthy = {
    supervisor: true,
    bedrock: true,
    brain: false,
    admin: false,
    provider: false,
    providerRequired: true,
  };
  assert.match(
    diagnoseStartupFailure(unhealthy, "Error: listen EPERM: operation not permitted 127.0.0.1:8790"),
    /Local Network.*EPERM/i,
  );
  assert.match(
    diagnoseStartupFailure(unhealthy, "EPERM: operation not permitted, open 'runtime/brain/interactions.jsonl'"),
    /runtime files.*EPERM/i,
  );
  assert.match(diagnoseStartupFailure(unhealthy), /brain, admin, provider/);
  assert.match(
    diagnoseAdminFailure("Error: listen EPERM: operation not permitted 127.0.0.1:3001"),
    /Local Network.*EPERM/i,
  );
  assert.match(
    diagnoseAdminFailure("EPERM: operation not permitted, open 'runtime/brain/interactions.jsonl'"),
    /runtime files.*EPERM/i,
  );
});
