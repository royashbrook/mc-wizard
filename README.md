# MC Wizard

A Bedrock-first spike for an AI Minecraft teacher that can answer questions from versioned sources and request safe, allow-listed demonstrations in a child's world.

The intended vertical slice is:

```text
iPad / Bedrock chat
  → official Bedrock Dedicated Server
  → MC Wizard behavior pack
  → visible MC Wizard SimulatedPlayer (an official Player subclass)
  → local HTTP brain
  → Bedrock RAG + optional external model
  → typed, allow-listed action
  → MC Wizard walks, looks, chats, holds, and places the approved blocks
```

Status: the Node brain, 30,877-chunk corpus, HTTP bridge, provider adapters, Apple-container BDS, fresh Beta-APIs world, behavior pack, two visible `SimulatedPlayer` entities, addressed engine chat, brain requests, and typed build actions have all been observed locally. The headless run passes the Wizard's complete 334-action calculator build, scaffold cleanup, one Test Kid lever raycast, and all 16 sums. The five-part T-flip-flop build passes structurally, but BDS 1.26.33.2 does not toggle its copper-bulb `lit` state through the synthetic pulse, so real iPad interaction remains its acceptance test.

Ask `wizard, build me something that changes every time I press a button` and the brain returns a kid-friendly explanation, cites the retrieved material, and emits the typed action for a Bedrock copper-bulb T flip-flop. The visible MC Wizard is designed to walk to the demonstration site and place the approved blocks once the BDS prerequisite above is available.

## What is here

- A dependency-free Node HTTP service with authentication, input limits, timeouts, and an offline mode.
- Local retrieval over self-authored mechanic cards plus cached official documentation.
- A sync job for the [Microsoft Minecraft Creator documentation](https://github.com/MicrosoftDocs/minecraft-creator) and separate [stable](https://feedback.minecraft.net/hc/en-us/sections/360001186971-Release-Changelogs) / [preview](https://feedback.minecraft.net/hc/en-us/sections/360001185332) changelogs.
- OpenAI Responses API support and an OpenAI-compatible Chat Completions mode for other providers.
- A current Bedrock 26.30+ behavior pack using `@minecraft/server`, `@minecraft/server-gametest`, `@minecraft/server-net`, and `@minecraft/server-admin`.
- A visible, server-created MC Wizard based on Bedrock's official [`SimulatedPlayer`](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server-gametest/simulatedplayer?view=minecraft-bedrock-experimental), which extends `Player` and can walk, look, chat, hold items, and perform player block interactions.
- Two real build actions performed through the embodied wizard's player APIs: a bounded copper-bulb T flip-flop and a two-bit redstone calculator.
- A safe action boundary: model prose cannot become commands or JavaScript. The behavior pack recognizes one exact action ID and runs fixed code.
- A pack installer that preserves other activated behavior packs in an existing BDS world.

## Run the brain

Requires Node 22.9 or newer.

```bash
cp .env.example .env
npm install
npm run hooks:install
npm test
npm start
```

Commits are issue-driven. The tracked `commit-msg` hook rejects messages without a reference to an existing issue in this repository. Use a message such as `Improve dialogue sessions (Refs #8)`.

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

The service sends the question and retrieved excerpts, not the player's coordinates. The player name is used only to derive a salted `safety_identifier` for OpenAI.

For the local subscription-backed bridge used by this spike, start this first:

```bash
npm run start:ai
```

`mtok-bridge` provides the OpenAI-compatible transport. Its upstream is the authenticated local Claude CLI running with `--safe-mode`, an empty tool list, and no session persistence. It receives only the model prompt: it cannot read files, run commands, load project customizations, or act in Minecraft. Then start the brain with `npm start`.

In game, `ai <question>` always means this general model route. It requires the `ai` keyword even when the player is alone or beside the Wizard, skips Minecraft RAG and Wizard actions, and prefixes short replies with `[Claude]`. Replies over 700 characters are placed in a signed book at the player's feet. Ordinary chat and `wiz`/`wizard` continue through the Minecraft-specialist route.

## Load official knowledge

```bash
npm run sync:docs
```

This command:

1. shallow-clones or updates `MicrosoftDocs/minecraft-creator` under ignored `.cache/`;
2. caches stable and preview changelogs into separate directories;
3. records the documentation commit and sync time;
4. lets the service index the new Markdown on its next start.

It requires Git and internet access. The first sync downloads roughly 8,800 repository files plus 712 changelog articles. The resulting `.cache/` is intentionally ignored: this workspace currently indexes 30,876 chunks, but a fresh clone must run `npm run sync:docs` to recreate that corpus. Before syncing, only the four authored mechanic cards are available.

Normal retrieval excludes preview material unless the question explicitly says preview, beta, or experimental. Current docs and tested mechanic cards rank above patch notes for ordinary mechanics questions. The spike uses a small exact-term/TF-IDF-style in-memory index; embeddings and a persistent vector store are intentionally deferred until retrieval evals show they improve answers.

Microsoft's repository licenses documentation under CC BY 4.0 and code samples under MIT. Preserve attribution and revision URLs. Changelog content has no explicit open-content license, so keep that cache private and return links rather than redistributing a corpus.

## Run with Bedrock

The correct base is the official Bedrock Dedicated Server, not a Java bridge or a reimplementation of the changing Bedrock protocol. Microsoft officially supports BDS on Windows and Ubuntu, not macOS.

The behavior pack uses beta chat, HTTP, and [`@minecraft/server-gametest`](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server-gametest/minecraft-server-gametest?view=minecraft-bedrock-experimental) APIs. The world must have the **Beta APIs** experiment enabled before moving it to BDS; there is no supported server property that turns this experiment on afterward. Pin the BDS and API versions after the first passing in-world test because beta APIs can change between releases.

### The embodied wizard

When a real player joins, the behavior pack is set up to spawn one `MC Wizard` near that player. This is a server-side `SimulatedPlayer`, not a custom mob wearing a player-shaped model: it is an actual subclass of Bedrock's `Player`. It uses the normal player rendering path and can navigate, turn to look at a child, speak under its own name, carry selected items, and place or interact with blocks as a player.

The embodiment does not need a separate resource pack or a second Xbox/Microsoft account. It does require the behavior pack, a Beta-APIs-enabled world, and the pre-release GameTest Script API. These capabilities are documented by Microsoft, but they have not yet been observed from an iPad against this spike's BDS world.

Address the character in chat:

- `wizard, <question or request>` asks a knowledge or build question.
- `wizard, come here` asks MC Wizard to walk to the speaker and face them.
- `wizard, stay` stops its current movement.

The movement commands control only the embodied character. Build requests still cross the typed allow-list: the model cannot invent commands, arbitrary JavaScript, block coordinates, or unbounded builds.

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
2. Choose the Mac's private LAN IPv4 first. Copy `.env.example` to `.env`, set `HOST` to that literal address (not `0.0.0.0`), replace `BRIDGE_TOKEN` with at least 24 random characters, and run `npm start`. The brain refuses to bind beyond loopback with a default or short token.
3. Supply the Mac's private LAN IPv4 and explicitly opt into an open server on that private network:

   ```bash
   export MC_WIZARD_LAN_IP=192.168.x.x
   export MC_WIZARD_OPEN_LAN=1
   ```

4. Activate/configure the behavior pack while BDS is stopped, then launch the pinned image/BDS version:

   ```bash
   npm run install:pack -- runtime/bedrock mc-wizard \
     "http://${MC_WIZARD_LAN_IP}:3000/v1/ask"
   npm run container:bds
   npm run container:logs
   ```

5. Add the server manually on each iPad using the Mac LAN IPv4 and UDP port `19132`; LAN discovery broadcasts may not cross the container VM. Do not forward this port on the router for the spike.

Approve the macOS Local Network/incoming-connections prompt if it appears. In the logs, wait for both `IPv4 supported, port: 19132` and `Server started.` before joining. Open-LAN mode still requires Microsoft authentication, binds only to the Mac's exact RFC1918 address, and must not be forwarded on the router. Anyone who can reach that private network can join until the container is stopped.

Stop BDS cleanly with `npm run container:stop`; later starts use `container start mc-wizard-bedrock`. `container start` preserves the old image, BDS version, port, and access mode. After any configuration change: stop BDS; update `.env` and restart the brain; then rerun `install:pack` while BDS is stopped. For a token-only change, run `container start mc-wizard-bedrock`. If the LAN bind, access mode, image digest, or BDS `VERSION` changed, run `npm run container:delete` and then `npm run container:bds`. Deleting the container does not delete the bind-mounted world in `runtime/bedrock`.

The launcher refuses an address that is not a private IPv4 assigned to this Mac or a missing world. It requires either an explicit `MC_WIZARD_OPEN_LAN=1` opt-in or a valid allowlist; `ONLINE_MODE=true` remains enforced. It pins both the OCI image digest and BDS 1.26.33.2 so a restart cannot silently cross a beta-API boundary. `compose.yaml` remains a Docker-compatible alternative, but Apple container is the prepared macOS route.

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

It installs the gated harness with a unique run ID, launches a unique Apple container with no published port, and always stops/deletes that container and disables the gate afterward. Raw BDS output is saved to ignored `runtime/bedrock/e2e-last.log`.

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

The brain returns prose, provenance, and an optional typed action:

```json
{
  "answer": "A T flip-flop stores one bit...",
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

The Bedrock adapter ignores every action except the exact allow-listed type, ID, and version above.

## Why this differs from the reference bot

[`danshorstein/minecraft-ai-bot`](https://github.com/danshorstein/minecraft-ai-bot) is an MIT-licensed Java/Paper companion built around Mineflayer, a large prompt cookbook, OpenRouter tool calls, and OP slash commands. Its best transferable ideas are structured tools, deterministic skills, fixed build anchors, serialized work, and separate planning/verification roles.

Mineflayer, Paper setup, Java NBT/commands, and raw OP command execution do not transfer to Bedrock. MC Wizard keeps the structured-skill idea but uses Bedrock's official beta `SimulatedPlayer` for the visible character and puts its actions behind a strict Script API compiler. It does not log in a headless protocol client or hold credentials for a second Xbox account. No source code from the reference project is copied here.

## Known limits of this spike

- The automated Node tests and HTTP bridge pass, and BDS has created both SimulatedPlayers and routed Test Kid's addressed chat to the brain. Neither character has yet been seen or controlled from an iPad.
- The T flip-flop and two-bit calculator actions have no undo. They require bounded, clear natural-ground areas and refuse occupied or constructed sites. Complete player-style placement and the calculator truth table pass headlessly; the T-flip-flop's real-client copper-bulb transition still needs the iPad check.
- The current documented Script API cannot program command-block command text dynamically. Prepared `.mcstructure` lessons can preserve command-block data; novel lessons must place the wiring and tell the child what to paste, or emulate the behavior in script.
- Official Microsoft documentation is not a complete gameplay encyclopedia. Fill gaps with versioned, self-authored mechanic cards backed by reproducible Bedrock tests. Do not ingest the community wiki by default without accepting its attribution, noncommercial, and share-alike requirements.
- There is no parental-control UI, durable child-chat audit policy, per-world protected region, undo transaction, semantic cache, embedding index, or retrieval evaluation set yet. The current E2E harness covers the in-world vertical slice only.

## License

MC Wizard is released under the [MIT License](./LICENSE). Microsoft Minecraft documentation retains its original licensing and attribution requirements; cached documentation is not committed here.

## Next proof points

1. Complete the iPad/BDS acceptance checklist above, including the real-client copper-bulb transition.
2. Add restart/backup recovery checks for the explicitly open private-LAN server.
3. Add undo/protected regions before any larger build action.
4. Replace or separately license the calculator geometry before commercial distribution.
5. Build a retrieval eval set from real questions from one Bedrock-playing child; add embeddings only if the lexical baseline misses them.
