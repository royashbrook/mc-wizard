# MC Wizard spike: tabled

Last updated: 2026-08-13

## Decision

Active development and child testing are paused. The supervisor, Bedrock server, brain, model provider, and admin console are all stopped. The repository, world data, private interaction history, tests, and implementation remain available for a possible future restart.

This was a successful technical spike but an unsuccessful child product. It proved that a visible AI-controlled Bedrock player can join a private family world, converse, carry items, move, place blocks, use commands, and complete some substantial builds. It did not produce a Wizard that children could trust to handle the next ordinary or imaginative request.

## What worked

- Bedrock clients on iPad could join a locally hosted official Bedrock Dedicated Server.
- A visible `SimulatedPlayer` could wear the custom Wizard appearance and perform player-like movement, inventory, placement, and interaction.
- The behavior/resource packs, local brain, provider bridge, supervisor, live admin console, pseudonymized interaction log, and headless Bedrock test runner all worked as real integrated components.
- Fast typed capabilities were dependable for requests they matched: chat, selected travel and commands, item delivery, common structures, portals, farms, machines, and some refinements.
- The system completed meaningful demonstrations, including a city and in-place city refinement, Nether travel, redstone builds, and long multi-part structures.
- The private feedback log contains genuine successes. Of 19 explicit grades retained locally, seven were grade 5. Those successes show that embodied assistance is fun when the request, plan, and executor line up.
- The cached documentation corpus, versioned retrieval pipeline, and knowledge graph are reusable infrastructure for a future Minecraft expert, even though they did not solve embodied planning.

## Why the experience failed

### Reliability was request-shaped, not user-shaped

The Wizard often succeeded only when wording matched a known capability or a tested model plan. A small variation, refinement, pronoun follow-up, oversized request, or novel object could take a completely different path and fail. Children experienced this as randomness: success on one command gave no confidence about the next.

The private log makes the discontinuity concrete. One 50×50 clearing request completed in about 0.2 seconds and received grade 5; a closely related circular clearing request fell into an irrelevant documentation excerpt. A 100-block tower was variously reduced to 16 blocks, timed out, offered no action, or eventually split into two executable pieces depending on the run.

### The model could describe more than the executor could do

Frontier models could usually invent a plausible answer, but converting that answer into bounded Bedrock actions was the hard part. The typed contract protected the world from malformed output, yet it also rejected, clipped, or repaired many useful plans. More permissive execution increased the risk of irrelevant or destructive actions; stricter validation produced refusals and generic fallbacks. Repeatedly expanding the action schema moved this boundary without eliminating it.

### Knowledge was not agency

The large Microsoft documentation corpus and graph improved retrieval, but Microsoft Creator documentation is not a complete player-facing gameplay encyclopedia. More importantly, knowing facts about cats, redstone, commands, or blocks did not give the Wizard a reliable loop for observing the world, planning a novel goal, acting, checking the result, and correcting it. Retrieval sometimes surfaced developer documentation that was lexically related but useless to a child.

### Fallbacks hid failure instead of recovering from it

Procedural silhouettes, generic rooms, local offers, extracted documentation, and canned abilities ensured that the Wizard often did *something*. They also produced the worst semantic failures: a structure unrelated to the request, a promise without an action, or a technically completed build that did not satisfy the child. Automated checks could verify that blocks were placed while missing that the result was a bad dragon, broken farm, wrong castle, or unhelpful answer.

### Conversation and goals were not robust enough

Provider latency, timeouts, restarts, stale goals, and follow-up resolution broke the illusion of one character with a coherent memory. At different points the Wizard resumed old builds, repeated planning messages, asked children to wait with no visible progress, rebuilt beside an existing project instead of refining it, or lost what words such as “it” and “bigger” referred to.

### Infrastructure health was part of the product

The server could remain joinable while the brain or CLI-backed provider was unavailable. To a child, an embodied Wizard standing silently or reporting that a service is offline is not degraded operation; it is a broken character. The final reliability branch added a local emergency brain and health supervision, but that improved availability without fixing semantic quality.

### The tests proved components, not delight

Hundreds of unit and headless Bedrock tests caught real regressions, but most asserted schema validity, block placement, command completion, or known scenarios. They could not establish that an arbitrary child request was understood or that the finished result looked and behaved right. The key missing metric was not test count; it was a stable pass rate on held-out, child-authored conversational goals and refinements.

The retained private log has 792 records: 368 asks, 405 action lifecycle events, and only 19 explicit grades. Nine of those grades were 1 and two were 2. That sample is small and not a scientific evaluation, but it agrees with the repeated live observation that failures dominated the experience children remembered.

## Lessons

1. **A stronger model alone is not enough.** A future model must reliably use game-native tools, retain goal state, inspect world results, and repair its own work within a child-sized latency budget.
2. **The product needs one coherent agent loop.** Deterministic skills are valuable fast paths and offline fallbacks, but they should be tools chosen by one goal-owning agent—not competing brains with different memories and failure behavior.
3. **Never promise an action before an executable first step exists.** Immediate acknowledgement is good; “I’ll build it” followed by silence is worse than an honest limitation.
4. **Verification must measure intent, not mechanics.** “All operations executed” is not evidence that a castle, calculator, farm, or refinement is correct. Semantic and visual/world-behavior checks are required.
5. **Refinement is the core use case.** Children naturally say “bigger,” “add rooms,” “make it work,” or “not like that.” Project identity, geometry, causal behavior, and prior feedback must survive every turn.
6. **Latency is gameplay.** The Wizard needs a useful response in roughly one second, visible purposeful activity during longer work, cancellation, and a bounded completion time. Multi-minute model or compaction waits are disqualifying.
7. **Offline behavior should be narrow and honest.** A small set of excellent local abilities is better than pretending a generic fallback satisfies any request.
8. **Real child transcripts are the acceptance suite.** Synthetic tests remain useful, but promotion should depend on a privacy-reviewed, held-out set of asks, follow-ups, corrections, and grades that the implementation has not been tuned to individually.
9. **The embodiment was worth keeping.** A character who moves, carries materials, and builds visibly was much more compelling than a chat box. The problem was the brain-to-action loop, not the premise of an embodied helper.
10. **Stop when trust is gone.** Incremental fixes no longer mattered once each success was followed by a surprising failure. Pausing is better than asking children to keep testing an unreliable experience.

## Conditions for revisiting

Do not restart child testing merely because a newer model is available. Resume only when a small engineering evaluation can demonstrate all of the following first:

- one always-on agent owns conversation, goal, observation, action, verification, and correction;
- the model/provider has predictable availability and produces a first acknowledgement in about one second;
- at least 90% of a held-out set of ordinary requests produce a relevant executable first action, not a refusal, offer, or unrelated fallback;
- multi-turn refinements consistently modify the same project;
- completion evaluation checks visible shape and functional behavior, not only command success;
- provider loss degrades to a clearly bounded set of good local skills without false promises;
- a privacy-reviewed child eval earns a median grade of at least 4/5 before open-ended family testing resumes.

## Preserved state

- Public source and issue history: <https://github.com/royashbrook/mc-wizard>
- Current tabled work branch: `codex/issue-41-live-brain-reliability`
- Local-only world, corpus cache, learned recipes, and interaction records remain ignored by Git and should stay private.
- Restart command, if this work is deliberately resumed: `npm run wizard:start`

No service is intended to run in the background while the project is tabled.
