import { bot } from "../services/telegram.service.js";
import { getDb } from "../db.js";
import { ObjectId } from "mongodb";
import {
  scheduleSilenceTimeout,
  cancelAllTaskJobs,
} from "./task-machine.service.js";
import type {
  TaskMachineContext,
  TaskMachineEvent,
} from "../machines/task-lifecycle.machine.js";
import { trackEvent } from "./posthog.service.js";

// ─── Main effect dispatcher ──────────────────────────────────────────────────

export async function executeEffects(
  taskId: string,
  previousState: string,
  newState: string,
  context: TaskMachineContext,
  event: TaskMachineEvent,
): Promise<void> {
  const db = getDb();

  // ── Track silence events in DB for daily check-in reporting ────────
  if (event.type === "SILENCE_TIMEOUT") {
    await db
      .collection("actionStations")
      .updateOne(
        { _id: new ObjectId(taskId) },
        { $inc: { silenceCount: 1 } },
      );
    trackEvent(context.chatId, "reminder_silent", {
      taskId,
      subject: context.subject,
      level: context.level,
    });
  }

  // Track user interactions
  if (
    event.type === "USER_COMPLETED" ||
    event.type === "USER_SKIPPED" ||
    event.type === "USER_PARTIAL" ||
    event.type === "USER_CONFIRMED" ||
    event.type === "USER_SNOOZED"
  ) {
    trackEvent(context.chatId, "reminder_interacted", {
      taskId,
      subject: context.subject,
      action: event.type,
    });
  }

  // ── State entry effects ──────────────────────────────────────────────

  // Entered preTask → send start reminder
  if (newState === "preTask" && previousState !== "preTask") {
    await sendStartReminder(context);
    await scheduleSilenceTimeout(taskId, context.level);
    trackEvent(context.chatId, "reminder_sent", {
      taskId,
      subject: context.subject,
      taskTitle: context.title,
    });
  }

  // Re-entered preTask via snooze → send snoozed confirmation + new reminder
  if (newState === "preTask" && previousState === "preTask") {
    await sendSnoozeConfirmation(context);
    await scheduleSilenceTimeout(taskId, context.level);
  }

  // Entered active.overdue → send overdue reminder
  if (newState === "active.overdue" && previousState !== "active.overdue") {
    await sendOverdueReminder(context);
    await scheduleSilenceTimeout(taskId, context.level);
  }

  // Entered active.escalating → send escalation message
  // (Note: escalating re-enters on NEXT_ESCALATION or SILENCE_TIMEOUT, so previousState CAN equal newState.
  // We just ensure we don't send it if the event was a user pressing an unhandled button.)
  if (newState === "active.escalating" && !event.type.startsWith("USER_")) {
    await sendEscalationMessage(context);
    await scheduleSilenceTimeout(taskId, context.level);
    trackEvent(context.chatId, "escalation_triggered", {
      taskId,
      subject: context.subject,
      level: context.level,
    });
  }

  // Entered endTimeCheckIn → send end-time check-in
  if (newState === "endTimeCheckIn") {
    await sendEndTimeCheckIn(context);
    await scheduleSilenceTimeout(taskId, context.level);
  }

  // Entered resolutionRequired → ask for reason (Level 2)
  if (newState === "resolutionRequired") {
    await sendReasonRequest(context);
    await scheduleSilenceTimeout(taskId, context.level);
  }

  // Entered any resolved state → write to DB + cleanup
  if (newState.startsWith("resolved.")) {
    const status = mapResolvedStateToStatus(newState);
    await updateTaskStatus(taskId, status, context);
    await cancelAllTaskJobs(taskId);
    await emitAnalyticsEvent(taskId, newState, context);

    // PostHog task resolution events
    const eventName =
      status === "completed" ? "task_completed" :
        status === "skipped" ? "task_skipped" : "task_partial";
    trackEvent(context.chatId, eventName, {
      taskId,
      subject: context.subject,
      taskTitle: context.title,
      durationMinutes: context.estimatedMinutes,
      snoozeCount: context.snoozeCount,
      level: context.level,
      resolvedState: newState,
    });
  }
}

// ─── Telegram message senders ────────────────────────────────────────────────

async function sendStartReminder(context: TaskMachineContext): Promise<void> {
  const subjectTag = context.subject ? `\n📚 Subject: ${context.subject}` : "";

  let message: string;
  let buttons: Array<Array<{ text: string; callback_data: string }>>;

  if (context.level === 2) {
    // Level 2: Soft confirmation — create commitment
    message =
      `⏰ <b>Planning to start in 5 minutes?</b>\n\n` +
      `📋 ${context.title}${subjectTag}\n` +
      `⏱ Duration: ${context.estimatedMinutes} min\n\n` +
      `Confirm you're ready.`;
    buttons = [
      [
        {
          text: "✅ I'm ready",
          callback_data: `sm_confirmed_${context.taskId}`,
        },
        {
          text: "⏰ Snooze 15 min",
          callback_data: `sm_snooze_${context.taskId}`,
        },
      ],
      [
        {
          text: "❌ Skip",
          callback_data: `sm_skip_${context.taskId}`,
        },
      ],
    ];
  } else {
    // Level 1: Simple reminder — no confirmation needed
    message =
      `⏰ <b>Starting in 5 minutes</b>\n\n` +
      `📋 ${context.title}${subjectTag}\n` +
      `⏱ Duration: ${context.estimatedMinutes} min\n\n` +
      `Get ready!`;
    buttons = [
      [
        {
          text: "⏰ Snooze 15 min",
          callback_data: `sm_snooze_${context.taskId}`,
        },
        {
          text: "❌ Skip",
          callback_data: `sm_skip_${context.taskId}`,
        },
      ],
    ];
  }

  await bot.sendMessage(context.chatId, message, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });

  // Update DB flag
  const db = getDb();
  await db
    .collection("actionStations")
    .updateOne(
      { _id: new ObjectId(context.taskId) },
      { $set: { startReminderSent: true } },
    );
}

async function sendSnoozeConfirmation(
  context: TaskMachineContext,
): Promise<void> {
  const message =
    `⏰ Snoozed <b>${context.title}</b> (${context.snoozeCount} time${context.snoozeCount > 1 ? "s" : ""})\n\n` +
    `I'll remind you again in 15 minutes.`;

  if (context.snoozeCount >= 3 && context.level === 2) {
    const warning =
      `\n\n⚠️ You've snoozed this ${context.snoozeCount} times. ` +
      `Are you avoiding this? Be honest with yourself.`;
    await sendMessage(context.chatId, message + warning);
  } else {
    await sendMessage(context.chatId, message);
  }
}

async function sendOverdueReminder(context: TaskMachineContext): Promise<void> {
  const minutesLate = Math.floor(
    (Date.now() - new Date(context.scheduledStart).getTime()) / 60000,
  );

  const subjectTag = context.subject ? ` (${context.subject})` : "";

  let message: string;
  if (context.level === 1) {
    message =
      `⚠️ <b>${minutesLate} minutes overdue</b>\n\n` +
      `📋 ${context.title}${subjectTag}\n\n` +
      `Just a nudge — you were supposed to start this already.`;
  } else {
    message =
      `⚠️ <b>${minutesLate} minutes overdue</b>\n\n` +
      `📋 ${context.title}${subjectTag}\n\n` +
      `You were supposed to start ${minutesLate} min ago. What's happening?`;
  }

  await bot.sendMessage(context.chatId, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "✅ Doing it now",
            callback_data: `sm_confirmed_${context.taskId}`,
          },
          {
            text: "❌ Can't do it",
            callback_data: `sm_skip_${context.taskId}`,
          },
        ],
      ],
    },
  });

  // Update DB flag
  const db = getDb();
  await db
    .collection("actionStations")
    .updateOne(
      { _id: new ObjectId(context.taskId) },
      { $set: { overdueReminderSent: true } },
    );
}

async function sendEscalationMessage(
  context: TaskMachineContext,
): Promise<void> {
  const subjectTag = context.subject ? ` (${context.subject})` : "";
  const tier = context.escalationTier;

  let message: string;
  if (tier === 1) {
    message =
      `🔔 <b>Still planning to study?</b>\n\n` +
      `📋 ${context.title}${subjectTag}\n\n` +
      `You've been silent. Are you doing this or not?`;
  } else {
    message =
      `🔴 <b>You're going silent on ${context.title}</b>${subjectTag}\n\n` +
      `Even 15 minutes of focused work counts. ` +
      `Don't let this become a pattern.\n\n` +
      `Start now or tell me you're skipping.`;
  }

  await bot.sendMessage(context.chatId, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "✅ On it",
            callback_data: `sm_confirmed_${context.taskId}`,
          },
          {
            text: "⏰ 15 min only",
            callback_data: `sm_confirmed_${context.taskId}`,
          },
        ],
        [
          {
            text: "❌ Skip today",
            callback_data: `sm_skip_${context.taskId}`,
          },
        ],
      ],
    },
  });
}

async function sendEndTimeCheckIn(context: TaskMachineContext): Promise<void> {
  const subjectTag = context.subject ? ` (${context.subject})` : "";

  let message: string;
  if (context.level === 1) {
    message =
      `🏁 <b>Time's up!</b>\n\n` +
      `📋 ${context.title}${subjectTag}\n\n` +
      `How did it go?`;
  } else {
    message =
      `🏁 <b>Time's up for ${context.title}</b>${subjectTag}\n\n` +
      `How much did you actually get done?`;
  }

  await bot.sendMessage(context.chatId, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "✅ Completed",
            callback_data: `sm_complete_${context.taskId}`,
          },
        ],
        [
          {
            text: "⚠️ Partial",
            callback_data: `sm_partial_${context.taskId}`,
          },
        ],
        [
          {
            text: "❌ Didn't do it",
            callback_data: `sm_skip_${context.taskId}`,
          },
        ],
      ],
    },
  });

  // Update DB flag
  const db = getDb();
  await db
    .collection("actionStations")
    .updateOne(
      { _id: new ObjectId(context.taskId) },
      { $set: { endReminderSent: true } },
    );
}

async function sendReasonRequest(context: TaskMachineContext): Promise<void> {
  const subjectTag = context.subject ? ` (${context.subject})` : "";
  const message =
    `📝 <b>Why did you miss this?</b>\n\n` +
    `📋 ${context.title}${subjectTag}\n\n` +
    `Be honest — tracking reasons helps identify patterns.`;

  await bot.sendMessage(context.chatId, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "⏰ Ran out of time",
            callback_data: `sm_reason_${context.taskId}_time`,
          },
          {
            text: "😴 Low energy",
            callback_data: `sm_reason_${context.taskId}_energy`,
          },
        ],
        [
          {
            text: "🙈 Avoided it",
            callback_data: `sm_reason_${context.taskId}_avoided`,
          },
          {
            text: "📅 Got busy",
            callback_data: `sm_reason_${context.taskId}_busy`,
          },
        ],
        [
          {
            text: "✅ Actually I did it",
            callback_data: `sm_complete_${context.taskId}`,
          },
        ],
      ],
    },
  });
}



// ─── Database operations ─────────────────────────────────────────────────────

function mapResolvedStateToStatus(
  state: string,
): "completed" | "partial" | "skipped" {
  if (state.includes("completed") || state.includes("endTimeAutoComplete"))
    return "completed";
  if (state.includes("partial")) return "partial";
  return "skipped";
}

async function updateTaskStatus(
  taskId: string,
  status: "completed" | "partial" | "skipped",
  context: TaskMachineContext,
): Promise<void> {
  const db = getDb();
  await db.collection("actionStations").updateOne(
    { _id: new ObjectId(taskId) },
    {
      $set: {
        status,
        completedAt: status === "completed" ? new Date() : null,
        machineMetadata: {
          resolvedState: status,
          snoozeCount: context.snoozeCount,
          escalationTier: context.escalationTier,
          missReason: context.missReason,
          subject: context.subject,
        },
      },
    },
  );
}

async function emitAnalyticsEvent(
  taskId: string,
  resolvedState: string,
  context: TaskMachineContext,
): Promise<void> {
  const db = getDb();

  const event = {
    taskId: new ObjectId(taskId),
    userId: new ObjectId(context.userId),
    resolvedState,
    subject: context.subject,
    level: context.level,
    snoozeCount: context.snoozeCount,
    escalationTier: context.escalationTier,
    missReason: context.missReason,
    scheduledStart: new Date(context.scheduledStart),
    scheduledEnd: new Date(context.scheduledEnd),
    resolvedAt: new Date(),
  };

  try {
    await db.collection("taskAnalytics").insertOne(event);
  } catch (err: any) {
    console.error(`❌ Failed to write analytics: ${err.message}`);
  }

  console.log(`📊 Analytics: [${context.title}]`, event);
}

// ─── Utility ─────────────────────────────────────────────────────────────────

async function sendMessage(chatId: string, text: string): Promise<void> {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
  } catch (e) {
    // Fallback to plain text if HTML parsing fails
    await bot.sendMessage(chatId, text.replace(/<[^>]+>/g, ""));
  }
}

