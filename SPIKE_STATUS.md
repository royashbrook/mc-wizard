# Spike status

Last updated: 2026-07-19

## Verified on this Mac

- Apple `container` runs the pinned Bedrock Dedicated Server image with the MC Wizard behavior pack and an isolated test world.
- The family server binds only to the selected private-LAN address on UDP 19132. `ONLINE_MODE=true` and `ALLOW_LIST=false`, so Microsoft-authenticated players on that LAN can join without preregistered gamertags.
- `MC Wizard` is a visible `SimulatedPlayer`. It walks or flies into reach, equips inventory items, uses player placement APIs, and verifies results; bulk placement is reserved for large structures and remains visibly narrated.
- The brain, provider bridge, Bedrock server, supervisor, and loopback admin desk are healthy. The active provider is Codex, and the local corpus currently contains 31,703 chunks.
- Chat supports visible player messages, implicit nearby/single-player addressing, explicit `wiz`/`wizard` aliases, and a separate anywhere-only `ai` route. Long AI replies become signed books with bounded whole-word titles.
- Goals persist across turns with action lifecycle state, active-project memory, bounded automatic replanning, cancellation/supersession, and fresh-world completion review.
- A focused live Bedrock run built a complete 31×31×18 city with crossed roads, four accessible buildings of different heights, eight streetlights, and exactly four villagers. A follow-up revised that same footprint in place to 31×31×24, added two taller skyscrapers and four lights, retained all villagers, and retained 100% of the original ground.
- A focused live Bedrock run built and lit a complete Nether portal, then moved the child and visible Wizard safely into the Nether.
- Common farms, redstone machines, recipes, portals, travel, and ordinary structures have typed local capabilities. Generated-structure travel uses one dimension-aware Bedrock locate hand for all 17 supported structure identifiers instead of village-only routing. Long-tail requests use the model's bounded plan contract instead of substituting a generic room.
- The Node/static suite passes 568 tests. Headless Bedrock scopes cover chat transport, player embodiment, machines, arbitrary structures, child-facing builds, refinements, farms, portals, city goal/refinement behavior, injected partial-travel rollback, and fixed-seed surface/village/woodland-mansion/Nether-fortress/underground-ancient-city travel with the visible Wizard.
- Novel-request generalization is deployed live (issue #35). A request outside the preprogrammed set now consults the model on every actionable turn, salvages a model plan entry by entry instead of rejecting it whole, and falls back to a real procedural silhouette builder rather than a bare corner outline. Questions with no scripted answer return retrieved evidence extractively, and successful novel builds are remembered and reused for reworded requests. Verified in the live stack: `build me a giant rainbow` and `make me a cozy blanket fort` each return a real `build_structure` action with an honest in-character answer, not the old grade-1 fallback. Safety is unchanged: allowlists stay allowlists, model prose never becomes commands, and corpus content still cannot produce console or configuration actions.
- The managed `npm run wizard:start` path is fixed and in use. The supervisor watchdog previously recreated a cold-booting BDS every 10 seconds and never reached "Server started." (issue #38); it now treats "the container is running" as the liveness signal. The pack installer previously left stale Finder-duplicate directories that could abort BDS boot during the image's forced pack refresh (issue #39); it now mirrors the clean source. Both are covered by tests.
- A real iPad join/rejoin accepted the required pack and rendered the Astral Workshop Wizard skin correctly. The diagnostic `wiz, copy my skin` remained limited to Character Creator data as documented and did not replace the player's classic Steve skin.
- The public repository is `https://github.com/royashbrook/mc-wizard`. The tracked commit hook requires an existing GitHub issue reference in each commit message.

## Still open

- The knowledge corpus and graph need broader player-facing Bedrock coverage and automated release-note ingestion.
- Open-ended builds remain probabilistic model work. The executor now preserves the goal and retries useful corrections, but more retained child-chat regressions and live semantic acceptance checks are still valuable.
- The generalization quality floor is proven by 568 unit tests and the procedural validator matrix, plus live smoke tests, but not yet by a real child grading unprogrammed requests at 3 or better in play. That live grading run is the main pending proof point.
