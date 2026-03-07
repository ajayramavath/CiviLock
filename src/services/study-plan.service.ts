// src/services/study-plan.service.ts
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import { createTaskMachine } from "./task-machine.service.js";
import { UPSC_SUBJECTS } from "../models/types.js";
import type { StudyBlock, StudyPlan } from "../models/types.js";
import Anthropic from "@anthropic-ai/sdk";
import { llmCall } from "./llm.service.js";
import { trackAPIUsage } from "./rate-limiter.service.js";

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

// ─── Parse text schedule ─────────────────────────────────────────────────────

export async function parseSchedule(
  text: string,
  user: any,
): Promise<ParsedSchedule> {
  const optionalSubject = user.upscProfile?.optionalSubject || "Not set";
  const today = new Date().toISOString().split("T")[0];

  console.log(
    `[PARSE] parseSchedule called | textLength=${text.length} | optional=${optionalSubject} | date=${today}`,
  );

  const response = await llmCall({
    chatId: user.telegramChatId,
    model: "claude-haiku-4-5-20251001",
    maxTokens: 1500,
    system: PARSE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `User's optional subject: ${optionalSubject}\nToday's date: ${today}\n\nSchedule:\n"${text}"`,
      },
    ],
    purpose: "schedule_parse"
  });

  return extractResult(response);
}

// ─── Parse photo schedule ────────────────────────────────────────────────────

export async function parseScheduleFromImage(
  base64Image: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  user: any,
): Promise<ParsedSchedule> {
  const optionalSubject = user.upscProfile?.optionalSubject || "Not set";
  const today = new Date().toISOString().split("T")[0];

  console.log(
    `[PARSE] parseScheduleFromImage called | mediaType=${mediaType} | base64Length=${base64Image.length} | optional=${optionalSubject}`,
  );

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
            text: `User's optional subject: ${optionalSubject}\nToday's date: ${today}\n\nExtract the study timetable from this image.`,
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
  // Handle both raw Anthropic response and llmCall result
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
  console.log(
    `[PARSE] Cleaned JSON (first 500 chars): ${clean.substring(0, 500)}`,
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

    // Fallback: if truncated, try to extract the "blocks" array before dayOverrides
    if (wasTruncated) {
      console.log(`[PARSE] Attempting truncation recovery...`);
      try {
        // Find the blocks array — it appears before dayOverrides
        const blocksMatch = clean.match(
          /"blocks"\s*:\s*(\[[\s\S]*?\])\s*,\s*"dayOverrides"/,
        );
        if (blocksMatch) {
          const blocks = JSON.parse(blocksMatch[1]);
          console.log(
            `[PARSE] Recovery succeeded | blocks=${blocks.length} (dayOverrides lost to truncation)`,
          );

          // Try to salvage any complete dayOverrides too
          let dayOverrides: Record<number, StudyBlock[]> | undefined;
          try {
            const overridesStart = clean.indexOf('"dayOverrides"');
            if (overridesStart !== -1) {
              // Try to find complete day entries (e.g., "1": [...])
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
                ? `Weekly schedule (${Object.keys(dayOverrides).length} days recovered — some data was lost, you can resend for a complete parse)`
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
  const wakeHour = user.sleepSchedule?.wakeHour ?? 6;
  const wakeMinute = user.sleepSchedule?.wakeMinute ?? 0;
  const sleepHour = user.sleepSchedule?.sleepHour ?? 23;
  const sleepsAfterMidnight = sleepHour < wakeHour;

  // ── Compute the NEXT wake cycle ──────────────────────────────────────
  // "Next day" = next wake time → next sleep time
  // If it's 1:30 AM and user sleeps at 2 AM, the next wake is TODAY at 6 AM
  // If it's 11 PM and user sleeps at 11:30 PM, the next wake is TOMORROW at 6 AM
  const now = new Date();
  const currentHour = now.getHours();

  const nextWake = new Date(now);
  nextWake.setHours(wakeHour, wakeMinute, 0, 0);

  // Determine if next wake is today or tomorrow
  const isInLateNight = sleepsAfterMidnight && currentHour < sleepHour;
  if (currentHour >= wakeHour && !isInLateNight) {
    // Past wake time and not in late-night window → next wake is tomorrow
    nextWake.setDate(nextWake.getDate() + 1);
  }
  // If in late-night window (e.g. 1:30 AM, sleep at 2 AM), next wake is today — already correct

  const cycleEnd = new Date(nextWake);
  if (sleepsAfterMidnight) {
    cycleEnd.setDate(cycleEnd.getDate() + 1);
  }
  cycleEnd.setHours(sleepHour, 0, 0, 0);

  const dayOfWeek = nextWake.getDay();

  console.log(
    `[BLOCKS] Next cycle: wake=${nextWake.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} → ` +
    `sleep=${cycleEnd.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} | dayOfWeek=${dayOfWeek}`,
  );

  // ── Check for existing blocks in the next cycle ──────────────────────
  const existing = await db.collection("actionStations").countDocuments({
    userId: uid,
    scheduledStart: { $gte: nextWake, $lte: cycleEnd },
    status: { $in: ["pending", "completed", "partial"] },
  });

  if (existing > 0) {
    console.log(`[BLOCKS] ${existing} blocks already exist for this cycle`);
    return { created: 0, blocks: [] };
  }

  // Pick blocks: day override or default
  const dayBlocks: StudyBlock[] = plan.dayOverrides?.[dayOfWeek] || plan.blocks;

  const createdBlocks: Array<{
    title: string;
    subject: string | null;
    start: Date;
    end: Date;
  }> = [];

  for (let i = 0; i < dayBlocks.length; i++) {
    const block = dayBlocks[i] as StudyBlock;

    // Anchor block to the wake day
    const start = new Date(nextWake);
    start.setHours(block.startHour, block.startMinute, 0, 0);

    // If block's start hour is before wake hour, it's a late-night block (after midnight)
    if (block.startHour < wakeHour) {
      start.setDate(start.getDate() + 1);
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
