/**
 * agent.service.ts
 *
 * Two-tier agent architecture:
 *
 * Tier 1 (structured JSON, single call, ~$0.002):
 *   save_user_info, save_upsc_profile, create_task,
 *   create_multiple_tasks, delete_task, update_task
 *   → Model returns {"reply":"...", "actions":[...]}
 *   → We execute actions after sending reply
 *
 * Tier 2 (tool runner, multi-call, ~$0.005-0.008):
 *   save_schedule, update_schedule
 *   → Model needs to see parse result before responding
 *
 * No tools classified → plain chat, cheapest path (~$0.001)
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { anthropic, llmCall, parseJSONResponse } from "./llm.service";
import { trackAPIUsage } from "./rate-limiter.service";
import { buildUserStatus, buildScheduleContext } from "./user-status.service";
import { getHistory, appendToHistory } from "./conversation-state.service";
import { buildCheckInContext } from "./analytics.service.js";
import { nowInIST } from "../utils/timezone";
import { observeExchange } from "./openai.service";
import { getDb } from "../db";
import type { User } from "../models/types";
import type { ObjectId } from "mongodb";

import {
  createTask,
  createMultipleTasks,
  deleteTask,
  updateTask,
  saveSchedule,
  updateSchedule,
  saveUserInfo,
  saveUpscProfile,
  getRecentBehavioralNotes,
  type CreateTaskInput,
  type CreateMultipleTasksInput,
  type DeleteTaskInput,
  type UpdateTaskInput,
  type SaveScheduleInput,
  type UpdateScheduleInput,
  type SaveUserInfoInput,
  type SaveUpscProfileInput,
  deleteMultipleTasks,
  updateMultipleTasks,
  type DeleteMultipleTasksInput,
  type UpdateMultipleTasksInput,
} from "./agent-tools";

// ─── Tier Classification ──────────────────────────────────

const TIER2_TOOLS = new Set(["save_schedule", "update_schedule"]);

function getTier(toolNames: string[]): "none" | "tier1" | "tier2" {
  if (toolNames.length === 0) return "none";
  if (toolNames.some((t) => TIER2_TOOLS.has(t))) return "tier2";
  return "tier1";
}

// ─── Action Schema Descriptions (for Tier 1 JSON prompt) ──

const ACTION_SCHEMAS: Record<string, string> = {
  save_user_info: `{"tool":"save_user_info","field":"name|review_time|wake_time|strictness","value":"string (times in HH:MM 24h)"}`,
  save_upsc_profile: `{"tool":"save_upsc_profile","targetYear?":"2025","attemptNumber?":1,"optionalSubject?":"Sociology","preparationMode?":"full_time|working|college","weakSubjects?":["geography"]}`,
  create_task: `{"tool":"create_task","title":"string","subject?":"polity|history|geography|economy|science|environment|ethics|current_affairs|optional|general","emoji?":"📚","startHour":16,"startMinute?":0,"durationMinutes":120,"date?":"today|tomorrow|YYYY-MM-DD"}`,
  create_multiple_tasks: `{"tool":"create_multiple_tasks","tasks":[{"title":"string","startHour":16,"startMinute?":0,"durationMinutes":120,"subject?":"string","emoji?":"string"}],"date?":"today"}`,
  delete_task: `{"tool":"delete_task","taskId":"ObjectId from today's/tomorrow's tasks","identifier?":"polity (fuzzy match, fallback if no taskId)"}`,
  delete_multiple_tasks: `{"tool":"delete_multiple_tasks","taskIds":["ObjectId1","ObjectId2"]}`,
  update_task: `{"tool":"update_task","taskId":"ObjectId from today's/tomorrow's tasks","identifier?":"polity (fallback)","newHour?":16,"newMinute?":0,"newDate?":"tomorrow","newDuration?":90,"newTitle?":"Answer Writing","newSubject?":"Answer Writing","newEmoji?":"✍️"}`,
  update_multiple_tasks: `{"tool":"update_multiple_tasks","updates":[{"taskId":"ObjectId","newTitle?":"string","newSubject?":"string","newHour?":16,"newMinute?":0,"newDuration?":90,"newEmoji?":"string"}]}`,
};


function buildActionSchemaBlock(toolNames: string[]): string {
  const tier1Tools = toolNames.filter((t) => !TIER2_TOOLS.has(t));
  if (tier1Tools.length === 0) return "";

  const schemas = tier1Tools
    .filter((t) => t in ACTION_SCHEMAS)
    .map((t) => `  ${t}: ${ACTION_SCHEMAS[t]}`)
    .join("\n");

  return `
ACTIONS AVAILABLE (include in "actions" array if needed):
${schemas}

IMPORTANT:
- When user sends MULTIPLE tasks and it's UNCLEAR if one-time or daily, ASK first. Don't create yet.
- Only include actions you're confident about. No action needed = empty array.
- For times, convert to 24h IST (e.g. "4 pm" → 16, "11 pm" → 23).`;
}

// ─── Tier 2 Tool Definitions (for tool runner) ────────────

function buildTier2Tools(user: User, toolNames: string[]) {
  const tools: any[] = [];

  // ── Tier 2 tools (schedule) ──

  if (toolNames.includes("save_schedule")) {
    tools.push(
      betaTool({
        name: "save_schedule",
        description:
          "Save full recurring timetable. NOT for one-off tasks. Pass user's text exactly. User confirms before activation.",
        inputSchema: {
          type: "object" as const,
          properties: {
            rawText: {
              type: "string",
              description: "User's schedule text exactly as written",
            },
          },
          required: ["rawText"],
        },
        run: async (input) =>
          await saveSchedule(input as SaveScheduleInput, user),
      })
    );
  }

  if (toolNames.includes("update_schedule")) {
    tools.push(
      betaTool({
        name: "update_schedule",
        description: "Modify existing recurring schedule.",
        inputSchema: {
          type: "object" as const,
          properties: {
            modification: { type: "string" },
          },
          required: ["modification"],
        },
        run: async (input) =>
          await updateSchedule(input as UpdateScheduleInput, user),
      })
    );
  }

  // ── Tier 1 tools (also available in Tier 2 for mixed operations) ──

  if (toolNames.includes("create_task") || toolNames.includes("create_multiple_tasks")) {
    tools.push(
      betaTool({
        name: "create_task",
        description:
          "Create a single study task for today or tomorrow. Use for one-off tasks, not recurring schedules.",
        inputSchema: {
          type: "object" as const,
          properties: {
            title: { type: "string" },
            subject: { type: "string", description: "polity|history|geography|economy|science|environment|ethics|current_affairs|optional|general" },
            emoji: { type: "string" },
            startHour: { type: "number", description: "24h IST hour" },
            startMinute: { type: "number" },
            durationMinutes: { type: "number" },
            date: { type: "string", description: "today|tomorrow|YYYY-MM-DD" },
          },
          required: ["title", "startHour", "durationMinutes"],
        },
        run: async (input) =>
          await createTask(
            { ...input, startMinute: input.startMinute ?? 0, date: input.date || "today" } as CreateTaskInput,
            user
          ),
      })
    );

    tools.push(
      betaTool({
        name: "create_multiple_tasks",
        description:
          "Create multiple study tasks at once. Use for one-off tasks, not recurring schedules.",
        inputSchema: {
          type: "object" as const,
          properties: {
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  subject: { type: "string" },
                  emoji: { type: "string" },
                  startHour: { type: "number" },
                  startMinute: { type: "number" },
                  durationMinutes: { type: "number" },
                },
                required: ["title", "startHour", "durationMinutes"],
              },
            },
            date: { type: "string", description: "today|tomorrow|YYYY-MM-DD" },
          },
          required: ["tasks"],
        },
        run: async (input) =>
          await createMultipleTasks(
            {
              tasks: (input.tasks as any[]).map((t) => ({
                ...t,
                startMinute: t.startMinute ?? 0,
              })),
              date: input.date || "today",
            } as CreateMultipleTasksInput,
            user
          ),
      })
    );
  }

  if (toolNames.includes("delete_task") || toolNames.includes("delete_multiple_tasks")) {
    tools.push(
      betaTool({
        name: "delete_task",
        description:
          "Delete/cancel a task by ID or by name. Use to remove conflicting tasks before creating replacements.",
        inputSchema: {
          type: "object" as const,
          properties: {
            taskId: { type: "string", description: "Task ObjectId from TODAY'S TASKS list" },
            identifier: { type: "string", description: "Task name/subject to fuzzy match (fallback)" },
          },
        },
        run: async (input) =>
          await deleteTask(input as DeleteTaskInput, user),
      })
    );

    tools.push(
      betaTool({
        name: "delete_multiple_tasks",
        description:
          "Delete multiple tasks at once by their IDs.",
        inputSchema: {
          type: "object" as const,
          properties: {
            taskIds: {
              type: "array",
              items: { type: "string" },
              description: "Array of Task ObjectIds from TODAY'S TASKS list",
            },
          },
          required: ["taskIds"],
        },
        run: async (input) =>
          await deleteMultipleTasks(input as DeleteMultipleTasksInput, user),
      })
    );
  }

  if (toolNames.includes("update_task") || toolNames.includes("update_multiple_tasks")) {
    tools.push(
      betaTool({
        name: "update_task",
        description:
          "Update an existing task. Can change time, duration, title, subject, and emoji. Use taskId from TODAY'S TASKS list.",
        inputSchema: {
          type: "object" as const,
          properties: {
            taskId: { type: "string", description: "Task ObjectId from TODAY'S TASKS list" },
            identifier: { type: "string", description: "Task name/subject to fuzzy match (fallback)" },
            newHour: { type: "number", description: "New start hour (24h IST)" },
            newMinute: { type: "number" },
            newDate: { type: "string", description: "today|tomorrow|YYYY-MM-DD" },
            newDuration: { type: "number", description: "New duration in minutes" },
            newTitle: { type: "string", description: "New task title" },
            newSubject: { type: "string", description: "New subject tag" },
            newEmoji: { type: "string", description: "New emoji" },
          },
        },
        run: async (input) =>
          await updateTask(input as UpdateTaskInput, user),
      })
    );

    tools.push(
      betaTool({
        name: "update_multiple_tasks",
        description:
          "Update multiple tasks at once. Each update can change title, subject, time, duration, or emoji.",
        inputSchema: {
          type: "object" as const,
          properties: {
            updates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  taskId: { type: "string", description: "Task ObjectId" },
                  newTitle: { type: "string" },
                  newSubject: { type: "string" },
                  newHour: { type: "number" },
                  newMinute: { type: "number" },
                  newDuration: { type: "number" },
                  newEmoji: { type: "string" },
                },
                required: ["taskId"],
              },
            },
          },
          required: ["updates"],
        },
        run: async (input) =>
          await updateMultipleTasks(input as UpdateMultipleTasksInput, user),
      })
    );
  }

  if (toolNames.includes("save_user_info")) {
    tools.push(
      betaTool({
        name: "save_user_info",
        description:
          "Save or update user info: name, wake_time, review_time (same as check-in time), or strictness.",
        inputSchema: {
          type: "object" as const,
          properties: {
            field: {
              type: "string",
              enum: ["name", "review_time", "wake_time", "strictness"],
            },
            value: {
              type: "string",
              description: "Value to save. Times in HH:MM 24h format.",
            },
          },
          required: ["field", "value"],
        },
        run: async (input) =>
          await saveUserInfo(input as SaveUserInfoInput, user),
      })
    );
  }

  if (toolNames.includes("save_upsc_profile")) {
    tools.push(
      betaTool({
        name: "save_upsc_profile",
        description: "Save UPSC-specific profile details.",
        inputSchema: {
          type: "object" as const,
          properties: {
            targetYear: { type: "string" },
            attemptNumber: { type: "number" },
            optionalSubject: { type: "string" },
            preparationMode: { type: "string", enum: ["full_time", "working", "college"] },
            weakSubjects: { type: "array", items: { type: "string" } },
          },
        },
        run: async (input) =>
          await saveUpscProfile(input as SaveUpscProfileInput, user),
      })
    );
  }

  return tools;
}

// ─── System Prompt ────────────────────────────────────────

const L1_TONE = `TONE: Supportive but honest. Celebrate wins, gently call out misses. The friend who won't let them bullshit themselves.`;
const L2_TONE = `TONE: Strict, no excuses. "You said you'd do geography yesterday too." Push hard — mediocrity won't clear UPSC.`;

function buildSystemPrompt(
  statusBlock: string,
  scheduleContext: string,
  behavioralNotes: string,
  strictnessLevel: number,
  actionSchemaBlock: string,
  isJsonMode: boolean
): string {
  const now = nowInIST();
  const timeStr = now.date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit", minute: "2-digit", hour12: true,
    weekday: "short", day: "numeric", month: "short",
  });

  const tone = strictnessLevel === 2 ? L2_TONE : L1_TONE;

  // const prelimsDate = new Date("2025-05-25T00:00:00+05:30");
  // const daysLeft = Math.max(0, Math.ceil((prelimsDate.getTime() - now.date.getTime()) / 86400000));
  // const prelimsLine = daysLeft > 0 ? `⏳ ${daysLeft} days to Prelims.` : "";

  const notesSection = behavioralNotes ? `\nOBSERVATIONS:\n${behavioralNotes}` : "";

  const jsonInstruction = isJsonMode
    ? `\nRESPONSE FORMAT: Return ONLY valid JSON: {"reply":"your message","actions":[]}
- "reply" = your Telegram message to the user (required)
- "actions" = array of tool calls (can be empty)
- No markdown wrapping, no backticks, just raw JSON.`
    : "";

  return `CiviLock — UPSC accountability bot. You enforce study plans.

${statusBlock}

IST: ${timeStr}
${scheduleContext ? `\nTODAY:\n${scheduleContext}` : ""}${notesSection}

${tone}

RULES:
- Short responses. Under 25 words. Telegram, not email.
- ALWAYS reply conversationally after tool calls. Never go silent.
- 1 emoji max. No filler. Don't repeat what user said. Don't say "Got it!" or "Perfect!".
- If the user gives a bare number for time (e.g., "11", "12", "8") without AM/PM, ASK which they mean before saving. Do NOT assume AM or PM, UNLESS MENTIONED CLEARLY. Return no actions, just ask.
- Exception: wake times 5-9 are obviously AM. Review times after 8 are obviously PM. Only ask when genuinely ambiguous (10, 11, 12).
- When user asks about their "schedule" or "routine", answer from DAILY ROUTINE (recurring template) as the primary answer. Then mention today separately if it differs: "Your daily routine: [from template]. For today, you have: [from today's tasks]."
- For any schedule/task questions, ALWAYS answer from TODAY'S TASKS and DAILY ROUTINE shown above. NEVER use conversation history to answer what the user's schedule is — it may be outdated. The context above is the live database.
${jsonInstruction}
${actionSchemaBlock}

ONBOARDING (if status shows missing info):
- Priority: name → schedule → wake_time → review_time. One per exchange. Natural, not robotic.review and checkin are the same thing.
- UPSC details (attempt, optional, target year) → save_upsc_profile when mentioned
- ALWAYS steer toward getting a schedule. No schedule = no accountability. Push for it.
- When asking for schedule the FIRST TIME, give options:
  "Now let's set up what you're studying. You can:
  📸 Send a photo of your timetable
  📝 Type your full schedule (daily or weekly)
  ✅ Or just tell me one thing you're doing today — like 'polity 4-6pm'
  Whatever works for you.

TASK & SCHEDULE INTENT — ALWAYS CLARIFY, NEVER ASSUME:
When user sends tasks or a schedule, NEVER assume if it's recurring or one-off. ALWAYS ask and confirm.

A) User has NO studyPlan (first time):
   - User sends 1+ tasks with times → ASK: "Is this your daily routine, or just for today?"
   - User confirms "daily/routine/every day" → use save_schedule (recurring template)
   - User confirms "just today/one-time" → use create_task or create_multiple_tasks (one-off)
   - Do NOT create anything until user confirms intent.

B) User HAS a studyPlan (schedule exists):
   - Check TODAY's tasks in the schedule context for time conflicts.
   - If CONFLICTS exist: Tell user what conflicts. "Your schedule has [existing] at [time]. Want me to replace it in your routine, or is this just for today?"
     - "Replace/update routine" → delete conflicting today's tasks + use update_schedule to modify template
     - "Just today" → delete conflicting today's tasks + use create_task/create_multiple_tasks for one-off
   - If NO conflicts: "Want me to add this to your daily routine, or just for today?"
     - "Add to routine" → use update_schedule
     - "Just today" → use create_task/create_multiple_tasks
   - ALWAYS delete conflicting today's tasks before creating new ones at the same time. Use delete_task for each conflict, then create new ones. Multiple actions in one response is OK.

C) User CONFIRMS intent (follow-up message like "daily", "just today", "replace"):
   - NOW execute the actions. Return the full actions array.
   - For routine updates: include delete_task for conflicts + the schedule/task creation.
   - After task creation, tell them: "I'll remind you when it's time to start, and check in when it's done."

BE PROACTIVE:
- Tasks are running/pending? Reference them: "You've got polity in 30 min. Ready?"
- User is chatting without purpose for long? Steer back: "Good chat, but what about that economics block you've been dodging?"

ACCOUNTABILITY:
- Reference past behavior from observations when relevant
- Use their name. Match their language (Hinglish OK).
- Acknowledge emotions, then push: "I get you're tired. But you said the same Tuesday."`
}

// ─── Tier 1: Structured JSON Path ─────────────────────────

async function runTier1(
  chatId: number,
  userMessage: string,
  user: User,
  toolNames: string[],
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>
): Promise<AgentResult> {
  const result = await llmCall({
    chatId: chatId.toString(),
    model: "claude-haiku-4-5-20251001",
    maxTokens: 512,
    system: systemPrompt,
    messages: messages as Array<{ role: "user" | "assistant"; content: string }>,
    purpose: "agent_json",
  });

  const totalInputTokens = result.inputTokens || 0;
  const totalOutputTokens = result.outputTokens || 0;

  console.log("here");

  // Parse JSON response
  let responseText = "";
  const toolsUsed: string[] = [];
  const actionResults: string[] = [];

  try {
    // Try to parse as JSON
    const raw = result.text || "";
    const parsed = parseJSONResponse(raw) || JSON.parse(raw);
    responseText = parsed.reply || parsed.response || raw;
    const actions: any[] = parsed.actions || [];
    console.log(`[TIER1] Parsed actions:`, JSON.stringify(actions));

    // Execute actions
    for (const action of actions) {
      const tool = action.tool;
      toolsUsed.push(tool);

      try {
        let actionResult: string;

        switch (tool) {
          case "save_user_info":
            actionResult = await saveUserInfo(
              { field: action.field, value: action.value } as SaveUserInfoInput,
              user
            );
            break;

          case "save_upsc_profile":
            actionResult = await saveUpscProfile(action as SaveUpscProfileInput, user);
            break;

          case "create_task":
            actionResult = await createTask(
              {
                title: action.title,
                subject: action.subject,
                emoji: action.emoji,
                startHour: action.startHour,
                startMinute: action.startMinute ?? 0,
                durationMinutes: action.durationMinutes,
                date: action.date || "today",
              } as CreateTaskInput,
              user
            );
            break;

          case "create_multiple_tasks":
            actionResult = await createMultipleTasks(
              {
                tasks: action.tasks.map((t: any) => ({
                  title: t.title,
                  subject: t.subject,
                  emoji: t.emoji,
                  startHour: t.startHour,
                  startMinute: t.startMinute ?? 0,
                  durationMinutes: t.durationMinutes,
                })),
                date: action.date || "today",
              } as CreateMultipleTasksInput,
              user
            );
            break;

          case "delete_task":
            actionResult = await deleteTask(action as DeleteTaskInput, user);
            break;

          case "update_task":
            actionResult = await updateTask(action as UpdateTaskInput, user);
            break;

          case "delete_multiple_tasks":
            actionResult = await deleteMultipleTasks(action as DeleteMultipleTasksInput, user);
            break;

          case "update_multiple_tasks":
            actionResult = await updateMultipleTasks(action as UpdateMultipleTasksInput, user);
            break;

          default:
            actionResult = `Unknown tool: ${tool}`;
        }

        actionResults.push(actionResult);
      } catch (err: any) {
        console.error(`Action ${tool} failed:`, err.message);
        actionResults.push(`Failed: ${err.message}`);
      }
    }
  } catch {
    // Not valid JSON — treat entire response as plain text
    responseText = result.text || "What's on your mind?";
  }

  // If any actions failed, we could append a note — but for Tier 1
  // actions (save_user_info, create_task) failures are very rare.
  // Log them but don't bother the user unless it's a task creation failure.
  for (let i = 0; i < actionResults.length; i++) {

    if ((actionResults[i] as string).startsWith("Failed:") && toolsUsed[i]?.includes("task")) {
      responseText += "\n\n⚠️ Had trouble creating that task. Try again?";
      break;
    }
  }

  return {
    text: responseText,
    toolsUsed,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  };
}

// ─── Tier 2: Tool Runner Path ─────────────────────────────

async function runTier2(
  chatId: number,
  userMessage: string,
  user: User,
  toolNames: string[],
  systemPrompt: string,
  messages: Anthropic.MessageParam[]
): Promise<AgentResult> {
  const tools = buildTier2Tools(user, toolNames);
  const toolsUsed: string[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const runner = anthropic.beta.messages.toolRunner({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages,
    tools,
  });

  for await (const message of runner) {
    totalInputTokens += message.usage?.input_tokens || 0;
    totalOutputTokens += message.usage?.output_tokens || 0;
    for (const block of message.content) {
      if (block.type === "tool_use") toolsUsed.push(block.name);
    }
  }

  const finalMessage = await runner.done();
  const textBlocks = finalMessage.content.filter(
    (block): block is Anthropic.TextBlock => block.type === "text"
  );
  const responseText = textBlocks.map((b) => b.text).join("\n") || "Got it! What's next?";

  return {
    text: responseText,
    toolsUsed,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  };
}

// ─── Plain Chat Path (no tools) ───────────────────────────

async function runChat(
  chatId: number,
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>
): Promise<AgentResult> {
  const result = await llmCall({
    chatId: chatId.toString(),
    model: "claude-haiku-4-5-20251001",
    maxTokens: 512,
    system: systemPrompt,
    messages: messages as Array<{ role: "user" | "assistant"; content: string }>,
    purpose: "agent_chat",
  });

  return {
    text: result.text || "What's on your mind?",
    toolsUsed: [],
    inputTokens: result.inputTokens || 0,
    outputTokens: result.outputTokens || 0,
  };
}

// ─── Main Agent Entry Point ───────────────────────────────

export interface AgentResult {
  text: string;
  toolsUsed: string[];
  inputTokens: number;
  outputTokens: number;
  pendingScheduleId?: string;
}

export async function runAgent(
  chatId: number,
  userMessage: string,
  user: User,
  toolNames: string[] = []
): Promise<AgentResult> {
  // 1. Build context in parallel
  const [statusResult, scheduleContext, history, behavioralNotes] =
    await Promise.all([
      buildUserStatus(user),
      buildScheduleContext(user),
      getHistory(chatId.toString()),
      getRecentBehavioralNotes(user._id as ObjectId),
    ]);

  // 2. Determine tier
  const tier = toolNames.includes("__fallback__") ? "tier2" : getTier(toolNames);
  const isJsonMode = tier === "tier1";

  // 3. Build action schema block (only for Tier 1)
  const actionSchemaBlock = isJsonMode ? buildActionSchemaBlock(toolNames) : "";

  // 4. Build system prompt
  const systemPrompt = buildSystemPrompt(
    statusResult.block,
    scheduleContext,
    behavioralNotes,
    user.strictnessLevel || 1,
    actionSchemaBlock,
    isJsonMode
  );

  // 5. Build messages — last 10 from history + current
  const trimmedHistory = history.slice(-10);
  const messages = [
    ...trimmedHistory.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    })),
    { role: "user" as const, content: userMessage },
  ];

  // 6. Run appropriate tier
  let result: AgentResult;

  switch (tier) {
    case "tier1":
      console.log(`[AGENT] Tier 1 (JSON) | tools=${JSON.stringify(toolNames)}`);
      result = await runTier1(chatId, userMessage, user, toolNames, systemPrompt, messages);
      break;

    case "tier2":
      console.log(`[AGENT] Tier 2 (tool runner) | tools=${JSON.stringify(toolNames)}`);
      result = await runTier2(
        chatId, userMessage, user,
        toolNames.includes("__fallback__") ? ["save_schedule", "update_schedule"] : toolNames,
        systemPrompt,
        messages as Anthropic.MessageParam[]
      );
      break;

    default:
      console.log(`[AGENT] Chat (no tools)`);
      result = await runChat(chatId, systemPrompt, messages);
      break;
  }

  // 7. Detect pending schedule (Tier 2 save_schedule)
  if (result.toolsUsed.includes("save_schedule")) {
    const match = result.text.match(/SCHEDULE_PENDING:([a-f0-9]{24})/);
    result.pendingScheduleId = match?.[1] || (user._id as ObjectId).toString();
  }

  // 8. Save to history (trim agent response for storage)
  const trimmedResponse = result.text.length > 200
    ? result.text.slice(0, 200) + "..."
    : result.text;
  await appendToHistory(chatId.toString(), userMessage, trimmedResponse);

  // 9. Track API usage
  if (tier === "tier2") {
    await trackAPIUsage(
      chatId.toString(),
      "agent",
      result.inputTokens,
      result.outputTokens,
      "claude-haiku-4-5-20251001"
    );
  }

  // 10. Background observe (4o-mini)
  observeExchange(chatId.toString(), userMessage, result.text, user).catch(() => { });

  return result;
}

// ─── Daily Check-In Response ──────────────────────────────

export async function generateCheckInResponse(user: any): Promise<string> {
  const context = await buildCheckInContext(user._id, user);
  const level = user.strictnessLevel || 1;

  const systemPrompt = level === 1
    ? `Supportive UPSC study partner daily check-in. Celebrate wins, gently flag misses. Mention subjects by name. End with one actionable suggestion. Use their name. 3-4 sentences max.\n\n${context}`
    : `Strict UPSC mentor daily check-in. Hard facts first: X/Y completed. Compare to yesterday. Call out skipped subjects. If avoidance alerts, confront directly. Prelims countdown as pressure. End with one command. 3-5 sentences.\n\n${context}`;

  const result = await llmCall({
    chatId: user.telegramChatId,
    maxTokens: 300,
    messages: [{ role: "user", content: systemPrompt }],
    purpose: "check_in",
  });
  return result.text || "Check-in couldn't be generated. Use /today to see your progress.";
}

// ─── Weekly Check-In Response ─────────────────────────────

export async function generateWeeklyCheckInResponse(
  user: any,
  weeklyContext: string,
): Promise<string> {
  const level = user.strictnessLevel || 1;

  const systemPrompt = level === 1
    ? `Supportive weekly review. Lead with biggest win. Per-subject hours. Celebrate improvement. Flag subjects under 2h. One concrete goal for next week. Use their name. 4-6 sentences.\n\n${weeklyContext}`
    : `Strict weekly accountability review. Headline stat: completion %, total hours. Compare to last week. Call out worst subject. Label 3+ skips as avoidance. If below 75% hours, say it directly. One non-negotiable directive. 5-7 sentences.\n\n${weeklyContext}`;

  const result = await llmCall({
    chatId: user.telegramChatId,
    maxTokens: 300,
    messages: [{ role: "user", content: systemPrompt }],
    purpose: "weekly_check_in",
  });
  return result.text || "Weekly review couldn't be generated. Use /week to see your stats.";
}