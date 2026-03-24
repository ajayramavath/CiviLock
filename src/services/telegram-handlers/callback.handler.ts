// src/services/telegram-handlers/callback.handler.ts
// Handles all inline button callbacks:
// - tt_ (timetable confirm/redo/skip) — from schedule parsing
// - sm_ (state machine) — task reminders
// - change_strictness_ — from /strictness command
// - Legacy task_ callbacks

import TelegramBot from "node-telegram-bot-api";
import { ObjectId } from "mongodb";
import { getDb } from "../../db.js";
import { taskReminderQueue } from "../../queue.js";
import { sendMachineEvent } from "../task-machine.service.js";
import { scheduleTaskReminders } from "../task-scheduler.service.js";
import { handleStrictnessChangeCallback } from "./command.handler.js";
import { captureMessageError } from "../monitoring.service.js";
import { trackEvent } from "../posthog.service.js";
import { getState, setState, clearState, appendToHistory } from "../conversation-state.service.js";
import { buildUserStatus } from "../user-status.service.js";
import {
  saveStudyPlan,
  generateDailyBlocks,
} from "../study-plan.service.js";
import type { User } from "../../models/types.js";
import { formatDateTime } from "../../utils/timezone.js";

export function registerCallbackHandler(bot: TelegramBot) {
  bot.on("callback_query", async (query) => {
    const chatId = query.message!.chat.id;
    const data = query.data!;
    const db = getDb();

    try {
      // ── Timetable confirm/redo/skip ────────────────────────────────
      if (data.startsWith("tt_")) {
        await handleTimetableCallback(bot, query);
        return;
      }

      // ── State machine callbacks (sm_ prefix) ──────────────────────
      if (data.startsWith("sm_")) {
        await handleStateMachineCallback(bot, query);
        return;
      }

      // ── Strictness change ─────────────────────────────────────────
      if (await handleStrictnessChangeCallback(bot, query)) return;

      // ── Legacy task callbacks ──────────────────────────────────────
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
        await bot.answerCallbackQuery(query.id, {
          text: "Something went wrong",
        });
      } catch { }
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Timetable confirm/redo/skip — triggered by schedule parsing in message handler
// ═════════════════════════════════════════════════════════════════════════════

async function handleTimetableCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const data = query.data!;
  const action = data.split(":")[0]; // "tt_confirm" | "tt_redo" | "tt_skip"
  const chatId = query.message!.chat.id;
  const db = getDb();

  await bot.answerCallbackQuery(query.id);

  // Update the message to show status
  try {
    const originalText = query.message?.text || "Schedule";
    const statusText =
      action === "tt_confirm"
        ? "✅ Confirmed"
        : action === "tt_redo"
          ? "🔄 Redoing"
          : "⏭️ Skipped";
    await bot.editMessageText(`${originalText}\n\n<i>${statusText}</i>`, {
      chat_id: chatId,
      message_id: query.message!.message_id,
      reply_markup: { inline_keyboard: [] },
      parse_mode: "HTML",
    });
  } catch { }

  const state = await getState(chatId.toString());
  const user = await db
    .collection("users")
    .findOne({ telegramChatId: chatId.toString() });

  if (!user) return;

  // ── Confirm ────────────────────────────────────────────────────────────
  if (action === "tt_confirm") {
    // Old flow: plan was in conversation state — save it first
    const parsedFromState = (state as any)?.data?.parsedSchedule;
    if (parsedFromState) {
      const rawInput = (state as any)?.data?.rawInput || "";
      const source = (state as any)?.data?.inputSource || "text";
      await saveStudyPlan(user._id, parsedFromState, rawInput, source);
    } else if (!user.studyPlan || !user.studyPlan.blocks?.length) {
      await bot.sendMessage(chatId, "Something went wrong. Send your schedule again.");
      return;
    }

    // Activate schedule (shared logic)
    const { activateSchedule } = await import("../schedule-activation.service.js");
    const activation = await activateSchedule(user as User);

    await setState(chatId.toString(), {
      history: (state as any)?.history || [],
    });

    trackEvent(chatId.toString(), "schedule_confirmed", {
      blockCount: user.studyPlan?.blocks?.length || 0,
      todayCreated: activation.todayCreated,
      todaySkipped: activation.todaySkipped,
      tomorrowCreated: activation.tomorrowCreated,
    });

    await bot.sendMessage(chatId, activation.confirmationMessage, {
      parse_mode: "HTML",
    });

    await appendToHistory(
      chatId.toString(),
      "✅ Lock it in",
      activation.confirmationMessage,
    );
    return;
  }

  // ── Redo ───────────────────────────────────────────────────────────────
  if (action === "tt_redo") {
    await bot.sendMessage(
      chatId,
      `No problem. Send your schedule again — type it out or send a photo.`,
    );
    return;
  }

  // ── Skip ───────────────────────────────────────────────────────────────
  if (action === "tt_skip") {
    await setState(chatId.toString(), {
      history: (state as any)?.history || [],
    });

    trackEvent(chatId.toString(), "schedule_skipped");

    let message =
      `No worries — you can send your timetable anytime.\n\n` +
      `In the meantime, just tell me what you're studying and I'll track it.\n` +
      `<i>"polity 9am to 12pm"</i> or <i>"study economy for 2 hours"</i>`;

    // Check for missing fields
    const { flags } = await buildUserStatus(user as User | null);
    if (!flags.hasName) {
      message += `\n\nWhat should I call you?`;
    } else if (!flags.hasReviewTime) {
      message += `\n\nWhen should I send your daily review?`;
    }

    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
    const { appendToHistory } = await import(
      "../conversation-state.service.js"
    );
    await appendToHistory(chatId.toString(), "⏭️ Skip for now", message);
    return;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// State machine callbacks (unchanged)
// ═════════════════════════════════════════════════════════════════════════════

async function handleStateMachineCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const data = query.data!;
  const parts = data.split("_");
  if (parts.length < 3) return;

  const action = parts[1] as string;
  let taskId: string;
  let event: any;

  if (action === "reason") {
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

  const ackMap: Record<string, string> = {
    USER_COMPLETED: "✅ Completed!",
    USER_PARTIAL: "⚠️ Partially done",
    USER_SKIPPED: "❌ Skipped",
    USER_SNOOZED: "⏰ Snoozed",
    USER_CONFIRMED: "👍 Confirmed",
    REASON_PROVIDED: "📝 Reason noted",
  };

  const actionText = ackMap[event.type] || "✓ Noted";

  try {
    const originalText = query.message?.text || "Task Update";
    const newText = `${originalText}\n\n<i>${actionText}</i>`;
    await bot.editMessageText(newText, {
      chat_id: query.message!.chat.id,
      message_id: query.message!.message_id,
      reply_markup: { inline_keyboard: [] },
      parse_mode: "HTML",
    });
  } catch { }

  await bot.answerCallbackQuery(query.id, { text: actionText });
}

// ═════════════════════════════════════════════════════════════════════════════
// Legacy callbacks (unchanged, kept for old tasks)
// ═════════════════════════════════════════════════════════════════════════════

async function handleTaskStatusCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  db: any,
) {
  const chatId = query.message!.chat.id;
  const data = query.data!;
  const [action, _, taskId] = data.split("_");

  const task = await db
    .collection("actionStations")
    .findOne({ _id: new ObjectId(taskId) });

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
    messageText = `<b>${task.title}</b> - Skipped.`;
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

  if (!minutes || !taskId) return;

  const snoozeMinutes = parseInt(minutes);

  const task = await db
    .collection("actionStations")
    .findOne({ _id: new ObjectId(taskId) });

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