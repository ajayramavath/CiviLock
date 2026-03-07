import { MongoClient, Db } from "mongodb";

let client: MongoClient;
let db: Db;

export async function connectDb(url: string) {
  client = new MongoClient(url);
  await client.connect();
  db = client.db();
  console.log("MongoDb connected successfully");
  db.collection("apiUsage").createIndex({ chatId: 1, date: 1 }, { unique: true });
  db.collection("apiUsage").createIndex({ month: 1 });
  db.collection("apiUsage").createIndex({ chatId: 1, month: 1 });
  return db;
}

export function getDb(): Db {
  if (!db) {
    throw new Error("Database not connected. Call connectDB() first.");
  }
  return db;
}

export async function closeDB() {
  if (client) {
    await client.close();
    console.log("❌ Disconnected from MongoDB");
  }
}
