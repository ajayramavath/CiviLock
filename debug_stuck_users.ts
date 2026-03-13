import { MongoClient, ObjectId } from "mongodb";
import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

async function debug() {
  const mongoUrl = process.env.MONGODB_URI;
  if (!mongoUrl) throw new Error("MONGODB_URI not found");

  const client = new MongoClient(mongoUrl);
  await client.connect();
  const db = client.db();

  const redis = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
  });

  const users = await db.collection("users").find({ onboardingComplete: false }).toArray();
  console.log(`Found ${users.length} users stuck in onboarding.\n`);

  for (const user of users) {
    const chatId = user.telegramChatId;
    if (!chatId) {
      console.log(`User ${user.name} (${user._id}) has no telegramChatId\n`);
      continue;
    }

    const stateRaw = await redis.get(`conv:${chatId}`);
    if (!stateRaw) {
      console.log(`--- User: ${user.name} (${chatId}) ---`);
      console.log("No conversation state found in Redis (might have expired).\n");
      continue;
    }

    const state = JSON.parse(stateRaw);
    console.log(`--- User: ${user.name} (${chatId}) ---`);
    console.log(`Current Step: ${state.step}`);
    console.log(`Last Updated: ${new Date(state.updatedAt).toLocaleString()}`);
    console.log("History:");
    if (state.history && state.history.length > 0) {
      state.history.forEach((msg: any) => {
        console.log(`  [${msg.role.toUpperCase()}]: ${msg.content.replace(/\n/g, " ")}`);
      });
    } else {
      console.log("  No history recorded.");
    }
    console.log("\n");
  }

  await client.close();
  redis.disconnect();
}

debug().catch(console.error);
