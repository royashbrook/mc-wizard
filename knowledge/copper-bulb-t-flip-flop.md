---
title: Copper bulb T flip-flop
source: https://feedback.minecraft.net/hc/en-us/articles/27451789924237-Minecraft-Bedrock-Edition-1-21-Tricky-Trials
edition: bedrock
channel: stable
version: 1.21+
kind: mechanic-card
---

# Copper bulb T flip-flop

A T flip-flop stores one binary state. Each distinct input pulse toggles that state: off becomes on, and on becomes off. It is useful when a momentary button should control something that stays in its new state.

In Bedrock 1.21 and later, a copper bulb is itself a compact T flip-flop. A redstone pulse toggles the bulb's lit state, and that state remains after the input loses power. The input must return to zero before another pulse can toggle it again.

## Small teaching build

1. Place a copper bulb.
2. Attach a button to the bulb.
3. Press the button repeatedly and watch the bulb remember its alternating state.
4. For an electrical output, place a comparator with its rear touching the bulb and its front pointing toward the output.
5. Run redstone dust from the comparator.

The comparator outputs strength 15 while the bulb is lit and 0 while it is dark. The copper bulb does not conduct redstone power, so read its stored state with a comparator when another circuit needs the result.

Waxing the bulb is optional. Wax preserves its visual oxidation stage; it does not create the toggle behavior.
