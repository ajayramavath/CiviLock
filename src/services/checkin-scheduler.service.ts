import { ObjectId } from "mongodb";
import { dailyCheckInQueue, weeklyCheckInQueue } from "../queue.js";

export async function scheduleDailyCheckin(
  userId: ObjectId,
  checkInTime: string,
) {
  const [hour, minute] = checkInTime.split(":").map(Number);
  const schedulerId = `daily-checkin-${userId}`;

  await dailyCheckInQueue.upsertJobScheduler(
    schedulerId,
    {
      pattern: `${minute} ${hour} * * *`,
      tz: "Asia/Kolkata",
    },
    {
      name: "daily-checkin",
      data: { userId },
      opts: {
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
      },
    },
  );

  console.log(
    `✅ Daily check-in scheduler upserted for user ${userId} at ${checkInTime} IST`,
  );
}

export async function scheduleWeeklyCheckin(
  userId: ObjectId,
  checkInTime: string,
) {
  const [hour, minute] = checkInTime.split(":").map(Number);
  const schedulerId = `weekly-checkin-${userId}`;

  // Sunday only: cron day-of-week 0 = Sunday
  await weeklyCheckInQueue.upsertJobScheduler(
    schedulerId,
    {
      pattern: `${minute} ${hour} * * 0`,
      tz: "Asia/Kolkata",
    },
    {
      name: "weekly-checkin",
      data: { userId },
      opts: {
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
      },
    },
  );

  console.log(
    `✅ Weekly check-in scheduler upserted for user ${userId} — every Sunday at ${checkInTime} IST`,
  );
}

export async function removeDailyCheckin(userId: ObjectId) {
  const schedulerId = `daily-checkin-${userId}`;
  const removed = await dailyCheckInQueue.removeJobScheduler(schedulerId);

  if (removed) {
    console.log(`🗑️ Removed daily check-in scheduler for user ${userId}`);
  }

  return removed;
}

export async function removeWeeklyCheckin(userId: ObjectId) {
  const schedulerId = `weekly-checkin-${userId}`;
  const removed = await weeklyCheckInQueue.removeJobScheduler(schedulerId);

  if (removed) {
    console.log(`🗑️ Removed weekly check-in scheduler for user ${userId}`);
  }

  return removed;
}

export async function getAllCheckinSchedulers() {
  return await dailyCheckInQueue.getJobSchedulers();
}

