// src/services/schedule-update.service.ts
// Handles targeted modifications to an existing study plan.
// "change all history blocks to geography", "add essay at 8pm on weekdays",
// "remove CSAT block", "swap morning and evening blocks"

import { llmCall, parseJSONResponse } from "./llm.service.js";
import type { StudyBlock, StudyPlan } from "../models/types.js";

interface ScheduleUpdateResult {
  success: boolean;
  updatedPlan: {
    blocks: StudyBlock[];
    dayOverrides?: Record<number, StudyBlock[]> | null;
    scope: { type: string; description: string; reviewAt: string };
  } | null;
  changes: string; // human-readable summary of what changed
  reply: string;   // message to send to user
}

const UPDATE_SYSTEM_PROMPT = `You are a study schedule editor. You receive an existing UPSC study timetable and a modification request from the user.

Your job: apply the requested change to the existing schedule and return the FULL updated schedule.

RULES:
1. Only modify what the user asked. Don't reorganize or "improve" things they didn't mention.
2. Keep all unchanged blocks exactly as they are (same times, durations, subjects, emojis).
3. If the user says "change all X to Y", update every matching block.
4. If the user says "add X at Y time", insert a new block without removing existing ones (unless there's a conflict — then flag it).
5. If the user says "remove X", delete matching blocks.
6. If the user says "swap X and Y", exchange their time slots.
7. If ambiguous, describe what you'd do in "changes" and set success=false so the handler can ask for clarification.

SUBJECT MAPPING (use short form):
GS1, GS2, GS3, GS4, Essay, CSAT, Optional Subject, Current Affairs, Answer Writing
- polity/constitution/IR/governance → GS2
- history/geography/society/culture → GS1
- economy/environment/science/tech → GS3
- ethics/integrity/case studies → GS4
- newspaper/current affairs → Current Affairs
- answer writing/mains practice → Answer Writing
- CSAT/aptitude/reasoning → CSAT

EMOJI: study→📚, answer writing→✍️, CA/newspaper→📰, CSAT→🧮, essay→📝, default→📋

BLOCK FORMAT (use EXACTLY these field names):
{
  "title": "Study History",
  "subject": "GS1",
  "emoji": "📚",
  "startHour": 14,
  "startMinute": 0,
  "durationMinutes": 180
}

Do NOT use "time", "duration", or "task" — use "startHour", "startMinute", "durationMinutes", and "title".

Return ONLY valid JSON:
{
  "success": true | false,
  "updatedPlan": {
    "blocks": [ ... full updated block list ... ],
    "dayOverrides": { ... updated overrides or null ... },
    "scope": { "type": "...", "description": "...", "reviewAt": "..." }
  },
  "changes": "Human-readable summary: Changed 3 History blocks to Geography, updated subjects from GS1 to GS1",
  "reply": "Message to show the user about what changed"
}

If success=false (ambiguous request), set updatedPlan to null and explain in reply what clarification you need.`;

export async function applyScheduleUpdate(
  chatId: string,
  modificationRequest: string,
  currentPlan: StudyPlan,
): Promise<ScheduleUpdateResult> {
  // Build current plan description for the LLM
  const planDescription = formatPlanForLLM(currentPlan);

  const result = await llmCall({
    chatId,
    maxTokens: 2000,
    purpose: "schedule_update",
    system: UPDATE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `CURRENT SCHEDULE:\n${planDescription}\n\nMODIFICATION REQUEST: "${modificationRequest}"`,
      },
    ],
  });

  if (!result.budgetOk) {
    return {
      success: false,
      updatedPlan: null,
      changes: "",
      reply: "I'm temporarily unable to process this. Try again in a bit.",
    };
  }

  const parsed = parseJSONResponse(result.text);

  if (!parsed) {
    return {
      success: false,
      updatedPlan: null,
      changes: "",
      reply: "Couldn't process that change. Try being more specific, like \"change all polity blocks to geography\" or \"add essay writing at 8pm\".",
    };
  }

  return {
    success: parsed.success ?? false,
    updatedPlan: parsed.updatedPlan || null,
    changes: parsed.changes || "",
    reply: parsed.reply || "Schedule updated.",
  };
}

/**
 * Format the current plan into a readable string for the LLM.
 */
function formatPlanForLLM(plan: StudyPlan): string {
  const lines: string[] = [];

  lines.push(`Scope: ${plan.scope.type} — ${plan.scope.description}`);
  lines.push(`Review date: ${plan.scope.reviewAt}`);
  lines.push("");

  lines.push("DEFAULT DAILY BLOCKS:");
  for (const block of plan.blocks) {
    const time = `${block.startHour}:${String(block.startMinute).padStart(2, "0")}`;
    lines.push(
      `  ${time} | ${block.durationMinutes}min | ${block.title} | subject=${block.subject} | emoji=${block.emoji}`,
    );
  }

  if (plan.dayOverrides && Object.keys(plan.dayOverrides).length > 0) {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    lines.push("");
    lines.push("DAY OVERRIDES:");
    for (const [dayNum, blocks] of Object.entries(plan.dayOverrides)) {
      const dayName = dayNames[parseInt(dayNum)] || `Day ${dayNum}`;
      if ((blocks as StudyBlock[]).length === 0) {
        lines.push(`  ${dayName}: OFF (no blocks)`);
      } else {
        lines.push(`  ${dayName}:`);
        for (const block of blocks as StudyBlock[]) {
          const time = `${block.startHour}:${String(block.startMinute).padStart(2, "0")}`;
          lines.push(
            `    ${time} | ${block.durationMinutes}min | ${block.title} | subject=${block.subject} | emoji=${block.emoji}`,
          );
        }
      }
    }
  }

  return lines.join("\n");
}