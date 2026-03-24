// src/jobs/nightly-scheduler.ts
// Runs every hour. For users whose "night time" is now:
// 1. Check if plan needs review → send reminder
// 2. Generate tomorrow's blocks from template
// 3. Send summary notification
//
// Handles three types of users:
// - Users with sleepSchedule.sleepHour → triggers at their sleep hour
// - Users with no sleepSchedule but have a plan → triggers at 10pm IST (default)

import { Worker, Queue } from "bullmq";
import { connection } from "../queue.js";
import { getDb } from "../db.js";
import {
  generateDailyBlocks,
  shouldReviewPlan,
} from "../services/study-plan.service.js";
import { bot } from "../services/telegram.service.js";
import { captureJobError } from "../services/monitoring.service.js";

export const nightlySchedulerQueue = new Queue("nightly-scheduler", {
  connection,
});

// ─── Per-user scheduling (called from callback handler on schedule confirm) ──

export async function scheduleNightlyBlocks(
  userId: any,
  sleepHour: number,
  sleepMinute: number,
): Promise<void> {
  // This is a no-op now — the global hourly check handles everything.
  // Kept for backward compatibility with callback.handler.ts.
  console.log(
    `[Nightly] scheduleNightlyBlocks called for user ${userId} (sleep ${sleepHour}:${sleepMinute}) — handled by global scheduler`,
  );
}

// ─── Global setup: hourly check ──────────────────────────────────────────────

export async function setupNightlyScheduler(): Promise<void> {
  await nightlySchedulerQueue.upsertJobScheduler(
    "nightly-global",
    {
      pattern: "0 * * * *", // every hour on the hour
      tz: "Asia/Kolkata",
    },
    {
      name: "nightly-schedule-check",
      data: {},
      opts: { removeOnComplete: true, removeOnFail: false },
    },
  );
  console.log("✅ Nightly scheduler set up (hourly check)");
}

// ─── Worker ──────────────────────────────────────────────────────────────────

export function startNightlySchedulerWorker() {
  const worker = new Worker(
    "nightly-scheduler",
    async () => {
      const db = getDb();
      const now = new Date();
      const currentHour = parseInt(
        now.toLocaleString("en-US", {
          timeZone: "Asia/Kolkata",
          hour: "numeric",
          hour12: false,
        }),
      );

      // ── Group 1: Users with sleepSchedule matching current hour ────
      const usersWithSleep = await db
        .collection("users")
        .find({
          "studyPlan.blocks": { $exists: true, $not: { $size: 0 } },
          "sleepSchedule.sleepHour": currentHour,
        })
        .toArray();

      // ── Group 2: Users without sleepSchedule → default to 12am ──
      let usersDefault: any[] = [];
      if (currentHour === 0) {
        usersDefault = await db
          .collection("users")
          .find({
            "studyPlan.blocks": { $exists: true, $not: { $size: 0 } },
            sleepSchedule: null,
          })
          .toArray();
      }

      const allUsers = [...usersWithSleep, ...usersDefault];

      // Dedupe
      const seen = new Set<string>();
      const users = allUsers.filter((u) => {
        const id = u._id.toString();
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      if (users.length === 0) return;

      console.log(
        `🌙 Nightly scheduler: ${users.length} users at hour ${currentHour}`,
      );

      for (const user of users) {
        try {
          await processNightlyForUser(user, db);
        } catch (err: any) {
          console.error(`❌ Nightly ${user.name}: ${err.message}`);
          captureJobError("nightly_scheduler", user._id, err);
        }
      }
    },
    { connection },
  );

  worker.on("failed", (_, err) =>
    console.error(`❌ Nightly scheduler: ${err.message}`),
  );
  console.log("✅ Nightly scheduler worker started");
}

// ─── Per-user nightly processing ─────────────────────────────────────────────

async function processNightlyForUser(user: any, db: any): Promise<void> {
  // 1. Check plan review
  if (user.studyPlan) {
    const review = shouldReviewPlan(user.studyPlan);

    if (review === "now") {
      await bot.sendMessage(
        user.telegramChatId,
        `📋 <b>Time to check your study plan.</b>\n\n` +
        `Your current schedule: <i>${user.studyPlan.scope.description}</i>\n\n` +
        `Is this still what you're following? If your schedule has changed, send me the new one — text or photo.\n\n` +
        `If it's still good, just say "same schedule" and I'll keep going.`,
        { parse_mode: "HTML" },
      );
    } else if (review === "soon") {
      await bot.sendMessage(
        user.telegramChatId,
        `⏳ Heads up — I'll be checking in on your study plan soon. If anything's changed, send the updated schedule anytime.`,
      );
    }
  }

  // 2. Generate tomorrow's blocks
  const result = await generateDailyBlocks(user._id);

  if (result.created > 0) {
    const blockList = result.blocks
      .map((b) => `${getEmoji(b.subject)} ${b.title} — ${fmtTime(b.start)}`)
      .join("\n");

    const name = user.profile?.name || user.name || "";
    await bot.sendMessage(
      user.telegramChatId,
      `🌙 <b>Tomorrow's ready${name ? `, ${name}` : ""}</b>\n\n` +
      `${result.created} blocks scheduled:\n\n${blockList}\n\n` +
      `I'll remind you before each one. Sleep well.`,
      { parse_mode: "HTML" },
    );

    console.log(`  ✅ ${user.name}: ${result.created} blocks generated`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEmoji(s: string | null): string {
  if (!s) return "📋";
  const m: Record<string, string> = {
    GS1: "📚",
    GS2: "📚",
    GS3: "📚",
    GS4: "📚",
    Essay: "📝",
    CSAT: "🧮",
    "Optional Subject": "📚",
    "Current Affairs": "📰",
    "Answer Writing": "✍️",
  };
  return m[s] || "📋";
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}