// src/services/study-plan.service.ts
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import { createTaskMachine } from "./task-machine.service.js";
import { UPSC_SUBJECTS } from "../models/types.js";
import type { StudyBlock, StudyPlan } from "../models/types.js";
import Anthropic from "@anthropic-ai/sdk";
import { llmCall } from "./llm.service.js";
import { trackAPIUsage } from "./rate-limiter.service.js";
import { istDate, nowInIST, addDays } from "../utils/timezone.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── The single AI prompt that figures everything out ────────────────────────

const PARSE_SYSTEM_PROMPT = `You are an expert at reading UPSC study timetables in any format and extracting structured schedules.

You will receive a study schedule from a UPSC aspirant. It could be:
- A simple daily plan: "9-12 polity, 2-5 optional, 7-8 CA"
- A weekly plan with different days: "Mon: polity, Tue: economy..."
- A monthly plan or multi-month coaching schedule
- A handwritten timetable photo
- A coaching institute's printed schedule
- Anything else

Your job:
1. Extract the daily study blocks (title, UPSC subject, start time, duration)
2. Figure out the SCOPE — is this a daily routine, a weekly plan, a month plan, a 3-month plan?
3. Decide when to REVIEW — when should we ask the user if this plan is still current?

SUBJECT MAPPING (use short form in output):
GS1, GS2, GS3, GS4, Essay, CSAT, Optional Subject, Current Affairs, Answer Writing
- polity/constitution/IR/governance → GS2
- history/geography/society/culture → GS1
- economy/environment/science/tech → GS3
- ethics/integrity/case studies → GS4
- newspaper/the hindu/current affairs → Current Affairs
- answer writing/mains practice → Answer Writing
- user's optional subject name → Optional Subject
- CSAT/aptitude/reasoning → CSAT
- non-study (gym, break, meal) → null (skip these blocks)

EMOJI: study→📚, answer writing→✍️, CA/newspaper→📰, CSAT→🧮, essay→📝, default→📋

DURATION DEFAULTS (when not specified): study=120min, revision=60min, CA=45min, answer writing=90min, CSAT=60min

Return ONLY valid JSON:
{
  "blocks": [
    { "title": "Study Polity", "subject": "GS2", "emoji": "📚", "startHour": 9, "startMinute": 0, "durationMinutes": 180 }
  ],
  "dayOverrides": null,
  "scope": {
    "type": "daily|weekly|monthly|multi_month|yearly",
    "description": "Human-readable description of what this plan covers",
    "reviewAt": "ISO date string — when to next ask the user about updating"
  }
}

SCOPE RULES:
- If user gives a flat list of times + subjects with no day references → type:"daily", repeat every day, reviewAt: 30 days from now
- If user specifies days (Mon/Tue/etc) → type:"weekly", use dayOverrides (0=Sun..6=Sat), put most common day in blocks, reviewAt: next Sunday
- If user gives a monthly plan (Week 1: X, Week 2: Y) → type:"monthly", extract THIS week's blocks, reviewAt: start of next week
- If user gives a multi-month schedule → type:"multi_month", extract THIS week's blocks, reviewAt: start of next week
- Always set reviewAt to a realistic date based on when the current portion of the plan runs out

DAY OVERRIDES:
If schedule differs by day, put the most common schedule in "blocks" and put day-specific differences in "dayOverrides" as { dayNumber: [blocks] }.
Day numbers: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday.
If all days are different, pick any day as default "blocks" and override the rest.
If a day has no study (e.g., Sunday off), set its override to an empty array [].`;

// ─── Build user context for schedule parsing ─────────────────────────────────

function buildParseContext(user: any): string {
  const optionalSubject =
    user.upscProfile?.optionalSubject ||
    user.profile?.optionalSubject ||
    "Not specified";

  const today = new Date().toISOString().split("T")[0];

  // Time context helps the parser disambiguate AM/PM
  let timeHint = "";
  if (user.sleepSchedule) {
    const wake = `${user.sleepSchedule.wakeHour}:${String(user.sleepSchedule.wakeMinute || 0).padStart(2, "0")}`;
    const sleep = `${user.sleepSchedule.sleepHour}:${String(user.sleepSchedule.sleepMinute || 0).padStart(2, "0")}`;
    timeHint = `\nUser's active hours: ${wake} to ${sleep} (use this to disambiguate AM/PM — e.g., "2" during active hours likely means 2 PM)`;
  } else if (user.wakeTime || user.profile?.wakeTime) {
    timeHint = `\nUser wakes around: ${user.wakeTime || user.profile?.wakeTime}`;
  }

  return `User's optional subject: ${optionalSubject}\nToday's date: ${today}${timeHint}`;
}

// ─── Parse text schedule ─────────────────────────────────────────────────────

export async function parseSchedule(
  text: string,
  user: any,
): Promise<ParsedSchedule> {
  const context = buildParseContext(user);

  console.log(
    `[PARSE] parseSchedule called | textLength=${text.length} | context=${context.split("\n").join(" | ")}`,
  );

  const response = await llmCall({
    chatId: user.telegramChatId,
    model: "claude-sonnet-4-5-20250929",
    maxTokens: 1500,
    system: PARSE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `${context}\n\nSchedule:\n"${text}"`,
      },
    ],
    purpose: "schedule_parse",
  });

  return extractResult(response);
}

// ─── Parse photo schedule ────────────────────────────────────────────────────

export async function parseScheduleFromImage(
  base64Image: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  user: any,
): Promise<ParsedSchedule> {
  const context = buildParseContext(user);

  console.log(
    `[PARSE] parseScheduleFromImage called | mediaType=${mediaType} | base64Length=${base64Image.length}`,
  );

  // Photo parsing uses Sonnet for better image understanding
  // Still using raw client because llmCall doesn't support image content blocks
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 4096,
    system: PARSE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: base64Image,
            },
          },
          {
            type: "text",
            text: `${context}\n\nExtract the study timetable from this image.`,
          },
        ],
      },
    ],
  });

  await trackAPIUsage(
    user.telegramChatId,
    "claude-sonnet-4-5-20250929",
    response.usage?.input_tokens || 0,
    response.usage?.output_tokens || 0,
    "photo_parse",
  );

  console.log(
    `[PARSE] Sonnet response | stopReason=${response.stop_reason} | contentBlocks=${response.content.length}`,
  );

  return extractResult(response);
}

// ─── Common result extractor ─────────────────────────────────────────────────

interface ParsedSchedule {
  blocks: StudyBlock[];
  dayOverrides?: Record<number, StudyBlock[]> | null;
  scope: {
    type: string;
    description: string;
    reviewAt: string;
  };
}

function extractResult(response: any): ParsedSchedule {
  const rawText = response.text
    ? response.text
    : response.content?.[0]?.type === "text"
      ? response.content[0].text
      : "{}";
  const clean = rawText
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  const wasTruncated =
    response.stop_reason === "max_tokens" ||
    response.stopReason === "max_tokens";

  console.log(
    `[PARSE] Raw AI response (first 500 chars): ${rawText.substring(0, 500)}`,
  );
  console.log(`[PARSE] Truncated: ${wasTruncated}`);

  // Try full JSON parse first
  try {
    const parsed = JSON.parse(clean);
    console.log(
      `[PARSE] JSON parsed OK | blocks=${parsed.blocks?.length || 0} | hasDayOverrides=${!!parsed.dayOverrides} | scopeType=${parsed.scope?.type}`,
    );

    if (parsed.dayOverrides && typeof parsed.dayOverrides === "object") {
      const days = Object.keys(parsed.dayOverrides);
      console.log(
        `[PARSE] Day overrides: ${days.map((d) => `${d}=${parsed.dayOverrides[d]?.length || 0} blocks`).join(", ")}`,
      );
    }

    return {
      blocks: parsed.blocks || [],
      dayOverrides: parsed.dayOverrides || undefined,
      scope: parsed.scope || {
        type: "daily",
        description: "Daily schedule",
        reviewAt: getDefaultReviewDate(),
      },
    };
  } catch (err: any) {
    console.log(`[PARSE] JSON parse failed | error=${err.message}`);

    // Fallback: if truncated, try to extract the "blocks" array
    if (wasTruncated) {
      console.log(`[PARSE] Attempting truncation recovery...`);
      try {
        const blocksMatch = clean.match(
          /"blocks"\s*:\s*(\[[\s\S]*?\])\s*,\s*"dayOverrides"/,
        );
        if (blocksMatch) {
          const blocks = JSON.parse(blocksMatch[1]);
          console.log(
            `[PARSE] Recovery succeeded | blocks=${blocks.length} (dayOverrides lost)`,
          );

          let dayOverrides: Record<number, StudyBlock[]> | undefined;
          try {
            const overridesStart = clean.indexOf('"dayOverrides"');
            if (overridesStart !== -1) {
              const overridesText = clean.substring(overridesStart);
              const dayMatches = overridesText.matchAll(
                /"(\d+)"\s*:\s*(\[[\s\S]*?\])\s*(?:,\s*"|\})/g,
              );
              const recovered: Record<number, StudyBlock[]> = {};
              for (const match of dayMatches) {
                try {
                  recovered[parseInt(match[1])] = JSON.parse(match[2]);
                } catch { }
              }
              if (Object.keys(recovered).length > 0) {
                dayOverrides = recovered;
                console.log(
                  `[PARSE] Recovered ${Object.keys(recovered).length} day overrides`,
                );
              }
            }
          } catch { }

          return {
            blocks,
            dayOverrides,
            scope: {
              type: dayOverrides ? "weekly" : "daily",
              description: dayOverrides
                ? `Weekly schedule (${Object.keys(dayOverrides).length} days recovered — some data was lost, resend for a complete parse)`
                : "Daily schedule (weekly details were cut off — resend for full parse)",
              reviewAt: getDefaultReviewDate(),
            },
          };
        }
      } catch (recoveryErr: any) {
        console.log(`[PARSE] Recovery failed: ${recoveryErr.message}`);
      }
    }

    console.log(`[PARSE] Full raw text:\n${rawText}`);
    return {
      blocks: [],
      scope: {
        type: "daily",
        description: "Could not parse",
        reviewAt: getDefaultReviewDate(),
      },
    };
  }
}

function getDefaultReviewDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString();
}

// ─── Save plan ───────────────────────────────────────────────────────────────

export async function saveStudyPlan(
  userId: ObjectId | string,
  parsed: ParsedSchedule,
  rawInput: string,
  source: "text" | "photo",
): Promise<StudyPlan> {
  const db = getDb();
  const uid = typeof userId === "string" ? new ObjectId(userId) : userId;
  const now = new Date().toISOString();

  const plan: StudyPlan = {
    blocks: parsed.blocks,
    dayOverrides: parsed.dayOverrides || undefined,
    scope: parsed.scope,
    rawInput,
    source,
    createdAt: now,
    updatedAt: now,
  };

  await db
    .collection("users")
    .updateOne({ _id: uid }, { $set: { studyPlan: plan } });

  return plan;
}

// ─── Generate tomorrow's blocks from plan ────────────────────────────────────

export async function generateDailyBlocks(userId: ObjectId | string): Promise<{
  created: number;
  blocks: Array<{
    title: string;
    subject: string | null;
    start: Date;
    end: Date;
  }>;
}> {
  const db = getDb();
  const uid = typeof userId === "string" ? new ObjectId(userId) : userId;
  const user = await db.collection("users").findOne({ _id: uid });

  if (!user?.studyPlan?.blocks?.length) {
    return { created: 0, blocks: [] };
  }

  const plan: StudyPlan = user.studyPlan;

  // Use sleepSchedule if available, otherwise defaults
  const wakeHour = user.sleepSchedule?.wakeHour ?? 6;
  const wakeMinute = user.sleepSchedule?.wakeMinute ?? 0;
  const sleepHour = user.sleepSchedule?.sleepHour ?? 23;
  const sleepsAfterMidnight = sleepHour < wakeHour;

  // ── Compute the NEXT wake cycle (IST-aware) ──────────────────────────
  const ist = nowInIST();
  const currentHour = ist.hour;

  let nextWake = istDate(ist.date, wakeHour, wakeMinute);

  const isInLateNight = sleepsAfterMidnight && currentHour < sleepHour;
  if (currentHour >= wakeHour && !isInLateNight) {
    const tomorrow = new Date(ist.date);
    tomorrow.setDate(tomorrow.getDate() + 1);
    nextWake = istDate(tomorrow, wakeHour, wakeMinute);
  }

  let cycleEndBase = nextWake;
  if (sleepsAfterMidnight) {
    cycleEndBase = new Date(nextWake.getTime() + 24 * 60 * 60 * 1000);
  }
  const cycleEnd = istDate(cycleEndBase, sleepHour, 0);

  const dayOfWeek = new Date(
    nextWake.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  ).getDay();

  console.log(
    `[BLOCKS] Next cycle: wake=${nextWake.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} → ` +
    `sleep=${cycleEnd.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} | dayOfWeek=${dayOfWeek}`,
  );

  // ── Check for existing blocks ────────────────────────────────────────
  const existing = await db.collection("actionStations").countDocuments({
    userId: uid,
    scheduledStart: { $gte: nextWake, $lte: cycleEnd },
    status: { $in: ["pending", "completed", "partial"] },
  });

  if (existing > 0) {
    console.log(`[BLOCKS] ${existing} blocks already exist for this cycle`);
    return { created: 0, blocks: [] };
  }

  const dayBlocks: StudyBlock[] =
    plan.dayOverrides?.[dayOfWeek] || plan.blocks;

  const createdBlocks: Array<{
    title: string;
    subject: string | null;
    start: Date;
    end: Date;
  }> = [];

  for (let i = 0; i < dayBlocks.length; i++) {
    const block = dayBlocks[i] as StudyBlock;

    let start = istDate(nextWake, block.startHour, block.startMinute);

    if (block.startHour < wakeHour) {
      const nextDay = new Date(nextWake.getTime() + 24 * 60 * 60 * 1000);
      start = istDate(nextDay, block.startHour, block.startMinute);
    }

    const end = new Date(start.getTime() + block.durationMinutes * 60 * 1000);

    const taskDoc = {
      userId: uid,
      projectId: new ObjectId(),
      title: block.title,
      subject: block.subject,
      emoji: block.emoji,
      scheduledStart: start,
      scheduledEnd: end,
      estimatedMinutes: block.durationMinutes,
      priority: 2,
      status: "pending",
      isRecurring: true,
      sourceBlockIndex: i,
      createdAt: new Date(),
    };

    const result = await db.collection("actionStations").insertOne(taskDoc);

    await createTaskMachine(
      {
        _id: result.insertedId.toString(),
        userId: uid.toString(),
        title: block.title,
        subject: block.subject,
        scheduledStart: start,
        scheduledEnd: end,
        estimatedMinutes: block.durationMinutes,
      },
      {
        telegramChatId: user.telegramChatId,
        strictnessLevel: user.strictnessLevel,
      },
    );

    createdBlocks.push({
      title: block.title,
      subject: block.subject,
      start,
      end,
    });
  }

  return { created: createdBlocks.length, blocks: createdBlocks };
}

// ─── Check if plan needs review ──────────────────────────────────────────────

export function shouldReviewPlan(plan: StudyPlan): "now" | "soon" | "no" {
  const now = new Date();
  const review = new Date(plan.scope.reviewAt);
  const daysUntil = Math.ceil(
    (review.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (daysUntil <= 0) return "now";
  if (daysUntil <= 2) return "soon";
  return "no";
}

// ─── Format for display ─────────────────────────────────────────────────────

export function formatPlanForDisplay(
  plan: StudyPlan,
  dayOfWeek?: number,
): string {
  const day = dayOfWeek ?? new Date().getDay();
  const blocks = plan.dayOverrides?.[day] || plan.blocks;

  if (!blocks.length) return "No study plan set.";

  const totalMinutes = blocks.reduce((s, b) => s + b.durationMinutes, 0);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;

  let message = `📋 <b>${plan.scope.description}</b>\n\n`;

  for (const block of blocks) {
    const time = formatSlotTime(block.startHour, block.startMinute);
    const subject = block.subject ? ` [${block.subject}]` : "";
    message += `${block.emoji} <b>${time}</b> (${block.durationMinutes}min) — ${block.title}${subject}\n`;
  }

  message += `\n⏱ Total: ${hours}h${mins > 0 ? ` ${mins}min` : ""}`;

  if (plan.dayOverrides && Object.keys(plan.dayOverrides).length > 0) {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const customDays = Object.keys(plan.dayOverrides)
      .map((d) => dayNames[parseInt(d)])
      .join(", ");
    message += `\n📅 Different on: ${customDays}`;
  }

  const review = shouldReviewPlan(plan);
  if (review === "now") {
    message += `\n\n⚠️ <b>Plan due for review.</b> Send your updated schedule anytime.`;
  } else if (review === "soon") {
    message += `\n\n⏳ Review coming up on ${new Date(plan.scope.reviewAt).toLocaleDateString("en-IN")}`;
  }

  return message;
}

function formatSlotTime(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  return `${h}:${minute.toString().padStart(2, "0")} ${period}`;
}