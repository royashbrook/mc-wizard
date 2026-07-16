import { createHmac } from "node:crypto";
import { appendFile, chmod, mkdir, open, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const REQUEST_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function text(value, max) {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : undefined;
}

function privateText(value, max, player) {
  const clean = text(value, max);
  const name = text(player, 64);
  if (!clean || !name) return clean;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return clean.replace(new RegExp(escaped, "gi"), "[player]");
}

function requestId(value, player) {
  return typeof value === "string" && REQUEST_ID.test(value)
    && value.toLowerCase() !== String(player).toLowerCase() ? value : undefined;
}

function actionLabel(action, player) {
  return privateText(action?.id || action?.plan?.title || action?.program?.title || action?.title || action?.type, 120, player);
}

function goalId(result, player) {
  return requestId(result?.goalId || result?.goal?.id || result?.action?.goalId, player);
}

export function createInteractionLog({
  filePath,
  salt,
  now = () => Date.now(),
  maxBytes = 2 * 1024 * 1024,
} = {}) {
  if (!filePath) throw new Error("interaction log file path is required");
  if (!salt || salt.length < 16) throw new Error("interaction log salt must be at least 16 characters");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 64 * 1024) {
    throw new Error("interaction log maxBytes must be at least 65536");
  }
  let pending = Promise.resolve();
  const playerHash = (player) => createHmac("sha256", salt).update(String(player)).digest("hex");
  const append = (entry) => {
    pending = pending.catch(() => {}).then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      const line = `${JSON.stringify(entry)}\n`;
      const lineBytes = Buffer.byteLength(line);
      let handle;
      try {
        handle = await open(filePath, "r");
        const { size } = await handle.stat();
        if (size + lineBytes > maxBytes) {
          const length = Math.min(size, Math.max(0, maxBytes - lineBytes));
          const buffer = Buffer.alloc(length);
          if (length) await handle.read(buffer, 0, length, size - length);
          let tail = buffer.toString("utf8");
          if (length < size) {
            const newline = tail.indexOf("\n");
            tail = newline < 0 ? "" : tail.slice(newline + 1);
          }
          await handle.close();
          handle = undefined;
          await writeFile(filePath, `${tail}${line}`, { encoding: "utf8", mode: 0o600 });
          await chmod(filePath, 0o600);
          return;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      } finally {
        await handle?.close();
      }
      await appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
      await chmod(filePath, 0o600);
    });
    return pending;
  };

  return {
    recordAsk({ player, question, mode, requestId: suppliedRequestId, result }) {
      const id = requestId(result?.requestId, player) || requestId(suppliedRequestId, player);
      const goal = goalId(result, player);
      const label = privateText(result?.actionLabel, 120, player) || actionLabel(result?.action, player);
      return append({
        timestamp: new Date(now()).toISOString(),
        event: "ask",
        mode: mode === "general" ? "general" : "wizard",
        playerHash: playerHash(player),
        input: privateText(question, 800, player),
        answer: privateText(result?.answer, 12_000, player),
        ...(id && { requestId: id }),
        ...(goal && { goalId: goal }),
        ...(label && { actionLabel: label }),
      });
    },
    recordActionResult({ player, requestId: suppliedRequestId, status, detail, result }) {
      const followUp = result?.replan || result?.review;
      const goal = goalId(result, player) || goalId(followUp, player);
      const label = actionLabel(followUp?.action, player);
      const safeDetail = privateText(detail, 500, player);
      const answer = privateText(followUp?.answer, 12_000, player);
      const outcome = {
        status,
        matched: Boolean(result?.matched),
        updated: Boolean(result?.updated),
        ...(result?.superseded && { superseded: true }),
        ...(result?.reviewDeferred && { reviewDeferred: true }),
        ...(result?.reviewLimitReached && { reviewLimitReached: true }),
        ...(result?.retryLimitReached && { retryLimitReached: true }),
      };
      return append({
        timestamp: new Date(now()).toISOString(),
        event: "action_result",
        playerHash: playerHash(player),
        requestId: requestId(suppliedRequestId, player),
        outcome,
        ...(safeDetail && { detail: safeDetail }),
        ...(answer && { answer }),
        ...(goal && { goalId: goal }),
        ...(label && { actionLabel: label }),
      });
    },
    recordFeedback({ player, requestId: suppliedRequestId, grade, feedback, result }) {
      const id = requestId(result?.requestId, player) || requestId(suppliedRequestId, player);
      const goal = goalId(result, player);
      const label = privateText(result?.actionLabel, 120, player) || actionLabel(result?.action, player);
      const note = privateText(feedback || result?.note, 500, player);
      const responseMode = privateText(result?.responseMode, 64, player);
      const status = ["completed", "failed"].includes(result?.status) ? result.status
        : result?.action ? "unknown" : "answered";
      const detail = privateText(result?.detail, 500, player);
      const followUpId = requestId(result?.followUp?.requestId, player);
      const followUpAnswer = privateText(result?.followUp?.answer, 12_000, player);
      const followUpLabel = actionLabel(result?.followUp?.action, player);
      const followUp = followUpId || followUpAnswer || followUpLabel ? {
        ...(followUpId && { requestId: followUpId }),
        ...(followUpAnswer && { answer: followUpAnswer }),
        ...(followUpLabel && { actionLabel: followUpLabel }),
      } : undefined;
      return append({
        timestamp: new Date(now()).toISOString(),
        event: "feedback",
        playerHash: playerHash(player),
        requestId: id,
        grade,
        ...(note && { note }),
        ...(goal && { goalId: goal }),
        ...(responseMode && { responseMode }),
        ...(label && { actionLabel: label }),
        outcome: { status, ...(detail && { detail }) },
        ...(followUp && { followUp }),
      });
    },
  };
}

export async function readRecentInteractions(filePath, { limit = 80, maxBytes = 256 * 1024 } = {}) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const { size } = await handle.stat();
    if (!size) return [];
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let value = buffer.toString("utf8");
    if (length < size) value = value.slice(value.indexOf("\n") + 1);
    return value.split("\n").filter(Boolean).slice(-limit).flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return entry && typeof entry === "object" && !Array.isArray(entry) ? [entry] : [];
      } catch {
        return [];
      }
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close();
  }
}
