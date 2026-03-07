// src/jobs/nightly-scheduler.ts
import { Worker, Queue } from "bullmq";
import { ObjectId } from "mongodb";
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

// ─── Schedule per-user nightly task generation (30 min before sleep) ─────────

export async function scheduleNightlyBlocks(
  userId: ObjectId | string,
  sleepHour: number,
  sleepMinute: number,
): Promise<void> {
  // Calculate 30 minutes before sleep time
  let scheduleHour = sleepHour;
  let scheduleMinute = sleepMinute - 30;

  if (scheduleMinute < 0) {
    scheduleMinute += 60;
    scheduleHour -= 1;
    if (scheduleHour < 0) scheduleHour += 24;
  }

  const schedulerId = `nightly-blocks-${userId}`;

  await nightlySchedulerQueue.upsertJobScheduler(
    schedulerId,
    {
      pattern: `${scheduleMinute} ${scheduleHour} * * *`,
      tz: "Asia/Kolkata",
    },
    {
      name: "nightly-blocks",
      data: { userId: userId.toString() },
      opts: {
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
      },
    },
  );

  const timeStr = `${scheduleHour}:${String(scheduleMinute).padStart(2, "0")}`;
  console.log(
    `✅ Nightly scheduler upserted for user ${userId} at ${timeStr} IST (30 min before sleep)`,
  );
}

export async function removeNightlySchedule(
  userId: ObjectId | string,
): Promise<void> {
  const schedulerId = `nightly-blocks-${userId}`;
  const removed = await nightlySchedulerQueue.removeJobScheduler(schedulerId);
  if (removed) {
    console.log(`🗑️ Removed nightly scheduler for user ${userId}`);
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

export function startNightlySchedulerWorker() {
  const worker = new Worker(
    "nightly-scheduler",
    async (job) => {
      const { userId } = job.data;
      const db = getDb();

      const user = await db
        .collection("users")
        .findOne({ _id: new ObjectId(userId) });

      if (!user || !user.onboardingComplete) return;

      console.log(`🌙 Nightly scheduler running for ${user.name}`);

      try {
        // ── Check if study plan needs review ─────────────────────────────
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

        // ── Generate tomorrow's study blocks ─────────────────────────────
        if (!user.studyPlan?.blocks?.length) {
          console.log(`  ⏭️ No study plan for ${user.name}, skipping`);
          return;
        }

        const result = await generateDailyBlocks(user._id);

        if (result.created > 0) {
          const blockList = result.blocks
            .map(
              (b) =>
                `${getEmoji(b.subject)} ${b.title} — ${fmtTime(b.start)}`,
            )
            .join("\n");

          const totalMinutes = result.blocks.reduce((sum, b) => {
            const diff = b.end.getTime() - b.start.getTime();
            return sum + Math.round(diff / 60000);
          }, 0);
          const totalHours = Math.round((totalMinutes / 60) * 10) / 10;

          await bot.sendMessage(
            user.telegramChatId,
            `🌙 <b>Tomorrow's schedule is ready</b>\n\n` +
            `${blockList}\n\n` +
            `📊 ${result.created} blocks · ${totalHours}h of study\n` +
            `I'll remind you 5 min before each block.\n\n` +
            `Sleep well! 😴`,
            { parse_mode: "HTML" },
          );

          console.log(
            `  ✅ Created ${result.created} blocks for ${user.name}`,
          );
        } else {
          console.log(
            `  ⏭️ Blocks already exist for ${user.name}'s tomorrow`,
          );
        }
      } catch (err: any) {
        console.error(
          `❌ Nightly scheduler failed for ${user.name}: ${err.message}`,
        );
      }
    },
    { connection },
  );

  worker.on("completed", (job) => {
    console.log(`✅ Nightly blocks job completed for ${job.data.userId}`);
  });

  worker.on("failed", (job, err) => {
    captureJobError("nightly-scheduler", job, err);
  });

  console.log("✅ Nightly scheduler worker started");
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
