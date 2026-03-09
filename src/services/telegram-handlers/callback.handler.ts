import TelegramBot from "node-telegram-bot-api";
import { ObjectId } from "mongodb";
import { getDb } from "../../db.js";
import { scheduleTaskReminders } from "../task-scheduler.service.js";
import { formatDateTime } from "../conversation.service";
import { taskReminderQueue } from "../../queue.js";
import { handleOnboardingCallback } from "./onboarding.handler.js";
import { sendMachineEvent } from "../task-machine.service.js";
import { handleStrictnessChangeCallback } from "./command.handler.js";
import { captureMessageError } from "../monitoring.service.js";

export function registerCallbackHandler(bot: TelegramBot) {
  bot.on("callback_query", async (query) => {
    const chatId = query.message!.chat.id;
    const data = query.data!;
    const db = getDb();

    try {
      // Onboarding strictness selection
      if (await handleOnboardingCallback(bot, query)) return;

      // ── State machine callbacks (sm_ prefix) ────────────────────
      if (data.startsWith("sm_")) {
        await handleStateMachineCallback(bot, query);
        return;
      }

      if (await handleStrictnessChangeCallback(bot, query)) return;

      // ── LEGACY: Direct task callbacks (task_ prefix) ─────────────────
      if (
        data.startsWith("task_complete_") ||
        data.startsWith("task_partial_") ||
        data.startsWith("task_skipped_")
      ) {
        await handleTaskStatusCallback(bot, query, db);
        return;
      }

      if (data.startsWith("task_snooze_")) {
        await handleSnoozeCallback(bot, query, db);
        return;
      }
    } catch (err: any) {
      captureMessageError("callback_handler", chatId, err, {
        callbackData: data,
      });
      try {
        await bot.answerCallbackQuery(query.id, { text: "Something went wrong" });
      } catch { }
    }
  });
}

// ── State machine callback handler ───────────────────────────────────────────

async function handleStateMachineCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const data = query.data!;

  // Parse: sm_{action}_{taskId} or sm_reason_{taskId}_{reason}
  const parts = data.split("_");
  if (parts.length < 3) {
    return;
  }
  // parts[0] = "sm"
  const action = parts[1] as string;

  let taskId: string;
  let event: any;

  if (action === "reason") {
    // sm_reason_{taskId}_{reasonCode}
    taskId = parts[2] as string;
    const reasonCode = parts[3] as string;
    const reasonMap: Record<string, string> = {
      time: "Ran out of time",
      energy: "Low energy",
      avoided: "Avoided it",
      busy: "Got busy",
    };
    event = {
      type: "REASON_PROVIDED",
      reason: reasonMap[reasonCode] || reasonCode,
    };
  } else {
    // sm_{action}_{taskId}
    taskId = parts[2] as string;

    const eventMap: Record<string, any> = {
      complete: { type: "USER_COMPLETED" },
      partial: { type: "USER_PARTIAL" },
      skip: { type: "USER_SKIPPED" },
      snooze: { type: "USER_SNOOZED" },
      confirmed: { type: "USER_CONFIRMED" },
    };

    event = eventMap[action];
  }

  if (!event || !taskId) {
    await bot.answerCallbackQuery(query.id, { text: "Unknown action" });
    return;
  }

  const result = await sendMachineEvent(taskId, event);

  if (!result) {
    await bot.answerCallbackQuery(query.id, {
      text: "Task already resolved or not found",
    });
    return;
  }

  // Acknowledge the button press
  const ackMap: Record<string, string> = {
    USER_COMPLETED: "✅ Completed!",
    USER_PARTIAL: "⚠️ Partially done",
    USER_SKIPPED: "❌ Skipped",
    USER_SNOOZED: "⏰ Snoozed",
    USER_CONFIRMED: "👍 Confirmed",
    REASON_PROVIDED: "📝 Reason noted",
  };

  const actionText = ackMap[event.type] || "✓ Noted";

  // Always remove the buttons and update the message text
  try {
    const originalText = query.message?.text || "Task Update";
    const newText = `${originalText}\n\n<i>${actionText}</i>`;

    await bot.editMessageText(newText, {
      chat_id: query.message!.chat.id,
      message_id: query.message!.message_id,
      reply_markup: { inline_keyboard: [] },
      parse_mode: "HTML",
    });
  } catch (e) {
    // Message may already be edited or text might be identical
  }

  await bot.answerCallbackQuery(query.id, {
    text: actionText,
  });
}


// ── Legacy handlers (keep working for old tasks) ─────────────────────────────

async function handleTaskStatusCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  db: any,
) {
  const chatId = query.message!.chat.id;
  const data = query.data!;
  const [action, _, taskId] = data.split("_");

  const task = await db.collection("actionStations").findOne({
    _id: new ObjectId(taskId),
  });

  if (!task) {
    await bot.answerCallbackQuery(query.id, { text: "Task not found" });
    return;
  }

  let status: string;
  let emoji: string;
  let messageText: string;

  if (action === "task" && data.includes("complete")) {
    status = "completed";
    emoji = "✅";
    messageText = `<b>${task.title}</b> - Completed!`;
  } else if (action === "task" && data.includes("partial")) {
    status = "partial";
    emoji = "⚠️";
    messageText = `<b>${task.title}</b> - Partially done. Progress counts!`;
  } else {
    status = "skipped";
    emoji = "❌";
    messageText = `<b>${task.title}</b> - Skipped. Let's talk about this in your daily check-in.`;
  }

  await db.collection("actionStations").updateOne(
    { _id: task._id },
    {
      $set: {
        status,
        completedAt: status === "completed" ? new Date() : null,
      },
    },
  );

  await bot.editMessageText(messageText, {
    chat_id: chatId,
    message_id: query.message!.message_id,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [] },
  });

  await bot.answerCallbackQuery(query.id, { text: `${emoji} Noted!` });
}

async function handleSnoozeCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  db: any,
) {
  const chatId = query.message!.chat.id;
  const data = query.data!;
  const [_, __, taskId, minutes] = data.split("_");

  if (!minutes || !taskId) {
    console.log(`Something went wrong:- data:${data}`);
    return;
  }

  const snoozeMinutes = parseInt(minutes);

  const task = await db.collection("actionStations").findOne({
    _id: new ObjectId(taskId),
  });

  if (!task) {
    await bot.answerCallbackQuery(query.id, { text: "Task not found" });
    return;
  }

  const newStart = new Date(
    task.scheduledStart.getTime() + snoozeMinutes * 60 * 1000,
  );
  const newEnd = new Date(
    task.scheduledEnd.getTime() + snoozeMinutes * 60 * 1000,
  );

  await db.collection("actionStations").updateOne(
    { _id: task._id },
    {
      $set: {
        scheduledStart: newStart,
        scheduledEnd: newEnd,
        startReminderSent: false,
      },
    },
  );

  const jobs = await taskReminderQueue.getJobs(["delayed", "waiting"]);
  for (const job of jobs) {
    if (job.data.taskId === taskId) {
      await job.remove();
      console.log(`🗑️ Removed old reminder: ${job.name}`);
    }
  }

  await scheduleTaskReminders(taskId, {
    ...task,
    scheduledStart: newStart,
    scheduledEnd: newEnd,
  });

  await bot.editMessageText(
    `⏰ Snoozed <b>${task.title}</b> by ${snoozeMinutes} minutes.\n\nNew time: ${formatDateTime(newStart)}`,
    {
      chat_id: chatId,
      message_id: query.message!.message_id,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    },
  );

  await bot.answerCallbackQuery(query.id, {
    text: `⏰ Snoozed ${snoozeMinutes} min`,
  });
}
