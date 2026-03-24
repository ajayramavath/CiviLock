/**
 * openai.service.ts
 *
 * Lightweight 4o-mini calls for classification and behavioral observation.
 * These are too cheap to matter (~$0.00005/call) but save significant
 * cost by keeping tool schemas out of most Haiku agent calls.
 */

import OpenAI from "openai";
import { trackAPIUsage } from "./rate-limiter.service";
import { saveBehavioralNote } from "./agent-tools";
import type { User } from "../models/types";
import type { ChatMessage } from "./conversation-state.service";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = "gpt-4o-mini";

// ─── Tool Classifier ─────────────────────────────────────
// Given the user's message + recent history, returns which tools
// (if any) the agent needs. Empty array = pure conversation.

const CLASSIFIER_SYSTEM = `Given recent chat context and the latest message in a UPSC study accountability bot, return a JSON array of tools needed. Return [] if none needed.

Tools:
- create_task: user mentions a SINGLE task with specific time ("polity at 9am", "study history 4-6"). Also used when user confirms tasks are one-off/just for today.
- create_multiple_tasks: user mentions MULTIPLE tasks with times AND has confirmed they are one-off/just for today. NOT for first-time task messages without confirmation.
- delete_task: cancel/remove a task ("cancel polity", "delete the 9am block"). Also used by agent to remove conflicting tasks before creating new ones.
- update_task: reschedule or change duration of a SINGLE existing task ("move polity to 3pm", "make it 2 hours")
- save_schedule: user CONFIRMS their tasks are a daily/recurring routine. Triggers: "this is my daily schedule", "every day", "same schedule daily", "yes daily","yes", "make it my routine". NOT triggered by just listing tasks — only after user confirms recurrence.
- update_schedule: modify existing recurring schedule ("swap polity and history", "add ethics at 7pm", "replace geography with polity"). Used when user confirms changes should apply to their routine.
- save_user_info: sharing or UPDATING name, wake time, review/check-in time, or strictness preference. "Review" and "check-in" are the SAME thing (daily review time). Includes corrections like "change my review to 10 pm".
- save_upsc_profile: mentioning target year, attempt number, optional subject, prep mode, weak subjects
- delete_multiple_tasks: remove multiple tasks at once ("clear all my tasks today", "delete polity and history")
- update_multiple_tasks: change multiple tasks at once ("change all morning tasks to geography", "move everything 1 hour later")

CRITICAL: 
- USE ONLY THE TOOLS MENTIONED ABOVE. DO NOT RETURN ANY OTHER TOOLS. YOU CAN RETURN MULTIPLE TOOLS.
- Short answers to questions (numbers, "yes", "no", single words) are almost NEVER save_schedule, unless they are answers to questions about schedule/tasks.
- LOOK AT WHAT THE BOT JUST ASKED. If the bot asked for name, wake time, review time, or strictness → the user's reply is save_user_info, even if it's just a number like "12" or "7 am".
- If the bot asked about target year, attempt number, optional subject, prep mode, or weak subjects → save_upsc_profile.
- A bare number IS a valid answer. "12" after "what time for daily review?" = save_user_info. "2027" after "what's your target year?" = save_upsc_profile.
- If the user says "No" or corrects a previous bot action ("No 11 pm", "I meant midnight", "not AM, PM"), that's save_user_info — they're correcting a value the bot just saved wrong.
- "review time" and "check-in time" are the SAME field. Always use save_user_info for both.
- When user lists 3+ tasks BUT hasn't confirmed if recurring → return ["create_multiple_tasks"]. The agent will ask for clarification before executing.
- When user confirms "daily"/"routine"/"every day" in response to agent's question → return ["save_schedule"].
- Classifier CAN return multiple tools: ["delete_task", "create_multiple_tasks"] or ["delete_task", "update_schedule"] when the agent needs to clear conflicts and create new tasks.

Return [] for: greetings, venting, motivation, chitchat, acknowledgments, questions about UPSC, general conversation, emotional messages, status updates without actionable content.

Return ONLY a valid JSON array. Examples: ["create_task"] or ["save_user_info", "save_upsc_profile"] or ["create_task", "save_schedule"] or ["delete_task", "update_schedule"] or []`;

export async function classifyMessage(
  chatId: string,
  userMessage: string,
  recentHistory: ChatMessage[]
): Promise<string[]> {
  try {
    // Build minimal context: last 4 messages + current
    const historyContext = recentHistory
      .slice(-4)
      .map((m) => `${m.role === "user" ? "User" : "Bot"}: ${m.content}`)
      .join("\n");

    const prompt = historyContext
      ? `Recent context:\n${historyContext}\n\nLatest message: "${userMessage}"`
      : `Latest message: "${userMessage}"`;

    const response = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 60,
      temperature: 0,
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM },
        { role: "user", content: prompt },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim() || "[]";

    // Track usage
    const usage = response.usage;
    if (usage) {
      await trackAPIUsage(chatId, MODEL, usage.prompt_tokens, usage.completion_tokens, "classifier");
    }

    const VALID_TOOLS = new Set([
      "save_user_info", "save_upsc_profile", "create_task",
      "create_multiple_tasks", "delete_task", "delete_multiple_tasks",
      "update_task", "update_multiple_tasks",
      "save_schedule", "update_schedule"
    ]);

    // Parse JSON array
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const filteredActions = parsed.filter((a: any) => VALID_TOOLS.has(a));
        return filteredActions;
      };
    } catch {
      // If parsing fails, try to extract array from response
      const match = text.match(/\[.*\]/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch { }
      }
    }

    return [];
  } catch (err) {
    console.error("Classifier error:", err);
    // On failure, assume tools needed (safe fallback — costs more but doesn't break)
    return ["__fallback__"];
  }
}

// ─── Behavioral Observation ───────────────────────────────
// Fire-and-forget after each message. Decides if anything about
// this exchange is worth remembering about the user.

const OBSERVE_SYSTEM = `Analyze this UPSC aspirant exchange. If something is worth noting about their behavior, return JSON: {"note":"...","category":"..."}. If nothing notable, return: null

RULES:
- Notes MUST be under 15 words. Factual, not analytical.
- Return null for 80% of messages. Most exchanges are routine.
- Good: "sleeps 6am, wakes 3pm — night owl"
- Bad: "Aspirant maintains extreme night owl schedule that may impact..."

ALWAYS return null for:
- Greetings, acknowledgments (hi, ok, yes, sure, thanks)
- Confusion or short replies (??, what, huh)
- User simply answering a question you asked
- User confirming something (yes, same every day, correct)
- Routine task/schedule creation with no behavioral signal

ONLY note:
- Life context (job, family, living situation, sleep schedule)
- Avoidance patterns (skipping same subject repeatedly)
- Emotional states (stressed, tired, frustrated, excited)
- Broken promises (said they'd do X, didn't)
- Milestones (first full day completed, streak)
- Preferences (responds well to pressure, hates nagging)

Categories: study_pattern, avoidance, emotional, life_context, preference, milestone, accountability, insight`;

export async function observeExchange(
  chatId: string,
  userMessage: string,
  botResponse: string,
  user: User
): Promise<void> {
  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 60,
      temperature: 0,
      messages: [
        { role: "system", content: OBSERVE_SYSTEM },
        { role: "user", content: `User: ${userMessage}\nBot: ${botResponse}` },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim();

    // Track usage
    const usage = response.usage;
    if (usage) {
      await trackAPIUsage(chatId, MODEL, usage.prompt_tokens, usage.completion_tokens, "observe");
    }

    if (!text || text === "null" || text.toLowerCase().startsWith("null")) return;

    // Parse the note
    try {
      const parsed = JSON.parse(text);
      if (parsed?.note && parsed?.category) {
        await saveBehavioralNote(
          { note: parsed.note, category: parsed.category },
          user
        );
      }
    } catch {
      // Try extracting JSON from response
      const match = text.match(/\{.*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (parsed?.note && parsed?.category) {
            await saveBehavioralNote(
              { note: parsed.note, category: parsed.category },
              user
            );
          }
        } catch { }
      }
    }
  } catch {
    // Silent fail — observation is non-critical
  }
}