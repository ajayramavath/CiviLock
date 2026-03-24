import TelegramBot from "node-telegram-bot-api";
import { getDb } from "../../db";
import { getHistory } from "../conversation-state.service";

export function registerAdminHandlers(adminBot: TelegramBot) {
  const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

  // Helper to fetch and send history
  async function sendUserHistory(chatId: number, targetChatId: string | number) {
    try {
      const { getFullHistory } = await import("../conversation-state.service");
      const fullHistory = await getFullHistory(targetChatId.toString());

      if (!fullHistory || fullHistory.length === 0) {
        adminBot.sendMessage(chatId, `No history found for <code>${targetChatId}</code>`, { parse_mode: "HTML" });
        return;
      }

      let historyText = `<b>History for ${targetChatId}</b>\n\n`;
      fullHistory.forEach((msg, idx) => {
        const role = msg.role === "assistant" ? "🤖 Bot" : "👤 User";
        historyText += `${idx + 1}. <b>${role}</b>:\n${msg.content}\n\n`;
      });

      if (historyText.length <= 4000) {
        await adminBot.sendMessage(chatId, historyText, { parse_mode: "HTML" });
      } else {
        let plainText = historyText.replace(/<[^>]*>?/gm, '');
        for (let i = 0; i < plainText.length; i += 4000) {
          await adminBot.sendMessage(chatId, plainText.substring(i, i + 4000));
        }
      }
    } catch (err) {
      console.error("Error fetching user history:", err);
      adminBot.sendMessage(chatId, "Error fetching user history.");
    }
  }

  adminBot.onText(/^\/users(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_CHAT_ID) return;

    const db = getDb();
    const param = match?.[1]?.trim();

    if (!param) {
      // /users without parameter: list all users as buttons
      try {
        const users = await db.collection("users").find({}).toArray();
        if (users.length === 0) {
          return adminBot.sendMessage(chatId, "No users found.");
        }

        const buttons = users.map((u) => {
          const namePart = u.name ? u.name : "Unknown";
          return [{
            text: `${namePart} (${u.telegramChatId})`,
            callback_data: `history_${u.telegramChatId}`
          }];
        });

        const fullMessage = `<b>Total Users: ${users.length}</b>\nSelect a user to view their history:`;
        await adminBot.sendMessage(chatId, fullMessage, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: buttons
          }
        });
      } catch (err) {
        console.error("Error fetching users list:", err);
        adminBot.sendMessage(chatId, "Error fetching users list.");
      }
      return;
    }

    // Still support manual /users [id] text fallback
    try {
      const dbUser = await db.collection("users").findOne({
        telegramChatId: parseInt(param, 10),
      });
      const targetChatId = dbUser ? dbUser.telegramChatId : param;
      await sendUserHistory(chatId, targetChatId);
    } catch (err) {
      console.error("Error with manual id:", err);
    }
  });

  // Handle inline keyboard clicks for history
  adminBot.on("callback_query", async (query) => {
    const chatId = query.message?.chat.id;
    if (!chatId || chatId.toString() !== ADMIN_CHAT_ID) return;

    if (query.data && query.data.startsWith("history_")) {
      const targetChatId = query.data.replace("history_", "");
      try {
        await adminBot.answerCallbackQuery(query.id); // Stop loading circle
        await sendUserHistory(chatId, targetChatId);
      } catch (error) {
        console.error("Error serving callback:", error);
      }
    }
  });
}
