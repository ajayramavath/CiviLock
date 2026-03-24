// Usage: bun run migration-v2.ts

import { bot } from "./src/services/telegram.service";
import { getDb } from "./src/db";

async function main() {
  const db = getDb();
  const users = db.collection("users");

  const allUsers = await users.find({}).toArray();
  console.log(`\n📦 Found ${allUsers.length} users to migrate\n`);

  for (const user of allUsers) {
    const updates: Record<string, any> = {};
    const unsets: Record<string, any> = {};
    const userId = user._id;
    const name = user.name || "there";

    console.log(`\n── ${name} (${user.telegramChatId}) ──`);

    // ─── 1. Add profile subdocument if missing ───
    if (!user.profile) {
      updates["profile"] = {
        name: user.name || null,
        strictnessLevel: user.strictnessLevel || 1,
        dailyReviewTime: user.dailyCheckInTime || null,
        wakeTime: user.wakeTime || null,
        exam: "UPSC",
        optionalSubject: user.upscProfile?.optionalSubject || null,
        weakSubjects: user.upscProfile?.weakSubjects || [],
        notes: [],
        lastUpdated: new Date(),
      };
      console.log("  + Added profile subdocument");
    }

    // ─── 2. Extract wakeTime from sleepSchedule if wakeTime is null ───
    if (!user.wakeTime && user.sleepSchedule?.wakeHour !== undefined) {
      const h = String(user.sleepSchedule.wakeHour).padStart(2, "0");
      const m = String(user.sleepSchedule.wakeMinute || 0).padStart(2, "0");
      updates["wakeTime"] = `${h}:${m}`;
      updates["profile.wakeTime"] = `${h}:${m}`;
      console.log(`  + Set wakeTime from sleepSchedule: ${h}:${m}`);
    }

    // ─── 3. Sync profile fields from top-level ───
    if (user.profile && !user.profile.dailyReviewTime && user.dailyCheckInTime) {
      updates["profile.dailyReviewTime"] = user.dailyCheckInTime;
      console.log(`  + Synced dailyReviewTime to profile`);
    }

    // ─── 4. Fix bad names ───
    const badNames = ["What", "Make timetable for working aspirants", "Yes's"];
    if (badNames.includes(user.name)) {
      // Don't change the name — let the bot re-ask naturally
      // Just flag it
      console.log(`  ⚠️ Suspicious name: "${user.name}" — will be re-asked by bot`);
    }

    // ─── 5. Apply updates ───
    if (Object.keys(updates).length > 0) {
      await users.updateOne({ _id: userId }, { $set: updates });
      console.log(`  ✅ Updated in DB`);
    } else {
      console.log(`  ℹ️ No DB changes needed`);
    }
  }

  // ─── 6. Send re-engagement messages ───
  console.log("\n\n📨 Sending re-engagement messages...\n");

  // Small delay between messages to avoid Telegram rate limits
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const user of allUsers) {
    if ((user._id).toString() !== "69ac9a8ec322936371c7b3e4") continue;
    const name = user.name || "there";
    const chatId = user.telegramChatId;
    const hasSchedule = user.studyPlan?.blocks?.length > 0;
    const hasProfile = user.upscProfile !== null;
    const hasCheckIn = user.dailyCheckInTime !== null;

    let message = "";

    if (hasSchedule) {
      // ── Fully onboarded users (Ajay, Sneha, sunshine) ──
      const blockCount = user.studyPlan.blocks.length;
      const subjects = user.studyPlan.blocks
        .map((b: any) => b.title)
        .join(", ");

      message =
        `Hey ${name}! 👋\n\n` +
        `CiviLock just got a major upgrade:\n\n` +
        `🔄 <b>Update your schedule in chat</b> — "change polity to geography" and it's done\n` +
        `🛠 <b>Fix tasks on the fly</b> — "move history to 4pm" or "swap today's polity with maths"\n` +
        `🧠 <b>Better AI</b> — understands context, corrections, and Hinglish\n\n` +
        `Your schedule (${blockCount} blocks: ${subjects}) is still locked in. ` +
        `Reminders and check-ins will keep firing as usual.\n\n` +
        `Just send me a message to pick up where you left off 💪`;
    } else if (hasProfile) {
      // ── Partially onboarded (have UPSC profile but no schedule) ──
      const target = user.upscProfile?.targetYear || "your target year";
      const optional = user.upscProfile?.optionalSubject || "your optional";
      const attempt = user.upscProfile?.attemptNumber
        ? `Attempt #${user.upscProfile.attemptNumber}`
        : "";

      message =
        `Hey ${name}! 👋\n\n` +
        `CiviLock just got a big upgrade — smarter schedule management, better reminders, and the AI actually understands what you're saying now.\n\n` +
        `I still have your profile: ${attempt ? attempt + ", " : ""}targeting ${target}, optional: ${optional}.\n\n` +
        `But you never sent me your study schedule — that's the one thing I need to actually hold you accountable.\n\n` +
        `Send me your timetable (type it out or send a photo), or just a task that you want to do today and I'll start tracking from today. 📚`;
    }

    await bot.sendMessage(chatId, message);
    await delay(200); // 200ms between messages to avoid rate limits
  }

  console.log("\n✅ Migration complete!");
}

main().catch(console.error);