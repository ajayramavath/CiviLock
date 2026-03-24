// src/services/conversation-state.service.ts
// Simplified: just stores conversation history in Redis.
// No more onboarding step machine — the classifier handles routing.

import Redis from "ioredis";

const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const MAX_HISTORY = 20;                  // store last 20 messages (10 exchanges)

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationState {
  history: ChatMessage[];
  data?: Record<string, any>;  // temporary storage (e.g., pending schedule confirmation)
  updatedAt: number;
}

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
  const state = (await getState(chatId)) ?? { history: [] };

  const history: ChatMessage[] = [
    ...state.history,
    { role: "user", content: userMessage },
    { role: "assistant", content: assistantResponse },
  ];

  await setState(chatId, { history });
}

export async function clearHistory(chatId: string) {
  await setState(chatId, { history: [] });
}

export async function getHistory(chatId: string): Promise<ChatMessage[]> {
  const state = await getState(chatId);
  const fullHistory = state?.history || [];
  // Only send the last MAX_HISTORY messages to avoid context pile-up
  return fullHistory.slice(-MAX_HISTORY);
}

export async function getFullHistory(chatId: string): Promise<ChatMessage[]> {
  const state = await getState(chatId);
  return state?.history || [];
}

export async function setState(
  chatId: string,
  state: Omit<ConversationState, "updatedAt">,
) {
  const full: ConversationState = { ...state, updatedAt: Date.now() };
  await redis.set(`conv:${chatId}`, JSON.stringify(full));
}

export async function clearState(chatId: string) {
  await redis.del(`conv:${chatId}`);
}