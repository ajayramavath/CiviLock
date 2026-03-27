import { ObjectId } from "mongodb";
import { dailyCheckInQueue, weeklyCheckInQueue } from "../queue.js";

/**
 * Validate and parse "HH:MM" time string. Returns [hour, minute] or null if invalid.
 */
function parseCheckInTime(checkInTime: string, userId: ObjectId): [number, number] | null {
  if (!checkInTime || typeof checkInTime !== "string" || !checkInTime.includes(":")) {
    console.warn(`⚠️ Invalid checkInTime "${checkInTime}" for user ${userId}, skipping`);
    return null;
  }
  const parts = checkInTime.split(":").map(Number);
  const hour = parts[0];
  const minute = parts[1];
  if (hour === undefined || minute === undefined || isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    console.warn(`⚠️ Invalid parsed time h=${hour} m=${minute} from "${checkInTime}" for user ${userId}, skipping`);
    return null;
  }
  return [hour, minute];
}

export async function scheduleDailyCheckin(
  userId: ObjectId,
  checkInTime: string,
) {
  const parsed = parseCheckInTime(checkInTime, userId);
  if (!parsed) return;
  const [hour, minute] = parsed;
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
  const parsed = parseCheckInTime(checkInTime, userId);
  if (!parsed) return;
  const [hour, minute] = parsed;
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
