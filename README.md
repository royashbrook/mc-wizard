# MC Wizard

A Bedrock-first spike for an AI Minecraft teacher that can answer questions from versioned sources and act as an all-capable Wizard in a trusted private family world.

The intended vertical slice is:

```text
iPad / Bedrock chat
  → official Bedrock Dedicated Server
  → MC Wizard behavior pack
  → visible MC Wizard SimulatedPlayer (an official Player subclass)
  → local HTTP brain
  → Bedrock RAG + optional external model
  → typed Minecraft, player, world, or server action
  → MC Wizard walks, looks, chats, holds, and places the approved blocks
```

Status: the Node brain, persistent bounded dialogue sessions, provider bridge, versioned RAG promotion, Apple-container BDS, behavior/resource packs, embodied `SimulatedPlayer`, safe typed plans, transaction rollback/undo, and isolated headless world runner are implemented. The physical 334-action calculator acceptance run is intentionally slow because the Wizard navigates within reach and uses an inventory item for every placement. BDS 1.26.33.2 still does not toggle a copper bulb's `lit` state through the synthetic pulse, so that one interaction remains an iPad acceptance check.

The primary design goal is that a child can ask for almost anything, a question or an in-game build, and get a favorable, honest result rather than a canned success only for preprogrammed requests. Novel requests are no longer all-or-nothing: model-authored plans are salvaged entry by entry instead of rejected whole, an unprogrammed build falls to a real procedural silhouette builder rather than a bare corner outline, questions with no scripted answer return retrieved evidence extractively, and successful novel builds are remembered and reused for reworded requests. In this trusted family world, every validated Bedrock mechanism is available—including commands, operator actions, server settings, TNT, command blocks, barriers, spawners, teleportation, and Script API capabilities. The hard boundary is child-appropriate content; execution remains typed, bounded, observable, and validated.

Ask `wizard, build me something that changes every time I press a button` and the brain returns a kid-friendly explanation, cites the retrieved material, and emits the typed action for a Bedrock copper-bulb T flip-flop. The visible MC Wizard is designed to walk to the demonstration site and place the approved blocks once the BDS prerequisite above is available.

## What is here

- A dependency-free Node HTTP service with authentication, input limits, timeouts, and an offline mode.
- Local retrieval over self-authored mechanic cards plus cached official documentation.
- A sync job for the [Microsoft Minecraft Creator documentation](https://github.com/MicrosoftDocs/minecraft-creator) and separate [stable](https://feedback.minecraft.net/hc/en-us/sections/360001186971-Release-Changelogs) / [preview](https://feedback.minecraft.net/hc/en-us/sections/360001185332) changelogs.
- OpenAI Responses API support and an OpenAI-compatible Chat Completions mode for other providers.
- A current Bedrock 26.30+ behavior pack using `@minecraft/server`, `@minecraft/server-gametest`, `@minecraft/server-net`, and `@minecraft/server-admin`.
- A visible, server-created MC Wizard based on Bedrock's official [`SimulatedPlayer`](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server-gametest/simulatedplayer?view=minecraft-bedrock-experimental), which extends `Player` and can walk, look, chat, hold items, and perform player block interactions.
- Embodied build actions for arbitrary bounded structures, houses, recipe displays, farms, common redstone machines, a copper-bulb T flip-flop, and a two-bit calculator.
- A typed action boundary: model prose cannot become commands or JavaScript. Validated skills, plans, capability programs, operator actions, and server settings are executable output.
- A loopback-only operator desk for live AI tuning, health, Bedrock console commands, logs, and browser-based dialogue tests.
- Journaled snapshots, rollback on failure/disconnect/restart, recent-build protection, and `wizard undo`.
- A pack installer that preserves other activated packs, plus an original importable classic Wizard skin pack.

## Run the brain

Requires Node 22.9 or newer.

```bash
cp .env.example .env
npm install
npm run hooks:install
npm test
npm run eval:live-chat
npm start
```

For the prepared local stack, one supervisor owns the provider bridge, brain, and Bedrock container with bounded restart backoff:

```bash
npm run wizard:start
npm run wizard:status
npm run wizard:stop
```

`wizard:start` does not report success merely because a supervisor PID exists. It waits for the brain, operator desk, Bedrock container, and any configured local provider to become healthy, then remains attached to that terminal so macOS keeps the launcher's Local Network and Files and Folders permissions. Leave it running and use another terminal for `wizard:status` or `wizard:stop`. A cold corpus build can take several minutes; adjust the bounded wait with `WIZARD_START_TIMEOUT_MS`. On failure it exits nonzero and reports a detected macOS permission denial. Status reports service health, provider name, corpus size, and the active knowledge-graph revision/counts; it does not print tokens, prompts, player identifiers, or credentials.

### Operator desk

`npm run wizard:start` also ensures the local operator desk is running. It can be managed independently without stopping Bedrock:

```bash
npm run admin:start
npm run admin:status
npm run admin:stop
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001) on the server Mac. The desk provides:

- live Bedrock, brain, and provider health;
- quick world controls plus a one-line Bedrock console input;
- recent container logs that refresh every four seconds and follow new output automatically;
- a live, persistent interaction history with Wizard/general questions, answers, action labels, and verified outcomes;
- a separate browser dialogue session for testing Wizard and general AI replies; and
- hot-loaded prompt addenda, AI enable/disable, and output-token limits.

### Live-chat refinement loop

Do not tune the Wizard from a remembered paraphrase. Inspect the latest local chat/session log and label each turn `success`, `partial`, or `failure`. Promote a live turn into the public `test/fixtures/live-chat-regressions.json` only with parent or guardian opt-in, after manually removing names, gamertags, contact/location details, school information, and other identifying text. Prefer a synthetic equivalent that preserves the exact typo or follow-up pattern which triggered the bug. Run `npm run eval:live-chat` before and after a fix.

The brain also appends pseudonymized local JSONL records to ignored `runtime/brain/interactions.jsonl`; set `INTERACTION_LOG_FILE` to override the path. The file is mode `0600` and automatically retains only its newest 2 MiB. Player names are HMAC-pseudonymized and removed from recorded text, but free-form chat can still contain personal information and must not be treated as anonymized. The operator desk polls the same history, so a tester can inspect the request, reply, chosen action, and executor result without relaying it by hand.

AI tuning is stored in ignored `runtime/admin/settings.json` and read on every request, so saving it does not restart Bedrock or the brain. The base safety, action, and book-format contracts remain in code. Console input uses the image's documented [`send-command`](https://github.com/itzg/docker-minecraft-bedrock-server#executing-server-commands) helper without invoking a shell.

The desk intentionally binds only to loopback. It is not available to iPads or other LAN devices. Change that only after adding authentication and TLS.

Commits are issue-driven. The tracked `commit-msg` hook rejects messages without a reference to an existing issue in this repository. A tracked pre-commit hook also rejects staged environment files, runtime/session data, world data, generated books, logs, credential-like values, and suspicious plaintext gamertags. Use a message such as `Improve dialogue sessions (Refs #8)`.

Run `npm run check:publication` to apply the same dependency-free scan to every tracked file. CI runs that command on every pull request and push to `main`. The guard is intentionally conservative but cannot prove that content is anonymous, and it does not replace GitHub secret scanning or manual review. Add only clearly fictional test identities to the reviewed allowlist in `scripts/check-publication.mjs`, with a test explaining the addition. For a local false-positive investigation only, `PUBLICATION_GUARD_REVIEWED=1 git commit` bypasses the local hook; CI still rejects the repository until the finding is removed or the reviewed rule is corrected.

In a second terminal:

```bash
npm run ask -- "Build me something that changes every time I press a button"
```

With no AI configuration, the service uses deterministic offline answers backed by the retrieved cards. This makes the bridge and build path testable without spending money or exposing a key.

### Connect an AI

For OpenAI, set these in `.env`:

```dotenv
AI_STYLE=responses
AI_API_KEY=your-key
AI_MODEL=gpt-5.6-luna
```

[`gpt-5.6-luna`](https://developers.openai.com/api/docs/guides/latest-model) is the current efficient GPT-5.6 variant; the model is configuration, not architecture. For an OpenAI-compatible provider such as OpenRouter or a local server:

```dotenv
AI_STYLE=chat
AI_BASE_URL=https://provider.example/v1
AI_API_KEY=your-key-if-required
AI_MODEL=provider-model-id
```

The service sends the question, retrieved excerpts, recent dialogue, and a bounded live-world snapshot—including Minecraft coordinates, nearby block/entity summaries, and current project geometry—to the configured provider. It does not send the player's gamertag; the name is used only to derive a per-install HMAC `safety_identifier` for OpenAI.

For the local subscription-backed bridge used by this spike, start this first:

```bash
npm run start:ai
```

`mtok-bridge` provides the OpenAI-compatible transport. Its upstream can be the authenticated local Codex, Grok, or Claude CLI. Codex runs ephemerally with native web search in a read-only sandbox; user configuration, rules, apps, multi-agent, and shell tools are disabled. Grok runs single-turn with memory, subagents, web search, and tools disabled; Claude uses safe mode, an empty tool list, and no session persistence. The provider receives only the model prompt: it cannot act in Minecraft. The loopback bridge rejects browser-originated and non-JSON requests. It runs three provider jobs by default (bounded to 2–4), bounds queue waits, and terminates the active CLI immediately when a player disconnects or the request times out. Then start the brain with `npm start`.

Greetings, readiness checks, thanks, jokes, calculator builds, T flip-flops, and small castle gates run as immediate local skills without an AI request. Any turn that is actually actionable still consults the model, so a canned answer never suppresses a build the child asked for, and an unmatched descriptor such as `rainbow` or `spooky` forces a model plan even when a generic template would otherwise match. Deeper questions use the cached corpus as evidence for the configured model to synthesize; when no model is configured or reachable, a question falls back to the top retrieved passage quoted extractively rather than to boilerplate. Raw documentation is never used as a chat fallback for a build. Every provider action is checked against the child's explicit intent before it can reach Bedrock, and an unrelated provider goal cannot attach itself to ordinary conversation. Build requests create a persisted goal with observable success criteria. A model plan is salvaged one entry at a time instead of rejected on the first bad block, and its placement order, supports, and verification steps are computed by the server rather than demanded from the model. If a shape still cannot be planned after the bounded repair attempts, the Wizard composes a real procedural build (a silhouette assembled from boxes, walls, roofs, and per-subject templates) as useful progress and automatically continues the same goal; it never labels that progress as the finished object, and it never silently substitutes an unrelated generic shape for a request it could not build. A completed placement batch is only an observation: Bedrock returns a fresh world snapshot, the goal reviewer either marks the goal complete or issues the next related correction, and at most six automatic actions can run before the Wizard explicitly asks the child to inspect the still-active project. New child requests supersede older planning and late provider replies atomically. The Bedrock log message `Running AutoCompaction...` is database maintenance, not an AI request; the operator desk hides those routine lines and reports that they use zero AI tokens.

Unfamiliar build requests explicitly require the planner to work from the cached, promoted Bedrock evidence attached to the turn and the Wizard's verified in-game capabilities. The Wizard route does no player-triggered web lookup and never claims fresh research; it synthesizes the available evidence into a concrete action, or makes useful in-game progress rather than leaving a child waiting. Novel plans may use any registered, validated gameplay or administration capability when it matches the child's request. A content-policy gate rejects child-inappropriate requests and generated output independently of the mechanism used. When a completed build receives a grade of 4 or 5 without a requested correction, its validated relative action is stored in ignored `runtime/brain/learned-recipes.json` and can be reused without another model call. Reuse is fuzzy: a reworded request with the same subject reuses the stored recipe, guarded so a different subject never borrows it. An unverified grade-4 completion is stored provisionally and promoted once it is verified, and a low grade or correction decrements a success/failure counter and enters the same-project refinement loop instead of deleting the recipe outright. Recipe records contain no player identity and are bounded by `LEARNED_RECIPES_MAX` (default 100).

In game, `ai <question>` always means this general model route. It requires the `ai` keyword even when the player is alone or beside the Wizard, skips Minecraft RAG and Wizard actions, and prefixes short replies with the configured provider label, such as `[ChatGPT]`. Replies over 700 characters are placed in a signed book at the player's feet. Ordinary chat and `wiz`/`wizard` continue through the Minecraft-specialist route.

## Load official knowledge

```bash
npm run sync:docs
```

This command:

1. shallow-clones or updates `MicrosoftDocs/minecraft-creator` under ignored `.cache/`;
2. caches stable and preview changelogs into separate directories;
3. builds a staged stable/preview Bedrock release with revision, version, attribution, and content hashes;
4. resolves safe JSON source transclusions so vanilla mob behavior is indexed instead of empty code placeholders;
5. builds a versioned typed graph with document fingerprints, source provenance, components/commands/identifiers, relation evidence, and compact entity-to-chunk postings;
6. runs retrieval and dialogue smoke evaluations, including player-facing cat taming;
7. atomically promotes the staged release only if every evaluation passes.

It requires Git and internet access. The first sync downloads roughly 8,800 repository files plus 712 changelog articles. The resulting `.cache/` is intentionally ignored: this workspace currently indexes 31,703 chunks, but a fresh clone must run `npm run sync:docs` to recreate that corpus. Before syncing, only the six authored mechanic cards are available. To build or refresh only the graph from an already-cached active release, without downloading documentation again, run `npm run graph:build`.

Every promoted release owns `knowledge-graph.json`. It records a schema/extractor revision, per-document content fingerprints and source locations, stable/preview/Java/unknown edition metadata, typed concepts, evidenced relations, and compact postings—not an external service or a live lookup. Runtime combines that graph evidence with lexical retrieval, requires lexical relevance before a graph boost can rank an answer, and uses only stable Bedrock material by default. Java, preview, malformed-channel, and ambiguous-edition notes fail closed; an explicit preview question may opt into preview material. Current docs and tested mechanic cards rank above patch notes for ordinary mechanics questions. Microsoft Creator documentation is an add-on/developer corpus, not a complete gameplay encyclopedia; curated player-facing cards provide instant verified answers for high-value topics while additional player-facing material can be promoted through the same private-cache pipeline.

Microsoft's repository licenses documentation under CC BY 4.0 and code samples under MIT. Preserve attribution and revision URLs. Changelog content has no explicit open-content license, so keep that cache private and return links rather than redistributing a corpus.

## Run with Bedrock

The correct base is the official Bedrock Dedicated Server, not a Java bridge or a reimplementation of the changing Bedrock protocol. Microsoft officially supports BDS on Windows and Ubuntu, not macOS.

The behavior pack uses beta chat, HTTP, and [`@minecraft/server-gametest`](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server-gametest/minecraft-server-gametest?view=minecraft-bedrock-experimental) APIs. The world must have the **Beta APIs** experiment enabled before moving it to BDS; there is no supported server property that turns this experiment on afterward. Pin the BDS and API versions after the first passing in-world test because beta APIs can change between releases.

### The embodied wizard

When a real player joins, the behavior pack is set up to spawn one `MC Wizard` near that player. This is a server-side `SimulatedPlayer`, not a custom mob wearing a player-shaped model: it is an actual subclass of Bedrock's `Player`. It uses the normal player rendering path and can navigate, turn to look at a child, speak under its own name, carry selected items, and place or interact with blocks as a player.

The embodiment does not need a second Xbox/Microsoft account. It requires a Beta-APIs-enabled world and the pre-release GameTest Script API. The original Astral Workshop Wizard skin is a standard 64x64 classic-arm skin under `bedrock/skin_packs/mc_wizard`; it intentionally replaces the old fake hat-and-robe shell. Run `npm run package:skin` to create `dist/mc-wizard-skin.mcpack` for Bedrock's Classic Skins picker.

Bedrock's Script API cannot pass classic PNG pixels to `SimulatedPlayer.setSkin`; its documented `PlayerSkinData` contains only Character Creator pieces, arm size, and skin color. The required world resource pack therefore uses the official player render path to map only the exact `MC Wizard` name to Astral Workshop Wizard. Every other player continues through `Texture.default`, preserving their own selected skin. The pack version is bumped when this path changes; the standalone installer and managed local starts both refresh the world's pack assignment and enforce `texturepack-required=true`, including for worlds initialized by older builds. The checked-in `player.entity.json` is based on Mojang's current Bedrock sample and must be refreshed when the pinned Bedrock minor version changes.

The iPad join/rejoin acceptance passed for the forced resource-pack download and Astral Workshop Wizard skin. `wiz, copy my skin` remains a diagnostic for Character Creator data; as expected, it did not copy a classic Steve skin and is not the classic-skin installation path.

![Astral Workshop Wizard skin preview](docs/assets/mc-wizard-skin-preview.png)

Address the character in chat:

- `wizard, <question or request>` asks a knowledge or build question.
- `wizard, copy my skin` lets an operator test copying their current Character Creator look to MC Wizard.
- `wizard, come here` asks MC Wizard to walk to the speaker and face them.
- `wizard, stay` stops its current movement.

### Private player notes

Each child can give Wiz a few lasting, personal instructions. They follow the child across reconnects, but never become another player's context:

- `wiz, you're standing too close` keeps Wiz about eight blocks away.
- `wiz, from now on build my stuff with only mushroom blocks` applies that palette to later builds, unless the child names a different material for one build.
- `wiz, ask before you teleport me` makes movement opt-in; a direct request such as `take me to the Nether` still works.
- `wiz, what do you remember about me?`, `wiz, forget my mushroom rule`, and `wiz, forget everything` list or remove only the speaker's own notes.

Notes are compact normalized settings, keyed by an HMAC of Bedrock's player ID in ignored `runtime/brain/player-preferences.json` (`0600`). The file contains no raw player names, chat, build plans, action history, or old goals. The operator desk shows only aggregate note counts; it cannot inspect individual notes. The local bridge bearer is a trusted server-to-server boundary, not per-player authentication—keep its port and token off untrusted networks.

The movement commands control only the embodied character. In trusted-family mode the model can also compose physical builds, any Minecraft command, dedicated-server console commands, server properties, experiments, and world options. It still cannot execute arbitrary host JavaScript or shell commands.

Addressed chat is the reliable interaction in this slice. Bedrock may not show a touch `Interact` action for another Player, even a simulated one, so tapping the body is an explicit iPad acceptance test rather than a promised control path.

### Existing Windows or Ubuntu BDS

1. Create a Bedrock world with Beta APIs enabled, activate/export it, and copy it into BDS.
2. Run BDS once. Confirm the world folder exists and `level-name` matches it exactly.
3. Start the brain with `npm start`.
4. Install and activate the pack:

   ```bash
   npm run install:pack -- "/path/to/bedrock-server" "World Folder" "http://127.0.0.1:3000/v1/ask"
   ```

5. Restart BDS. Connect an iPad to the server machine's LAN IP on UDP port `19132`.
6. Confirm MC Wizard appears nearby, then type `wizard, come here`, `wizard, how does a T flip-flop work?`, or `wizard, build a T flip flop for me`.

`BRIDGE_TOKEN` in `.env` is also used by the installer. Change the development token before the service is reachable by anything beyond your own machine.

### macOS development route: Apple container

Apple container 1.1.0 is installed and verified on this Mac. It runs one lightweight Linux VM per OCI container. The pinned third-party [`itzg/minecraft-bedrock-server`](https://github.com/itzg/docker-minecraft-bedrock-server) amd64 image runs Microsoft's x86-64 BDS through [Apple container's Rosetta path](https://github.com/apple/container/blob/main/docs/how-to.md#build-and-run-a-multiplatform-image). This avoids the native heap faults observed with the image's arm64/Box64 wrapper, but it is still not a Mojang-supported macOS host.

Install the current signed Apple container 1.1.0 package deliberately rather than piping an installer into a shell:

```bash
curl -L -o /tmp/container-1.1.0-installer-signed.pkg \
  https://github.com/apple/container/releases/download/1.1.0/container-1.1.0-installer-signed.pkg
echo "0ca1c42a2269c2557efb1d82b1b38ac553e6a3a3da1b1179c439bcee1e7d6714  /tmp/container-1.1.0-installer-signed.pkg" \
  | shasum -a 256 -c -
pkgutil --check-signature /tmp/container-1.1.0-installer-signed.pkg
open /tmp/container-1.1.0-installer-signed.pkg
```

After reviewing/installing it:

```bash
container system start
container system version
container system status
```

Then:

1. Either put an exported Beta-APIs-enabled world at `runtime/bedrock/worlds/mc-wizard`, or create a disposable fresh one headlessly with `npm run bootstrap:bds`. The bootstrap container publishes no network port, stops BDS cleanly, backs up `level.dat`, structurally enables the three official Beta API experiment bytes, and deletes only its temporary container.
2. Choose the Mac's private LAN IPv4 first. Copy `.env.example` to `.env`, set both `HOST` and `MC_WIZARD_LAN_IP` to that literal address (not `0.0.0.0`), replace `BRIDGE_TOKEN` with at least 24 random characters, and run `npm start`. Leave `WIZARD_SALT` blank to derive a private stable salt from that token, or set it to a different random secret of at least 24 characters. The brain refuses to bind beyond loopback with a default or short token and ignores the old public salt placeholder.
3. Confirm `.env` contains the Mac's private LAN IPv4:

   ```bash
   MC_WIZARD_LAN_IP=192.168.x.x
   ```

4. Activate/configure both packs and launch the pinned image/BDS version:

   ```bash
   npm run container:start
   npm run container:logs
   ```

5. Add the server manually on each iPad using the Mac LAN IPv4 and UDP port `19132`; LAN discovery broadcasts may not cross the container VM. Do not forward this port on the router for the spike.

Approve the macOS Local Network/incoming-connections prompt if it appears. In the logs, wait for both `IPv4 supported, port: 19132` and `Server started.` before joining. Open-LAN mode still requires Microsoft authentication, binds only to the Mac's exact RFC1918 address, and must not be forwarded on the router. Anyone who can reach that private network can join until the container is stopped.

Stop BDS cleanly with `npm run container:stop`; later starts use `npm run container:start`. That managed start deletes and recreates only the disposable container, while preserving the bind-mounted world in `runtime/bedrock`; this guarantees BDS reloads the current packs, world-version assignments, Script API config, LAN bind, and required client-pack setting. After any configuration change: stop BDS, update `.env`, restart the brain, then use the managed start.

The launcher refuses an address that is not a private IPv4 assigned to this Mac or a missing world. This experimental family build is intentionally open to authenticated players on the private LAN and gives new players operator permission. It pins both the OCI image digest and BDS 1.26.33.2 so a restart cannot silently cross a beta-API boundary. `compose.yaml` remains a Docker-compatible alternative, but Apple container is the prepared macOS route.

### Required iPad/BDS acceptance checks

None of these in-world checks has passed yet. The first live run must record whether:

- an iPad sees the MC Wizard body, held item, movement, head direction, name tag, and authored chat;
- tapping or using MC Wizard produces a usable interaction on the Bedrock touch client;
- MC Wizard appears correctly in the iPad player list and the BDS `/list` output;
- the locator bar or player-waypoint UI treats MC Wizard as expected;
- death, disconnect, and a BDS restart recover to exactly one MC Wizard rather than zero or duplicates;
- MC Wizard affects the advertised player count or `max-players` limit, including when a second child joins; and
- `come here`, `stay`, and an actual block placement remain synchronized and do not trigger the wizard's own chat listener.

Player-list, locator, touch-interaction, restart, and player-count behavior are deliberately acceptance checks rather than claims: the Script API documents the `Player` subclass and its actions, but not every client UI and dedicated-server lifecycle consequence.

### Headless in-world acceptance

The pack can run its real chat-to-build path without an Xbox login. With the brain already running, the isolated one-command test is:

```bash
npm run test:e2e:bds
```

For a shorter live acceptance focused only on the three common redstone machines:

```bash
npm run test:e2e:machines
```

That run has Test Kid close and reopen the 2x2 piston door, waits for the automatic smelter to deliver an iron ingot, and confirms the item sorter sends a diamond and a feather to different output chests. It checks real blocks, inventories, hopper directions, and redstone movement rather than chat text.

Focused runs cover the open-ended child experience without rerunning the whole suite:

```bash
npm run test:e2e:arbitrary
npm run test:e2e:portal
npm run test:e2e:travel-rollback
npm run test:e2e:local-travel
npm run test:e2e:city
npm run test:e2e:child
npm run test:e2e:refinement
npm run test:e2e:farms
npm run test:e2e:kelp
```

The arbitrary run verifies an unusual exact-size structure rather than a canned prototype. The local-travel run rescues Test Kid from underground, reaches a generated village and woodland mansion, crosses dimensions to a generated Nether fortress, and then reaches a generated underground ancient city with the visible Wizard. The child run verifies a sized house, an in-place castle upgrade, working chicken, wool, and naturally harvested kelp farms, bounded splash-potion rain, contextual time and weather, physical item delivery, and an in-world recipe lesson. The refinement run keeps rooms, villagers, a balcony, enlargement, and a moat on the same castle. The farm run requires fresh sugar cane, bamboo, and cactus growth to reach the output chest; the kelp run isolates the same natural-growth-to-chest proof for its observer/piston circuit.

It bootstraps a fresh Beta-APIs world under a unique `runtime/e2e/<run-id>` data root, launches a unique Apple container with no published port, and always stops/deletes that container. A passing world is deleted; a failing world is retained for diagnosis. Raw BDS output is saved to ignored `runtime/e2e-last.log`.

The test creates a disposable pad away from spawn and spawns a uniquely named Test Kid as a second official `SimulatedPlayer`. Test Kid first attempts each request with `SimulatedPlayer.chat`. If BDS does not surface that call through `world.beforeEvents.chatSend`, the harness detects the missing event after ten ticks and invokes the exact same addressed-message parser/router directly. Every run reports `engine-event` or `direct-harness-fallback`, so a passing build test never falsely claims that simulated chat reached the engine listener. It then checks the wizard's five-part T flip-flop, asks for the two-bit calculator, and verifies one real Test Kid lever raycast. Because BDS eventually ignores repeated SimulatedPlayer lever clicks, the isolated fixture removes those four levers and Test Kid physically places or breaks redstone blocks at the exact input positions while all 16 electrical sums are read from the output lamps. It emits one correlated `MC_WIZARD_E2E` PASS/FAIL record and disconnects. Real iPad chat always uses the engine listener; the direct chat route exists only inside the gated headless harness.

## Bridge contract

The behavior pack calls:

```http
POST /v1/ask
Authorization: Bearer <BRIDGE_TOKEN>
Content-Type: application/json

{"player":"BuilderKid","question":"build a t flip flop","mode":"wizard"}
```

The explicit general route sends `"mode":"general"`; that response always has `"kind":"general"`, no sources, and no action.

The brain returns prose, provenance, a persisted goal, and an optional typed action:

```json
{
  "answer": "A T flip-flop stores one bit...",
  "goal": {
    "objective": "Build a working T flip-flop nearby",
    "successCriteria": "Each button press toggles the output and the lamp shows its state",
    "status": "active"
  },
  "action": {
    "type": "place_blueprint",
    "id": "copper_bulb_t_flip_flop",
    "version": 1
  },
  "sources": [
    {
      "title": "Copper bulb T flip-flop",
      "url": "https://feedback.minecraft.net/...",
      "version": "1.21+",
      "channel": "stable"
    }
  ],
  "mode": "offline"
}
```

The Bedrock adapter accepts only registered, versioned actions and validates every material, dimension, coordinate, interaction, entity, and operation bound before execution. It reports `started`, `completed`, or `failed` back to `/v1/action-result`; completed results include a bounded live-world snapshot for semantic goal review. Structure and machine corrections retain immutable goal lineage and the prior project location, and unrelated replacement actions are rejected.

## Turn architecture: roles inside one turn

The rule the brain is built around is "never give up and never do nothing": if a child asks for something the Wizard can actually do, the turn owes them a real attempt — never a bare refusal, never a promise with no action attached, never silence, never a documentation excerpt.

A live session broke that rule three ways at once. A child asked twice to clear and level a 50x50 area and got nothing either time. Three independent causes, each reproduced separately against the shipped code:

1. **The refusal detector never fired.** It did not match `I can't` or `I cannot`, so the model's refusal shipped to the child verbatim. The test that existed to catch this re-declared the production regex inline, inherited the identical blind spot, and stayed green. Tests here now import the matcher from the runtime module, or assert the property behaviourally, and never re-implement a predicate the code owns.
2. **The recovery path threw, and the catch laundered the failure.** When the ladder was entered and found nothing it threw; the outer catch then reset the action to the same empty value the failure had already produced, and shipped it as a normal turn.
3. **Every recovery floor was lexically inside `if (buildRequest ...)`.** Terrain is not a build request, so no floor was reachable at all for these turns.

The turn is now assembled from small injected roles under `src/roles/`, each unit-tested on its own with stub dependencies:

| Module | Responsibility |
| --- | --- |
| `turn-state.mjs` | The turn blackboard. `action` and `responseMode` are written only in pairs through `adopt()`, because the pack's planning-deferred retry keys on that pair and drift between them changes in-world behaviour. |
| `intent.mjs` | The frozen turn record. Adds `actionableIntent` (the generalization of `buildRequest` that unlocks the floor for terrain, travel, gift and effect turns) and `consultModel`, the single cost gate. |
| `terrain.mjs` | The deterministic terrain rung: a terrain verb plus a terrain noun in one clause compiles to y-sliced `fill … air` commands, re-validated through the executor allowlist. |
| `critic.mjs` | Four fixed tiers — safety, existence, fidelity, completeness — over the file's own validated predicates. The existence tier fires on `!action && actionableIntent` first, so detection does not depend on recognizing the model's prose. |
| `escalation.mjs` | One ordered ladder replacing the two divergent floor sites, walked with a monotonic index and an append-only rejected set. |
| `orchestrator.mjs` | Transitions, budgets, and the terminal assertion. It contains no regex, no Minecraft vocabulary and no allowlist, so it cannot widen a safety boundary. |

Every role takes its dependencies by injection and none of them imports `src/wizard.mjs`, so there is no import cycle and no validated predicate moved out of the file that owns it.

No action type was added, and the `started` / `completed` / `failed` and review/replan/retry vocabulary the pack dispatches on is unchanged. One new `responseMode` value, `local-offer-floor`, was added for the bound-offer floor. The pack treats `responseMode` as opaque apart from `planning-deferred` and `player-memory`, so no result is dispatched differently because of it — but it is a new string on the wire and is named here rather than left to be found later.

**No safety regex was widened by this work, and none needed to be.** That is a consequence of where the deterministic rungs sit, not a lucky outcome. The terrain rung is deterministic, not model-authored, so the model-policing gates — `providerActionMatchesRequest`, `providerPowerMatchesRequest` and its guarded-command table, subject fidelity, the research ban — never see it and were not edited; widening the guarded-command vocabulary to let a fill-with-air through would have loosened a gate that exists to police model output. The rung is also placed after the "the child only asked for an explanation" bail, so `just explain how to clear a 50x50 area` still explains rather than digging. The one safety surface it does cross is the one it must: every candidate it authors is re-validated through `allowedWizardAction`, and it returns that gatekeeper's output rather than the object it built. `test/never-empty.test.mjs` re-runs the allowlist over whatever action actually ships and requires the two to be identical.

Two suites are the executable form of the rule. `test/never-empty.test.mjs` crosses roughly forty hostile child prompts — including the verbatim live turns — with five provider behaviours (refuses, promises without acting, returns invalid JSON, throws, times out), and requires every one of the 200+ cells to be non-empty, free of the provider's own refusal or promise text, and, on actionable turns, to ship a real action, an offer that a following bare `yes` actually converts into work, or the planning-deferred terminal the pack already retries. `test/cost-gate.test.mjs` counts provider calls: zero for the canned turns and the whole terrain rung, exactly one for a turn that genuinely needs the model, and never more than `1 + MC_WIZARD_REPAIR_ROUNDS` for a hostile turn.

### What this does not do

This is an orchestrator **inside a single turn**, not a unified agent loop. There are still three loops in the system, and this work removed none of them:

- the six recursive `api.ask` calls in `src/wizard.mjs` (follow-ups, refinements, goal review, replan), which re-enter the whole turn rather than iterating the orchestrator;
- the pack-side result dispatcher in `bedrock/behavior_packs/mc_wizard/scripts/main.js`, which owns review, replan, retry and their caps; and
- the pack's own planning-deferred retry, which re-asks after a deferred turn.

Collapsing the recursive calls into orchestrator iterations is deliberately deferred: it changes how many times `sessions.reserve` fires and therefore supersede semantics, the pack owns the other half of the loop, and the container acceptance suites cannot be run offline. The reward there is tidiness; the reliability wins are the ones above.

## Why this differs from the reference bot

[`danshorstein/minecraft-ai-bot`](https://github.com/danshorstein/minecraft-ai-bot) is an MIT-licensed Java/Paper companion built around Mineflayer, a large prompt cookbook, OpenRouter tool calls, and OP slash commands. Its strongest transferable idea is its continuous goal runner: plan once, execute a step, scan the world, ask an independent QA role whether the criteria pass, and continue at a fixed anchor. It also relies on deterministic city/castle skills and a broad raw-command escape hatch; it is not a RAG or Minecraft-documentation system.

Mineflayer, Paper setup, Java NBT/commands, and raw OP command execution do not transfer to Bedrock. The reference character is visible, but its large builds are performed by `/fill`, `/setblock`, and `/summon`, with extra crew players used theatrically. MC Wizard keeps the structured-skill and iterative-QA ideas, uses Bedrock's official beta `SimulatedPlayer` for the visible character, and puts actions behind a strict Script API compiler. It does not log in a headless protocol client or hold credentials for a second Xbox account. No source code from the reference project is copied here.

## Known limits of this spike

- The live iPad test verified the visible player entity, Astral Workshop Wizard skin, chat, AI books, and basic mechanics. The custom wand and T-flip-flop's real-client copper-bulb transition still need a quick iPad visual check. The fitted costume was removed after testing because it obscured the player model.
- The T flip-flop, calculator, command lessons, and validated plans are transactional and undoable. They require bounded clear areas, reject occupied/protected overlaps, and roll back on failure or disconnect.
- The current documented Script API cannot safely program arbitrary command-block text. Prepared lesson definitions make the Wizard physically place the command block and button, then tell the child exactly what to paste; they deliberately do not `/structure load` a prebuilt result.
- The simulated player attempts normal placement and interaction first. Large surfaces use bounded fill operations, and a rejected Bedrock placement can be repaired directly after visible player attempts; therefore the current runtime does not guarantee that every final block was accepted through the player-placement API.
- Goal QA observes validated plans, project memory, nearby blocks/entities, weather, time, and action-specific acceptance results. It is not visual scene understanding yet. Automatic continuation is capped at six actions under one immutable goal; the goal stays active and the Wizard asks for child feedback rather than silently claiming success at the cap.
- Novel builds now reach a passable result offline through the procedural silhouette builder, but the silhouettes are blocky approximations, not detailed models, and the quality floor is proven by unit tests and the validator matrix rather than by a live child grade. A real iPad/BDS run is still the pending proof that unprogrammed requests grade 3 or better in play. When a salvaged plan drops some pieces, the build reports a partial status and reopens for review instead of claiming full completion.
- The never-empty rule is gated on intent, and intent recognition is still lexical. A terrain work order is recognized only when a terrain verb and a terrain noun appear in the same clause, so `clear a 50x50 area`, `flatten this hill` and `wiz can you clear the trees around here` compile to real work, while `dig out a big hole here` (no recognized noun) and `make this flat` (no recognized verb, and deliberately pinned as non-actionable so the rung cannot steal a build) still fall through to an answer rather than an action. Those turns are not empty — they never ship a refusal, a promise with no action, or silence — but they are not yet the favorable result the project is aiming at. The matrix in `test/never-empty.test.mjs` records them explicitly rather than hiding them.
- The floor deliberately does not fire on review, answer-only, superseded, or plainly conversational turns. "Do something anyway" on a review would silently replace a child's finished build, and an honest "I don't know that yet" on a knowledge question has to stay honest.
- Official Microsoft documentation is not a complete gameplay encyclopedia. Fill gaps with versioned, self-authored mechanic cards backed by reproducible Bedrock tests. Do not ingest the community wiki by default without accepting its attribution, noncommercial, and share-alike requirements.
- The operator desk is not a parental-control or child-chat-audit system. Dialogue sessions are bounded and stored under hashed player keys for continuity and regression promotion, but there is no retention/consent policy, per-world protected region, semantic cache, embedding index, or broad retrieval evaluation set yet.

## License

MC Wizard is released under the [MIT License](./LICENSE). Microsoft Minecraft documentation retains its original licensing and attribution requirements; cached documentation is not committed here.

## Next proof points

1. Run a live iPad/BDS session that grades unprogrammed novel requests, confirming the procedural floor and salvage path actually land at 3 or better in play rather than only in tests.
2. Complete the remaining iPad visual checks for the wand and real-client copper-bulb transition; the Wizard skin itself is accepted.
3. Add richer project-region observation, or a visual QA model, without exposing arbitrary world commands.
4. Grow the procedural template catalog and refine silhouettes toward recognizable shapes for the subjects children ask for most.
5. Prefer a direct provider API for the primary runtime; keep local CLI providers as subscription-backed fallbacks.
6. Add a scheduled world-backup restore drill for the explicitly open private-LAN server.
7. Expand the evaluated mechanic-card catalog and build a retrieval eval set from real child questions before broadening the block allowlist or adding embeddings.
8. Replace or separately license the calculator geometry before commercial distribution.
