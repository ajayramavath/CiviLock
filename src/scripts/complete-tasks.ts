import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

async function completeTasks() {
  const uri =
    process.env.MONGODB_URI || "mongodb://localhost:27017/accountability";
  const client = new MongoClient(uri);

  await client.connect();
  const db = client.db();

  console.log("✅ Marking tasks as complete...");

  // Get the tasks for test-user-123
  const tasks = await db
    .collection("actionStations")
    .find({ userId: new ObjectId("698b9eabf2799ac2e8533395") })
    .toArray();

  // Find task 1 (Go to gym) and task 3 (Complete basic version of scheduler)
  const task1 = tasks.find((t) => t.title === "Go to gym");
  const task3 = tasks.find(
    (t) => t.title === "Complete basic version of scheduler",
  );

  if (task1) {
    await db.collection("actionStations").updateOne(
      { _id: task1._id },
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
        },
      },
    );
    console.log(`✅ Marked complete: ${task1.title}`);
  }

  if (task3) {
    await db.collection("actionStations").updateOne(
      { _id: task3._id },
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
        },
      },
    );
    console.log(`✅ Marked complete: ${task3.title}`);
  }

  // Show final status
  const updatedTasks = await db
    .collection("actionStations")
    .find({ userId: new ObjectId("698b9eabf2799ac2e8533395") })
    .toArray();

  console.log("\n📊 Task Status:");
  updatedTasks.forEach((task) => {
    console.log(`- ${task.title}: ${task.status}`);
  });

  await client.close();
}

completeTasks().catch(console.error);
