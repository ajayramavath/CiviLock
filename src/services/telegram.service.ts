import TelegramBot from "node-telegram-bot-api";
import { ObjectId } from "mongodb";
import { registerOnboardingHandlers } from "./telegram-handlers/onboarding.handler";
import { registerCommandHandlers } from "./telegram-handlers/command.handler";
import { registerMessageHandler } from "./telegram-handlers/message.handler";
import { registerCallbackHandler } from "./telegram-handlers/callback.handler";
import { getDb } from "../db";

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, {
  polling: true,
});

registerOnboardingHandlers(bot);
registerCommandHandlers(bot);
registerMessageHandler(bot);
registerCallbackHandler(bot);

export function parseTime(
  text: string,
): { hour: number; minute: number } | null {
  text = text.toLowerCase().trim();

  if (text.includes("midnight") || text === "12am")
    return { hour: 0, minute: 0 };

  const match = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!match || !match[1]) return null;

  let hour = parseInt(match[1]);
  const minute = match[2] ? parseInt(match[2]) : 0;
  const period = match[3];

  if (period === "pm" && hour < 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return { hour, minute };
}

export async function sendTelegramMessage(
  userId: ObjectId,
  message: string,
  parseMode: "HTML" | undefined = "HTML",
) {
  const db = getDb();
  const user = await db.collection("users").findOne({ _id: userId });

  if (!user || !user.telegramChatId) {
    console.log("No Telegram chat ID for user");
    return;
  }

  try {
    await bot.sendMessage(user.telegramChatId, message, {
      parse_mode: parseMode,
    });
    console.log("✅ Telegram message sent");
  } catch (error: any) {
    if (
      error.code === "ETELEGRAM" &&
      error.message?.includes("parse entities")
    ) {
      const plain = message.replace(/<[^>]*>/g, "");
      try {
        await bot.sendMessage(user.telegramChatId, plain);
        console.log("✅ Sent as plain text (fallback)");
      } catch {
        console.error("❌ Complete send failure");
      }
    } else {
      console.error("❌ Failed to send Telegram message:", error.message);
    }
  }
}

export { bot };
