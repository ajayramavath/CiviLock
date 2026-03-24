import { Worker } from "bullmq";
import { getDb } from "../db";
import { connection } from "../queue";
import { generateCheckInResponse } from "../services/agent.service";
import { ObjectId } from "mongodb";
import { sendTelegramMessage } from "../services/telegram.service";
import { captureJobError } from "../services/monitoring.service";
import { trackEvent } from "../services/posthog.service";

function daysUntilPrelims(targetYear: number): number {
  const may = new Date(targetYear, 4, 31);
  const dayOfWeek = may.getDay();
  const lastSunday = new Date(may);
  lastSunday.setDate(may.getDate() - dayOfWeek);
  const diff = lastSunday.getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

export async function startDailyCheckInWorker() {
  const worker = new Worker(
    "daily-checkIn",
    async (job) => {
      console.log(`🔔 Daily check-in for user: ${job.data.userId}`);
      const db = getDb();
      const user = await db
        .collection("users")
        .findOne({ _id: new ObjectId(job.data.userId) });

      if (!user) {
        console.log("User not found");
        return;
      }

      if (!user.onboardingComplete && !user.studyPlan) {
        const taskCount = await db.collection("actionStations").countDocuments({ userId: user._id });
        if (taskCount === 0) return;
      }

      // Get today's tasks for the summary header
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(todayStart);
      todayEnd.setDate(todayEnd.getDate() + 1);

      const todayTasks = await db
        .collection("actionStations")
        .find({
          userId: user._id,
          scheduledStart: { $gte: todayStart, $lt: todayEnd },
        })
        .toArray();

      const completed = todayTasks.filter(
        (t) => t.status === "completed",
      ).length;
      const totalTasks = todayTasks.length;
      const completedMinutes = todayTasks
        .filter((t) => t.status === "completed")
        .reduce((sum, t) => sum + (t.estimatedMinutes || 60), 0);
      const totalMinutes = todayTasks.reduce(
        (sum, t) => sum + (t.estimatedMinutes || 60),
        0,
      );

      const completedHours = Math.round(completedMinutes / 60 * 10) / 10;
      const totalHours = Math.round(totalMinutes / 60 * 10) / 10;
      const skippedMinutes = todayTasks
        .filter((t) => t.status === "skipped")
        .reduce((sum, t) => sum + (t.estimatedMinutes || 60), 0);
      const skippedHours = Math.round(skippedMinutes / 60 * 10) / 10;

      // Generate AI response using full UPSC context
      const response = await generateCheckInResponse(user);

      console.log(`\n🤖 Check-in for ${user.name}:\n${response}\n`);

      // Build the message
      const days = user.upscProfile
        ? daysUntilPrelims(user.upscProfile.targetYear)
        : null;
      const countdown = days !== null ? `\n⏰ ${days} days until Prelims` : "";

      // Per-subject hourly breakdown
      const subjectMap = new Map<string, { scheduled: number; completed: number; skipped: number }>();
      for (const task of todayTasks) {
        if (!task.subject) continue;
        const existing = subjectMap.get(task.subject) || { scheduled: 0, completed: 0, skipped: 0 };
        existing.scheduled += task.estimatedMinutes || 60;
        if (task.status === "completed") existing.completed += task.estimatedMinutes || 60;
        if (task.status === "skipped") existing.skipped += task.estimatedMinutes || 60;
        subjectMap.set(task.subject, existing);
      }

      let subjectBreakdown = "";
      if (subjectMap.size > 0) {
        subjectBreakdown += `\n\n📚 <b>Subject-wise Hours:</b>`;
        for (const [subject, data] of subjectMap) {
          const schedH = Math.round(data.scheduled / 60 * 10) / 10;
          const compH = Math.round(data.completed / 60 * 10) / 10;
          const icon = data.completed >= data.scheduled ? "✅" :
            data.completed > 0 ? "⚠️" : "❌";
          let line = `\n${icon} <b>${subject}</b>: ${compH}h / ${schedH}h`;
          if (data.skipped > 0) {
            const skipH = Math.round(data.skipped / 60 * 10) / 10;
            line += ` (${skipH}h skipped)`;
          }
          subjectBreakdown += line;
        }
      }

      const formattedResponse = response
        .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
        .replace(/\*(.*?)\*/g, "<i>$1</i>");

      const message =
        `🔔 <b>Daily Check-in</b>${countdown}\n\n` +
        `📊 <b>${completed}/${totalTasks}</b> blocks · ${completedHours}h completed / ${totalHours}h scheduled` +
        `${skippedHours > 0 ? ` · ${skippedHours}h skipped` : ""}` +
        `${subjectBreakdown}\n\n` +
        `${formattedResponse}`;

      await sendTelegramMessage(user._id, message, "HTML");

      trackEvent(user.telegramChatId, "daily_checkin_sent", {
        completionRate: totalTasks > 0 ? Math.round((completed / totalTasks) * 100) : 0,
        totalBlocks: totalTasks,
        completedBlocks: completed,
        skippedBlocks: todayTasks.filter((t) => t.status === "skipped").length,
        completedHours,
        skippedHours,
      });
    },
    { connection },
  );

  worker.on("completed", (job) => {
    console.log(`✅ Daily check-in completed for ${job.data.userId}`);
  });

  worker.on("failed", (job, err) => {
    captureJobError("daily-checkIn", job, err);
  });

  console.log("✅ Daily check-in worker started");
}
