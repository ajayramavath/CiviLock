// src/services/telegram-handlers/timetable.handler.ts
import TelegramBot from "node-telegram-bot-api";
import { getDb } from "../../db.js";
import {
  parseSchedule,
  parseScheduleFromImage,
  saveStudyPlan,
  generateDailyBlocks,
  formatPlanForDisplay,
} from "../study-plan.service.js";
import type { StudyBlock } from "../../models/types.js";
import {
  getState,
  setState,
  clearState,
} from "../conversation-state.service.js";
import { trackEvent, identifyUser } from "../posthog.service.js";

// ─── Handle schedule messages during onboarding ──────────────────────────────

export async function handleTimetableMessage(
  bot: TelegramBot,
  msg: TelegramBot.Message,
): Promise<boolean> {
  const chatId = msg.chat.id;
  const state = await getState(chatId.toString());

  console.log(
    `[TT] handleTimetableMessage called | chatId=${chatId} | step=${state?.step} | hasText=${!!msg.text} | hasPhoto=${!!msg.photo?.length}`,
  );

  if (!state) {
    console.log(`[TT] No state found, returning false`);
    return false;
  }

  if (state.step === "onboarding_timetable_input") {
    if (msg.photo && msg.photo.length > 0) {
      console.log(
        `[TT] Routing to photo input | photoCount=${msg.photo.length}`,
      );
      return await handlePhotoInput(bot, chatId, msg, state);
    }
    if (msg.text) {
      console.log(
        `[TT] Routing to text input | textLength=${msg.text.length} | preview="${msg.text.substring(0, 80)}..."`,
      );
      return await handleTextInput(bot, chatId, msg.text, state);
    }
    console.log(`[TT] Message has neither text nor photo, returning false`);
    return false;
  }

  console.log(`[TT] Step "${state.step}" not handled by timetable handler`);
  return false;
}

// ─── Handle timetable callbacks ──────────────────────────────────────────────

export async function handleTimetableCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<boolean> {
  const data = query.data!;
  if (!data.startsWith("tt_")) return false;

  const chatId = query.message!.chat.id;
  const state = await getState(chatId.toString());

  console.log(
    `[TT] handleTimetableCallback | chatId=${chatId} | callback=${data} | hasState=${!!state}`,
  );

  if (!state) {
    console.log(`[TT] No state for callback, returning false`);
    return false;
  }

  await bot.answerCallbackQuery(query.id);

  if (data === "tt_confirm") {
    console.log(
      `[TT] Confirm pressed | hasParsedSchedule=${!!state.data?.parsedSchedule} | blockCount=${state.data?.parsedSchedule?.blocks?.length || 0}`,
    );

    const parsed = state.data?.parsedSchedule;
    if (!parsed) {
      console.log(`[TT] ERROR: No parsed schedule in state data`);
      await bot.sendMessage(
        chatId,
        "Something went wrong. Send your schedule again.",
      );
      return true;
    }

    const db = getDb();
    const user = await db
      .collection("users")
      .findOne({ telegramChatId: chatId.toString() });

    if (!user) {
      console.log(`[TT] ERROR: User not found for chatId=${chatId}`);
      return true;
    }

    const rawInput = state.data?.rawInput || "";
    const source = state.data?.inputSource || "text";

    console.log(
      `[TT] Saving study plan | userId=${user._id} | source=${source} | blocks=${parsed.blocks.length} | scope=${parsed.scope.type}`,
    );

    await saveStudyPlan(user._id, parsed, rawInput, source);

    console.log(`[TT] Study plan saved, generating daily blocks...`);

    const result = await generateDailyBlocks(user._id);

    console.log(`[TT] Daily blocks generated | created=${result.created}`);

    await finishOnboarding(bot, chatId, state, result.created);
    return true;
  }

  if (data === "tt_redo") {
    console.log(`[TT] Redo pressed, resetting to timetable input`);
    await setState(chatId.toString(), {
      ...state,
      step: "onboarding_timetable_input",
      data: { ...state.data, parsedSchedule: undefined },
    });
    await bot.sendMessage(
      chatId,
      `No problem. Send your schedule again — text or photo.`,
    );
    return true;
  }

  if (data === "tt_skip") {
    console.log(`[TT] Skip pressed, finishing onboarding without plan`);
    await finishOnboarding(bot, chatId, state);
    return true;
  }

  console.log(`[TT] Unhandled callback: ${data}`);
  return false;
}

// ─── Text input ──────────────────────────────────────────────────────────────

async function handleTextInput(
  bot: TelegramBot,
  chatId: number,
  text: string,
  state: any,
): Promise<boolean> {
  console.log(
    `[TT] handleTextInput | chatId=${chatId} | text="${text.substring(0, 100)}"`,
  );

  await bot.sendChatAction(chatId, "typing");

  const db = getDb();
  const user = await db
    .collection("users")
    .findOne({ telegramChatId: chatId.toString() });

  if (!user) {
    console.log(`[TT] ERROR: User not found in handleTextInput`);
    return true;
  }

  console.log(
    `[TT] Calling parseSchedule for user=${user.name} | optional=${user.upscProfile?.optionalSubject}`,
  );

  const startTime = Date.now();
  const parsed = await parseSchedule(text, user);
  const elapsed = Date.now() - startTime;

  console.log(
    `[TT] parseSchedule returned | elapsed=${elapsed}ms | blocks=${parsed.blocks.length} | scope=${parsed.scope.type} | description="${parsed.scope.description}"`,
  );

  if (parsed.blocks.length > 0) {
    console.log(`[TT] Parsed blocks:`);
    parsed.blocks.forEach((b, i) => {
      console.log(
        `  [${i}] ${b.startHour}:${String(b.startMinute).padStart(2, "0")} | ${b.durationMinutes}min | ${b.title} | subject=${b.subject} | emoji=${b.emoji}`,
      );
    });

    if (parsed.dayOverrides) {
      const overrideDays = Object.keys(parsed.dayOverrides);
      console.log(`[TT] Day overrides: ${overrideDays.join(", ")}`);
      overrideDays.forEach((day) => {
        const blocks = parsed.dayOverrides![parseInt(day)] || [];
        console.log(`  Day ${day}: ${blocks.length} blocks`);
      });
    }

    console.log(`[TT] Review date: ${parsed.scope.reviewAt}`);
  }

  if (parsed.blocks.length === 0) {
    console.log(`[TT] No blocks parsed — asking user to retry`);
    await bot.sendMessage(
      chatId,
      `Couldn't extract study blocks from that. Try something like:\n\n` +
      `<i>"6am newspaper, 9-12 polity, 2-5 pub ad, 7-8:30 answer writing, 9-10 revision"</i>\n\n` +
      `Or send a photo of your timetable.`,
      { parse_mode: "HTML" },
    );
    return true;
  }

  console.log(`[TT] Showing parsed schedule for confirmation`);
  await showParsedSchedule(bot, chatId, parsed, state, text, "text");
  return true;
}

// ─── Photo input ─────────────────────────────────────────────────────────────

async function handlePhotoInput(
  bot: TelegramBot,
  chatId: number,
  msg: TelegramBot.Message,
  state: any,
): Promise<boolean> {
  console.log(
    `[TT] handlePhotoInput | chatId=${chatId} | photoSizes=${msg.photo!.length}`,
  );

  await bot.sendChatAction(chatId, "typing");
  await bot.sendMessage(chatId, "📸 Reading your schedule...");

  const db = getDb();
  const user = await db
    .collection("users")
    .findOne({ telegramChatId: chatId.toString() });

  if (!user) {
    console.log(`[TT] ERROR: User not found in handlePhotoInput`);
    return true;
  }

  const photo = msg.photo![msg.photo!.length - 1];
  if (!photo) {
    console.log(`photo is telegram message is undefined: ${photo}`);
    return true;
  }
  console.log(
    `[TT] Using photo | fileId=${photo.file_id} | width=${photo.width} | height=${photo.height}`,
  );

  let file;
  try {
    file = await bot.getFile(photo.file_id);
    console.log(`[TT] Got file path: ${file.file_path}`);
  } catch (err: any) {
    console.log(`[TT] ERROR getting file: ${err.message}`);
    await bot.sendMessage(
      chatId,
      "Couldn't download the photo. Try again or type your schedule.",
    );
    return true;
  }

  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

  let base64: string;
  try {
    const response = await fetch(fileUrl);
    console.log(
      `[TT] Fetched photo | status=${response.status} | contentType=${response.headers.get("content-type")}`,
    );
    const buffer = await response.arrayBuffer();
    base64 = Buffer.from(buffer).toString("base64");
    console.log(`[TT] Base64 encoded | length=${base64.length} chars`);
  } catch (err: any) {
    console.log(`[TT] ERROR fetching photo: ${err.message}`);
    await bot.sendMessage(
      chatId,
      "Couldn't download the photo. Try again or type your schedule.",
    );
    return true;
  }

  const ext = file.file_path?.split(".").pop() || "jpeg";
  const mediaType =
    ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  console.log(`[TT] Media type: ${mediaType}`);

  console.log(`[TT] Calling parseScheduleFromImage...`);
  const startTime = Date.now();

  const parsed = await parseScheduleFromImage(
    base64,
    mediaType as "image/jpeg" | "image/png" | "image/webp",
    user,
  );

  const elapsed = Date.now() - startTime;
  console.log(
    `[TT] parseScheduleFromImage returned | elapsed=${elapsed}ms | blocks=${parsed.blocks.length} | scope=${parsed.scope.type}`,
  );

  if (parsed.blocks.length > 0) {
    console.log(`[TT] Parsed blocks from image:`);
    parsed.blocks.forEach((b, i) => {
      console.log(
        `  [${i}] ${b.startHour}:${String(b.startMinute).padStart(2, "0")} | ${b.durationMinutes}min | ${b.title} | subject=${b.subject}`,
      );
    });
  }

  if (parsed.blocks.length === 0) {
    console.log(`[TT] No blocks parsed from image`);
    await bot.sendMessage(
      chatId,
      `Couldn't read the schedule from that. Try a clearer photo, or just type it out.`,
    );
    return true;
  }

  console.log(`[TT] Showing parsed schedule from image for confirmation`);
  await showParsedSchedule(bot, chatId, parsed, state, "[photo]", "photo");
  return true;
}

// ─── Show parsed schedule for confirmation ───────────────────────────────────

async function showParsedSchedule(
  bot: TelegramBot,
  chatId: number,
  parsed: {
    blocks: StudyBlock[];
    dayOverrides?: Record<number, StudyBlock[]> | null;
    scope: { type: string; description: string; reviewAt: string };
  },
  state: any,
  rawInput: string,
  inputSource: "text" | "photo",
): Promise<void> {
  console.log(
    `[TT] showParsedSchedule | chatId=${chatId} | blocks=${parsed.blocks.length} | source=${inputSource} | scopeType=${parsed.scope.type}`,
  );

  await setState(chatId.toString(), {
    ...state,
    data: { ...state.data, parsedSchedule: parsed, rawInput, inputSource },
  });

  console.log(`[TT] State updated with parsedSchedule`);

  const totalMinutes = parsed.blocks.reduce((s, b) => s + b.durationMinutes, 0);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;

  let message = `📋 <b>Got it. Here's what I'll enforce:</b>\n\n`;

  for (const block of parsed.blocks) {
    const time = formatSlotTime(block.startHour, block.startMinute);
    const subject = block.subject ? ` [${block.subject}]` : "";
    message += `${block.emoji} <b>${time}</b> (${block.durationMinutes}min) — ${block.title}${subject}\n`;
  }

  message += `\n⏱ Total: ${hours}h${mins > 0 ? ` ${mins}min` : ""}`;
  message += `\n📅 <i>${parsed.scope.description}</i>`;

  if (parsed.dayOverrides && Object.keys(parsed.dayOverrides).length > 0) {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const customDays = Object.keys(parsed.dayOverrides)
      .map((d) => dayNames[parseInt(d)])
      .join(", ");
    message += `\n🔄 Different on: ${customDays}`;
  }

  const reviewDate = new Date(parsed.scope.reviewAt).toLocaleDateString(
    "en-IN",
  );
  message += `\n\nI'll check in on <b>${reviewDate}</b> to see if this needs updating.`;

  console.log(
    `[TT] Sending confirmation message | totalMinutes=${totalMinutes} | reviewAt=${parsed.scope.reviewAt}`,
  );

  await bot.sendMessage(chatId, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Lock it in", callback_data: "tt_confirm" },
          { text: "🔄 Let me redo", callback_data: "tt_redo" },
        ],
        [{ text: "⏭️ Skip for now", callback_data: "tt_skip" }],
      ],
    },
  });
}

// ─── Entry point — called from onboarding after strictness ───────────────────

export async function promptForSchedule(
  bot: TelegramBot,
  chatId: number,
  state: any,
): Promise<void> {
  console.log(
    `[TT] promptForSchedule | chatId=${chatId} | currentStep=${state?.step}`,
  );

  await setState(chatId.toString(), {
    ...state,
    step: "onboarding_timetable_input",
  });

  console.log(`[TT] State set to onboarding_timetable_input`);

  await bot.sendMessage(
    chatId,
    `📋 <b>Last step — your study schedule.</b>\n\n` +
    `This is what I enforce. Without it, I'm useless.\n\n` +
    `Send me your timetable however you have it:\n\n` +
    `📝 Type it: <i>"9-12 polity, 2-5 optional, 7-8 CA"</i>\n` +
    `📸 Photo: handwritten, coaching app screenshot, anything\n` +
    `📅 Weekly: <i>"Mon: polity+geo, Tue: economy+optional..."</i>\n\n` +
    `Whatever format. I'll figure it out.`,
    { parse_mode: "HTML" },
  );
}

// ─── Finish onboarding ──────────────────────────────────────────────────────

async function finishOnboarding(
  bot: TelegramBot,
  chatId: number,
  state: any,
  blocksCreated?: number,
): Promise<void> {
  console.log(
    `[TT] finishOnboarding | chatId=${chatId} | blocksCreated=${blocksCreated}`,
  );

  const db = getDb();
  const user = await db
    .collection("users")
    .findOne({ telegramChatId: chatId.toString() });

  if (!user) {
    console.log(`[TT] ERROR: User not found in finishOnboarding`);
    return;
  }

  const { scheduleDailyCheckin, scheduleWeeklyCheckin } =
    await import("../checkin-scheduler.service.js");
  const { scheduleNightlyBlocks } =
    await import("../../jobs/nightly-scheduler.js");

  await db
    .collection("users")
    .updateOne({ _id: user._id }, { $set: { onboardingComplete: true } });

  console.log(`[TT] User marked onboardingComplete=true | userId=${user._id}`);

  trackEvent(chatId.toString(), "onboarding_completed", {
    strictnessLevel: user.strictnessLevel,
    targetYear: user.upscProfile?.targetYear,
    attemptNumber: user.upscProfile?.attemptNumber,
    optionalSubject: user.upscProfile?.optionalSubject,
    blocksCreated: blocksCreated || 0,
  });
  identifyUser(chatId.toString(), {
    name: user.name,
    onboardingComplete: true,
    strictnessLevel: user.strictnessLevel,
    targetYear: user.upscProfile?.targetYear,
  });

  await scheduleDailyCheckin(user._id, user.dailyCheckInTime);
  await scheduleWeeklyCheckin(user._id, user.dailyCheckInTime);
  console.log(`[TT] Daily + weekly checkin scheduled at ${user.dailyCheckInTime}`);

  if (user.sleepSchedule) {
    await scheduleNightlyBlocks(
      user._id,
      user.sleepSchedule.sleepHour,
      user.sleepSchedule.sleepMinute ?? 0,
    );
    console.log(`[TT] Nightly block scheduler set (30 min before sleep)`);
  }

  await clearState(chatId.toString());
  console.log(`[TT] Conversation state cleared`);

  const upsc = user.upscProfile;
  const days = upsc ? daysUntilPrelims(upsc.targetYear) : null;
  const levelName =
    user.strictnessLevel === 2 ? "Strict Mentor 🔥" : "Study Partner 📖";

  let message = `✅ <b>You're all set, ${user.name}!</b>\n\n`;

  if (upsc) {
    message +=
      `🎯 Prelims ${upsc.targetYear}${days !== null ? ` (${days} days)` : ""}\n` +
      `📝 Attempt #${upsc.attemptNumber} · ${upsc.optionalSubject || "No optional"}\n` +
      `🔥 ${levelName}\n`;
  }

  if (blocksCreated && blocksCreated > 0) {
    message += `\n📅 <b>${blocksCreated} study blocks scheduled for tomorrow!</b>\n`;
  } else if (!user.studyPlan) {
    message += `\n📋 No schedule yet — send it anytime or use /plan.\n`;
  }

  message +=
    `\n<b>How it works:</b>\n` +
    `• Every night I schedule tomorrow from your plan\n` +
    `• 5 min before each block → reminder\n` +
    `• I track completions, flag when you're falling behind\n` +
    `• When your plan needs updating, I'll tell you\n\n` +
    `/today — today's blocks\n` +
    `/plan — manually tweak tomorrow\n` +
    `/week — weekly breakdown\n` +
    `/mytimetable — view current plan\n` +
    `/updateplan — send new schedule\n\n`;

  if (days !== null) {
    message += `<b>${days} days. Let's go.</b>`;
  } else {
    message += `<b>Let's go.</b>`;
  }

  console.log(`[TT] Sending onboarding complete message to ${user.name}`);
  await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
  console.log(`[TT] ✅ Onboarding complete for ${user.name}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysUntilPrelims(targetYear: number): number {
  const may = new Date(targetYear, 4, 31);
  const dayOfWeek = may.getDay();
  const lastSunday = new Date(may);
  lastSunday.setDate(may.getDate() - dayOfWeek);
  const diff = lastSunday.getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

function formatSlotTime(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  return `${h}:${minute.toString().padStart(2, "0")} ${period}`;
}
