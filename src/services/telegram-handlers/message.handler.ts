import TelegramBot from "node-telegram-bot-api";
import { getDb } from "../../db.js";
import {
  processUserMessage,
  saveConfirmedTask,
  parseBulkPlan,
  getUserCurrentDayCycle,
  getUserNextDayCycle,
  formatHourMin,
  formatTime,
  formatDateTime,
} from "../conversation.service";
import { istDate, addDays } from "../../utils/timezone.js";
import {
  appendToHistory,
  clearHistory,
  getState,
} from "../conversation-state.service.js";
import { createTaskMachine } from "../task-machine.service.js";
import { handleOnboardingMessage } from "./onboarding.handler.js";
import { text } from "express";
import { checkRateLimit } from "../rate-limiter.service.js";
import { captureMessageError } from "../monitoring.service.js";
import { trackEvent } from "../posthog.service.js";

export function registerMessageHandler(bot: TelegramBot) {
  bot.on("message", async (msg) => {
    console.log("Got a message 1");
    if (!msg.text && !msg.photo) return;
    if (msg.text?.startsWith("/")) return;

    const chatId = msg.chat.id;

    try {
      const photoSize = msg.photo?.[msg.photo.length - 1]?.file_size;
      const rateCheck = await checkRateLimit(
        chatId.toString(),
        msg.text || undefined,
        photoSize,
      );
      if (!rateCheck.allowed) {
        await bot.sendMessage(chatId, rateCheck.reason!);
        return;
      }
      const db = getDb();
      const state = await getState(chatId.toString());

      trackEvent(chatId.toString(), "message_sent", {
        hasPhoto: !!msg.photo,
        messageLength: msg.text?.length || 0,
        isOnboarding: state?.step?.startsWith("onboarding_") || false,
      });

      // ========== ONBOARDING FLOW ==========
      await bot.sendChatAction(chatId, "typing");
      const consumed = await handleOnboardingMessage(bot, msg);

      if (consumed) return;

      // ========== REQUIRE ONBOARDING ==========
      const user = await db.collection("users").findOne({
        telegramChatId: chatId.toString(),
      });

      if (!user || !user.onboardingComplete || !msg.text) return;

      console.log(state?.data?.planningMode)

      // ========== BULK PLAN MODE ==========
      // if (state?.data?.planningMode) {
      //   await handleBulkPlan(bot, chatId, msg.text, user);
      //   return;
      // }

      // ========== SMART CONVERSATION ==========

      const history = state?.history ?? [];

      const { response: result, rawAssistantContent } = await processUserMessage(
        msg.text,
        user,
        history,
      );

      await appendToHistory(chatId.toString(), msg.text, rawAssistantContent);

      switch (result.type) {
        case "task_captured":
          await handleTaskCaptured(bot, chatId, result);
          break;

        case "task_updated":
          await handleTaskUpdated(bot, chatId, result, user, db);
          break;

        case "task_deleted":
          await handleTaskDeleted(bot, chatId, result, user, db);
          break;

        case "slot_confirmed":
        case "slot_selected":
          await handleSlotSelected(bot, chatId, result, user, history);
          break;

        case "slot_rejected":
          await handleSlotRejected(bot, chatId, result);
          break;

        case "not_a_task":
        case "unclear":
        default: {
          const formattedReply = result.replyMessage
            ? result.replyMessage.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>").replace(/\*(.*?)\*/g, "<i>$1</i>")
            : "";
          await bot.sendMessage(chatId, formattedReply, { parse_mode: "HTML" });
          if (result.type === "not_a_task") {
            await clearHistory(chatId.toString());
          }
          break;
        }
      }
    } catch (err: any) {
      captureMessageError("message_handler", chatId, err, {
        text: msg.text?.slice(0, 100),
        hasPhoto: !!msg.photo,
      });
      try {
        await bot.sendMessage(
          chatId,
          "Something went wrong processing your message. Please try again.",
        );
      } catch { }
    }
  });
}

// ── Bulk Plan Handler ────────────────────────────────────────────────────────

async function handleBulkPlan(
  bot: TelegramBot,
  chatId: number,
  text: string,
  user: any,
): Promise<void> {
  await bot.sendChatAction(chatId, "typing");

  const result = await parseBulkPlan(text, user);

  if (result.tasks.length === 0) {
    await bot.sendMessage(
      chatId,
      result.replyMessage ||
      "Couldn't parse study blocks. Try: '9-12 polity, 2-5 optional, 7-8 CA'",
    );
    return;
  }

  const dayCycle = getUserNextDayCycle(user);
  let message = `📋 <b>Scheduled ${result.tasks.length} study blocks for tomorrow:</b>\n\n`;
  let createdCount = 0;

  for (const task of result.tasks) {
    try {
      const slot = {
        hour: task.hour,
        minute: task.minute,
        date: "tomorrow" as const,
      };

      const { taskDoc, taskId } = await saveConfirmedTask(
        user._id,
        {
          title: task.title,
          durationMinutes: task.durationMinutes,
          emoji: task.emoji,
          subject: task.subject,
        },
        slot,
        user,
      );

      // Create state machine for each task
      await createTaskMachine(
        {
          _id: taskId,
          userId: user._id.toString(),
          title: task.title,
          subject: task.subject,
          scheduledStart: taskDoc.scheduledStart,
          scheduledEnd: taskDoc.scheduledEnd,
          estimatedMinutes: task.durationMinutes,
        },
        {
          telegramChatId: user.telegramChatId,
          strictnessLevel: user.strictnessLevel,
        },
      );

      const subjectTag = task.subject ? ` [${task.subject}]` : "";
      message += `${task.emoji} ${task.title}${subjectTag}\n   ⏰ ${formatDateTime(taskDoc.scheduledStart)} (${task.durationMinutes}min)\n\n`;
      createdCount++;
    } catch (err) {
      console.error(`Failed to create task: ${task.title}`, err);
    }
  }

  if (createdCount > 0) {
    message += `I'll remind you 5 min before each block. Use /today tomorrow to track progress.`;
    await clearHistory(chatId.toString());
  } else {
    message =
      "Something went wrong creating the study blocks. Please try again.";
  }

  await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
}

// ── Response handlers ────────────────────────────────────────────────────────

async function handleTaskCaptured(
  bot: TelegramBot,
  chatId: number,
  result: any,
) {
  if (!result.task || !result.suggestedSlots?.length) {
    await bot.sendMessage(
      chatId,
      result.replyMessage || "Got it! When would you like to study this?",
    );
    return;
  }

  let message = result.replyMessage
    ? `${result.replyMessage.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>").replace(/\*(.*?)\*/g, "<i>$1</i>")}\n\n`
    : `Got it! Adding <b>${result.task.title}</b> (${result.task.durationMinutes} min)\n\nBest available slots:\n\n`;

  result.suggestedSlots.forEach((slot: any, i: number) => {
    const label = slot.date === "today" ? "Today" : "Tomorrow";
    message += `${i + 1}️⃣ <b>${label}, ${formatHourMin(slot.hour, slot.minute)}</b>\n   ${slot.reason}\n\n`;
  });

  message += `Which works? Reply with the number or a different time.`;

  await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
}

async function handleTaskUpdated(
  bot: TelegramBot,
  chatId: number,
  result: any,
  user: any,
  db: any,
) {
  if (!result.taskToUpdate) {
    await bot.sendMessage(chatId, "Which study block did you want to update?");
    return;
  }

  const updateInfo = result.taskToUpdate;
  const allTasks = await db
    .collection("actionStations")
    .find({
      userId: user._id,
      status: "pending",
    })
    .sort({ scheduledStart: 1 })
    .toArray();

  const identifier = updateInfo.identifier ? updateInfo.identifier.toLowerCase() : "";
  let taskToUpdate = null;

  // 1. Try exact ID match first (new behavior)
  if (updateInfo.taskId) {
    taskToUpdate = allTasks.find((t: any) => t._id.toString() === updateInfo.taskId);
  }

  // 2. Fallback to old heuristic match if the LLM didn't provide a taskId or it was invalid
  if (!taskToUpdate && updateInfo.currentTime && identifier) {
    taskToUpdate = allTasks.find((t: any) => {
      const fullTitle = `${t.title} ${t.subject || ""}`.toLowerCase();
      const titleMatch = fullTitle.includes(identifier) || identifier.includes(t.title.toLowerCase());

      const istDateStr = new Date(t.scheduledStart).toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
      const hourMatch = new Date(istDateStr).getHours() === updateInfo.currentTime!.hour;

      return titleMatch && hourMatch;
    });
  }

  // 3. Last resort fuzzy match
  if (!taskToUpdate && identifier) {
    const matchingTasks = allTasks.filter((t: any) => {
      const fullTitle = `${t.title} ${t.subject || ""}`.toLowerCase();
      return fullTitle.includes(identifier) || identifier.includes(t.title.toLowerCase());
    });

    if (matchingTasks.length === 1) {
      taskToUpdate = matchingTasks[0];
    } else if (matchingTasks.length > 1) {
      let message = `I found multiple "${updateInfo.identifier}" blocks. Which one?\n\n`;
      matchingTasks.forEach((t: any, i: number) => {
        const subject = t.subject ? ` [${t.subject}]` : "";
        message += `${i + 1}. ${formatTime(t.scheduledStart)} - ${t.title}${subject}\n`;
      });
      message += `\nReply like: "move the 2pm one to 8pm"`;
      await bot.sendMessage(chatId, message);
      return;
    }
  }

  if (!taskToUpdate) {
    await bot.sendMessage(
      chatId,
      `Couldn't find that block. Use /today to see your current schedule.`,
    );
    return;
  }

  if (updateInfo.newSlot) {
    const slot = updateInfo.newSlot;
    const targetCycle =
      slot.date === "today"
        ? getUserCurrentDayCycle(user)
        : getUserNextDayCycle(user);

    let newStart = istDate(targetCycle.startDateTime, slot.hour, slot.minute);

    if (slot.hour < user.sleepSchedule.wakeHour) {
      const nextDay = addDays(targetCycle.startDateTime, 1);
      newStart = istDate(nextDay, slot.hour, slot.minute);
    }

    const duration = updateInfo.newDuration || taskToUpdate.estimatedMinutes;
    const newEnd = new Date(newStart.getTime() + duration * 60 * 1000);

    await db.collection("actionStations").updateOne(
      { _id: taskToUpdate._id },
      {
        $set: {
          scheduledStart: newStart,
          scheduledEnd: newEnd,
          estimatedMinutes: duration,
        },
      },
    );

    // Cancel old machine jobs and create new machine
    try {
      const { cancelAllTaskJobs } = await import("../task-machine.service.js");
      await cancelAllTaskJobs(taskToUpdate._id.toString());
      await createTaskMachine(
        {
          _id: taskToUpdate._id.toString(),
          userId: user._id.toString(),
          title: taskToUpdate.title,
          subject: taskToUpdate.subject,
          scheduledStart: newStart,
          scheduledEnd: newEnd,
          estimatedMinutes: duration,
        },
        {
          telegramChatId: user.telegramChatId,
          strictnessLevel: user.strictnessLevel,
        },
      );
    } catch (err) {
      console.error("Failed to recreate machine for updated task", err);
    }

    const subject = taskToUpdate.subject ? ` [${taskToUpdate.subject}]` : "";
    const responseMsg = result.replyMessage
      ? result.replyMessage.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>").replace(/\*(.*?)\*/g, "<i>$1</i>")
      : `✅ Updated! <b>${taskToUpdate.title}</b>${subject} moved to ${formatDateTime(newStart)}`;

    await bot.sendMessage(chatId, responseMsg, { parse_mode: "HTML" });
  } else {
    let message = `When should I reschedule <b>${taskToUpdate.title}</b>?\n\n`;

    if (result.suggestedSlots?.length) {
      result.suggestedSlots.forEach((slot: any, i: number) => {
        const label = slot.date === "today" ? "Today" : "Tomorrow";
        message += `${i + 1}️⃣ <b>${label}, ${formatHourMin(slot.hour, slot.minute)}</b>\n   ${slot.reason}\n\n`;
      });
    }

    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
  }

  await clearHistory(chatId.toString());
}

async function handleTaskDeleted(
  bot: TelegramBot,
  chatId: number,
  result: any,
  user: any,
  db: any,
) {
  if (!result.taskToDelete && !result.tasksToDelete) {
    await bot.sendMessage(chatId, "Which study block did you want to cancel?");
    return;
  }

  const deleteList = result.tasksToDelete || [result.taskToDelete];

  const allTasks = await db
    .collection("actionStations")
    .find({
      userId: user._id,
      status: "pending",
    })
    .sort({ scheduledStart: 1 })
    .toArray();

  const deletedIds = new Set();
  const successfullyDeleted = [];

  for (const deleteInfo of deleteList) {
    const identifier = deleteInfo.identifier ? deleteInfo.identifier.toLowerCase() : "";
    let taskToDelete = null;

    // 1. Try exact ID match first
    if (deleteInfo.taskId) {
      taskToDelete = allTasks.find((t: any) => t._id.toString() === deleteInfo.taskId && !deletedIds.has(t._id.toString()));
    }

    // 2. Fallback to heuristic
    if (!taskToDelete && deleteInfo.currentTime && identifier) {
      taskToDelete = allTasks.find((t: any) => {
        if (deletedIds.has(t._id.toString())) return false;
        const fullTitle = `${t.title} ${t.subject || ""}`.toLowerCase();
        const titleMatch = fullTitle.includes(identifier) || identifier.includes(t.title.toLowerCase());

        const istDateStr = new Date(t.scheduledStart).toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
        const hourMatch = new Date(istDateStr).getHours() === deleteInfo.currentTime.hour;

        return titleMatch && hourMatch;
      });
    }

    // 3. Fallback to fuzzy
    if (!taskToDelete && identifier) {
      const matchingTasks = allTasks.filter((t: any) => {
        if (deletedIds.has(t._id.toString())) return false;
        const fullTitle = `${t.title} ${t.subject || ""}`.toLowerCase();
        return fullTitle.includes(identifier) || identifier.includes(t.title.toLowerCase());
      });

      if (matchingTasks.length === 1) {
        taskToDelete = matchingTasks[0];
      } else if (matchingTasks.length > 1 && deleteList.length === 1) {
        let message = `I found multiple "${deleteInfo.identifier}" blocks. Which one to cancel?\n\n`;
        matchingTasks.forEach((t: any, i: number) => {
          message += `${i + 1}. ${formatTime(t.scheduledStart)} - ${t.title}\n`;
        });
        await bot.sendMessage(chatId, message);
        return;
      }
    }

    if (taskToDelete) {
      deletedIds.add(taskToDelete._id.toString());
      successfullyDeleted.push(taskToDelete);

      // Clean up machine
      try {
        const { cancelAllTaskJobs } = await import("../task-machine.service.js");
        await cancelAllTaskJobs(taskToDelete._id.toString());
      } catch { }

      await db.collection("actionStations").deleteOne({ _id: taskToDelete._id });
    }
  }

  if (successfullyDeleted.length === 0) {
    await bot.sendMessage(
      chatId,
      `Couldn't find any blocks to cancel. Use /today to see your schedule.`,
    );
    return;
  }

  let defaultMsg = "";
  if (successfullyDeleted.length === 1) {
    const t = successfullyDeleted[0];
    const subject = t.subject ? ` [${t.subject}]` : "";
    defaultMsg = `✅ Cancelled: <b>${t.title}</b>${subject} (was at ${formatTime(t.scheduledStart)})`;
  } else {
    defaultMsg = `✅ Cancelled ${successfullyDeleted.length} study blocks.`;
  }

  const responseMsg = result.replyMessage
    ? result.replyMessage.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>").replace(/\*(.*?)\*/g, "<i>$1</i>")
    : defaultMsg;

  await bot.sendMessage(chatId, responseMsg, { parse_mode: "HTML" });

  await clearHistory(chatId.toString());
}

async function handleSlotSelected(
  bot: TelegramBot,
  chatId: number,
  result: any,
  user: any,
  history: any[],
) {
  const slot = result.selectedSlot;

  if (!slot) {
    await bot.sendMessage(chatId, "Which slot? Reply with the number.");
    return;
  }

  let task = result.task;

  if (!task) {
    const lastTaskCapture = [...history].reverse().find((h: any) => {
      if (h.role !== "assistant") return false;
      try {
        const parsed = JSON.parse(h.content);
        return parsed.type === "task_captured" && parsed.task;
      } catch {
        return false;
      }
    });

    task = lastTaskCapture ? JSON.parse(lastTaskCapture.content).task : null;
  }

  if (!task) {
    await bot.sendMessage(
      chatId,
      "Lost track of which task. What did you want to add?",
    );
    return;
  }

  const { taskDoc, taskId } = await saveConfirmedTask(
    user._id,
    task,
    slot,
    user,
  );

  // Create state machine instead of legacy reminders
  await createTaskMachine(
    {
      _id: taskId,
      userId: user._id.toString(),
      title: task.title,
      subject: task.subject || null,
      scheduledStart: taskDoc.scheduledStart,
      scheduledEnd: taskDoc.scheduledEnd,
      estimatedMinutes: task.durationMinutes,
    },
    {
      telegramChatId: user.telegramChatId,
      strictnessLevel: user.strictnessLevel,
    },
  );

  await clearHistory(chatId.toString());

  const subjectTag = task.subject ? ` [${task.subject}]` : "";
  const responseMsg = result.replyMessage
    ? result.replyMessage.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>").replace(/\*(.*?)\*/g, "<i>$1</i>")
    : `✅ <b>Locked in!</b>\n\n${task.emoji} ${task.title}${subjectTag}\n📅 ${formatDateTime(taskDoc.scheduledStart)} (${task.durationMinutes} min)\n\nI'll remind you 5 minutes before.`;

  await bot.sendMessage(chatId, responseMsg, { parse_mode: "HTML" });
}

async function handleSlotRejected(
  bot: TelegramBot,
  chatId: number,
  result: any,
) {
  if (!result.suggestedSlots?.length) {
    await bot.sendMessage(
      chatId,
      "No open slots found. Tell me a specific time that works.",
    );
    return;
  }

  let message = `No problem! How about:\n\n`;
  result.suggestedSlots.forEach((slot: any, i: number) => {
    const label = slot.date === "today" ? "Today" : "Tomorrow";
    message += `${i + 1}️⃣ <b>${label}, ${formatHourMin(slot.hour, slot.minute)}</b>\n   ${slot.reason}\n\n`;
  });
  message += `Which works?`;

  await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
}
