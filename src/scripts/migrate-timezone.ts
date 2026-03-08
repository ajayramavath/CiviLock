// src/scripts/migrate-timezone.ts
// One-time migration: fixes tasks created with wrong timezone offsets.
// Run with: bun run src/scripts/migrate-timezone.ts
//
// What it does:
// 1. Clears all PENDING task-reminder jobs from BullMQ
// 2. Removes all PENDING actionStations (future tasks with wrong times)
// 3. Cleans up orphaned Redis state machines
// 4. Regenerates tomorrow's blocks for all users with correct IST times

import dotenv from "dotenv";
dotenv.config();

import { connectDb, getDb } from "../db.js";
import { taskReminderQueue, connection } from "../queue.js";
import { generateDailyBlocks } from "../services/study-plan.service.js";
import { bot } from "../services/telegram.service.js";

const dbUrl = process.env.MONGODB_URI || "mongodb://localhost:27017/scheduler";

async function migrate() {
  console.log("🔧 Starting timezone migration...\n");

  // 1. Connect to DB
  await connectDb(dbUrl);
  const db = getDb();

  // 2. Clear all delayed task-reminder jobs from BullMQ
  console.log("📦 Clearing BullMQ task-reminder jobs...");
  const delayed = await taskReminderQueue.getDelayed();
  const active = await taskReminderQueue.getActive();
  const waiting = await taskReminderQueue.getWaiting();

  let cleared = 0;
  for (const job of [...delayed, ...waiting]) {
    try {
      await job.remove();
      cleared++;
    } catch { }
  }
  console.log(`   Removed ${cleared} queued jobs (${delayed.length} delayed, ${waiting.length} waiting)`);

  // 3. Find and remove all PENDING actionStations (future tasks with wrong times)
  const now = new Date();
  const pendingTasks = await db
    .collection("actionStations")
    .find({
      status: "pending",
      scheduledStart: { $gte: now },
    })
    .toArray();

  console.log(`\n🗄️  Found ${pendingTasks.length} pending future tasks to remove`);

  if (pendingTasks.length > 0) {
    // Clean up Redis state machines for these tasks
    let redisCleared = 0;
    for (const task of pendingTasks) {
      const key = `task-machine:${task._id}`;
      const deleted = await connection.del(key);
      if (deleted) redisCleared++;
    }
    console.log(`   Cleaned ${redisCleared} Redis state machines`);

    // Remove from MongoDB
    const deleteResult = await db
      .collection("actionStations")
      .deleteMany({
        status: "pending",
        scheduledStart: { $gte: now },
      });
    console.log(`   Deleted ${deleteResult.deletedCount} pending tasks from MongoDB`);
  }

  // 4. Regenerate blocks for all onboarded users
  console.log("\n📅 Regenerating blocks with correct IST times...");
  const users = await db
    .collection("users")
    .find({
      onboardingComplete: true,
      "studyPlan.blocks.0": { $exists: true },
    })
    .toArray();

  for (const user of users) {
    try {
      const result = await generateDailyBlocks(user._id);
      if (result.created > 0) {
        const blockList = result.blocks
          .map((b) => `  • ${b.title} — ${b.start.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`)
          .join("\n");

        console.log(`   ✅ ${user.name}: ${result.created} blocks created`);
        console.log(blockList);

        // Notify user
        await bot.sendMessage(
          user.telegramChatId,
          `🔧 <b>Schedule Updated</b>\n\n` +
          `Your study blocks have been recalculated with correct timings.\n\n` +
          `📅 <b>${result.created} blocks scheduled:</b>\n` +
          result.blocks
            .map((b) => `• ${b.title} — ${b.start.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true })}`)
            .join("\n") +
          `\n\nI'll remind you 5 min before each block. 👍`,
          { parse_mode: "HTML" },
        );
      } else {
        console.log(`   ⏭️  ${user.name}: no blocks needed (already exist or no plan)`);
      }
    } catch (err: any) {
      console.error(`   ❌ ${user.name}: ${err.message}`);
    }
  }

  // 5. Summary
  console.log("\n✅ Migration complete!");
  console.log(`   • ${cleared} BullMQ jobs cleared`);
  console.log(`   • ${pendingTasks.length} wrong-timezone tasks removed`);
  console.log(`   • ${users.length} users processed`);

  // Wait for messages to send, then exit
  await new Promise((resolve) => setTimeout(resolve, 2000));
  process.exit(0);
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
