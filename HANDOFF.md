# MC Wizard handoff

Written 2026-07-27 for an incoming assistant picking this up mid-flight.

Repo: `royashbrook/mc-wizard` (PRIVATE). Branch `main` at `2288e5f`. Suite: **788 tests, 788 passing**, runs fully offline with no container and no network. Working tree clean.

---

## 1. What this is and what we are actually trying to do

A Minecraft Bedrock "Wizard" that children talk to in chat. A child types something, a Node brain decides what to do, and a behavior pack makes a visible `SimulatedPlayer` actually do it in world.

Pipeline:

```
child chat in Bedrock
  -> behavior pack (bedrock/behavior_packs/mc_wizard/scripts/main.js) POSTs /v1/ask
  -> Node brain (src/server.mjs -> src/wizard.mjs)
  -> optional model call via a local CLI bridge (scripts/local-ai-bridge.mjs -> codex)
  -> a typed, validated action returned to the pack
  -> pack executes it, posts /v1/action-result with a fresh world snapshot
```

**The north star, in the owner's words:** a child should be able to ask for absolutely anything and get a favorable result. Two rules he has stated explicitly and repeatedly:

> "never give up and never do nothing"

> "if I asked any frontier model what to do to accomplish X, it would tell me the steps. Why can't our agent figure out the steps and execute the moves?"

The measurable symptom that started this work: quality was bimodal. Preprogrammed capabilities graded 5/5, anything unprogrammed graded 1/5.

---

## 2. THE most important thing to understand

Read this section before touching anything. Nearly every failure found in the last two days had the same shape, and it is not what it looks like at first.

**The model is doing its job. We keep discarding its correct work over trivia, then a local fallback substitutes something worse and says something false about it.**

Concrete, verified examples from real child sessions:

| Child asked | What the model produced | Why it was thrown away | What the child got |
|---|---|---|---|
| enchanted diamond pickaxe | correct `give_items` with `efficiency` | validator demanded `minecraft:efficiency`; the missing prefix discarded the WHOLE action | plain pickaxe, plus "enchanting is beyond my wand" which is FALSE |
| set of enchanted netherite armor | four correct pieces | intent gate required EVERY word of `netherite_helmet` to appear in the question, and no child says "helmet" | "armor is not in my spellbook" |
| clear a 50x50 area | nothing; planner declined | no refusal detection existed at all | a flat "I can't", no attempt |
| wizard tower 100 tall, "wizardy" | a real tower | height 100 > 64 limit rejected the whole plan | generic 9x9x16 box, all style stripped |

So when you see a bad result, the first question is **not** "how do we make the model smarter" or "what capability is missing". It is:

1. Did the model actually produce something good? (check `runtime/brain/interactions.jsonl` for `rejections` and gate names)
2. Which gate discarded it, and was that gate defending anything real?
3. Did a fallback then say something untrue about our own capabilities?

There is telemetry for exactly this. Every rejection records a gate name and reason.

**Corollary the owner articulated and I agree with:** limits like 128x128x64 bound ONE undoable placement. They are execution and rollback constraints. They are NOT statements about what a child may ask for. We have been leaking execution limits up into the planning layer, which forces the model to either refuse or produce something we then reject. This is the root cause of issue #46 and is the single most valuable thing left to fix.

---

## 3. Architecture as it stands

### Role modules (`src/roles/`, all new, dependency injected, none import `src/wizard.mjs`)

| File | Job |
|---|---|
| `orchestrator.mjs` | drives one turn through the state machine |
| `intent.mjs` | classifies the turn, computes `actionableIntent` and the model-consultation cost gate |
| `critic.mjs` | tiered pre-execution checks (deterministic first) |
| `escalation.mjs` | the ordered ladder that guarantees a non-empty turn |
| `turn-state.mjs` | owns the mutable turn state that used to be seven loose closure variables |
| `terrain.mjs` | clear / level / dig detector and fill-with-air planner |
| `gift.mjs`, `travel.mjs`, `effect.mjs`, `admin.mjs` | the four non-build intent detectors |

### The escalation ladder (this is the never-empty guarantee)

`CLASSIFY -> PROVISIONAL_RECIPE -> LOCAL_STRUCTURE -> TERRAIN -> (gift/travel/effect/admin rungs) -> PLANNER -> PLANNING_DEFERRED -> BOUND_OFFER`

The last rung is a bound offer naming ONE concrete step, phrased so a following bare "yes" binds and executes.

### Things that will bite you

- `src/wizard.mjs` is about 5300 lines and the turn body is long. It is being extracted into roles incrementally, not rewritten. Do not attempt a rewrite.
- The behavior pack (`main.js`, 6600 lines) owns roughly half the orchestration: review, replan, retry dispatch. A brain-side change that alters which of those the pack receives can desync the two.
- `bedrock/behavior_packs/**/scripts/*.js` must stay plain ES modules loadable in the Bedrock scripting runtime. **No Node APIs in those files.** They are imported by both the pack and the Node brain.
- Dependency-free by policy. Only runtime dep is `mtok-bridge`. Do not add packages.

---

## 4. Safety boundaries that must NOT be weakened

These are enumerated with file and line in the survey artifact (see section 8). The short list:

- `allowedWizardAction` (`src/skills.mjs`) is the single action allowlist.
- `command_block`, `structure_block`, `mob_spawner`, `barrier`, `tnt` are always rejected by name.
- The research restriction banning `world.command` / `server.*` in research-derived plans, including its verbatim message.
- Subject fidelity: a request for a dragon must never become a house.
- `unsafeCommandAnswer`: model prose never leaks slash commands to a child.
- Privacy: player names are HMAC pseudonymized, telemetry is stripped from client responses and kept only in the local interaction log.
- Teleport consent and the opted-out-player guard in the pack.
- Per-action geometry caps. **`test/arbitrary-structure.test.mjs` "rejects an oversized provider plan outright" exists specifically to catch a softened bounds check.** I tried to soften it and backed out. Do not weaken it; chunk before the validator instead.

A useful distinction learned the hard way: widening DETECTION (recognizing more of what a child means) is good and safe. Widening AUTHORITY (what the system is permitted to do) is not. Every detector added routes through the same validated builder for exactly this reason.

---

## 5. What was fixed in the last two days

All committed, all with positive and negative tests written failing-first.

| Commit | Fix |
|---|---|
| `389549f` | supervisor watchdog recreated a cold-booting BDS every 10s and never reached "Server started" |
| `d9d7389` | pack installer left stale Finder-duplicate dirs that aborted BDS boot; now mirrors the clean source |
| `846303b` | terrain verbs added to the empty-promise guard; `extractiveAnswer` ignores continuation tokens like "go" (it was returning scripting docs to a child) |
| `7ebbbe8`, `477bc88` | refusal detection added. **The first version was inert** and its test asserted with the same broken regex, so it shipped green. Corrected. |
| `c88ccd9` | orchestrator roles; the never-empty floor is no longer gated on `buildRequest` (terrain requests previously had NO floor at all) |
| `882ff41` | gift/travel/effect/admin detectors wired; also closed a validator fail-open where malformed `give_items` silently became an iron pickaxe |
| `1204877` | bare ids namespaced (`efficiency` -> `minecraft:efficiency`); collective requests ("a set of netherite armor") accept their constituent pieces |
| `259df80` | gift caveat describes what actually shipped, not what was requested |
| `81d4f6c`, `5e7d588` | over-large declared structure dimensions clamped rather than discarding the plan |
| `2288e5f` | three-digit heights parse ("100 blocks tall" was invisible to the parser) |

Verified live on the running server after each: enchanted netherite set delivers all four pieces with correct enchantments; enchanted diamond pickaxe delivers with Efficiency V, Unbreaking III, Fortune III; terrain clear/level/dig execute real fills with zero provider calls.

---

## 6. Open issues, most valuable first

- **#46 chunk oversized builds instead of shrinking or refusing.** The big one, and the owner's own diagnosis. A 100-block tower should be planned in full, split into buildable chunks, and worked in order. The goal loop already supports continuation (6 automatic actions, goal lineage preserved). The terrain rung already does exactly this pattern for a 100x100 sweep ("say the word and I will do the next piece"). Structures never learned it. **Chunk BEFORE the validator so each chunk is legitimately in bounds and the safety test stays untouched.**
- **#43 no terrain capability.** Partly addressed by the terrain rung, but there is still no typed, undoable `clear_area` / `level_ground` action. Currently done with `run_commands` fill-with-air.
- **#40 material-bearing novel builds.** "giant mushroom house" degrades to a plain house when the planner's geometry does not use the named material. Same discard-instead-of-repair pattern.
- **#45 `run_commands` and `potion_rain` still take catalogue defaults when malformed.** A malformed action silently becomes the catalogue EXAMPLE action instead of being rejected. I fixed the `give_items` case. The principled fix (catalogue resolves id-keyed skills only) turned 10 tests red because the effect route depends on borrowing `run_commands` defaults, so it needs the effect route to build its own payload first.
- **#41 `npm run wizard:start` is broken on this Mac.** macOS denies the detached daemon both socket bind and Documents file access (`EPERM`). Same operations succeed from a normal shell. See section 7 for the workaround actually in use.
- **#36 test hermeticity and negative coverage gaps.**
- **#42, #44** are largely fixed but left open as the tracking issues for their areas.

### Known broken, not yet filed

- **"ok, throw it on the ground" loses context.** There is no drop/throw route. The owner correctly notes `run_commands` can already `summon` an item, so the capability exists and the request simply never reaches it. Same shape as terrain was.
- **Privacy scrubber corrupts text for very short player names.** A test player named "B" caused every letter b in the log to be replaced, turning "build" into "[player]uild". Harmless in practice, real robustness bug.
- **"make this flat" and similar** work now, but the terrain vocabulary is a word list and will keep meeting phrasings it does not know. Consider whether the detector should defer to the model more readily rather than growing the list forever.

---

## 7. Running it, and the traps

The stack is currently UP and healthy: brain 200, desk 200, Bedrock container running.

- Join from an iPad: `192.168.22.108` port `19132` UDP.
- Operator desk: `http://127.0.0.1:3001` (loopback only).

**Do not use `npm run wizard:start`.** It reports a healthy supervisor while the brain holds no socket (issue #41). Start the three services directly:

```bash
cd /Users/roy/Documents/mc-wizard
node --env-file-if-exists=.env scripts/local-ai-bridge.mjs &
node --env-file-if-exists=.env src/server.mjs &
node --env-file-if-exists=.env src/admin.mjs &
npm run container:start
```

Traps:

- **The brain takes about 4 minutes on a cold start** to index 31,703 corpus chunks before it answers. It is not hung. On a warm cache it is about 10 seconds.
- **`.env` timeouts matter enormously.** They were `AI_TIMEOUT_MS=35000` / `MTOK_TIMEOUT_MS=30000`, which silently overrode the code defaults and made every large plan time out. They are now `110000` / `90000`. If big builds start failing again, check these first.
- **The brain must be restarted to pick up code changes**, and the bridge must be restarted to pick up its own timeout.
- Tests: `npm test`. Always run the full suite before committing; several fixes in this area have cross-file consequences.
- Commits are issue-driven. A tracked `commit-msg` hook rejects any message without a reference to an existing issue, for example `Refs #46`.
- There is a voice guard hook on issue and PR bodies that rejects em dashes. Use commas, colons, or parentheses.

---

## 8. Useful artifacts from the analysis

Committed to the repo under **`docs/analysis/`** (see its README for detail and caveats):

- `docs/analysis/orch-survey.json` a precise map of the current turn pipeline, every de facto role with file and line, and **41 safety gates enumerated with what each protects**. This is the most reusable artifact produced.
- `docs/analysis/orch-spec.json` the merged architecture spec for the role restructure.
- `docs/analysis/design-run-survey-and-designs.json` the raw design run: survey plus three competing architectures.
- `docs/analysis/design-run-final-spec.json` the raw judging run that merged them, including what was cut and why.

Line numbers inside these were accurate when generated and have drifted. Treat every file and line reference as a hint to verify. The original `synthesis.json` and `reports.json` were lost to session cleanup; their substance survives in the body of issue #35 and in section 2 above.

---

## 9. How to work on this well

Things that worked, offered as suggestions rather than rules:

1. **Read `runtime/brain/interactions.jsonl` first.** Real child turns with gate-level rejection reasons. Almost every diagnosis in the last two days came from there rather than from reasoning about the code.
2. **Reproduce as a failing test before fixing.** Several bugs looked obvious and were not. One "fix" shipped inert with a test that asserted using the same broken regex it was testing, so it passed while the bug shipped. Assert on literal observed strings, not on a copy of the implementation's own pattern.
3. **Verify agent and subagent claims.** A subagent reported a latent bug that was real but understated, and another reported a doc-dump that did not reproduce. Check before acting.
4. **Verify live after each change.** The offline suite is a good net but it did not catch the timeout misconfiguration or the two-digit height pattern.
5. **When a fix collides with a test, decide honestly whether the test encodes safety or just old behavior.** Both cases occurred. Weakening a real guard is not acceptable; updating a test that merely pinned the do-nothing behavior is correct and should carry a comment saying why.

The owner is technical, direct, and reads the actual output. He values honest reporting of what is broken over optimistic summaries, and he has caught real errors in this work. If something is not fixed, say so plainly.
