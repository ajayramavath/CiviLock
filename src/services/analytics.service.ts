// src/services/analytics.service.ts
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";

// ─── Weekly Subject Stats ────────────────────────────────────────────────────

export interface SubjectStat {
  subject: string;
  totalBlocks: number;
  completedBlocks: number;
  skippedBlocks: number;
  totalMinutes: number;
  completedMinutes: number;
  skippedMinutes: number;
  completionRate: number; // percentage
}

export interface WeeklyStats {
  totalBlocks: number;
  completedBlocks: number;
  skippedBlocks: number;
  totalHours: number;
  completedHours: number;
  skippedHours: number;
  completionRate: number;
  currentStreak: number;
  subjects: SubjectStat[];
  previousWeekRate: number | null;
}

export async function getWeeklySubjectStats(
  userId: ObjectId | string,
  onboardedAt?: Date,
): Promise<WeeklyStats> {
  const db = getDb();
  const uid = typeof userId === "string" ? new ObjectId(userId) : userId;

  // Last 7 days, but never before onboarding
  let weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  if (onboardedAt && onboardedAt > weekAgo) weekAgo = new Date(onboardedAt);

  // Previous week (7-14 days ago), clamped to onboarding
  let twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  if (onboardedAt && onboardedAt > twoWeeksAgo) twoWeeksAgo = new Date(onboardedAt);

  const [currentWeekTasks, previousWeekTasks] = await Promise.all([
    db
      .collection("actionStations")
      .find({
        userId: uid,
        scheduledStart: { $gte: weekAgo },
        status: { $in: ["completed", "partial", "skipped", "pending"] },
      })
      .toArray(),

    db
      .collection("actionStations")
      .find({
        userId: uid,
        scheduledStart: { $gte: twoWeeksAgo, $lt: weekAgo },
        status: { $in: ["completed", "partial", "skipped"] },
      })
      .toArray(),
  ]);

  // Overall stats
  const totalBlocks = currentWeekTasks.length;
  const completedBlocks = currentWeekTasks.filter(
    (t) => t.status === "completed",
  ).length;
  const skippedBlocks = currentWeekTasks.filter(
    (t) => t.status === "skipped",
  ).length;

  const totalMinutes = currentWeekTasks.reduce(
    (sum, t) => sum + (t.estimatedMinutes || 60),
    0,
  );
  const completedMinutes = currentWeekTasks
    .filter((t) => t.status === "completed")
    .reduce((sum, t) => sum + (t.estimatedMinutes || 60), 0);
  const skippedMinutes = currentWeekTasks
    .filter((t) => t.status === "skipped")
    .reduce((sum, t) => sum + (t.estimatedMinutes || 60), 0);

  const completionRate =
    totalBlocks > 0 ? Math.round((completedBlocks / totalBlocks) * 100) : 0;

  // Previous week rate
  const prevTotal = previousWeekTasks.length;
  const prevCompleted = previousWeekTasks.filter(
    (t) => t.status === "completed",
  ).length;
  const previousWeekRate =
    prevTotal > 0 ? Math.round((prevCompleted / prevTotal) * 100) : null;

  // Subject breakdown
  const subjectMap = new Map<string, SubjectStat>();

  for (const task of currentWeekTasks) {
    const subject = task.subject || "Untagged";
    const existing = subjectMap.get(subject) || {
      subject,
      totalBlocks: 0,
      completedBlocks: 0,
      skippedBlocks: 0,
      totalMinutes: 0,
      completedMinutes: 0,
      skippedMinutes: 0,
      completionRate: 0,
    };

    existing.totalBlocks++;
    existing.totalMinutes += task.estimatedMinutes || 60;

    if (task.status === "completed") {
      existing.completedBlocks++;
      existing.completedMinutes += task.estimatedMinutes || 60;
    } else if (task.status === "skipped") {
      existing.skippedBlocks++;
      existing.skippedMinutes += task.estimatedMinutes || 60;
    }

    subjectMap.set(subject, existing);
  }

  // Calculate per-subject completion rates
  const subjects = Array.from(subjectMap.values()).map((s) => ({
    ...s,
    completionRate:
      s.totalBlocks > 0
        ? Math.round((s.completedBlocks / s.totalBlocks) * 100)
        : 0,
  }));

  // Streak calculation
  const currentStreak = await calculateStreak(uid, onboardedAt);

  return {
    totalBlocks,
    completedBlocks,
    skippedBlocks,
    totalHours: Math.round((totalMinutes / 60) * 10) / 10,
    completedHours: Math.round((completedMinutes / 60) * 10) / 10,
    skippedHours: Math.round((skippedMinutes / 60) * 10) / 10,
    completionRate,
    currentStreak,
    subjects,
    previousWeekRate,
  };
}

// ─── Avoidance Detection ─────────────────────────────────────────────────────
// Flags subjects skipped 3+ times in the last 7 days

export interface AvoidanceAlert {
  subject: string;
  skipCount: number;
  totalBlocks: number;
  completionRate: number;
}

export async function getAvoidanceAlerts(
  userId: ObjectId | string,
  onboardedAt?: Date,
): Promise<AvoidanceAlert[]> {
  const db = getDb();
  const uid = typeof userId === "string" ? new ObjectId(userId) : userId;

  let weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  if (onboardedAt && onboardedAt > weekAgo) weekAgo = new Date(onboardedAt);

  const tasks = await db
    .collection("actionStations")
    .find({
      userId: uid,
      scheduledStart: { $gte: weekAgo },
      subject: { $ne: null },
      status: { $in: ["completed", "partial", "skipped"] },
    })
    .toArray();

  // Group by subject
  const subjectMap = new Map<
    string,
    { total: number; skipped: number; completed: number }
  >();

  for (const task of tasks) {
    const subject = task.subject;
    if (!subject) continue;

    const existing = subjectMap.get(subject) || {
      total: 0,
      skipped: 0,
      completed: 0,
    };
    existing.total++;
    if (task.status === "skipped") existing.skipped++;
    if (task.status === "completed") existing.completed++;
    subjectMap.set(subject, existing);
  }

  // Flag subjects with 3+ skips
  const alerts: AvoidanceAlert[] = [];
  for (const [subject, data] of subjectMap) {
    if (data.skipped >= 3) {
      alerts.push({
        subject,
        skipCount: data.skipped,
        totalBlocks: data.total,
        completionRate:
          data.total > 0 ? Math.round((data.completed / data.total) * 100) : 0,
      });
    }
  }

  return alerts.sort((a, b) => b.skipCount - a.skipCount);
}

// ─── Streak Calculation ──────────────────────────────────────────────────────
// Consecutive days with at least 1 completed task

async function calculateStreak(userId: ObjectId, onboardedAt?: Date): Promise<number> {
  const db = getDb();
  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Don't look back past onboarding date
  const maxDays = onboardedAt
    ? Math.min(90, Math.ceil((today.getTime() - onboardedAt.getTime()) / (1000 * 60 * 60 * 24)) + 1)
    : 90;

  for (let i = 0; i < maxDays; i++) {
    // Check up to 90 days back
    const dayStart = new Date(today);
    dayStart.setDate(dayStart.getDate() - i);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const completed = await db.collection("actionStations").countDocuments({
      userId,
      scheduledStart: { $gte: dayStart, $lt: dayEnd },
      status: "completed",
    });

    // Also check if there were any tasks at all (skip days with no tasks)
    const total = await db.collection("actionStations").countDocuments({
      userId,
      scheduledStart: { $gte: dayStart, $lt: dayEnd },
    });

    if (total === 0) {
      // No tasks scheduled — don't break streak but don't increment
      continue;
    }

    if (completed > 0) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

// ─── Daily Check-In Data Builder ─────────────────────────────────────────────
// Builds the context string for the AI daily check-in

export async function buildCheckInContext(
  userId: ObjectId | string,
  user: any,
): Promise<string> {
  const db = getDb();
  const uid = typeof userId === "string" ? new ObjectId(userId) : userId;

  // Today's tasks
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);

  const todayTasks = await db
    .collection("actionStations")
    .find({
      userId: uid,
      scheduledStart: { $gte: todayStart, $lt: todayEnd },
    })
    .toArray();

  // If user onboarded today, there may be no meaningful data yet
  const onboardedAt = user.createdAt ? new Date(user.createdAt) : undefined;

  const completed = todayTasks.filter((t) => t.status === "completed");
  const skipped = todayTasks.filter((t) => t.status === "skipped");
  const partial = todayTasks.filter((t) => t.status === "partial");
  const pending = todayTasks.filter((t) => t.status === "pending");

  const totalMinutes = todayTasks.reduce(
    (s, t) => s + (t.estimatedMinutes || 60),
    0,
  );
  const completedMinutes = completed.reduce(
    (s, t) => s + (t.estimatedMinutes || 60),
    0,
  );

  // Subject breakdown for today
  const subjectsDone = completed.filter((t) => t.subject).map((t) => t.subject);
  const subjectsSkipped = skipped
    .filter((t) => t.subject)
    .map((t) => t.subject);

  // Weekly stats for context
  const weekStats = await getWeeklySubjectStats(uid, onboardedAt);
  const avoidance = await getAvoidanceAlerts(uid, onboardedAt);

  // UPSC context
  const upsc = user.upscProfile;
  const days = upsc ? daysUntilPrelims(upsc.targetYear) : null;

  // Yesterday's comparison (skip if user wasn't onboarded yet)
  let yesterdayCompleted = 0;
  let yesterdayTotal = 0;
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);

  if (!onboardedAt || yesterdayStart >= onboardedAt) {
    const yesterdayTasks = await db
      .collection("actionStations")
      .find({
        userId: uid,
        scheduledStart: { $gte: yesterdayStart, $lt: todayStart },
      })
      .toArray();
    yesterdayCompleted = yesterdayTasks.filter(
      (t) => t.status === "completed",
    ).length;
    yesterdayTotal = yesterdayTasks.length;
  }

  // Build context
  let context = `DAILY CHECK-IN CONTEXT:\n`;
  context += `\nUser's name: ${user.name || user.profile?.name || "there"}`;
  context += `\nStrictness level: ${user.strictnessLevel || 1}`;
  context += `\nToday: ${completed.length}/${todayTasks.length} blocks completed (${Math.round(completedMinutes / 60 * 10) / 10}h / ${Math.round(totalMinutes / 60 * 10) / 10}h)`;
  context += `\nYesterday: ${yesterdayCompleted}/${yesterdayTotal} blocks completed`;

  // Per-subject hourly breakdown
  const subjectBreakdown = new Map<string, { scheduled: number; completed: number; skipped: number }>();
  for (const task of todayTasks) {
    const subject = task.subject || "Untagged";
    const existing = subjectBreakdown.get(subject) || { scheduled: 0, completed: 0, skipped: 0 };
    existing.scheduled += task.estimatedMinutes || 60;
    if (task.status === "completed") existing.completed += task.estimatedMinutes || 60;
    if (task.status === "skipped") existing.skipped += task.estimatedMinutes || 60;
    subjectBreakdown.set(subject, existing);
  }

  if (subjectBreakdown.size > 0) {
    context += `\n\nSUBJECT-WISE HOURS TODAY:`;
    for (const [subject, data] of subjectBreakdown) {
      const schedH = Math.round(data.scheduled / 60 * 10) / 10;
      const compH = Math.round(data.completed / 60 * 10) / 10;
      const skipH = Math.round(data.skipped / 60 * 10) / 10;
      context += `\n  ${subject}: ${compH}h completed / ${schedH}h scheduled`;
      if (skipH > 0) context += ` (${skipH}h skipped)`;
    }
  }

  if (pending.length > 0) {
    context += `\nStill pending: ${pending.map((t) => `${t.title}${t.subject ? ` [${t.subject}]` : ""}`).join(", ")}`;
  }

  context += `\n\nWeekly completion rate: ${weekStats.completionRate}%`;
  context += `\nWeekly hours: ${weekStats.completedHours}h completed / ${weekStats.totalHours}h scheduled / ${weekStats.skippedHours}h skipped`;
  context += `\nStreak: ${weekStats.currentStreak} days`;

  if (avoidance.length > 0) {
    context += `\nAVOIDANCE ALERT: ${avoidance.map((a) => `${a.subject} (skipped ${a.skipCount}x this week)`).join(", ")}`;
  }

  // Silence tracking — for L2 "You went silent during X blocks" check-in
  const silentTasks = todayTasks.filter((t) => (t.silenceCount || 0) > 0);
  if (silentTasks.length > 0) {
    context += `\nSILENCE FLAG: User went silent during ${silentTasks.length} block${silentTasks.length > 1 ? "s" : ""} today: ${silentTasks.map((t) => t.title).join(", ")}`;
  }

  if (days !== null) {
    context += `\n\nDays until Prelims: ${days}`;
  }

  if (upsc?.weakSubjects?.length > 0) {
    const weakShort = upsc.weakSubjects.map((s: string) => s.split(" (")[0]);
    context += `\nUser's weak subjects: ${weakShort.join(", ")}`;
  }

  if (upsc) {
    context += `\nAttempt: #${upsc.attemptNumber}`;
  }

  return context;
}

function daysUntilPrelims(targetYear: number): number {
  const may = new Date(targetYear, 4, 31);
  const dayOfWeek = may.getDay();
  const lastSunday = new Date(may);
  lastSunday.setDate(may.getDate() - dayOfWeek);
  const diff = lastSunday.getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}
