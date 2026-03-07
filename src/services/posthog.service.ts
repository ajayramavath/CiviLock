// src/services/posthog.service.ts
import { PostHog } from "posthog-node";

let posthog: PostHog | null = null;

// ─── Initialize ──────────────────────────────────────────────────────────────

export function initPostHog() {
  const apiKey = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";

  if (!apiKey) {
    console.log("⚠️ POSTHOG_API_KEY not set — product analytics disabled");
    return;
  }

  posthog = new PostHog(apiKey, { host, flushAt: 10, flushInterval: 30000 });
  console.log("✅ PostHog initialized");
}

// ─── Track Event ─────────────────────────────────────────────────────────────

export function trackEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, any>,
) {
  if (!posthog) return;

  posthog.capture({
    distinctId,
    event,
    properties: {
      ...properties,
      source: "telegram_bot",
      timestamp: new Date().toISOString(),
    },
  });
}

// ─── Identify User ──────────────────────────────────────────────────────────

export function identifyUser(
  distinctId: string,
  properties: Record<string, any>,
) {
  if (!posthog) return;

  posthog.identify({
    distinctId,
    properties: {
      ...properties,
      source: "telegram_bot",
    },
  });
}

// ─── Shutdown ────────────────────────────────────────────────────────────────

export async function shutdownPostHog() {
  if (!posthog) return;
  await posthog.shutdown();
  console.log("✅ PostHog flushed and shut down");
}
