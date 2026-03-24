/**
 * agent-tools.ts
 *
 * Tool implementations for the CiviLock agent.
 * Thin wrappers around existing services.
 *
 * Note: getTodayTasks/getTomorrowTasks removed as tools —
 * today's schedule is injected into the system prompt instead.
 * saveBehavioralNote/getRecentBehavioralNotes kept for
 * background observation and prompt injection.
 */

import { ObjectId } from "mongodb";
import {
  parseSchedule,
  saveStudyPlan,
} from "./study-plan.service";
import { applyScheduleUpdate } from "./schedule-update.service";
import { saveExtractedFields } from "./profile.service";
import { createTaskMachine, cancelAllTaskJobs } from "./task-machine.service";
import { getDb } from "../db";
import { nowInIST, istDate, todayMidnightIST, addDays } from "../utils/timezone";
import type { User, ActionStation, StudyBlock } from "../models/types";

// ─── Helpers ──────────────────────────────────────────────

function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function tomorrowIST(): string {
  return addDays(new Date(), 1).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function resolveDate(dateStr: string, hour: number, minute: number): Date {
  let base: string;
  if (dateStr === "today") base = todayIST();
  else if (dateStr === "tomorrow") base = tomorrowIST();
  else base = dateStr;

  return new Date(
    `${base}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`
  );
}

// ═══════════════════════════════════════════════════════════
// TASK MANAGEMENT
// ═══════════════════════════════════════════════════════════

export interface CreateTaskInput {
  title: string;
  subject?: string;
  emoji?: string;
  startHour: number;
  startMinute: number;
  durationMinutes: number;
  date: string;
}

export async function createTask(input: CreateTaskInput, user: User): Promise<string> {
  const db = getDb();
  const { title, subject, emoji, startHour, startMinute, durationMinutes, date } = input;

  const scheduledStart = resolveDate(date, startHour, startMinute);
  const scheduledEnd = new Date(scheduledStart.getTime() + durationMinutes * 60_000);

  if (date === "today" && scheduledEnd.getTime() <= Date.now()) {
    const timeStr = `${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}`;
    return `Skipped: ${title} at ${timeStr} — already past. Only future tasks created.`;
  }

  const actionStation: Partial<ActionStation> = {
    userId: user._id as ObjectId,
    title,
    subject: subject || null,
    emoji: emoji || "📚",
    status: "pending",
    scheduledStart,
    scheduledEnd,
    estimatedMinutes: durationMinutes,
    isRecurring: false,
    createdAt: new Date(),
  };

  const result = await db.collection("actionStations").insertOne(actionStation);
  const taskId = result.insertedId;

  await createTaskMachine(
    { _id: taskId.toString(), userId: (user._id).toString(), title, subject: subject || null, scheduledStart, scheduledEnd, estimatedMinutes: durationMinutes },
    { telegramChatId: user.telegramChatId, strictnessLevel: user.strictnessLevel || 1 }
  );

  const timeStr = `${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}`;
  return `Task created: ${emoji || "📚"} ${title} at ${timeStr} (${durationMinutes} min) on ${date}. Task ID: ${taskId}`;
}

export interface CreateMultipleTasksInput {
  tasks: Array<{
    title: string;
    subject?: string;
    emoji?: string;
    startHour: number;
    startMinute: number;
    durationMinutes: number;
  }>;
  date: string;
}

export async function createMultipleTasks(input: CreateMultipleTasksInput, user: User): Promise<string> {
  const results: string[] = [];
  for (const t of input.tasks) {
    const result = await createTask(
      { title: t.title, subject: t.subject, emoji: t.emoji, startHour: t.startHour, startMinute: t.startMinute ?? 0, durationMinutes: t.durationMinutes, date: input.date },
      user
    );
    results.push(result);
  }
  return `Created ${results.length} tasks:\n${results.join("\n")}`;
}

export interface DeleteTaskInput {
  taskId?: string;
  identifier?: string;
}

export interface DeleteMultipleTasksInput {
  taskIds: string[];
}

export interface UpdateMultipleTasksInput {
  updates: Array<{
    taskId: string;
    newTitle?: string;
    newSubject?: string;
    newHour?: number;
    newMinute?: number;
    newDuration?: number;
    newEmoji?: string;
  }>;
}

export async function deleteTask(input: DeleteTaskInput, user: User): Promise<string> {
  const db = getDb();
  let task: ActionStation | null = null;

  if (input.taskId) {
    try {
      task = (await db.collection("actionStations").findOne({ _id: new ObjectId(input.taskId), userId: user._id })) as ActionStation | null;
    } catch {
      return "Invalid task ID format.";
    }
  } else if (input.identifier) {
    const startOfDay = todayMidnightIST();
    const endOfDay = addDays(startOfDay, 1);
    task = (await db.collection("actionStations").findOne({
      userId: user._id,
      title: { $regex: input.identifier, $options: "i" },
      scheduledStart: { $gte: startOfDay, $lt: endOfDay },
      status: { $in: ["pending", "in_progress"] },
    })) as ActionStation | null;
  }

  if (!task) return "Task not found.";

  await cancelAllTaskJobs((task._id as ObjectId).toString());
  await db.collection("actionStations").deleteOne({ _id: task._id });
  return `Deleted task: ${task.emoji || ""} ${task.title}`;
}

export async function deleteMultipleTasks(input: DeleteMultipleTasksInput, user: User): Promise<string> {
  const results: string[] = [];
  for (const taskId of input.taskIds) {
    const result = await deleteTask({ taskId }, user);
    results.push(result);
  }
  return results.join("\n");
}


export interface UpdateTaskInput {
  taskId?: string;
  identifier?: string;
  newHour?: number;
  newMinute?: number;
  newDate?: string;
  newDuration?: number;
  newTitle?: string;
  newSubject?: string;
}

export async function updateTask(input: UpdateTaskInput, user: User): Promise<string> {
  const db = getDb();
  let task: ActionStation | null = null;

  if (input.taskId) {
    try {
      task = (await db.collection("actionStations").findOne({ _id: new ObjectId(input.taskId), userId: user._id })) as ActionStation | null;
    } catch {
      return "Invalid task ID format.";
    }
  } else if (input.identifier) {
    const startOfDay = todayMidnightIST();
    const endOfDay = addDays(startOfDay, 1);
    task = (await db.collection("actionStations").findOne({
      userId: user._id,
      title: { $regex: input.identifier, $options: "i" },
      scheduledStart: { $gte: startOfDay, $lt: endOfDay },
      status: { $in: ["pending", "in_progress"] },
    })) as ActionStation | null;
  }

  if (!task) return "Task not found.";

  const updates: Record<string, any> = {};
  const oldStart = task.scheduledStart;
  let newStart = new Date(oldStart);

  if (input.newDate || input.newHour !== undefined || input.newMinute !== undefined) {
    const dateStr = input.newDate || oldStart.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const oldIST = new Date(oldStart.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const hour = input.newHour ?? oldIST.getHours();
    const minute = input.newMinute ?? oldIST.getMinutes();
    newStart = resolveDate(dateStr, hour, minute);
    updates.scheduledStart = newStart;
  }

  const duration = input.newDuration ?? task.estimatedMinutes;
  if (input.newDuration) updates.estimatedMinutes = input.newDuration;
  updates.scheduledEnd = new Date(newStart.getTime() + duration * 60_000);

  if (input.newTitle) updates.title = input.newTitle;
  if (input.newSubject) updates.subject = input.newSubject;

  await cancelAllTaskJobs((task._id as ObjectId).toString());
  await db.collection("actionStations").updateOne({ _id: task._id }, { $set: updates });

  await createTaskMachine(
    { _id: (task._id as ObjectId).toString(), userId: user._id.toString(), title: task.title, subject: task.subject, scheduledStart: updates.scheduledStart || task.scheduledStart, scheduledEnd: updates.scheduledEnd, estimatedMinutes: duration },
    { telegramChatId: user.telegramChatId, strictnessLevel: user.strictnessLevel || 1 }
  );

  const timeStr = `${String(input.newHour ?? new Date(newStart.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).getHours()).padStart(2, "0")}:${String(input.newMinute ?? new Date(newStart.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).getMinutes()).padStart(2, "0")}`;
  return `Updated task: ${task.emoji || ""} ${task.title}. New time: ${timeStr}, duration: ${duration} min.`;
}

export async function updateMultipleTasks(input: UpdateMultipleTasksInput, user: User): Promise<string> {
  const results: string[] = [];
  for (const update of input.updates) {
    const result = await updateTask(
      {
        taskId: update.taskId,
        newTitle: update.newTitle,
        newSubject: update.newSubject,
        newHour: update.newHour,
        newMinute: update.newMinute,
        newDuration: update.newDuration,
      },
      user,
    );
    results.push(result);
  }
  return results.join("\n");
}

// ═══════════════════════════════════════════════════════════
// SCHEDULE MANAGEMENT
// ═══════════════════════════════════════════════════════════

export interface SaveScheduleInput {
  rawText: string;
}

export async function saveSchedule(input: SaveScheduleInput, user: User): Promise<string> {
  try {
    const parsed = await parseSchedule(input.rawText, user);

    if (!parsed.blocks || parsed.blocks.length === 0) {
      return "PARSE_FAILED: Could not parse any study blocks. Ask user to rephrase with times and subjects.";
    }

    const plan = await saveStudyPlan(user._id, parsed, input.rawText, "text");

    const blockSummary = parsed.blocks
      .map((b) => `${b.emoji || "📚"} ${b.title} — ${String(b.startHour).padStart(2, "0")}:${String(b.startMinute).padStart(2, "0")} (${b.durationMinutes} min)`)
      .join("\n");

    return `SCHEDULE_PENDING:${user._id}\nParsed ${parsed.blocks.length} blocks (${parsed.scope || "daily"} schedule):\n${blockSummary}`;
  } catch (err: any) {
    return `PARSE_FAILED: ${err.message}`;
  }
}

export interface UpdateScheduleInput {
  modification: string;
}

export async function updateSchedule(input: UpdateScheduleInput, user: User): Promise<string> {
  const db = getDb();
  const userDoc = await db.collection("users").findOne({ _id: user._id as ObjectId });
  if (!userDoc?.studyPlan) {
    return "No existing schedule found. User needs to send a schedule first.";
  }

  const result = await applyScheduleUpdate(user.telegramChatId, input.modification, userDoc.studyPlan);
  if (!result.success || !result.updatedPlan) return `Could not update schedule: ${result.reply}`;
  const normalizedBlocks = result.updatedPlan.blocks.map(normalizeBlock);
  await db.collection("users").updateOne(
    { _id: user._id as ObjectId },
    {
      $set: {
        "studyPlan.blocks": normalizedBlocks,
        "studyPlan.dayOverrides": result.updatedPlan.dayOverrides || null,
        "studyPlan.scope": result.updatedPlan.scope,
        "studyPlan.updatedAt": new Date(),
      },
    }
  );

  return `Schedule updated. Changes: ${result.changes}. ${result.reply}`;
}

// Normalize blocks — LLM sometimes returns wrong field names
function normalizeBlock(block: any): StudyBlock {
  let startHour = block.startHour;
  let startMinute = block.startMinute ?? 0;

  // Handle "time": "14:00" format
  if (startHour === undefined && block.time) {
    const parts = block.time.split(":");
    startHour = parseInt(parts[0]);
    startMinute = parseInt(parts[1] || "0");
  }

  return {
    title: block.title || block.task || "Study Block",
    subject: block.subject || null,
    emoji: block.emoji || "📚",
    startHour,
    startMinute,
    durationMinutes: block.durationMinutes || block.duration || 60,
  };
}

// ═══════════════════════════════════════════════════════════
// USER PROFILE
// ═══════════════════════════════════════════════════════════

export interface SaveUserInfoInput {
  field: "name" | "review_time" | "wake_time" | "strictness";
  value: string;
}

export async function saveUserInfo(input: SaveUserInfoInput, user: User): Promise<string> {
  const extracted = {
    name: input.field === "name" ? input.value : null,
    review_time: input.field === "review_time" ? input.value : null,
    wake_time: input.field === "wake_time" ? input.value : null,
    strictness: input.field === "strictness" ? (parseInt(input.value) as 1 | 2) : null,
  };

  const savedFields = await saveExtractedFields(user, extracted);
  if (savedFields.length === 0) return `Could not save ${input.field}.`;
  return `Saved ${input.field}: ${input.value}`;
}

export interface SaveUpscProfileInput {
  targetYear?: string;
  attemptNumber?: number;
  optionalSubject?: string;
  preparationMode?: string;
  weakSubjects?: string[];
}

export async function saveUpscProfile(input: SaveUpscProfileInput, user: User): Promise<string> {
  const db = getDb();

  const userDoc = await db.collection("users").findOne({ _id: user._id as ObjectId });
  const existing = userDoc?.upscProfile || {};
  const updated = { ...existing };
  const savedFields: string[] = [];
  const profileUpdates: Record<string, any> = {};

  if (input.targetYear) { updated.targetYear = input.targetYear; savedFields.push(`target year: ${input.targetYear}`); }
  if (input.attemptNumber !== undefined) { updated.attemptNumber = input.attemptNumber; savedFields.push(`attempt #${input.attemptNumber}`); }
  if (input.optionalSubject) { updated.optionalSubject = input.optionalSubject; profileUpdates["profile.optionalSubject"] = input.optionalSubject; savedFields.push(`optional: ${input.optionalSubject}`); }
  if (input.preparationMode) { updated.preparationMode = input.preparationMode; savedFields.push(`mode: ${input.preparationMode}`); }
  if (input.weakSubjects && input.weakSubjects.length > 0) { updated.weakSubjects = input.weakSubjects; profileUpdates["profile.weakSubjects"] = input.weakSubjects; savedFields.push(`weak: ${input.weakSubjects.join(", ")}`); }

  if (savedFields.length === 0) return "No UPSC profile fields provided.";

  await db.collection("users").updateOne(
    { _id: user._id as ObjectId },
    { $set: { upscProfile: updated, ...profileUpdates } }
  );

  return `Saved UPSC profile: ${savedFields.join(", ")}`;
}

// ═══════════════════════════════════════════════════════════
// BEHAVIORAL OBSERVATION (called from agent.service.ts)
// ═══════════════════════════════════════════════════════════

export interface SaveBehavioralNoteInput {
  note: string;
  category: "study_pattern" | "avoidance" | "emotional" | "life_context" | "preference" | "milestone" | "accountability" | "insight";
}

export async function saveBehavioralNote(input: SaveBehavioralNoteInput, user: User): Promise<string> {
  const db = getDb();
  await db.collection("behavioralNotes").insertOne({
    userId: user._id,
    note: input.note,
    category: input.category,
    createdAt: new Date(),
  });
  return `Observation recorded [${input.category}]: "${input.note}"`;
}

/**
 * Fetch behavioral notes for system prompt injection.
 * - 15 most recent notes (any category)
 * - 10 avoidance + accountability (enforcement ammo)
 * - 5 life_context (rarely changes, always relevant)
 * Deduped, ~30 notes max, ~1000-1500 tokens.
 */
export async function getRecentBehavioralNotes(userId: ObjectId): Promise<string> {
  const db = getDb();
  const [recentNotes, enforcementNotes, contextNotes] = await Promise.all([
    db.collection("behavioralNotes").find({ userId }).sort({ createdAt: -1 }).limit(15).toArray(),
    db.collection("behavioralNotes").find({ userId, category: { $in: ["avoidance", "accountability"] } }).sort({ createdAt: -1 }).limit(10).toArray(),
    db.collection("behavioralNotes").find({ userId, category: "life_context" }).sort({ createdAt: -1 }).limit(5).toArray(),
  ]);

  const seen = new Set<string>();
  const allNotes: any[] = [];
  for (const note of [...recentNotes, ...enforcementNotes, ...contextNotes]) {
    const id = note._id.toString();
    if (!seen.has(id)) { seen.add(id); allNotes.push(note); }
  }
  allNotes.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (allNotes.length === 0) return "";

  return allNotes.map((n) => {
    const diffMin = Math.floor((Date.now() - new Date(n.createdAt).getTime()) / 60_000);
    const age = diffMin < 60 ? `${diffMin}m` : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h` : `${Math.floor(diffMin / 1440)}d`;
    return `[${n.category}] (${age}) ${n.note}`;
  }).join("\n");
}