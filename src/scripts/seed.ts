import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

async function seed() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/scheduler";
  const client = new MongoClient(uri);

  await client.connect();
  const db = client.db();

  const userId = new ObjectId("698b9eabf2799ac2e8533395");
  await db.collection("users").insertOne({
    _id: userId,
    name: "Ajay",
    email: "ajay@test.com",
    strictnessLevel: 3,
    dailyCheckInTime: "21:00",
    weeklyReviewTime: "Sunday 21:00",
    createdAt: new Date(),
  });
  console.log(`✅ Created user: ${userId}`);

  await client.close();
  console.log("\n✅ Seeding complete!");
}

seed().catch(console.error);
