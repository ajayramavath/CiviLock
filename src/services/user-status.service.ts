// src/services/user-status.service.ts
// Builds the compact status block injected into classifier, task handler, and conversation handler prompts.

import { getDb } from "../db.js";
import type { User } from "../models/types.js";

export interface UserStatus {
  block: string;      // the formatted text block for LLM prompts
  flags: {
    hasName: boolean;
    hasReviewTime: boolean;
    hasWakeTime: boolean;
    hasSchedule: boolean;
    hasTodayTasks: boolean;
    isOnboarded: boolean;
  };
}

/**
 * Build a status block for a user. If user is null (brand new, pre-/start),
 * returns a minimal "new user" block.
 */
export async function buildUserStatus(user: User | null): Promise<UserStatus> {
  if (!user) {
    return {
      block: `USER STATUS:\nNew user — no data yet.`,
      flags: {
        hasName: false,
        hasReviewTime: false,
        hasWakeTime: false,
        hasSchedule: false,
        hasTodayTasks: false,
        isOnboarded: false,
      },
    };
  }

  const db = getDb();

  // Check today's tasks
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  const todayTaskCount = await db.collection("actionStations").countDocuments({
    userId: user._id,
    scheduledStart: { $gte: todayStart, $lte: todayEnd },
  });

  const todayCompleted = await db.collection("actionStations").countDocuments({
    userId: user._id,
    scheduledStart: { $gte: todayStart, $lte: todayEnd },
    status: { $in: ["completed", "partial"] },
  });

  // Name
  const hasName = !!(user.profile?.name || (user.name && user.name !== "User"));
  const displayName = user.profile?.name || user.name;

  // Review time
  const reviewTime = user.profile?.dailyReviewTime || user.dailyCheckInTime;
  const hasReviewTime = !!reviewTime;

  // Wake time
  const wakeTime = user.profile?.wakeTime || user.wakeTime;
  const hasWakeTime = !!wakeTime;
  let wakeDisplay = "not set";
  if (wakeTime) {
    wakeDisplay = formatTimeDisplay(wakeTime);
  } else if (user.sleepSchedule?.wakeHour !== undefined) {
    // Legacy: infer from sleepSchedule
    const h = user.sleepSchedule.wakeHour;
    const m = user.sleepSchedule.wakeMinute;
    wakeDisplay = `~${formatHHMM(h, m)} (from sleep schedule)`;
  }

  // Schedule
  const hasSchedule = !!(user.studyPlan && user.studyPlan.blocks?.length > 0);
  const scheduleDisplay = hasSchedule
    ? `${user.studyPlan!.blocks.length} blocks/day`
    : "no timetable set";

  // Strictness
  const strictness = user.profile?.strictnessLevel || user.strictnessLevel || 1;
  const strictnessLabel = strictness === 2 ? "Strict Mentor (L2)" : "Study Partner (L1)";

  // Today's tasks
  const hasTodayTasks = todayTaskCount > 0;
  const todayDisplay = hasTodayTasks
    ? `${todayCompleted}/${todayTaskCount} completed`
    : "no tasks scheduled";

  // Missing fields (for follow-up prompting)
  const missing: string[] = [];
  if (!hasName) missing.push("name");
  if (!hasReviewTime) missing.push("daily review time");
  if (!hasWakeTime) missing.push("wake time");

  // Build the block
  const lines: string[] = [
    `USER STATUS:`,
    `Name: ${hasName ? displayName : "not set"}`,
    `Strictness: ${strictnessLabel}`,
    `Daily review: ${hasReviewTime ? formatTimeDisplay(reviewTime!) : "not set"}`,
    `Wake time: ${wakeDisplay}`,
    `Schedule: ${scheduleDisplay}`,
    `Today: ${todayDisplay}`,
  ];

  if (missing.length > 0) {
    lines.push(`Missing info: ${missing.join(", ")}`);
  }

  // Profile notes if any
  if (user.profile?.notes?.length) {
    const recentNotes = user.profile.notes.slice(-3);
    lines.push(`Notes: ${recentNotes.join(" | ")}`);
  }

  return {
    block: lines.join("\n"),
    flags: {
      hasName,
      hasReviewTime,
      hasWakeTime,
      hasSchedule,
      hasTodayTasks,
      isOnboarded: user.onboardingComplete,
    },
  };
}

/**
 * Build a compact schedule block showing today's and tomorrow's tasks.
 * Used by the task handler to find open slots.
 */
export async function buildScheduleContext(user: User): Promise<string> {
  const db = getDb();
  const now = new Date();

  // Today
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  // Tomorrow
  const tomorrowStart = new Date(todayEnd.getTime() + 1);
  tomorrowStart.setHours(0, 0, 0, 0);
  const tomorrowEnd = new Date(tomorrowStart);
  tomorrowEnd.setHours(23, 59, 59, 999);

  const [todayTasks, tomorrowTasks] = await Promise.all([
    db
      .collection("actionStations")
      .find({
        userId: user._id,
        scheduledStart: { $gte: todayStart, $lte: todayEnd },
      })
      .sort({ scheduledStart: 1 })
      .project({ title: 1, subject: 1, scheduledStart: 1, scheduledEnd: 1, status: 1 })
      .toArray(),
    db
      .collection("actionStations")
      .find({
        userId: user._id,
        scheduledStart: { $gte: tomorrowStart, $lte: tomorrowEnd },
      })
      .sort({ scheduledStart: 1 })
      .project({ title: 1, subject: 1, scheduledStart: 1, scheduledEnd: 1, status: 1 })
      .toArray(),
  ]);

  const formatTasks = (tasks: any[]) => {
    if (tasks.length === 0) return "  (empty)";
    return tasks
      .map((t) => {
        const start = new Date(t.scheduledStart).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: "Asia/Kolkata",
        });
        const end = new Date(t.scheduledEnd).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: "Asia/Kolkata",
        });
        const status = t.status !== "pending" ? ` (${t.status})` : "";
        return `  ${t._id} | ${start}-${end}: ${t.title}${status}`;
      })
      .join("\n");
  };

  const plan = user.studyPlan;
  let templateSection = "";
  if (plan?.blocks?.length) {
    const templateLines = plan.blocks.map((b: any) => {
      const hour = String(b.startHour).padStart(2, "0");
      const min = String(b.startMinute).padStart(2, "0");
      return `  ${hour}:${min} (${b.durationMinutes}min): ${b.title}`;
    });
    templateSection = `\n\nDAILY ROUTINE (recurring template):\n${templateLines.join("\n")}`;
  }

  return [
    `TODAY'S TASKS:`,
    formatTasks(todayTasks),
    ``,
    `TOMORROW'S TASKS:`,
    formatTasks(tomorrowTasks),
    templateSection,
  ].join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimeDisplay(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = parseInt(hStr as string);
  const m = parseInt(mStr as string);
  return formatHHMM(h, m);
}

function formatHHMM(h: number, m: number): string {
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${hour12}:${m.toString().padStart(2, "0")} ${period}`;
}