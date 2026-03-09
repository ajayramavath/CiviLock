import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import type { ChatMessage } from "./conversation-state.service.js";
import { UPSC_SUBJECTS } from "../models/types.js";
import { llmCall } from "./llm.service.js";
import { istDate, addDays, nowInIST } from "../utils/timezone.js";

export interface ConversationResponse {
  type:
  | "task_captured"
  | "slot_confirmed"
  | "slot_rejected"
  | "slot_selected"
  | "task_updated"
  | "task_deleted"
  | "not_a_task"
  | "unclear";
  task?: {
    title: string;
    durationMinutes: number;
    emoji: string;
    subject: string | null;
  };
  taskToUpdate?: {
    identifier: string;
    currentTime?: { hour: number; minute: number };
    date?: "today" | "tomorrow";
    newSlot?: { hour: number; minute: number; date: "today" | "tomorrow" };
    newDuration?: number;
  };
  taskToDelete?: {
    identifier: string;
    currentTime?: { hour: number; minute: number };
    date?: "today" | "tomorrow";
  };
  suggestedSlots?: Array<{
    hour: number;
    minute: number;
    date: "today" | "tomorrow";
    reason: string;
  }>;
  selectedSlot?: {
    hour: number;
    minute: number;
    date: "today" | "tomorrow";
  };
  replyMessage: string;
}

export async function processUserMessage(
  userMessage: string,
  user: any,
  history: ChatMessage[],
): Promise<{ response: ConversationResponse; rawAssistantContent: string }> {
  console.log(userMessage);
  const db = getDb();
  const currentCycle = getUserCurrentDayCycle(user);
  const nextCycle = getUserNextDayCycle(user);

  const [currentTasks, nextTasks] = await Promise.all([
    db
      .collection("actionStations")
      .find({
        userId: user._id,
        scheduledStart: {
          $gte: currentCycle.startDateTime,
          $lte: currentCycle.endDateTime,
        },
        status: "pending",
      })
      .sort({ scheduledStart: 1 })
      .project({ _id: 1, title: 1, subject: 1, scheduledStart: 1, scheduledEnd: 1 })
      .toArray(),

    db
      .collection("actionStations")
      .find({
        userId: user._id,
        scheduledStart: {
          $gte: nextCycle.startDateTime,
          $lte: nextCycle.endDateTime,
        },
        status: "pending",
      })
      .sort({ scheduledStart: 1 })
      .project({ _id: 1, title: 1, subject: 1, scheduledStart: 1, scheduledEnd: 1 })
      .toArray(),
  ]);

  const formatSchedule = (tasks: any[]) =>
    tasks.length === 0
      ? "Empty"
      : tasks
        .map(
          (t) =>
            `  [ID: ${t._id}] ${formatTime(t.scheduledStart)}-${formatTime(t.scheduledEnd)}: ${t.title}${t.subject ? ` [${t.subject}]` : ""}`,
        )
        .join("\n");

  const upsc = user.upscProfile;
  const upscContext = upsc
    ? `\nUPSC PROFILE:\nTarget: Prelims ${upsc.targetYear}\nAttempt: #${upsc.attemptNumber}\nOptional: ${upsc.optionalSubject || "Not set"}\nWeak subjects: ${upsc.weakSubjects?.length > 0 ? upsc.weakSubjects.map((s: string) => s.split(" (")[0]).join(", ") : "None"}`
    : "";

  let routineContext = "";
  if (user.studyPlan) {
    const rawContent = typeof user.studyPlan.rawInput === 'string' && user.studyPlan.rawInput.length > 0
      ? user.studyPlan.rawInput
      : "See attached routine definition / photo";
    routineContext = `\nPERMANENT WEEKLY ROUTINE (OVERARCHING SCHEDULE):\n${rawContent}`;
  }

  const subjectList = UPSC_SUBJECTS.map((s) => s.split(" (")[0]).join(", ");

  const systemPrompt = `
You are a UPSC accountability agent helping manage a student's study schedule.

USER INFO:
Name: ${user.name}
Wake: ${formatHourMin(user.sleepSchedule.wakeHour, user.sleepSchedule.wakeMinute)}
Sleep: ${formatHourMin(user.sleepSchedule.sleepHour, user.sleepSchedule.sleepMinute)}
Current time: ${new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true })}
${upscContext}
${routineContext}

TODAY'S SCHEDULE:
${formatSchedule(currentTasks)}

TOMORROW'S SCHEDULE:
${formatSchedule(nextTasks)}

INSTRUCTIONS:
Always respond with valid JSON only. No markdown, no extra text.

CRITICAL - SUBJECT TAGGING:
Every study task MUST include a "subject" field. Map the user's task to the closest UPSC subject:
${subjectList}
If the task is clearly non-study (gym, break, etc), subject should be null.
Examples:
- "study polity" → subject: "GS2"
- "revise ancient history" → subject: "GS1"
- "practice economy questions" → subject: "GS3"
- "ethics case studies" → subject: "GS4"
- "write 2 answers" → subject: "Answer Writing"
- "read newspaper" → subject: "Current Affairs"
- "study pub ad" or user's optional → subject: "Optional Subject"
- "CSAT practice" → subject: "CSAT"
- "gym" → subject: null

Determine intent from the user's message and conversation history:

1. NEW TASK (No specific time) - user expressing something they need to do:
   type: "task_captured"
   - Extract concise title, estimate duration, assign UPSC subject, suggest 2 open slots
   - Default to tomorrow unless user implies today/now/tonight
   - FORBIDDEN: Do not use this type if the user provided a specific time!

2. NEW TASK (Specific time given) - user provides both the task AND the exact time:
   type: "slot_confirmed"
   - Include both 'task' and 'selectedSlot' in the JSON
   - Skip suggesting slots entirely
   - Example: "Add history at 1:30 am" -> MUST return slot_confirmed, NEVER task_captured.

3. UPDATE TASK - user wants to move/reschedule/change an existing task:
   type: "task_updated"
   - Identify task by its exact ID from the schedule
   - Include taskToUpdate with taskId, and newSlot if specified

4. DELETE TASK - user wants to cancel/remove a task:
   type: "task_deleted"
   - Identify task by its exact ID from the schedule

5. RESPONDING TO SLOTS - user replying to slot suggestions:
   - Accepting first → type: "slot_confirmed", include selectedSlot
   - Picking specific → type: "slot_selected", include selectedSlot
   - Rejecting → type: "slot_rejected", suggest 2 different slots

6. NOT A TASK - clearly not task management → type: "not_a_task"

JSON format:
{
  "type": "task_captured|task_updated|task_deleted|slot_confirmed|slot_selected|slot_rejected|not_a_task",
  "task": { "title": "...", "durationMinutes": 30, "emoji": "📚", "subject": "GS2" },
  "taskToUpdate": { "taskId": "...", "newSlot": { "hour": 20, "minute": 0, "date": "today" }, "newDuration": 90 },
  "taskToDelete": { "taskId": "..." },
  "suggestedSlots": [ { "hour": 21, "minute": 0, "date": "today", "reason": "..." } ],
  "selectedSlot": { "hour": 21, "minute": 0, "date": "today" },
  "replyMessage": "Plain text reply to show user"
}

EMOJI GUIDE: study/learn/revise→📚, answer writing→✍️, current affairs→📰, CSAT→🧮, essay→📝, gym/exercise→🏋️, default→📋
DURATION DEFAULTS: study session→120min, revision→60min, answer writing→90min, current affairs→45min, CSAT practice→60min, essay practice→120min
`.trim();

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  const llmResult = await llmCall({
    chatId: user.telegramChatId,
    maxTokens: 500,
    system: systemPrompt,
    messages,
    purpose: "conversation",
  });

  if (!llmResult.text) {
    return {
      response: {
        type: "unclear",
        replyMessage: "I didn't quite get that. Tell me what you need to study, or use /today.",
      },
      rawAssistantContent: "",
    };
  }
  const clean = llmResult.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  let response: ConversationResponse;
  try {
    response = JSON.parse(clean);
  } catch {
    response = {
      type: "unclear",
      replyMessage:
        "I didn't quite get that. Tell me what you need to study, or use /today to see your schedule.",
    };
  }

  console.log(response);

  return {
    response,
    rawAssistantContent: clean,
  };
}

// ============================================================================
// SAVE CONFIRMED TASK — now includes subject
// ============================================================================

export async function saveConfirmedTask(
  userId: ObjectId,
  task: {
    title: string;
    durationMinutes: number;
    emoji: string;
    subject?: string | null;
  },
  slot: { hour: number; minute: number; date: "today" | "tomorrow" },
  user: any,
): Promise<{ taskDoc: any; taskId: string }> {
  const db = getDb();

  const dayCycle =
    slot.date === "today"
      ? getUserCurrentDayCycle(user)
      : getUserNextDayCycle(user);

  let startDate = istDate(dayCycle.startDateTime, slot.hour, slot.minute);

  // If block's start hour is before wake, it's a late-night block (next calendar day)
  if (slot.hour < user.sleepSchedule.wakeHour) {
    const nextDay = addDays(dayCycle.startDateTime, 1);
    startDate = istDate(nextDay, slot.hour, slot.minute);
  }

  const endDate = new Date(
    startDate.getTime() + task.durationMinutes * 60 * 1000,
  );

  const taskDoc = {
    userId,
    projectId: new ObjectId(),
    title: task.title,
    emoji: task.emoji,
    subject: task.subject || null,
    scheduledStart: startDate,
    scheduledEnd: endDate,
    estimatedMinutes: task.durationMinutes,
    priority: 2,
    status: "pending",
    isRecurring: false,
    createdAt: new Date(),
  };

  const result = await db.collection("actionStations").insertOne(taskDoc);
  return { taskDoc, taskId: result.insertedId.toString() };
}

// ============================================================================
// BULK PLAN — parse multiple study blocks at once
// ============================================================================

export interface BulkPlanResult {
  tasks: Array<{
    title: string;
    emoji: string;
    subject: string | null;
    hour: number;
    minute: number;
    durationMinutes: number;
  }>;
  replyMessage: string;
}

export async function parseBulkPlan(
  userMessage: string,
  user: any,
): Promise<BulkPlanResult> {
  const upsc = user.upscProfile;
  const subjectList = UPSC_SUBJECTS.map((s) => s.split(" (")[0]).join(", ");

  const systemPrompt = `
You are a UPSC study schedule parser. Parse the user's plan into structured study blocks.

USER INFO:
Wake: ${formatHourMin(user.sleepSchedule.wakeHour, user.sleepSchedule.wakeMinute)}
Sleep: ${formatHourMin(user.sleepSchedule.sleepHour, user.sleepSchedule.sleepMinute)}
${upsc ? `Optional subject: ${upsc.optionalSubject || "Not set"}` : ""}

SUBJECT MAPPING (use short form):
${subjectList}
Map every study task to one. Non-study tasks get null.

Parse the user's message into study blocks. Be flexible with time formats.
Examples of input:
"9-12 polity, 2-5 optional, 7-8 current affairs, 9-10 answer writing"
"study GS1 morning, economy afternoon, CA evening"
"6am newspaper, 9am to 12 polity, 2pm pub ad, 5pm essay practice, 8pm revision GS3"

Return ONLY valid JSON:
{
  "tasks": [
    { "title": "Study Polity", "emoji": "📚", "subject": "GS2", "hour": 9, "minute": 0, "durationMinutes": 180 },
    { "title": "Optional - Pub Ad", "emoji": "📚", "subject": "Optional Subject", "hour": 14, "minute": 0, "durationMinutes": 180 }
  ],
  "replyMessage": "Brief confirmation message listing what was scheduled"
}

DURATION: If user says "9-12", that's 180 min. If user says "study polity 2 hours", that's 120 min. If no duration, default: study=120, revision=60, CA=45, answer writing=90.
EMOJI: study/revise→📚, answer writing→✍️, current affairs→📰, CSAT→🧮, essay→📝, gym→🏋️, default→📋
`.trim();

  const llmResult = await llmCall({
    chatId: user.telegramChatId,
    maxTokens: 800,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    purpose: "bulk_plan",
  });
  const clean = llmResult.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch {
    return {
      tasks: [],
      replyMessage:
        "Couldn't parse that. Try something like: '9-12 polity, 2-5 optional, 7-8 CA'",
    };
  }
}

// ============================================================================
// HELPERS
// ============================================================================

export function getUserCurrentDayCycle(user: any) {
  const { wakeHour, wakeMinute, sleepHour, sleepMinute } = user.sleepSchedule;
  const { hour: currentHour, date: now } = nowInIST();
  const sleepsAfterMidnight = sleepHour < wakeHour;
  const isInLateNight = sleepsAfterMidnight && currentHour < sleepHour;

  let baseDate = now;
  if (isInLateNight) {
    // It's e.g. 1 AM — the cycle started yesterday
    baseDate = addDays(now, -1);
  }

  const cycleStart = istDate(baseDate, wakeHour, wakeMinute);
  const cycleEndBase = sleepsAfterMidnight ? addDays(baseDate, 1) : baseDate;
  const cycleEnd = istDate(cycleEndBase, sleepHour, sleepMinute);

  return { startDateTime: cycleStart, endDateTime: cycleEnd };
}

export function getUserNextDayCycle(user: any) {
  const current = getUserCurrentDayCycle(user);
  const { wakeHour, wakeMinute, sleepHour, sleepMinute } = user.sleepSchedule;
  const sleepsAfterMidnight = sleepHour < wakeHour;

  const nextStart = addDays(current.startDateTime, 1);
  const nextStartDate = istDate(nextStart, wakeHour, wakeMinute);
  const nextEndBase = sleepsAfterMidnight ? addDays(nextStart, 1) : nextStart;
  const nextEnd = istDate(nextEndBase, sleepHour, sleepMinute);

  return { startDateTime: nextStartDate, endDateTime: nextEnd };
}

export function formatHourMin(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  return `${h}:${minute.toString().padStart(2, "0")} ${period}`;
}

export function formatTime(date: Date): string {
  return new Date(date).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

export function formatDateTime(date: Date): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}
