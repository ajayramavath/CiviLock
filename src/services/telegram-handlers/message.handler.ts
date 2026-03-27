/**
 * message.handler.ts
 *
 * Flow:
 *   message in
 *     → unsupported media? → reject (zero cost)
 *     → command? → skip (handled by command.handler.ts)
 *     → photo? → parseScheduleFromImage → confirm buttons
 *     → new user? → hardcoded welcome (zero cost)
 *     → 4o-mini classifier → returns tool list ($0.00004)
 *       → empty → Haiku plain chat, no tools (~$0.002)
 *       → tools → Haiku tool runner with ONLY those tools (~$0.004-0.006)
 *     → 4o-mini observe in background ($0.00005)
 */

import TelegramBot from "node-telegram-bot-api";
import { ObjectId } from "mongodb";
import { runAgent } from "../agent.service";
import {
  parseScheduleFromImage,
  saveStudyPlan,
} from "../study-plan.service";
import { createDefaultProfile } from "../profile.service";
import { appendToHistory, getHistory } from "../conversation-state.service";
import { getDb } from "../../db";
import type { User } from "../../models/types";
import { classifyMessage } from "../openai.service";

// ─── Welcome Message (hardcoded, zero API cost) ───────────

export const WELCOME_MESSAGE =
  `Hey! 👋 *Welcome to CiviLock*\n\n` +
  `I'm like that friend who won't let you skip your UPSC study schedule.\n` +
  `*Daily reminders, end-of-day reviews, and real accountability* to keep you consistent.\n` +
  `Glad you're here for the journey\n\n` +
  `*what should I call you?*`;

// ─── Auto-create user on first contact ────────────────────

interface EnsureUserResult {
  user: User;
  isNew: boolean;
}

async function ensureUser(
  chatId: number,
  msg: TelegramBot.Message
): Promise<EnsureUserResult> {
  const db = getDb();
  const existing = (await db
    .collection("users")
    .findOne({ telegramChatId: chatId.toString() })) as User | null;

  if (existing) return { user: existing, isNew: false };

  const userId = new ObjectId();
  const firstName = msg.from?.first_name || "User";

  const newUser = {
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
  };

  await db.collection("users").insertOne(newUser);
  return { user: newUser as unknown as User, isNew: true };
}

// ─── Static Response Filter ───────────────────────────────

// const STATIC_ACKS = new Set([
//   "ok", "okay", "k", "kk", "thanks", "thank you", "thankyou", "ty", "thx",
//   "cool", "nice", "great", "good", "got it", "gotcha", "noted", "done",
//   "alright", "sure", "yep", "yup", "ya", "yes", "hmm", "hm", "right", "fine",
//   "acha", "accha", "theek hai", "theek", "sahi", "haan", "ha", "ji",
// ]);

// const EMOJI_ONLY =
//   /^[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier_Base}\p{Emoji_Modifier}\p{Emoji_Component}\s]+$/u;

// function isStaticAck(text: string): boolean {
//   const normalized = text.trim().toLowerCase().replace(/[!.]+$/, "");
//   if (STATIC_ACKS.has(normalized)) return true;
//   if (EMOJI_ONLY.test(text.trim())) return true;
//   if (normalized.length <= 3 && !normalized.startsWith("/")) return true;
//   return false;
// }

const QUICK_REPLIES = ["👍", "Got it!", "Noted ✓", "Alright!", "✓", "💪"];

// function randomAck(): string {
//   return QUICK_REPLIES[Math.floor(Math.random() * QUICK_REPLIES.length)];
// }

// ─── Unsupported Media ────────────────────────────────────

const UNSUPPORTED_MEDIA_MSG =
  "I can only read text messages and photos of schedules. Please type your message or send a photo of your timetable 📸";

// ─── Photo Handler ────────────────────────────────────────

async function handlePhoto(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  user: User
): Promise<void> {
  const photo = msg.photo;
  if (!photo || photo.length === 0) return;

  const chatId = msg.chat.id;
  const file = photo[photo.length - 1];
  if (!file) return;
  const fileId = file.file_id;


  try {
    await bot.sendChatAction(chatId, "typing");

    const fileLink = await bot.getFileLink(fileId);
    const response = await fetch(fileLink);
    const buffer = Buffer.from(await response.arrayBuffer());
    const base64 = buffer.toString("base64");

    const ext = fileLink.split(".").pop()?.toLowerCase();
    const mediaType =
      ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";

    const parsed = await parseScheduleFromImage(base64, mediaType, user);

    if (!parsed.blocks || parsed.blocks.length === 0) {
      await bot.sendMessage(
        chatId,
        "I couldn't find any study schedule in that image. Try sending a clearer photo or type it out 📝"
      );
      return;
    }

    await saveStudyPlan(user._id, parsed, "[photo]", "photo");

    const blockSummary = parsed.blocks
      .map(
        (b) =>
          `${b.emoji || "📚"} ${b.title} — ${String(b.startHour).padStart(2, "0")}:${String(b.startMinute).padStart(2, "0")} (${b.durationMinutes} min)`
      )
      .join("\n");

    await bot.sendMessage(
      chatId,
      `📋 Here's what I got from your photo:\n\n${blockSummary}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Looks good", callback_data: `tt_confirm:${user._id}` },
            { text: "🔄 Redo", callback_data: `tt_redo:${user._id}` },
            { text: "⏭ Skip", callback_data: `tt_skip:${user._id}` },
          ]],
        },
      }
    );
  } catch (err: any) {
    console.error("Photo handler error:", err);
    await bot.sendMessage(
      chatId,
      "Something went wrong processing your photo. Try again or type your schedule instead 📝"
    );
  }
}

// ─── Schedule Confirmation Buttons ────────────────────────

function buildScheduleConfirmKeyboard(
  planId: string
): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "✅ Looks good", callback_data: `tt_confirm:${planId}` },
      { text: "🔄 Redo", callback_data: `tt_redo:${planId}` },
      { text: "⏭ Skip", callback_data: `tt_skip:${planId}` },
    ]],
  };
}

// ─── Send Response ────────────────────────────────────────

async function sendResponse(
  bot: TelegramBot,
  chatId: number,
  text: string,
  replyMarkup?: TelegramBot.InlineKeyboardMarkup
): Promise<void> {
  const opts: TelegramBot.SendMessageOptions = { parse_mode: "Markdown" };
  if (replyMarkup) opts.reply_markup = replyMarkup;

  const send = async (chunk: string, addMarkup: boolean) => {
    const o: TelegramBot.SendMessageOptions = { parse_mode: "Markdown" };
    if (addMarkup && replyMarkup) o.reply_markup = replyMarkup;
    try {
      await bot.sendMessage(chatId, chunk, o);
    } catch (err: any) {
      if (err.code === "ETELEGRAM" && err.message?.includes("parse entities")) {
        const plain = chunk.replace(/[*_`\[\]()~>#+\-=|{}.!]/g, "");
        const po: TelegramBot.SendMessageOptions = {};
        if (addMarkup && replyMarkup) po.reply_markup = replyMarkup;
        await bot.sendMessage(chatId, plain, po);
      } else {
        throw err;
      }
    }
  };

  if (text.length <= 4000) {
    await send(text, true);
  } else {
    const chunks = text.match(/.{1,4000}/gs) || [text];
    for (let i = 0; i < chunks.length; i++) {
      await send(chunks[i] as string, i === chunks.length - 1);
    }
  }
}

// ─── Register Handler ─────────────────────────────────────

export function registerMessageHandler(bot: TelegramBot) {
  bot.on("message", async (msg) => {
    if (!msg.text && !msg.photo) {
      if (msg.sticker || msg.animation || msg.voice || msg.video || msg.video_note || msg.document) {
        await bot.sendMessage(msg.chat.id, UNSUPPORTED_MEDIA_MSG);
      }
      return;
    }

    if (msg.text?.startsWith("/")) return;

    const chatId = msg.chat.id;

    // ── Photo ──
    if (msg.photo) {
      const { user } = await ensureUser(chatId, msg);
      await handlePhoto(bot, msg, user);
      return;
    }

    // ── Text ──
    const text = msg.text?.trim();
    if (!text) return;

    const { user, isNew } = await ensureUser(chatId, msg);

    // New user → hardcoded welcome
    if (isNew) {
      await bot.sendMessage(chatId, WELCOME_MESSAGE, { parse_mode: "Markdown" });
      return;
    }

    // ── Classify → Agent ──
    try {
      await bot.sendChatAction(chatId, "typing");

      // 1. Classify with 4o-mini (get recent history for context)
      const history = await getHistory(chatId.toString());
      const toolNames = await classifyMessage(chatId.toString(), text, history);

      console.log(`[CLASSIFY] chatId=${chatId} | tools=${JSON.stringify(toolNames)} | msg="${text.slice(0, 50)}"`);

      // In runAgent, before getTier:
      if (toolNames.includes("update_schedule")) {
        // Schedule updates often need to update/delete today's tasks too
        if (!toolNames.includes("update_task")) toolNames.push("update_task");
        if (!toolNames.includes("update_multiple_tasks")) toolNames.push("update_multiple_tasks");
        if (!toolNames.includes("delete_task")) toolNames.push("delete_task");
        if (!toolNames.includes("delete_multiple_tasks")) toolNames.push("delete_multiple_tasks");
        if (!toolNames.includes("create_task")) toolNames.push("create_task");
        if (!toolNames.includes("create_multiple_tasks")) toolNames.push("create_multiple_tasks");
      }

      // 2. Run agent with only the tools the classifier requested
      const result = await runAgent(chatId, text, user, toolNames);

      // 3. Get response (already sanitized by agent.service)
      let responseText = result.text.trim();

      if (!responseText) responseText = "What's next?";

      // 4. If schedule was saved via agent, activate immediately (no confirm buttons)
      if (result.pendingScheduleId) {
        // Send agent's response first (e.g., "Locked in. I'll remind you...")
        await sendResponse(bot, chatId, responseText);

        // Activate: create today's tasks, tomorrow's blocks, schedule check-ins
        const { activateSchedule } = await import("../schedule-activation.service.js");
        const activation = await activateSchedule(user);

        // Send confirmation with task counts
        await bot.sendMessage(chatId, activation.confirmationMessage, {
          parse_mode: "HTML",
        });

        await appendToHistory(
          chatId.toString(),
          "✅ Schedule confirmed",
          activation.confirmationMessage,
        );
      } else {
        await sendResponse(bot, chatId, responseText);
      }

    } catch (err: any) {
      console.error("Agent error:", err);
      await bot.sendMessage(
        chatId,
        "Something went wrong on my end. Try again in a moment 🔄"
      );
    }
  });
}