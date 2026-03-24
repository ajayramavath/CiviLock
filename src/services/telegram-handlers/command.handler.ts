// src/services/telegram-handlers/command.handler.ts
import TelegramBot from "node-telegram-bot-api";
import { getDb } from "../../db.js";
import {
  getAvoidanceAlerts,
  getWeeklySubjectStats,
} from "../analytics.service.js";
import { trackEvent } from "../posthog.service.js";
import { createDefaultProfile, getUserCurrentDayCycle } from "../profile.service.js";
import { ObjectId } from "mongodb";
import { formatTime } from "../../utils/timezone.js";
import { WELCOME_MESSAGE } from "./message.handler.js";

// ─── Prelims helper ──────────────────────────────────────────────────────────

function getPrelimsDate(year: number): Date {
  const exceptions: Record<number, string> = {
    2025: "2025-05-25",
    2026: "2026-05-24",
  };
  if (exceptions[year]) {
    return new Date(exceptions[year]);
  }
  const may31 = new Date(year, 4, 31);
  const lastSunday = new Date(may31);
  lastSunday.setDate(may31.getDate() - may31.getDay());
  return lastSunday;
}

export function daysUntilPrelims(year: number): number {
  const prelims = getPrelimsDate(year);
  return Math.max(
    0,
    Math.ceil((prelims.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
  );
}

// ─── Register all commands ───────────────────────────────────────────────────

export function registerCommandHandlers(bot: TelegramBot) {
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const db = getDb();

    let user = await db
      .collection("users")
      .findOne({ telegramChatId: chatId.toString() });

    if (!user) {
      // ── New user ────────────────────────────────────────────────────
      const userId = new ObjectId();
      const firstName = msg.from?.first_name || "User";

      await db.collection("users").insertOne({
        _id: userId,
        name: firstName,
        telegramChatId: chatId.toString(),
        strictnessLevel: 1,
        timezone: "Asia/Kolkata",
        wakeTime: null,
        sleepSchedule: null,
        dailyCheckInTime: null,
        weeklyReviewTime: null,
        upscProfile: null,
        studyPlan: null,
        profile: createDefaultProfile(firstName),
        onboardingComplete: false,
        createdAt: new Date(),
      });

      trackEvent(chatId.toString(), "user_created_via_start");
      await bot.sendMessage(chatId, WELCOME_MESSAGE, { parse_mode: "Markdown" });

    } else {
      // ── Existing user ───────────────────────────────────────────────
      // Ensure profile subdoc exists (migration for old users)
      if (!user.profile) {
        await db.collection("users").updateOne(
          { _id: user._id },
          { $set: { profile: createDefaultProfile(user.name) } },
        );
      }

      const days = user.upscProfile
        ? daysUntilPrelims(user.upscProfile.targetYear)
        : null;
      const countdown = days ? `\n⏰ <b>${days} days until Prelims</b>` : "";
      const name = user.profile?.name || user.name || "there";

      await bot.sendMessage(
        chatId,
        `👋 <b>${name}</b>!${countdown}\n\n` +
        `/today — Today's blocks\n` +
        `/week — Weekly summary\n` +
        `/strictness — Change accountability level\n` +
        `/help — All commands\n\n` +
        `Or just tell me what you need to study.`,
        { parse_mode: "HTML" },
      );
    }
  });
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
      `/today - View today's schedule\n` +
      `/week - Weekly subject-wise summary\n` +
      `<b>Settings:</b>\n` +
      `/strictness - Change accountability level\n` +
      `<b>Quick Add:</b>\n` +
      `<i>"study polity 9am to 12pm"</i>\n` +
      `<i>"revise geography 2 hours"</i>\n` +
      `<i>"answer writing practice evening"</i>`,
      { parse_mode: "HTML" },
    );
  });

  // ── /today ─────────────────────────────────────────────────────────────

  bot.onText(/\/today/, async (msg) => {
    const chatId = msg.chat.id;
    trackEvent(chatId.toString(), "command_used", { command: "/today" });
    const db = getDb();
    const user = await db
      .collection("users")
      .findOne({ telegramChatId: chatId.toString() });

    if (!user) {
      await bot.sendMessage(chatId, "Hey! Use /start to get set up first.");
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
        `📭 No study blocks scheduled for today.${days ? `\n\n⏰ ${days} days until Prelims.` : ""}\n\nTell me what you're studying, or send your timetable!`,
      );
      return;
    }

    const completed = tasks.filter((t) => t.status === "completed").length;
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
    } else {
      message += `🎉 All blocks completed today!`;
    }

    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
  });

  // ── /week ──────────────────────────────────────────────────────────────

  bot.onText(/\/week/, async (msg) => {
    const chatId = msg.chat.id;
    trackEvent(chatId.toString(), "command_used", { command: "/week" });
    const db = getDb();
    const user = await db
      .collection("users")
      .findOne({ telegramChatId: chatId.toString() });

    if (!user) {
      await bot.sendMessage(chatId, "Hey! Use /start to get set up first.");
      return;
    }

    const days = user.upscProfile
      ? daysUntilPrelims(user.upscProfile.targetYear)
      : null;
    const onboardedAt = user.createdAt ? new Date(user.createdAt) : undefined;
    const stats = await getWeeklySubjectStats(user._id, onboardedAt);
    const avoidance = await getAvoidanceAlerts(user._id, onboardedAt);

    if (stats.totalBlocks === 0) {
      await bot.sendMessage(
        chatId,
        `📊 <b>Weekly Summary</b>${days ? ` — ⏰ ${days} days until Prelims` : ""}\n\nNo study blocks this week yet. Tell me what you're studying, or send your timetable!`,
        { parse_mode: "HTML" },
      );
      return;
    }

    let message = `📊 <b>Weekly Summary</b> (Last 7 Days)${days ? `\n⏰ <b>${days} days until Prelims</b>` : ""}\n\n`;

    message +=
      `<b>Overview:</b>\n` +
      `📋 Blocks: ${stats.completedBlocks}/${stats.totalBlocks} completed (${stats.completionRate}%)\n` +
      `⏱ Hours: ${stats.completedHours}h completed / ${stats.totalHours}h scheduled` +
      `${stats.skippedHours > 0 ? ` / ${stats.skippedHours}h skipped` : ""}\n` +
      `🔥 Streak: ${stats.currentStreak} day${stats.currentStreak !== 1 ? "s" : ""}\n\n`;

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
          const compH = Math.round((s.completedMinutes / 60) * 10) / 10;
          const schedH = Math.round((s.totalMinutes / 60) * 10) / 10;
          let line = `${bar} <b>${s.subject}</b>: ${compH}h / ${schedH}h (${s.completionRate}%)`;
          if (s.skippedMinutes > 0) {
            const skipH = Math.round((s.skippedMinutes / 60) * 10) / 10;
            line += ` — ${skipH}h skipped`;
          }
          message += `${line}\n`;
        });

      message += "\n";
    }

    if (avoidance.length > 0) {
      message += `<b>⚠️ Avoidance Alerts:</b>\n`;
      avoidance.forEach((a) => {
        message += `🔴 <b>${a.subject}</b>: skipped ${a.skipCount} times this week\n`;
      });
      message += "\n";
    }

    if (user.upscProfile?.weakSubjects?.length > 0) {
      const weakNotStudied = user.upscProfile.weakSubjects.filter(
        (ws: string) => {
          const short = ws.split(" (")[0];
          const stat = stats.subjects.find((s) => s.subject === short);
          return !stat || stat.completedMinutes < 60;
        },
      );

      if (weakNotStudied.length > 0) {
        const names = weakNotStudied
          .map((s: string) => s.split(" (")[0])
          .join(", ");
        message += `❗ <b>Weak subjects need attention:</b> ${names}\n\n`;
      }
    }

    if (stats.previousWeekRate !== null) {
      const diff = stats.completionRate - stats.previousWeekRate;
      const arrow = diff > 0 ? "📈" : diff < 0 ? "📉" : "➡️";
      message += `${arrow} vs last week: ${diff > 0 ? "+" : ""}${diff}% completion rate\n`;
    }

    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
  });
  // ── /strictness ────────────────────────────────────────────────────────

  bot.onText(/\/strictness/, async (msg) => {
    const chatId = msg.chat.id;
    trackEvent(chatId.toString(), "command_used", { command: "/strictness" });
    const db = getDb();
    const user = await db
      .collection("users")
      .findOne({ telegramChatId: chatId.toString() });

    if (!user) {
      await bot.sendMessage(chatId, "Use /start to get set up first.");
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

// ── Strictness change callback ───────────────────────────────────────────

export async function handleStrictnessChangeCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<boolean> {
  const data = query.data!;
  if (!data.startsWith("change_strictness_")) return false;

  const chatId = query.message!.chat.id;
  const level = parseInt(data.replace("change_strictness_", "")) as 1 | 2;
  const db = getDb();

  await db.collection("users").updateOne(
    { telegramChatId: chatId.toString() },
    {
      $set: {
        strictnessLevel: level,
        "profile.strictnessLevel": level,
      },
    },
  );

  const name = level === 2 ? "Strict Mentor 🔥" : "Study Partner 📖";

  try {
    await bot.editMessageText(`✅ Changed to: <b>${name}</b>`, {
      chat_id: chatId,
      message_id: query.message!.message_id,
      reply_markup: { inline_keyboard: [] },
      parse_mode: "HTML",
    });
  } catch { }

  await bot.answerCallbackQuery(query.id, { text: `Switched to ${name}` });
  await bot.sendMessage(
    chatId,
    `Accountability level: <b>${name}</b>\n\n${level === 2 ? "No more easy exits. I'll follow up." : "I'll track and remind, but won't chase."}`,
    { parse_mode: "HTML" },
  );

  return true;
}