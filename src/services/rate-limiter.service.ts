import { getDb } from "../db";
import { connection } from "../queue";

const LIMITS = {
  MESSAGES_PER_HOUR: 30,
  MAX_MESSAGE_LENGTH: 2000,
  MAX_PHOTO_SIZE: 5 * 1024 * 1024, // 5MB
  MONTHLY_API_CALL_LIMIT: 50000,
};

// ─── Rate Limiting (connection — ephemeral) ───────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  remaining?: number;
}

export async function checkRateLimit(
  chatId: string,
  messageText?: string,
  photoSize?: number,
): Promise<RateLimitResult> {
  // Message size check
  if (messageText && messageText.length > LIMITS.MAX_MESSAGE_LENGTH) {
    console.log(`[RATE] Message too long | chatId=${chatId} | length=${messageText.length}`);
    return {
      allowed: false,
      reason: `Message too long (${messageText.length} chars). Keep it under ${LIMITS.MAX_MESSAGE_LENGTH} characters.`,
    };
  }

  // Photo size check
  if (photoSize && photoSize > LIMITS.MAX_PHOTO_SIZE) {
    console.log(`[RATE] Photo too large | chatId=${chatId} | size=${photoSize}`);
    return {
      allowed: false,
      reason: `Photo is too large. Please send a smaller image (under 5MB).`,
    };
  }

  // Per-user messages/hour
  const hourKey = `ratelimit:msg:${chatId}`;
  const count = await connection.incr(hourKey);
  if (count === 1) await connection.expire(hourKey, 3600);

  if (count > LIMITS.MESSAGES_PER_HOUR) {
    console.log(`[RATE] User rate limited | chatId=${chatId} | count=${count}`);
    return {
      allowed: false,
      reason: `You're sending too many messages. Limit is ${LIMITS.MESSAGES_PER_HOUR}/hour. Try again in a bit.`,
    };
  }

  return { allowed: true, remaining: LIMITS.MESSAGES_PER_HOUR - count };
}

// ─── API Usage Tracking (MongoDB — persistent) ──────────────────────────────

const COST_PER_MODEL: Record<string, { inputPer1K: number; outputPer1K: number }> = {
  "claude-haiku-4-5-20251001": { inputPer1K: 0.001, outputPer1K: 0.005 },
  "claude-sonnet-4-5-20250929": { inputPer1K: 0.003, outputPer1K: 0.015 },
};

export async function trackAPIUsage(
  chatId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  purpose: string,
): Promise<{ withinBudget: boolean }> {
  const today = new Date().toISOString().slice(0, 10); // "2026-03-07"
  const month = today.slice(0, 7); // "2026-03"

  const costConfig = COST_PER_MODEL[model] || { inputPer1K: 0.003, outputPer1K: 0.015 };
  const cost = (inputTokens / 1000) * costConfig.inputPer1K + (outputTokens / 1000) * costConfig.outputPer1K;

  const db = getDb();

  // Upsert daily usage doc per user
  await db.collection("apiUsage").updateOne(
    { chatId, date: today },
    {
      $inc: {
        totalCalls: 1,
        totalCost: cost,
        totalInputTokens: inputTokens,
        totalOutputTokens: outputTokens,
        [`calls.${purpose}`]: 1,
        [`tokens.${purpose}.input`]: inputTokens,
        [`tokens.${purpose}.output`]: outputTokens,
        [`cost.${purpose}`]: cost,
      },
      $setOnInsert: {
        chatId,
        date: today,
        month,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );

  // Check global monthly budget via connection counter (fast path)
  const monthKey = `usage:global:${month}`;
  const globalCount = await connection.incr(monthKey);
  if (globalCount === 1) await connection.expire(monthKey, 60 * 60 * 24 * 35);

  const withinBudget = globalCount <= LIMITS.MONTHLY_API_CALL_LIMIT;

  if (!withinBudget) {
    console.log(`[RATE] ⚠️ Monthly API budget exceeded | month=${month} | calls=${globalCount}`);
  }

  console.log(
    `[USAGE] chatId=${chatId} | model=${model} | purpose=${purpose} | ` +
    `in=${inputTokens} out=${outputTokens} | cost=$${cost.toFixed(4)} | ` +
    `monthCalls=${globalCount}`,
  );

  return { withinBudget };
}

/**
 * Check global monthly budget BEFORE making an API call.
 */
export async function checkAPIBudget(): Promise<{ allowed: boolean; callsUsed: number; limit: number }> {
  const month = new Date().toISOString().slice(0, 7);
  const monthKey = `usage:global:${month}`;
  const callsStr = await connection.get(monthKey);
  const callsUsed = parseInt(callsStr || "0");

  return {
    allowed: callsUsed < LIMITS.MONTHLY_API_CALL_LIMIT,
    callsUsed,
    limit: LIMITS.MONTHLY_API_CALL_LIMIT,
  };
}

// ─── Usage Queries (from MongoDB) ────────────────────────────────────────────

/** Get a user's usage for a specific day */
export async function getUserDailyUsage(chatId: string, date?: string) {
  const db = getDb();
  const day = date || new Date().toISOString().slice(0, 10);
  return await db.collection("apiUsage").findOne({ chatId, date: day });
}

/** Get a user's total usage for a month */
export async function getUserMonthlyUsage(chatId: string, month?: string) {
  const db = getDb();
  const m = month || new Date().toISOString().slice(0, 7);

  const result = await db.collection("apiUsage").aggregate([
    { $match: { chatId, month: m } },
    {
      $group: {
        _id: null,
        totalCalls: { $sum: "$totalCalls" },
        totalCost: { $sum: "$totalCost" },
        totalInputTokens: { $sum: "$totalInputTokens" },
        totalOutputTokens: { $sum: "$totalOutputTokens" },
        days: { $sum: 1 },
      },
    },
  ]).toArray();

  return result[0] || { totalCalls: 0, totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, days: 0 };
}

/** Get global usage across all users for a month */
export async function getGlobalMonthlyUsage(month?: string) {
  const db = getDb();
  const m = month || new Date().toISOString().slice(0, 7);

  const result = await db.collection("apiUsage").aggregate([
    { $match: { month: m } },
    {
      $group: {
        _id: null,
        totalCalls: { $sum: "$totalCalls" },
        totalCost: { $sum: "$totalCost" },
        totalInputTokens: { $sum: "$totalInputTokens" },
        totalOutputTokens: { $sum: "$totalOutputTokens" },
        uniqueUsers: { $addToSet: "$chatId" },
      },
    },
    {
      $project: {
        totalCalls: 1,
        totalCost: 1,
        totalInputTokens: 1,
        totalOutputTokens: 1,
        uniqueUsers: { $size: "$uniqueUsers" },
      },
    },
  ]).toArray();

  return result[0] || { totalCalls: 0, totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, uniqueUsers: 0 };
}

/** Get per-user usage breakdown for a month (for admin dashboard) */
export async function getAllUsersMonthlyUsage(month?: string) {
  const db = getDb();
  const m = month || new Date().toISOString().slice(0, 7);

  return await db.collection("apiUsage").aggregate([
    { $match: { month: m } },
    {
      $group: {
        _id: "$chatId",
        totalCalls: { $sum: "$totalCalls" },
        totalCost: { $sum: "$totalCost" },
        totalInputTokens: { $sum: "$totalInputTokens" },
        totalOutputTokens: { $sum: "$totalOutputTokens" },
        activeDays: { $sum: 1 },
      },
    },
    { $sort: { totalCost: -1 } },
  ]).toArray();
}