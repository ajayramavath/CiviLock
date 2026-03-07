// src/services/telegram-handlers/onboarding.handler.ts
import TelegramBot from "node-telegram-bot-api";
import { getDb } from "../../db.js";
import { ObjectId } from "mongodb";
import { formatHourMin } from "../conversation.service.js";
import { getState, setState } from "../conversation-state.service.js";
import { parseTime } from "../telegram.service.js";
import { UPSC_SUBJECTS } from "../../models/types.js";
import {
  promptForSchedule,
  handleTimetableMessage,
  handleTimetableCallback,
} from "./timetable.handler.js";
import { trackEvent, identifyUser } from "../posthog.service.js";

function daysUntilPrelims(targetYear: number): number {
  const may = new Date(targetYear, 4, 31);
  const dayOfWeek = may.getDay();
  const lastSunday = new Date(may);
  lastSunday.setDate(may.getDate() - dayOfWeek);
  return Math.max(
    0,
    Math.ceil((lastSunday.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
  );
}

// ─── /start ──────────────────────────────────────────────────────────────────

export function registerOnboardingHandlers(bot: TelegramBot) {
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const db = getDb();

    let user = await db
      .collection("users")
      .findOne({ telegramChatId: chatId.toString() });

    if (!user) {
      const userId = new ObjectId();
      await db.collection("users").insertOne({
        _id: userId,
        name: msg.from?.first_name || "User",
        telegramChatId: chatId.toString(),
        strictnessLevel: 2,
        timezone: "Asia/Kolkata",
        sleepSchedule: null,
        dailyCheckInTime: null,
        weeklyReviewTime: null,
        upscProfile: null,
        studyPlan: null,
        onboardingComplete: false,
        createdAt: new Date(),
      });

      trackEvent(chatId.toString(), "onboarding_started");

      await setState(chatId.toString(), {
        step: "onboarding_name",
        data: { userId: userId.toString() },
        history: [],
      });

      await bot.sendMessage(
        chatId,
        `🎯 <b>Welcome to your UPSC Accountability Agent!</b>\n\n` +
        `I don't teach. I <b>enforce</b>.\n\n` +
        `Give me your study schedule, and I'll make sure you actually follow it. ` +
        `Every day. No excuses.\n\n` +
        `Quick setup — 2 minutes.\n\n` +
        `<b>What should I call you?</b>`,
        { parse_mode: "HTML" },
      );
    } else if (!user.onboardingComplete) {
      await setState(chatId.toString(), {
        step: "onboarding_name",
        data: { userId: user._id.toString() },
        history: [],
      });
      await bot.sendMessage(
        chatId,
        `👋 Welcome back! Let's finish setup.\n\n<b>What should I call you?</b>`,
        { parse_mode: "HTML" },
      );
    } else {
      const days = user.upscProfile
        ? daysUntilPrelims(user.upscProfile.targetYear)
        : null;
      const countdown = days ? `\n⏰ <b>${days} days until Prelims</b>` : "";
      await bot.sendMessage(
        chatId,
        `👋 <b>${user.name}</b>!${countdown}\n\n/today - Today's blocks\n/plan - Plan tomorrow\n/week - Weekly summary\n/mytimetable - View plan\n/help - All commands`,
        { parse_mode: "HTML" },
      );
    }
  });
}

// ─── Message handler ─────────────────────────────────────────────────────────

export async function handleOnboardingMessage(
  bot: TelegramBot,
  msg: TelegramBot.Message,
): Promise<boolean> {
  const chatId = msg.chat.id;
  const db = getDb();
  const state = await getState(chatId.toString());

  console.log("received a message");

  if (!state || !state.step.startsWith("onboarding_")) return false;
  console.log("received a message 1");

  // Delegate timetable step
  if (state.step === "onboarding_timetable_input") {
    return await handleTimetableMessage(bot, msg);
  }

  // ── Name ──
  if (state.step === "onboarding_name") {
    const name = msg.text!.trim();
    await db
      .collection("users")
      .updateOne({ _id: new ObjectId(state.data.userId) }, { $set: { name } });
    await setState(chatId.toString(), {
      step: "onboarding_wake",
      data: { ...state.data, name },
      history: [],
    });
    await bot.sendMessage(
      chatId,
      `<b>${name}</b> — got it.\n\n<b>What time do you wake up?</b>\n<i>"6am", "7:30", "5"</i>`,
      { parse_mode: "HTML" },
    );
    trackEvent(chatId.toString(), "onboarding_step_completed", { step: "name" });
    return true;
  }

  // ── Wake ──
  if (state.step === "onboarding_wake") {
    const t = parseTime(msg.text!);
    if (!t) {
      await bot.sendMessage(chatId, `Try: <i>"6am"</i> or <i>"7:30"</i>`, {
        parse_mode: "HTML",
      });
      return true;
    }
    await setState(chatId.toString(), {
      step: "onboarding_sleep",
      data: { ...state.data, wakeHour: t.hour, wakeMinute: t.minute },
      history: [],
    });
    await bot.sendMessage(
      chatId,
      `✅ Wake: <b>${formatHourMin(t.hour, t.minute)}</b>\n\n<b>Sleep time?</b>\n<i>"12am", "1:30am", "midnight"</i>`,
      { parse_mode: "HTML" },
    );
    trackEvent(chatId.toString(), "onboarding_step_completed", { step: "wake" });
    return true;
  }

  // ── Sleep ──
  if (state.step === "onboarding_sleep") {
    const t = parseTime(msg.text!);
    if (!t) {
      await bot.sendMessage(chatId, `Try: <i>"12am"</i> or <i>"1:30am"</i>`, {
        parse_mode: "HTML",
      });
      return true;
    }

    let checkInHour = t.hour - 1;
    if (checkInHour < 0) checkInHour = 23;
    const dailyCheckInTime = `${checkInHour.toString().padStart(2, "0")}:${t.minute.toString().padStart(2, "0")}`;

    await db.collection("users").updateOne(
      { _id: new ObjectId(state.data.userId) },
      {
        $set: {
          sleepSchedule: {
            wakeHour: state.data.wakeHour,
            wakeMinute: state.data.wakeMinute,
            sleepHour: t.hour,
            sleepMinute: t.minute,
          },
          dailyCheckInTime,
          weeklyReviewTime: "Sunday 21:00",
        },
      },
    );

    await setState(chatId.toString(), {
      step: "onboarding_target_year",
      data: {
        ...state.data,
        sleepHour: t.hour,
        sleepMinute: t.minute,
        dailyCheckInTime,
      },
      history: [],
    });

    await bot.sendMessage(
      chatId,
      `✅ ${formatHourMin(state.data.wakeHour, state.data.wakeMinute)} → ${formatHourMin(t.hour, t.minute)}\n\n<b>Which Prelims?</b>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🎯 2026", callback_data: "upsc_year_2026" },
              { text: "🎯 2027", callback_data: "upsc_year_2027" },
            ],
            [{ text: "🎯 2028", callback_data: "upsc_year_2028" }],
          ],
        },
      },
    );
    trackEvent(chatId.toString(), "onboarding_step_completed", { step: "sleep" });
    return true;
  }

  // ── Optional subject (text) ──
  if (state.step === "onboarding_optional_subject") {
    await setState(chatId.toString(), {
      step: "onboarding_prep_mode",
      data: { ...state.data, optionalSubject: msg.text!.trim() },
      history: [],
    });
    await bot.sendMessage(
      chatId,
      `✅ <b>${msg.text!.trim()}</b>\n\n<b>Coaching or self-study?</b>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🏫 Coaching", callback_data: "upsc_prep_coaching" },
              { text: "📚 Self-Study", callback_data: "upsc_prep_self" },
            ],
          ],
        },
      },
    );
    return true;
  }

  // ── Button-driven steps ──
  if (
    [
      "onboarding_target_year",
      "onboarding_attempt",
      "onboarding_prep_mode",
      "onboarding_weak_subjects",
      "onboarding_strictness",
    ].includes(state.step)
  ) {
    await bot.sendMessage(chatId, "Tap a button above ☝️");
    return true;
  }

  return false;
}

// ─── Callback handler ────────────────────────────────────────────────────────

export async function handleOnboardingCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<boolean> {
  const data = query.data!;
  const chatId = query.message!.chat.id;
  const db = getDb();
  const state = await getState(chatId.toString());

  if (data.startsWith("tt_")) return await handleTimetableCallback(bot, query);
  if (
    !data.startsWith("strictness_") &&
    !data.startsWith("upsc_") &&
    !data.startsWith("weak_")
  )
    return false;
  if (!state) return false;

  // ── Target Year ──
  if (data.startsWith("upsc_year_")) {
    const year = parseInt(data.replace("upsc_year_", ""));
    await setState(chatId.toString(), {
      step: "onboarding_attempt",
      data: { ...state.data, targetYear: year },
      history: [],
    });
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(
      chatId,
      `🎯 <b>Prelims ${year}</b> — ${daysUntilPrelims(year)} days\n\n<b>Which attempt?</b>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "1️⃣ First", callback_data: "upsc_attempt_1" },
              { text: "2️⃣ Second", callback_data: "upsc_attempt_2" },
            ],
            [{ text: "3️⃣ Third+", callback_data: "upsc_attempt_3" }],
          ],
        },
      },
    );
    return true;
  }

  // ── Attempt ──
  if (data.startsWith("upsc_attempt_")) {
    const attempt = parseInt(data.replace("upsc_attempt_", ""));
    await setState(chatId.toString(), {
      step: "onboarding_optional_subject",
      data: { ...state.data, attemptNumber: attempt },
      history: [],
    });
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(
      chatId,
      `✅ Attempt #${attempt}\n\n<b>Optional subject?</b>\n<i>"Public Administration", "Sociology", "Geography"</i>`,
      { parse_mode: "HTML" },
    );
    return true;
  }

  // ── Prep Mode ──
  if (data.startsWith("upsc_prep_")) {
    const mode =
      data.replace("upsc_prep_", "") === "self" ? "self-study" : "coaching";
    await setState(chatId.toString(), {
      step: "onboarding_weak_subjects",
      data: { ...state.data, preparationMode: mode, selectedWeak: [] },
      history: [],
    });
    await bot.answerCallbackQuery(query.id);
    await sendWeakSelector(bot, chatId, []);
    return true;
  }

  // ── Weak toggle ──
  if (data.startsWith("weak_toggle_")) {
    const idx = parseInt(data.replace("weak_toggle_", ""));
    const subject = UPSC_SUBJECTS[idx];
    if (!subject) return true;
    const current: string[] = state.data?.selectedWeak || [];
    const updated = current.includes(subject)
      ? current.filter((s: string) => s !== subject)
      : [...current, subject];
    await setState(chatId.toString(), {
      ...state,
      data: { ...state.data, selectedWeak: updated },
    });
    await bot.answerCallbackQuery(query.id);
    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: buildWeakKb(updated) },
        { chat_id: chatId, message_id: query.message!.message_id },
      );
    } catch { }
    return true;
  }

  // ── Weak done ──
  if (data === "weak_done") {
    const weak: string[] = state.data?.selectedWeak || [];
    await setState(chatId.toString(), {
      step: "onboarding_strictness",
      data: { ...state.data, weakSubjects: weak },
      history: [],
    });
    await bot.answerCallbackQuery(query.id);
    const list =
      weak.length > 0
        ? weak.map((s: string) => s.split(" (")[0]).join(", ")
        : "None";
    await bot.sendMessage(
      chatId,
      `✅ Weak: <b>${list}</b>\n\n<b>Accountability level:</b>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📖 Study Partner", callback_data: "strictness_1" }],
            [{ text: "🔥 Strict Mentor", callback_data: "strictness_2" }],
          ],
        },
      },
    );
    await bot.sendMessage(
      chatId,
      `<b>Study Partner:</b> Tracks, reminds gently. Silence = backs off.\n\n<b>Strict Mentor:</b> Follows up, asks why, confronts avoidance.`,
      { parse_mode: "HTML" },
    );
    return true;
  }

  // ── Strictness → save profile → ask for schedule ──
  if (data.startsWith("strictness_")) {
    const level = Math.min(parseInt(data.replace("strictness_", "")), 2) as
      | 1
      | 2;
    const user = await db
      .collection("users")
      .findOne({ telegramChatId: chatId.toString() });
    if (!user) return true;

    const upscProfile = {
      targetYear: state.data?.targetYear || 2026,
      attemptNumber: state.data?.attemptNumber || 1,
      optionalSubject: state.data?.optionalSubject || null,
      preparationMode: state.data?.preparationMode || "self-study",
      weakSubjects: state.data?.weakSubjects || [],
    };

    await db
      .collection("users")
      .updateOne(
        { _id: user._id },
        { $set: { strictnessLevel: level, upscProfile } },
      );
    await bot.answerCallbackQuery(query.id);

    await bot.sendMessage(
      chatId,
      `✅ ${level === 2 ? "Strict Mentor 🔥" : "Study Partner 📖"}`,
      { parse_mode: "HTML" },
    );

    trackEvent(chatId.toString(), "onboarding_step_completed", {
      step: "strictness",
      strictnessLevel: level,
    });
    identifyUser(chatId.toString(), {
      name: state.data?.name,
      strictnessLevel: level,
      targetYear: state.data?.targetYear,
      attemptNumber: state.data?.attemptNumber,
      optionalSubject: state.data?.optionalSubject,
      preparationMode: state.data?.preparationMode,
      weakSubjects: state.data?.weakSubjects,
    });

    // Go straight to schedule prompt
    await promptForSchedule(bot, chatId, {
      ...state,
      data: { ...state.data, strictnessLevel: level },
    });
    return true;
  }

  return false;
}

// ─── Weak subject selector ───────────────────────────────────────────────────

async function sendWeakSelector(
  bot: TelegramBot,
  chatId: number,
  selected: string[],
) {
  await bot.sendMessage(
    chatId,
    `<b>Weak subjects?</b> Tap to toggle, ✅ Done when finished.`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildWeakKb(selected) },
    },
  );
}

function buildWeakKb(selected: string[]): TelegramBot.InlineKeyboardButton[][] {
  const kb: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < UPSC_SUBJECTS.length; i += 2) {
    const row: TelegramBot.InlineKeyboardButton[] = [];
    for (let j = i; j < Math.min(i + 2, UPSC_SUBJECTS.length); j++) {
      const s = UPSC_SUBJECTS[j] as string;
      row.push({
        text: `${selected.includes(s) ? "✅" : "⬜"} ${s.split(" (")[0]}`,
        callback_data: `weak_toggle_${j}`,
      });
    }
    kb.push(row);
  }
  kb.push([{ text: "✅ Done", callback_data: "weak_done" }]);
  return kb;
}
