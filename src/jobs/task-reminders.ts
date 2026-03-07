import { Worker } from "bullmq";
import { connection } from "../queue.js";
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import { bot } from "../services/telegram.service.js";
import { sendMachineEvent } from "../services/task-machine.service.js";
import { captureJobError } from "../services/monitoring.service.js";

export function startTaskReminderWorker() {
  const worker = new Worker(
    "task-reminders",
    async (job) => {
      if (job.name === "state-event") {
        const { taskId, event } = job.data;
        console.log(
          `🤖 Processing state event: ${event.type} for task ${taskId}`,
        );
        await sendMachineEvent(taskId, event);
        return;
      }

      const { taskId, reminderType } = job.data;

      const db = getDb();
      const task = await db
        .collection("actionStations")
        .findOne({ _id: new ObjectId(taskId) });

      if (!task || task.status === "completed") {
        console.log("Task already completed or not found");
        return;
      }

      const user = await db.collection("users").findOne({ _id: task.userId });
      if (!user || !user.telegramChatId) return;

      let message = "";

      switch (reminderType) {
        case "start":
          message = `⏰ <b>Starting in 5 minutes</b>\n\n📋 ${task.title}\n⏱ Duration: ${task.estimatedMinutes} min\n\nGet ready!`;

          await bot.sendMessage(user.telegramChatId, message, {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "⏰ Snooze 15 min",
                    callback_data: `task_snooze_${task._id}_15`,
                  },
                  {
                    text: "❌ Skip this task",
                    callback_data: `task_skipped_${task._id}`,
                  },
                ],
              ],
            },
          });

          await db
            .collection("actionStations")
            .updateOne(
              { _id: task._id },
              { $set: { startReminderSent: true } },
            );

          console.log(
            `✅ [LEGACY] Sent ${reminderType} reminder for: ${task.title}`,
          );
          return;

        case "overdue":
          const minutesLate = Math.floor(
            (Date.now() - task.scheduledStart.getTime()) / 60000,
          );
          message = `⚠️ <b>${minutesLate} minutes overdue</b>\n\n📋 ${task.title}\n\nYou were supposed to start ${minutesLate} min ago. Are you doing it?\n\n🔥 Stop making excuses. Do it now.`;
          await bot.sendMessage(user.telegramChatId, message, {
            parse_mode: "HTML",
          });
          await db
            .collection("actionStations")
            .updateOne(
              { _id: task._id },
              { $set: { overdueReminderSent: true } },
            );
          console.log(
            `✅ [LEGACY] Sent ${reminderType} reminder for: ${task.title}`,
          );
          return;

        case "end":
          message = `🏁 <b>Time's up</b>\n\n📋 ${task.title}\n\nScheduled time is over. Did you complete it?`;
          await db
            .collection("actionStations")
            .updateOne({ _id: task._id }, { $set: { endReminderSent: true } });

          await bot.sendMessage(user.telegramChatId, message, {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "✅ Completed",
                    callback_data: `task_complete_${task._id}`,
                  },
                ],
                [
                  {
                    text: "⚠️ Partially Done",
                    callback_data: `task_partial_${task._id}`,
                  },
                ],
                [
                  {
                    text: "❌ Didn't Do It",
                    callback_data: `task_skipped_${task._id}`,
                  },
                ],
              ],
            },
          });
          console.log(
            `✅ [LEGACY] Sent ${reminderType} reminder for: ${task.title}`,
          );
          return;
      }
    },
    { connection },
  );

  worker.on("completed", (job) => {
    if (job.name === "state-event") {
      console.log(`✅ State event processed: ${job.data.event.type}`);
    } else {
      console.log(`✅ [LEGACY] Reminder sent: ${job.data.reminderType}`);
    }
  });

  worker.on("failed", (job, err) => {
    captureJobError("task-reminders", job, err);
  });

  console.log(
    "✅ Task reminder worker started (hybrid: state-machine + legacy)",
  );
}
