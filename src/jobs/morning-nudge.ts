// src/jobs/morning-nudge.ts
// Sends a morning message to users at their wake time.
// If tasks exist for today: shows summary.
// If no tasks: nudges them to plan their day.

import { Worker, Queue } from "bullmq";
import { connection } from "../queue.js";
import { getDb } from "../db.js";
import { bot } from "../services/telegram.service.js";
import { captureJobError } from "../services/monitoring.service.js";
import { getUserCurrentDayCycle } from "../services/profile.service.js";
import { formatTime } from "../utils/timezone.js";

export const morningNudgeQueue = new Queue("morning-nudge", { connection });

// ─── Setup: hourly check that matches user wake times ────────────────────────

export async function setupMorningNudge(): Promise<void> {
  await morningNudgeQueue.upsertJobScheduler(
    "morning-global",
    {
      pattern: "0 * * * *", // every hour
      tz: "Asia/Kolkata",
    },
    {
      name: "morning-nudge-check",
      data: {},
      opts: { removeOnComplete: true, removeOnFail: false },
    },
  );

  console.log("✅ Morning nudge scheduler set up (hourly check)");
}

// ─── Worker ──────────────────────────────────────────────────────────────────

export function startMorningNudgeWorker() {
  const worker = new Worker(
    "morning-nudge",
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

      // Find users whose wake hour matches current hour
      // Three sources of wake time, checked in priority order:
      // 1. Explicit wakeTime from profile (HH:MM string)
      // 2. sleepSchedule.wakeHour
      // 3. Default: 8am for users with neither

      // Users with sleepSchedule.wakeHour matching
      const usersWithSleep = await db
        .collection("users")
        .find({
          "sleepSchedule.wakeHour": currentHour,
        })
        .toArray();

      // Users with explicit wakeTime matching (HH:MM format)
      const wakeTimePattern = `${currentHour.toString().padStart(2, "0")}:`;
      const usersWithWakeTime = await db
        .collection("users")
        .find({
          sleepSchedule: null,
          wakeTime: { $regex: `^${wakeTimePattern}` },
        })
        .toArray();

      // Users with no wake info at all — default to 8am
      let usersDefault: any[] = [];
      if (currentHour === 8) {
        usersDefault = await db
          .collection("users")
          .find({
            sleepSchedule: null,
            wakeTime: null,
            "profile.wakeTime": null,
          })
          .toArray();
      }

      const allUsers = [...usersWithSleep, ...usersWithWakeTime, ...usersDefault];

      // Dedupe by chatId
      const seen = new Set<string>();
      const users = allUsers.filter((u) => {
        if (seen.has(u.telegramChatId)) return false;
        seen.add(u.telegramChatId);
        return true;
      });

      if (users.length === 0) return;

      console.log(
        `☀️ Morning nudge: ${users.length} users at wake hour ${currentHour}`,
      );

      for (const user of users) {
        try {
          if (!user.onboardingComplete && !user.studyPlan) {
            const taskCount = await db.collection("actionStations").countDocuments({ userId: user._id });
            if (taskCount === 0) continue;
          }
          await sendMorningMessage(user, db);
        } catch (err: any) {
          console.error(
            `❌ Morning nudge failed for ${user.name}: ${err.message}`,
          );
          captureJobError("morning_nudge", user._id, err);
        }
      }
    },
    { connection },
  );

  worker.on("failed", (_, err) =>
    console.error(`❌ Morning nudge worker: ${err.message}`),
  );
  console.log("✅ Morning nudge worker started");
}

// ─── Send the actual morning message ─────────────────────────────────────────

async function sendMorningMessage(user: any, db: any): Promise<void> {
  const dayCycle = getUserCurrentDayCycle(user);

  const todayTasks = await db
    .collection("actionStations")
    .find({
      userId: user._id,
      scheduledStart: {
        $gte: dayCycle.startDateTime,
        $lte: dayCycle.endDateTime,
      },
    })
    .sort({ scheduledStart: 1 })
    .toArray();

  const name = user.profile?.name || user.name || "there";
  const isStrict = (user.profile?.strictnessLevel || user.strictnessLevel) === 2;

  if (todayTasks.length > 0) {
    // Has tasks — show summary
    const totalMinutes = todayTasks.reduce(
      (sum: number, t: any) => sum + (t.estimatedMinutes || 60),
      0,
    );
    const hours = Math.round(totalMinutes / 60);

    let message = `☀️ <b>Good morning${name !== "there" ? `, ${name}` : ""}!</b>\n\n`;
    message += `📅 <b>${todayTasks.length} blocks today</b> (${hours}h)\n\n`;

    todayTasks.forEach((task: any) => {
      const time = formatTime(task.scheduledStart);
      const emoji = task.emoji || "📋";
      message += `${emoji} ${time} — ${task.title} (${task.estimatedMinutes || 60}min)\n`;
    });

    const firstTask = todayTasks[0];
    const firstTime = formatTime(firstTask.scheduledStart);
    message += `\nFirst block at <b>${firstTime}</b>. I'll remind you 5 min before.`;

    await bot.sendMessage(user.telegramChatId, message, {
      parse_mode: "HTML",
    });
  } else {
    // No tasks — nudge to plan
    const greeting = isStrict
      ? `☀️ <b>${name}</b>, no tasks set for today. That's a wasted day unless you fix it now.`
      : `☀️ <b>Good morning${name !== "there" ? `, ${name}` : ""}!</b> You don't have anything scheduled today.`;

    const cta = `\nTell me what you're studying, or send your timetable and I'll set it up.`;

    await bot.sendMessage(user.telegramChatId, `${greeting}${cta}`, {
      parse_mode: "HTML",
    });
  }
}