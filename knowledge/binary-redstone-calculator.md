---
title: Two-bit redstone calculator
edition: bedrock
channel: stable
version: 1.26
source: https://learn.microsoft.com/en-us/minecraft/creator/documents/redstoneguide
---

# Two-bit redstone calculator

A small calculator can add two unsigned binary numbers using only ordinary support blocks and redstone components. It does not need commands, observers, pistons, or scripted calculation after construction.

Use four levers for the inputs `A2`, `B2`, `A1`, and `B1`. Here `A2` and `B2` are worth two; `A1` and `B1` are worth one. Therefore each input number ranges from zero through three.

Two chained full-adder modules calculate:

```text
sum = A XOR B XOR carry-in
carry-out = (A AND B) OR (carry-in AND (A XOR B))
```

The low-bit module adds the one-value levers. Its carry feeds the high-bit module, which adds the two-value levers. Three output lamps represent values four, two, and one, so `100` is four and `110` is six.

Useful checks are `0+0=000`, `1+1=010`, `1+3=100`, `2+3=101`, and `3+3=110`. Testing `1+3` is especially useful because it proves the carry travels from the low-bit adder into the high-bit adder.

The spike's compact full-adder geometry is adapted with attribution from [Minecraft Wiki's Full adder 1](https://minecraft.wiki/w/Tutorial:Arithmetic_logic/Full_adder_1), whose content is CC BY-NC-SA 3.0. Keep the calculator blueprint isolated under that attribution and replace or relicense it before commercial distribution.
