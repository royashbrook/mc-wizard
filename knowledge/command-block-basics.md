---
title: Bedrock command block basics
source: https://learn.microsoft.com/en-us/minecraft/creator/documents/commandblocks?view=minecraft-bedrock-stable
edition: bedrock
channel: stable
version: current
kind: mechanic-card
---

# Bedrock command block basics

Command blocks run Minecraft Bedrock commands. Use them in a creative test world with cheats enabled. Obtain one with `/give @s command_block`; command blocks are intentionally unavailable from the normal creative inventory.

## Three block types

- Impulse runs its command once when triggered.
- Repeat runs its command every game tick while active. Twenty game ticks normally pass each second, so careless repeating commands can create noise or lag.
- Chain runs after a command block pointing into it has run.

Each command block can be Conditional or Unconditional and Needs Redstone or Always Active. Start with a harmless command such as `/say hello`, confirm the direction of a chain, and only then replace it with a world-changing command.

Bedrock command syntax is not interchangeable with Java Edition syntax. Java NBT examples are especially likely to fail in Bedrock.

The current Script API can place command block blocks but does not expose a documented component for changing their command text. MC Wizard should use tested structures for prepared command-block lessons, or place the wiring and tell the player exactly what to paste.
