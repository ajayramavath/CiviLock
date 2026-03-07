import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

async function addMyTasks() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/scheduler";
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();

  const userId = new ObjectId("698b9eabf2799ac2e8533395");
  const projectId = new ObjectId();

  const tomorrow = new Date();

  const tasks = [
    {
      title: "Wake up at 11 am",
      scheduledFor: new Date(tomorrow.setHours(11, 0, 0, 0)),
    },
    {
      title: "Study MTL 390 for 6 hours",
      scheduledFor: new Date(tomorrow.setHours(13, 0, 0, 0)),
    },
    {
      title: "Go to gym - leg day",
      scheduledFor: new Date(tomorrow.setHours(19, 30, 0, 0)),
    },
  ];

  for (const task of tasks) {
    await db.collection("actionStations").insertOne({
      userId,
      projectId,
      title: task.title,
      scheduledFor: task.scheduledFor,
      status: "pending",
      isRecurring: false,
      createdAt: new Date(),
    });
    console.log(`✅ Added: ${task.title}`);
  }

  await client.close();
  console.log("\n✅ Your real tasks added!");
}

addMyTasks().catch(console.error);
