import { ObjectId } from "mongodb";
import { getDb } from "../db";
import { generateDailyBlocks } from "./study-plan.service";
import { createTaskMachine } from "./task-machine.service";
import { buildUserStatus } from "./user-status.service";
import { istDate, todayMidnightIST, addDays } from "../utils/timezone";
import type { User } from "../models/types";

interface ActivationResult {
  todayCreated: number;
  todaySkipped: number;
  tomorrowCreated: number;
  confirmationMessage: string;
}

export async function activateSchedule(user: User): Promise<ActivationResult> {
  const db = getDb();

  // Re-fetch user to get the latest studyPlan
  const freshUser = await db.collection("users").findOne({ _id: user._id as ObjectId });
  const plan = freshUser?.studyPlan;

  if (!plan?.blocks?.length) {
    return {
      todayCreated: 0,
      todaySkipped: 0,
      tomorrowCreated: 0,
      confirmationMessage: "Something went wrong — no schedule found. Send your schedule again.",
    };
  }

  // Generate tomorrow's blocks from template
  const result = await generateDailyBlocks(user._id as ObjectId);

  // Create TODAY's remaining blocks (only future ones, skip past)
  let todayCreated = 0;
  let todaySkipped = 0;

  const now = new Date();
  const todayStart = todayMidnightIST();
  const todayEnd = addDays(todayStart, 1);

  // Check which blocks already have tasks today (avoid duplicates)
  const existingToday = await db
    .collection("actionStations")
    .find({
      userId: user._id,
      scheduledStart: { $gte: todayStart, $lt: todayEnd },
    })
    .toArray();
  const existingTitles = new Set(existingToday.map((t: any) => t.title));

  for (const block of plan.blocks) {
    // Skip if task already exists for today
    if (existingTitles.has(block.title)) continue;

    const scheduledStart = istDate(now, block.startHour, block.startMinute);
    const scheduledEnd = new Date(
      scheduledStart.getTime() + block.durationMinutes * 60_000,
    );

    // Only create if end time is still in the future
    if (scheduledEnd.getTime() <= now.getTime()) {
      todaySkipped++;
      continue;
    }

    const actionStation = {
      userId: user._id,
      title: block.title,
      subject: block.subject || null,
      emoji: block.emoji || "📚",
      status: "pending" as const,
      scheduledStart,
      scheduledEnd,
      estimatedMinutes: block.durationMinutes,
      isRecurring: true,
      sourceBlockIndex: plan.blocks.indexOf(block),
      createdAt: new Date(),
    };

    const insertResult = await db
      .collection("actionStations")
      .insertOne(actionStation);

    await createTaskMachine(
      {
        _id: insertResult.insertedId.toString(),
        userId: (user._id as ObjectId).toString(),
        title: block.title,
        subject: block.subject || null,
        scheduledStart,
        scheduledEnd,
        estimatedMinutes: block.durationMinutes,
      },
      {
        telegramChatId: user.telegramChatId,
        strictnessLevel: user.strictnessLevel || 1,
      },
    );

    todayCreated++;
  }

  // Schedule check-ins: use dailyCheckInTime if set, otherwise default 22:00
  const checkInTime = freshUser?.dailyCheckInTime || "22:00";
  try {
    const { scheduleDailyCheckin, scheduleWeeklyCheckin } = await import(
      "./checkin-scheduler.service.js"
    );
    await scheduleDailyCheckin(user._id as ObjectId, checkInTime);
    await scheduleWeeklyCheckin(user._id as ObjectId, checkInTime);
  } catch (err) {
    console.error("Failed to schedule check-ins:", err);
  }

  // Save default check-in time if not set
  if (!freshUser?.dailyCheckInTime) {
    await db
      .collection("users")
      .updateOne(
        { _id: user._id as ObjectId },
        { $set: { dailyCheckInTime: "22:00" } },
      );
  }

  // Mark onboarding complete if user has name + schedule
  const hasName = !!(
    freshUser?.profile?.name ||
    (freshUser?.name && freshUser?.name !== "User")
  );
  if (hasName && !freshUser?.onboardingComplete) {
    await db
      .collection("users")
      .updateOne(
        { _id: user._id as ObjectId },
        { $set: { onboardingComplete: true } },
      );
  }

  // Build confirmation message
  let message = `✅ <b>Schedule locked in!</b>\n`;

  if (todayCreated > 0) {
    message += `\n📅 <b>${todayCreated} blocks set for today</b>`;
    if (todaySkipped > 0) {
      message += ` (${todaySkipped} skipped — already past)`;
    }
    message += `\n`;
  } else if (todaySkipped > 0) {
    message += `\n⏩ All of today's blocks already passed — starting fresh tomorrow.\n`;
  }

  if (result.created > 0) {
    message += `📅 <b>${result.created} blocks scheduled for tomorrow</b>\n`;
  }

  message += `I'll remind you before each one.\n`;

  message +=
    `\n<b>How it works:</b>\n` +
    `• Every night I create tomorrow's blocks from your plan\n` +
    `• Before each block → reminder\n` +
    `• I track completions and flag when you're falling behind\n\n` +
    `/today — see today's blocks\n` +
    `/week — weekly breakdown\n`;

  // Check for missing fields and add follow-up
  const { flags } = await buildUserStatus(freshUser as User | null);
  if (!flags.hasReviewTime) {
    message += `\nBy the way — when should I send your daily review? Like "9pm" or "10:30 at night"`;
  }

  return {
    todayCreated,
    todaySkipped,
    tomorrowCreated: result.created,
    confirmationMessage: message,
  };
}