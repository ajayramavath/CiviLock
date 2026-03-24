// src/services/profile.service.ts
// Saves extracted fields and behavioral notes to the user document.
// Called after classifier extraction and after conversation handler returns user_notes.

import { getDb } from "../db.js";
import { ObjectId } from "mongodb";
import type { ClassifierResult, User } from "../models/types.js";
import type TelegramBot from "node-telegram-bot-api";
import { istDate, addDays, nowInIST } from "../utils/timezone.js";

/**
 * Apply extracted fields from the classifier to the user document.
 * Updates both legacy top-level fields and the new profile subdocument.
 * Returns a list of what was updated (for logging).
 */
export async function saveExtractedFields(
  user: User,
  extracted: ClassifierResult["extracted"],
): Promise<string[]> {
  const db = getDb();
  const updates: Record<string, any> = {};
  const saved: string[] = [];

  if (extracted.name) {
    updates["name"] = extracted.name;
    updates["profile.name"] = extracted.name;
    saved.push(`name: ${extracted.name}`);
  }

  if (extracted.review_time) {
    updates["dailyCheckInTime"] = extracted.review_time;
    updates["profile.dailyReviewTime"] = extracted.review_time;
    saved.push(`review_time: ${extracted.review_time}`);

    // Schedule daily + weekly check-ins now that we have a time
    const userId =
      typeof user._id === "string" ? new ObjectId(user._id) : user._id;
    try {
      const { scheduleDailyCheckin, scheduleWeeklyCheckin } = await import(
        "./checkin-scheduler.service.js"
      );
      await scheduleDailyCheckin(userId, extracted.review_time);
      await scheduleWeeklyCheckin(userId, extracted.review_time);
      console.log(
        `[Profile] Check-ins scheduled for ${user.telegramChatId} at ${extracted.review_time}`,
      );
    } catch (err) {
      console.error(
        `[Profile] Failed to schedule check-ins for ${user.telegramChatId}:`,
        err,
      );
    }
  }

  if (extracted.strictness) {
    updates["strictnessLevel"] = extracted.strictness;
    updates["profile.strictnessLevel"] = extracted.strictness;
    saved.push(`strictness: L${extracted.strictness}`);
  }

  if (extracted.wake_time) {
    updates["wakeTime"] = extracted.wake_time;
    updates["profile.wakeTime"] = extracted.wake_time;
    saved.push(`wake_time: ${extracted.wake_time}`);
  }

  if (Object.keys(updates).length > 0) {
    updates["profile.lastUpdated"] = new Date();

    const userId =
      typeof user._id === "string" ? new ObjectId(user._id) : user._id;

    await db.collection("users").updateOne({ _id: userId }, { $set: updates });

    console.log(
      `[Profile] Updated user ${user.telegramChatId}: ${saved.join(", ")}`,
    );
  }

  return saved;
}

/**
 * Append a behavioral note from the conversation handler.
 * Keeps max 20 notes, drops oldest when full.
 */
export async function saveUserNote(
  user: User,
  note: string,
): Promise<void> {
  const db = getDb();
  const userId =
    typeof user._id === "string" ? new ObjectId(user._id) : user._id;

  // Check current note count
  const currentUser = await db.collection("users").findOne(
    { _id: userId },
    { projection: { "profile.notes": 1 } },
  );

  const currentNotes: string[] = currentUser?.profile?.notes || [];

  // Avoid duplicate notes
  const lowerNote = note.toLowerCase();
  const isDuplicate = currentNotes.some(
    (n) => n.toLowerCase() === lowerNote,
  );
  if (isDuplicate) return;

  if (currentNotes.length >= 20) {
    // Remove oldest, add new
    await db.collection("users").updateOne(
      { _id: userId },
      {
        $pop: { "profile.notes": -1 }, // remove first (oldest)
      },
    );
  }

  await db.collection("users").updateOne(
    { _id: userId },
    {
      $push: { "profile.notes": note } as any,
      $set: { "profile.lastUpdated": new Date() },
    },
  );

  console.log(`[Profile] Note saved for ${user.telegramChatId}: "${note}"`);
}

/**
 * Initialize the profile subdocument for a new user.
 * Called once when user is first created.
 */
export function createDefaultProfile(name?: string): Record<string, any> {
  return {
    name: name || null,
    strictnessLevel: 1,
    dailyReviewTime: null,
    wakeTime: null,
    exam: "UPSC",
    optionalSubject: null,
    weakSubjects: [],
    notes: [],
    lastUpdated: new Date(),
  };
}

/**
 * Check if user has enough info to be considered "onboarded."
 * Minimal bar: has a name and either tasks or a timetable.
 */
export async function checkOnboardingComplete(user: User): Promise<boolean> {
  const hasName = !!(user.profile?.name || (user.name && user.name !== "User"));
  const hasSchedule = !!(user.studyPlan && user.studyPlan.blocks?.length > 0);

  if (hasName && hasSchedule) return true;

  // Also count as onboarded if they've created any tasks
  if (hasName) {
    const db = getDb();
    const taskCount = await db.collection("actionStations").countDocuments({ userId: user._id });
    if (taskCount > 0) return true;
  }

  return false;
}

interface EnsureUserResult {
  user: User;
  isNew: boolean;
}



export async function ensureUser(
  chatId: number,
  msg: TelegramBot.Message
): Promise<EnsureUserResult> {
  const db = getDb();
  const existing = await db
    .collection("users")
    .findOne({ telegramChatId: chatId.toString() }) as User | null;

  if (existing) return { user: existing, isNew: false };

  const userId = new ObjectId();
  const firstName = msg.from?.first_name || "User";

  const newUser = {
    _id: userId,
    name: firstName,
    telegramChatId: chatId.toString(),
    strictnessLevel: 1,
    timezone: "Asia/Kolkata",
    wakeTime: null,
    sleepSchedule: null,
    dailyCheckInTime: null,
    weeklyReviewTime: null,
    upscProfile: null,
    studyPlan: null,
    profile: createDefaultProfile(firstName),
    onboardingComplete: false,
    createdAt: new Date(),
  };

  await db.collection("users").insertOne(newUser);
  return { user: newUser as unknown as User, isNew: true };
}


export function getUserCurrentDayCycle(user: any) {
  if (!user.sleepSchedule) {
    const { date: now } = nowInIST();
    return {
      startDateTime: istDate(now, 6, 0),
      endDateTime: istDate(now, 23, 0),
    };
  }

  const { wakeHour, wakeMinute, sleepHour, sleepMinute } = user.sleepSchedule;
  const { hour: currentHour, date: now } = nowInIST();
  const sleepsAfterMidnight = sleepHour < wakeHour;
  const isInLateNight = sleepsAfterMidnight && currentHour < sleepHour;

  let baseDate = now;
  if (isInLateNight) {
    baseDate = addDays(now, -1);
  }

  const cycleStart = istDate(baseDate, wakeHour, wakeMinute);
  const cycleEndBase = sleepsAfterMidnight ? addDays(baseDate, 1) : baseDate;
  const cycleEnd = istDate(cycleEndBase, sleepHour, sleepMinute || 0);

  return { startDateTime: cycleStart, endDateTime: cycleEnd };
}

export function getUserNextDayCycle(user: any) {
  const current = getUserCurrentDayCycle(user);

  if (!user.sleepSchedule) {
    const nextStart = addDays(current.startDateTime, 1);
    return {
      startDateTime: istDate(nextStart, 6, 0),
      endDateTime: istDate(nextStart, 23, 0),
    };
  }

  const { wakeHour, wakeMinute, sleepHour, sleepMinute } = user.sleepSchedule;
  const sleepsAfterMidnight = sleepHour < wakeHour;

  const nextStart = addDays(current.startDateTime, 1);
  const nextStartDate = istDate(nextStart, wakeHour, wakeMinute);
  const nextEndBase = sleepsAfterMidnight ? addDays(nextStart, 1) : nextStart;
  const nextEnd = istDate(nextEndBase, sleepHour, sleepMinute || 0);

  return { startDateTime: nextStartDate, endDateTime: nextEnd };
}

