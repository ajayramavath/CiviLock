import { Queue, Worker } from "bullmq";
import Redis from "ioredis";

const connection = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  maxRetriesPerRequest: null,
});

export const dailyCheckInQueue = new Queue("daily-checkIn", { connection });

export const weeklyCheckInQueue = new Queue("weekly-checkIn", { connection });

export const taskReminderQueue = new Queue("task-reminders", { connection });

console.log("✅ BullMQ queues initialized");

export { connection };
