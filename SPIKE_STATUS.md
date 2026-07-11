# Spike status

Last updated: 2026-07-11

## Verified on this Mac

- Apple `container` 1.1.0 is installed, signed by Apple, notarized, and running.
- The pinned amd64 `itzg/minecraft-bedrock-server` image starts BDS 1.26.33.2 through Apple container's Rosetta path; the unstable arm64/Box64 route was removed.
- A fresh `mc-wizard` world was created without publishing a port. Its `level.dat` was structurally patched and re-read with `gametest`, `experiments_ever_used`, and `saved_with_toggled_experiments` enabled. The original is backed up beside it.
- BDS reports `Experiment(s) active: gtst` and loads the MC Wizard behavior pack.
- BDS creates both visible `SimulatedPlayer` entities: a uniquely named Test Kid and `MC Wizard`.
- `SimulatedPlayer.chat()` reaches `world.beforeEvents.chatSend` on this BDS build.
- The addressed request reaches the LAN-bound local brain, which indexes 30,877 chunks and returns the allow-listed `copper_bulb_t_flip_flop` action.
- The Node/static suite passes 22 tests.
- The correlated headless run passes addressed engine chat, the Wizard's five-part T-flip-flop placement, its complete 334-action calculator build, scaffold cleanup, one Test Kid lever raycast, and all 16 player-powered sums.
- The live builder now equips an inventory item, flies into a prevalidated close-reach position, looks at the support face, calls the simulated player's item-use API, and verifies the resulting block. It has no direct block-write or teleport path. A failed reach or placement stops the build instead of filling the gap.
- Player chat remains visible. `wiz`, `wizard`, and `mc wizard` are explicit aliases; ordinary chat is implicitly addressed when one human is online or the speaker is within 12 blocks. Wizard-originated chat is guarded against reply loops.
- The brain keeps six recent turns per player, answers ordinary conversation directly, and no longer prints source titles into game chat.
- The live brain now reports `provider=chat:claude`. `ai <question>` routes anywhere through loopback-only `mtok-bridge` to authenticated Claude CLI with safe mode, no tools, and no session persistence. It bypasses Wizard persona, retrieval, and actions; long replies become signed books dropped at the asker’s feet.
- Claude is also the primary MC Wizard decision-maker. The brain supplies a 12-turn per-player session and a model-visible skill registry; Claude returns a typed answer/action envelope, while the server discards every action outside the two registered physical builds. Live probes passed a greeting, an in-character joke, and model-selected calculator construction.
- Long-answer books preserve bullets and paragraphs across bounded pages. Titles are derived from the subject, contain only whole words, and fit Bedrock's 16-character limit (`make me a guide on how to beat minecraft` becomes `Beat Minecraft`).
- The public repository and post-spike backlog are at `https://github.com/royashbrook/mc-wizard`. The tracked commit hook requires and verifies an existing issue reference in every commit message.
- BDS 1.26.33.2 accepts the synthetic button and player-placed pulse but does not toggle the copper bulb's `lit` state; that transition is reserved for the real iPad acceptance check instead of being reported as a pass.
- `mc-wizard-bedrock` is running on `192.168.22.108:19132/udp`, bound only to that private address. `ONLINE_MODE=true` and `ALLOW_LIST=false`, so any Microsoft-authenticated player on the same LAN can join without pre-registering a gamertag.

## Next live proof

Join from an iPad, confirm visible chat and implicit addressing, watch the Wizard fly and place a small build, press the T-flip-flop button, and test the calculator levers. The latest headless run proves the physical five-part build and chat path. The large calculator needs a fresh isolated E2E world: repeated test runs damaged the shared fixture floor, so its earlier full truth-table pass does not validate the new flight movement yet.

## Still unverified

- iPad rendering, name tag/player-list behavior, touch interaction, restart recovery, and real family chat.
- A custom wizard skin. The current beta `PlayerSkinData` API exposes persona metadata rather than accepting a raw 64×64 skin texture, so this needs a compatible persona-piece configuration or a client resource-pack costume.
- The new close-reach creative-flight path across the complete 334-action calculator. The small physical build passes; the current shared E2E world is no longer a reliable large-build fixture.
- The family has explicitly approved open-LAN mode. No gamertags are required; Microsoft-authenticated players on the private network can join while the container is running.
