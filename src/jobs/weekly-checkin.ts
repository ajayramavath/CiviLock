// src/jobs/weekly-checkin.ts
import { Worker } from "bullmq";
import { ObjectId } from "mongodb";
import { connection } from "../queue.js";
import { getDb } from "../db.js";
import { generateWeeklyCheckInResponse } from "../services/agent.service.js";
import { sendTelegramMessage } from "../services/telegram.service.js";
import {
  getWeeklySubjectStats,
  getAvoidanceAlerts,
} from "../services/analytics.service.js";
import { captureJobError } from "../services/monitoring.service.js";
import { trackEvent } from "../services/posthog.service.js";

// ─── Worker ──────────────────────────────────────────────────────────────────

export function startWeeklyCheckInWorker() {
  const worker = new Worker(
    "weekly-checkIn",
    async (job) => {
      const { userId } = job.data;
      const db = getDb();

      const user = await db
        .collection("users")
        .findOne({ _id: new ObjectId(userId) });

      if (!user) return;

      if (!user.onboardingComplete && !user.studyPlan) {
        const taskCount = await db.collection("actionStations").countDocuments({ userId: user._id });
        if (taskCount === 0) return;
      }

      console.log(`📊 Running weekly check-in for ${user.name}`);
      const onboardedAt = user.createdAt ? new Date(user.createdAt) : undefined;

      try {
        const stats = await getWeeklySubjectStats(user._id, onboardedAt);
        const avoidance = await getAvoidanceAlerts(user._id, onboardedAt);

        // Build weekly context for AI
        let weeklyContext = `WEEKLY CHECK-IN CONTEXT:\n`;
        weeklyContext += `\nUser: ${user.name}`;
        weeklyContext += `\nStrictness: ${user.strictnessLevel === 2 ? "Strict Mentor" : "Study Partner"}`;

        // Overall stats
        weeklyContext += `\n\nOVERALL:`;
        weeklyContext += `\nBlocks: ${stats.completedBlocks}/${stats.totalBlocks} completed (${stats.completionRate}%)`;
        weeklyContext += `\nHours: ${stats.completedHours}h completed / ${stats.totalHours}h scheduled / ${stats.skippedHours}h skipped`;
        weeklyContext += `\nStreak: ${stats.currentStreak} days`;

        if (stats.previousWeekRate !== null) {
          const diff = stats.completionRate - stats.previousWeekRate;
          weeklyContext += `\nLast week: ${stats.previousWeekRate}% (${diff > 0 ? "+" : ""}${diff}% change)`;
        }

        // Per-subject breakdown
        if (stats.subjects.length > 0) {
          weeklyContext += `\n\nSUBJECT-WISE HOURS:`;
          for (const s of stats.subjects) {
            const compH = Math.round((s.completedMinutes / 60) * 10) / 10;
            const schedH = Math.round((s.totalMinutes / 60) * 10) / 10;
            const skipH = Math.round((s.skippedMinutes / 60) * 10) / 10;
            weeklyContext += `\n  ${s.subject}: ${compH}h / ${schedH}h (${s.completionRate}%)`;
            if (skipH > 0) weeklyContext += ` — ${skipH}h skipped`;
          }
        }

        // Avoidance
        if (avoidance.length > 0) {
          weeklyContext += `\n\nAVOIDANCE ALERTS:`;
          for (const a of avoidance) {
            weeklyContext += `\n  ${a.subject}: skipped ${a.skipCount} times this week`;
          }
        }

        // Weak subjects
        if (user.upscProfile?.weakSubjects?.length > 0) {
          const weakNotStudied = user.upscProfile.weakSubjects.filter(
            (ws: string) => {
              const short = ws.split(" (")[0];
              const stat = stats.subjects.find((s) => s.subject === short);
              return !stat || stat.completedMinutes < 60;
            },
          );
          if (weakNotStudied.length > 0) {
            weeklyContext += `\n\nWEAK SUBJECTS WITH <1h: ${weakNotStudied.map((s: string) => s.split(" (")[0]).join(", ")}`;
          }
        }

        // Prelims countdown
        const days = user.upscProfile
          ? daysUntilPrelims(user.upscProfile.targetYear)
          : null;
        if (days !== null) {
          weeklyContext += `\n\nDays until Prelims: ${days}`;
        }

        // Generate AI weekly review
        const response = await generateWeeklyCheckInResponse(
          user,
          weeklyContext,
        );

        const formattedResponse = response
          .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
          .replace(/\*(.*?)\*/g, "<i>$1</i>");

        console.log(`\n📊 Weekly review for ${user.name}:\n${response}\n`);

        // Build the message
        const countdown =
          days !== null ? `\n⏰ <b>${days} days until Prelims</b>` : "";

        // Subject breakdown table
        let subjectBreakdown = "";
        if (stats.subjects.length > 0) {
          subjectBreakdown += `\n\n📚 <b>Subject-wise Hours:</b>`;
          const sorted = [...stats.subjects].sort(
            (a, b) => b.totalMinutes - a.totalMinutes,
          );
          for (const s of sorted) {
            const compH = Math.round((s.completedMinutes / 60) * 10) / 10;
            const schedH = Math.round((s.totalMinutes / 60) * 10) / 10;
            const icon =
              s.completionRate >= 80
                ? "🟢"
                : s.completionRate >= 50
                  ? "🟡"
                  : "🔴";
            let line = `\n${icon} <b>${s.subject}</b>: ${compH}h / ${schedH}h (${s.completionRate}%)`;
            if (s.skippedMinutes > 0) {
              const skipH = Math.round((s.skippedMinutes / 60) * 10) / 10;
              line += ` — ${skipH}h skipped`;
            }
            subjectBreakdown += line;
          }
        }

        // Avoidance alerts
        let avoidanceSection = "";
        if (avoidance.length > 0) {
          avoidanceSection += `\n\n⚠️ <b>Avoidance Alerts:</b>`;
          for (const a of avoidance) {
            avoidanceSection += `\n🔴 <b>${a.subject}</b>: skipped ${a.skipCount} times`;
          }
        }

        // Week-over-week trend
        let trend = "";
        if (stats.previousWeekRate !== null) {
          const diff = stats.completionRate - stats.previousWeekRate;
          const arrow = diff > 0 ? "📈" : diff < 0 ? "📉" : "➡️";
          trend = `\n${arrow} vs last week: ${diff > 0 ? "+" : ""}${diff}%`;
        }

        const message =
          `📊 <b>Weekly Review</b>${countdown}\n\n` +
          `📋 <b>${stats.completedBlocks}/${stats.totalBlocks}</b> blocks · ` +
          `${stats.completedHours}h completed / ${stats.totalHours}h scheduled` +
          `${stats.skippedHours > 0 ? ` / ${stats.skippedHours}h skipped` : ""}` +
          `\n🔥 Streak: ${stats.currentStreak} day${stats.currentStreak !== 1 ? "s" : ""}` +
          `${trend}` +
          `${subjectBreakdown}` +
          `${avoidanceSection}\n\n` +
          `${formattedResponse}`;

        await sendTelegramMessage(user._id, message, "HTML");

        trackEvent(user.telegramChatId, "weekly_checkin_sent", {
          completionRate: stats.completionRate,
          totalHours: stats.totalHours,
          completedHours: stats.completedHours,
          skippedHours: stats.skippedHours,
          streakDays: stats.currentStreak,
          subjectCount: stats.subjects.length,
          avoidanceCount: avoidance.length,
        });
      } catch (err: any) {
        console.error(
          `❌ Weekly check-in failed for ${user.name}: ${err.message}`,
        );
      }
    },
    { connection },
  );

  worker.on("completed", (job) =>
    console.log(`✅ Weekly check-in completed for ${job.data.userId}`),
  );

  worker.on("failed", (job, err) => {
    captureJobError("weekly-checkIn", job, err);
  });

  console.log("✅ Weekly check-in worker started");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysUntilPrelims(targetYear: number): number | null {
  const may = new Date(targetYear, 4, 31);
  const dayOfWeek = may.getDay();
  const lastSunday = new Date(may);
  lastSunday.setDate(may.getDate() - dayOfWeek);
  const diff = lastSunday.getTime() - Date.now();
  return diff > 0 ? Math.ceil(diff / (1000 * 60 * 60 * 24)) : null;
}
