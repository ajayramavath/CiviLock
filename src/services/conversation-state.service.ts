// src/services/conversation-state.service.ts
import Redis from "ioredis";

const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const STATE_TTL_SECONDS = 2 * 60 * 60;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationState {
  step: // Onboarding - basics
    | "onboarding_name"
    | "onboarding_wake"
    | "onboarding_sleep"
    // Onboarding - UPSC profile
    | "onboarding_target_year"
    | "onboarding_attempt"
    | "onboarding_optional_subject"
    | "onboarding_prep_mode"
    | "onboarding_weak_subjects"
    | "onboarding_strictness"
    // Onboarding - timetable capture
    | "onboarding_timetable_input"
    // Active states
    | "chatting"
    | "idle";
  history: ChatMessage[];
  data?: any;
  updatedAt: number;
}

const MAX_HISTORY = 10;

export async function getState(
  chatId: string,
): Promise<ConversationState | null> {
  try {
    const raw = await redis.get(`conv:${chatId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function appendToHistory(
  chatId: string,
  userMessage: string,
  assistantResponse: string,
) {
  const state = (await getState(chatId)) ?? {
    step: "chatting" as const,
    history: [],
  };

  const history: ChatMessage[] = [
    ...state.history,
    { role: "user", content: userMessage },
    { role: "assistant", content: assistantResponse },
  ];

  const trimmed = history.slice(-MAX_HISTORY);

  await setState(chatId, {
    ...state,
    step: "chatting",
    history: trimmed,
  });
}

export async function clearHistory(chatId: string) {
  const state = await getState(chatId);
  if (!state) return;

  await setState(chatId, {
    ...state,
    step: "idle",
    history: [],
  });
}

export async function setState(
  chatId: string,
  state: Omit<ConversationState, "updatedAt">,
) {
  const full: ConversationState = { ...state, updatedAt: Date.now() };
  await redis.setex(`conv:${chatId}`, STATE_TTL_SECONDS, JSON.stringify(full));
}

export async function clearState(chatId: string) {
  await redis.del(`conv:${chatId}`);
}
