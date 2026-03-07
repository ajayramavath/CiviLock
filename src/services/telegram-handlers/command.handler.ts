import TelegramBot from "node-telegram-bot-api";
import { getDb } from "../../db.js";
import {
  getUserCurrentDayCycle,
  getUserNextDayCycle,
  formatTime,
  formatDateTime,
} from "../conversation.service";
import { getState, setState } from "../conversation-state.service.js";
import {
  getAvoidanceAlerts,
  getWeeklySubjectStats,
} from "../analytics.service.js";
import { trackEvent } from "../posthog.service.js";

// ─── Prelims helper ──────────────────────────────────────────────────────────

function daysUntilPrelims(targetYear: number): number {
  const may = new Date(targetYear, 4, 31);
  const dayOfWeek = may.getDay();
  const lastSunday = new Date(may);
  lastSunday.setDate(may.getDate() - dayOfWeek);
  const diff = lastSunday.getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

// ─── Register all commands ───────────────────────────────────────────────────

export function registerCommandHandlers(bot: TelegramBot) {
  // ── /help ──────────────────────────────────────────────────────────────

  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    trackEvent(chatId.toString(), "command_used", { command: "/help" });
    const db = getDb();
    const user = await db
      .collection("users")
      .findOne({ telegramChatId: chatId.toString() });
    const days = user?.upscProfile
      ? daysUntilPrelims(user.upscProfile.targetYear)
      : null;
    const countdown = days ? `\n\n⏰ <b>${days} days until Prelims</b>` : "";

    await bot.sendMessage(
      chatId,
      `📖 <b>Commands</b>${countdown}\n\n` +
      `<b>Study Management:</b>\n` +
      `/plan - Schedule tomorrow's study blocks\n` +
      `/today - View today's schedule\n` +
      `/week - Weekly subject-wise summary\n` +
      `/complete [number] - Mark study block done\n\n` +
      `<b>Settings:</b>\n` +
      `/strictness - Change accountability level\n` +
      `/pause [minutes] - Pause reminders\n\n` +
      `<b>Quick Add:</b>\n` +
      `<i>"study polity 9am to 12pm"</i>\n` +
      `<i>"revise geography 2 hours"</i>\n` +
      `<i>"answer writing practice evening"</i>`,
      { parse_mode: "HTML" },
    );
  });

  // ── /plan — UPSC bulk study scheduling ─────────────────────────────────

  bot.onText(/\/plan/, async (msg) => {
    const chatId = msg.chat.id;
    trackEvent(chatId.toString(), "command_used", { command: "/plan" });
    const db = getDb();
    const user = await db
      .collection("users")
      .findOne({ telegramChatId: chatId.toString() });
    const state = await getState(chatId.toString());

    if (!user || !user.onboardingComplete) {
      await bot.sendMessage(
        chatId,
        "⚠️ Please complete setup first. Use /start",
      );
      return;
    }

    const dayCycle = getUserNextDayCycle(user);
    const days = user.upscProfile
      ? daysUntilPrelims(user.upscProfile.targetYear)
      : null;
    const countdown = days ? `\n⏰ <b>${days} days until Prelims</b>\n` : "";

    // Check if there are already tasks for tomorrow
    const existingTasks = await db
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

    let existingInfo = "";
    if (existingTasks.length > 0) {
      existingInfo =
        `\n📋 <b>Already scheduled:</b>\n` +
        existingTasks
          .map(
            (t) =>
              `  ${formatTime(t.scheduledStart)} - ${t.title}${t.subject ? ` [${t.subject}]` : ""}`,
          )
          .join("\n") +
        "\n\nNew blocks will be added alongside these.\n";
    }

    // Get avoidance data to suggest what to study
    const avoidance = await getAvoidanceAlerts(user._id);
    let suggestion = "";
    if (avoidance.length > 0) {
      const avoided = avoidance.map((a) => a.subject).join(", ");
      suggestion = `\n⚠️ <b>You've been avoiding:</b> ${avoided}\nConsider including these tomorrow.\n`;
    }

    await setState(chatId.toString(), {
      step: "idle",
      data: { planningMode: true, dayCycle },
      history: state?.history || [],
    });

    await bot.sendMessage(
      chatId,
      `📋 <b>Plan Tomorrow's Study</b>\n${countdown}` +
      `\n🌅 ${formatDateTime(dayCycle.startDateTime)} → 😴 ${formatDateTime(dayCycle.endDateTime)}\n` +
      existingInfo +
      suggestion +
      `\nDump your full plan:\n` +
      `<i>"9-12 polity, 2-5 optional, 7-8 CA, 9-10 answer writing"</i>\n\n` +
      `Or one at a time:\n` +
      `<i>"study polity 9am to 12pm"</i>`,
      { parse_mode: "HTML" },
    );
  });

  // ── /today — show today's study blocks with subject tags ───────────────

  bot.onText(/\/today/, async (msg) => {
    const chatId = msg.chat.id;
    trackEvent(chatId.toString(), "command_used", { command: "/today" });
    const db = getDb();
    const user = await db
      .collection("users")
      .findOne({ telegramChatId: chatId.toString() });

    if (!user || !user.onboardingComplete) {
      await bot.sendMessage(chatId, "Please complete setup first. Use /start");
      return;
    }

    const dayCycle = getUserCurrentDayCycle(user);
    const days = user.upscProfile
      ? daysUntilPrelims(user.upscProfile.targetYear)
      : null;

    const tasks = await db
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

    if (tasks.length === 0) {
      await bot.sendMessage(
        chatId,
        `📭 No study blocks scheduled for today.${days ? `\n\n⏰ ${days} days until Prelims.` : ""}\n\nUse /plan to schedule, or just tell me what to study!`,
      );
      return;
    }

    const completed = tasks.filter((t) => t.status === "completed").length;
    const partial = tasks.filter((t) => t.status === "partial").length;
    const skipped = tasks.filter((t) => t.status === "skipped").length;

    // Calculate hours
    const totalMinutes = tasks.reduce(
      (sum, t) => sum + (t.estimatedMinutes || 60),
      0,
    );
    const completedMinutes = tasks
      .filter((t) => t.status === "completed")
      .reduce((sum, t) => sum + (t.estimatedMinutes || 60), 0);

    let message =
      `📅 <b>Today's Study Blocks</b> (${completed}/${tasks.length} done)` +
      `${days ? ` — ⏰ ${days} days` : ""}\n` +
      `📊 ${Math.round(completedMinutes / 60)}h / ${Math.round(totalMinutes / 60)}h studied\n\n`;

    tasks.forEach((task, i) => {
      const statusIcon =
        task.status === "completed"
          ? "✅"
          : task.status === "partial"
            ? "⚠️"
            : task.status === "skipped"
              ? "❌"
              : "⏳";
      const time = formatTime(task.scheduledStart);
      const subject = task.subject ? ` <code>[${task.subject}]</code>` : "";

      message += `${i + 1}. ${statusIcon} ${task.title}${subject}\n   ⏰ ${time} (${task.estimatedMinutes || 60}min)\n\n`;
    });

    if (completed < tasks.length) {
      message += `Reply /complete [number] to mark done`;
    } else {
      message += `🎉 All blocks completed today!`;
    }

    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
  });

  // ── /week — weekly subject-wise summary + avoidance alerts ─────────────

  bot.onText(/\/week/, async (msg) => {
    const chatId = msg.chat.id;
    trackEvent(chatId.toString(), "command_used", { command: "/week" });
    const db = getDb();
    const user = await db
      .collection("users")
      .findOne({ telegramChatId: chatId.toString() });

    if (!user || !user.onboardingComplete) {
      await bot.sendMessage(chatId, "Please complete setup first. Use /start");
      return;
    }

    const days = user.upscProfile
      ? daysUntilPrelims(user.upscProfile.targetYear)
      : null;
    const stats = await getWeeklySubjectStats(user._id);
    const avoidance = await getAvoidanceAlerts(user._id);

    if (stats.totalBlocks === 0) {
      await bot.sendMessage(
        chatId,
        `📊 <b>Weekly Summary</b>${days ? ` — ⏰ ${days} days until Prelims` : ""}\n\nNo study blocks this week yet. Use /plan to get started!`,
        { parse_mode: "HTML" },
      );
      return;
    }

    let message = `📊 <b>Weekly Summary</b> (Last 7 Days)${days ? `\n⏰ <b>${days} days until Prelims</b>` : ""}\n\n`;

    // Overall stats
    message +=
      `<b>Overview:</b>\n` +
      `📋 Blocks: ${stats.completedBlocks}/${stats.totalBlocks} completed (${stats.completionRate}%)\n` +
      `⏱ Hours: ${stats.completedHours}h completed / ${stats.totalHours}h scheduled` +
      `${stats.skippedHours > 0 ? ` / ${stats.skippedHours}h skipped` : ""}\n` +
      `🔥 Streak: ${stats.currentStreak} day${stats.currentStreak !== 1 ? "s" : ""}\n\n`;

    // Subject breakdown with hours
    if (stats.subjects.length > 0) {
      message += `<b>Subject-wise Hours:</b>\n`;

      stats.subjects
        .sort((a, b) => b.totalMinutes - a.totalMinutes)
        .forEach((s) => {
          const bar =
            s.completionRate >= 80
              ? "🟢"
              : s.completionRate >= 50
                ? "🟡"
                : "🔴";
          const compH = Math.round(s.completedMinutes / 60 * 10) / 10;
          const schedH = Math.round(s.totalMinutes / 60 * 10) / 10;
          let line = `${bar} <b>${s.subject}</b>: ${compH}h / ${schedH}h (${s.completionRate}%)`;
          if (s.skippedMinutes > 0) {
            const skipH = Math.round(s.skippedMinutes / 60 * 10) / 10;
            line += ` — ${skipH}h skipped`;
          }
          message += `${line}\n`;
        });

      message += "\n";
    }

    // Avoidance alerts
    if (avoidance.length > 0) {
      message += `<b>⚠️ Avoidance Alerts:</b>\n`;
      avoidance.forEach((a) => {
        message += `🔴 <b>${a.subject}</b>: skipped ${a.skipCount} times this week\n`;
      });
      message += "\n";
    }

    // Weak subject check
    if (user.upscProfile?.weakSubjects?.length > 0) {
      const weakNotStudied = user.upscProfile.weakSubjects.filter(
        (ws: string) => {
          const short = ws.split(" (")[0];
          const stat = stats.subjects.find((s) => s.subject === short);
          return !stat || stat.completedMinutes < 60; // less than 1 hour on a weak subject
        },
      );

      if (weakNotStudied.length > 0) {
        const names = weakNotStudied
          .map((s: string) => s.split(" (")[0])
          .join(", ");
        message += `❗ <b>Weak subjects need attention:</b> ${names}\n\n`;
      }
    }

    // Comparison placeholder
    if (stats.previousWeekRate !== null) {
      const diff = stats.completionRate - stats.previousWeekRate;
      const arrow = diff > 0 ? "📈" : diff < 0 ? "📉" : "➡️";
      message += `${arrow} vs last week: ${diff > 0 ? "+" : ""}${diff}% completion rate\n`;
    }

    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
  });

  // ── /complete [number] ─────────────────────────────────────────────────

  bot.onText(/\/complete (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!match || !match[1]) {
      await bot.sendMessage(chatId, "Usage: /complete [task number]");
      return;
    }

    const taskNumber = parseInt(match[1]);
    const db = getDb();
    const user = await db
      .collection("users")
      .findOne({ telegramChatId: chatId.toString() });

    if (!user || !user.onboardingComplete) {
      await bot.sendMessage(chatId, "Please complete setup first.");
      return;
    }

    const dayCycle = getUserCurrentDayCycle(user);
    const tasks = await db
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

    if (taskNumber < 1 || taskNumber > tasks.length) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid number. Use /today to see your blocks.",
      );
      return;
    }

    const task = tasks[taskNumber - 1];
    if (!task) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid number. Use /today to see your blocks.",
      );
      return;
    }

    // Try to send machine event first, fall back to direct DB update
    try {
      const { sendMachineEvent } = await import("../task-machine.service.js");
      const result = await sendMachineEvent(task._id.toString(), {
        type: "USER_COMPLETED",
      });
      if (!result) {
        // Machine not found — direct DB update (legacy task)
        await db
          .collection("actionStations")
          .updateOne(
            { _id: task._id },
            { $set: { status: "completed", completedAt: new Date() } },
          );
      }
    } catch {
      await db
        .collection("actionStations")
        .updateOne(
          { _id: task._id },
          { $set: { status: "completed", completedAt: new Date() } },
        );
    }

    const remaining = tasks.filter((t) => t.status !== "completed").length - 1;
    const subject = task.subject ? ` [${task.subject}]` : "";

    await bot.sendMessage(
      chatId,
      `✅ <b>${task.title}</b>${subject} completed!\n\n${remaining > 0 ? `${remaining} blocks left today. Keep pushing! 💪` : `🎉 All done for today!`}`,
      { parse_mode: "HTML" },
    );
  });

  // ── /strictness — 2 levels ─────────────────────────────────────────────

  bot.onText(/\/strictness/, async (msg) => {
    const chatId = msg.chat.id;
    trackEvent(chatId.toString(), "command_used", { command: "/strictness" });
    const db = getDb();
    const user = await db
      .collection("users")
      .findOne({ telegramChatId: chatId.toString() });

    if (!user) {
      await bot.sendMessage(chatId, "Please use /start first.");
      return;
    }

    const current =
      user.strictnessLevel === 2 ? "Strict Mentor 🔥" : "Study Partner 📖";

    await bot.sendMessage(
      chatId,
      `Current level: <b>${current}</b>\n\nChoose your accountability level:`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "📖 Study Partner",
                callback_data: "change_strictness_1",
              },
              {
                text: "🔥 Strict Mentor",
                callback_data: "change_strictness_2",
              },
            ],
          ],
        },
      },
    );
  });
}

// ── Strictness change callback (register in callback.handler.ts) ─────────

export async function handleStrictnessChangeCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<boolean> {
  const data = query.data!;
  if (!data.startsWith("change_strictness_")) return false;

  const chatId = query.message!.chat.id;
  const level = parseInt(data.replace("change_strictness_", "")) as 1 | 2;
  const db = getDb();

  await db
    .collection("users")
    .updateOne(
      { telegramChatId: chatId.toString() },
      { $set: { strictnessLevel: level } },
    );

  const name = level === 2 ? "Strict Mentor 🔥" : "Study Partner 📖";
  await bot.answerCallbackQuery(query.id, { text: `Switched to ${name}` });
  await bot.sendMessage(
    chatId,
    `✅ Accountability level: <b>${name}</b>\n\n${level === 2 ? "No more easy exits. I'll follow up." : "I'll track and remind, but won't chase."}`,
    { parse_mode: "HTML" },
  );

  return true;
}
