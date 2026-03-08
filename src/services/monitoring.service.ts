// src/services/monitoring.service.ts
import * as Sentry from "@sentry/node";
import type { Express, Request, Response, NextFunction } from "express";
import { adminBot } from "./telegram.service.js";

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// ─── Severity levels ────────────────────────────────────────────────────────

type Severity = "critical" | "warning" | "info";

const QUEUE_SEVERITY: Record<string, Severity> = {
  "nightly-scheduler": "critical",
  "daily-checkIn": "critical",
  "weekly-checkIn": "warning",
  "task-reminders": "warning",
};

// ─── Initialize Sentry + Global Error Handlers ──────────────────────────────

export function initMonitoring() {
  const dsn = process.env.SENTRY_DSN;

  if (dsn) {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || "development",
      tracesSampleRate: 0.2,
      beforeSend(event) {
        // Strip PII from breadcrumbs if needed
        return event;
      },
    });
    console.log("✅ Sentry initialized");
  } else {
    console.log("⚠️ SENTRY_DSN not set — error tracking disabled");
  }

  // Global uncaught exception handler
  process.on("uncaughtException", (err) => {
    console.error("💥 Uncaught Exception:", err);
    Sentry.captureException(err, {
      tags: { type: "uncaught_exception" },
    });
    alertAdmin(
      "critical",
      "Uncaught Exception",
      err.message,
      { stack: err.stack?.slice(0, 500) },
    );
    // Flush Sentry before crash
    Sentry.close(2000).then(() => process.exit(1));
  });

  // Global unhandled rejection handler
  process.on("unhandledRejection", (reason: any) => {
    const message = reason?.message || String(reason);
    console.error("💥 Unhandled Rejection:", message);
    Sentry.captureException(reason instanceof Error ? reason : new Error(message), {
      tags: { type: "unhandled_rejection" },
    });
    alertAdmin("warning", "Unhandled Rejection", message);
  });
}

// ─── Express Error Handler (must be called AFTER all routes) ─────────────────

export function setupExpressErrorHandler(app: Express) {
  // Sentry's official Express error handler — captures the error and forwards it
  Sentry.setupExpressErrorHandler(app);

  // Our custom error handler — sends Telegram alerts + returns 500
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    console.error(`❌ [Express] ${req.method} ${req.path} — ${err.message}`);

    Sentry.captureException(err, {
      tags: { type: "express_route" },
      extra: {
        method: req.method,
        path: req.path,
        query: req.query,
      },
    });

    alertAdmin("warning", "Express Route Error", err.message, {
      route: `${req.method} ${req.path}`,
      stack: err.stack?.split("\n").slice(0, 3).join(" → "),
    });

    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  });
}

// ─── Job Error Capture ──────────────────────────────────────────────────────

export function captureJobError(
  queueName: string,
  job: any,
  err: Error,
) {
  const userId = job?.data?.userId || "unknown";
  const attemptsMade = job?.attemptsMade || 0;
  const maxAttempts = job?.opts?.attempts || 3;
  const isFinalAttempt = attemptsMade >= maxAttempts;

  // Always log
  console.error(
    `❌ [${queueName}] Job failed | userId=${userId} | attempt=${attemptsMade}/${maxAttempts} | ${err.message}`,
  );

  // Send to Sentry with context
  Sentry.captureException(err, {
    tags: {
      queue: queueName,
      severity: QUEUE_SEVERITY[queueName] || "warning",
      final_attempt: String(isFinalAttempt),
    },
    extra: {
      userId,
      jobId: job?.id,
      jobName: job?.name,
      jobData: job?.data,
      attemptsMade,
      maxAttempts,
    },
  });

  // Telegram alert on final attempt OR critical queues
  const severity = QUEUE_SEVERITY[queueName] || "warning";
  if (isFinalAttempt || severity === "critical") {
    alertAdmin(severity, `Job Failed — ${queueName}`, err.message, {
      userId,
      attempt: `${attemptsMade}/${maxAttempts}`,
      final: isFinalAttempt ? "YES ⚠️" : "no (will retry)",
    });
  }
}

// ─── Message Handler Error Capture ──────────────────────────────────────────

export function captureMessageError(
  context: string,
  chatId: number | string,
  err: Error,
  extra?: Record<string, any>,
) {
  console.error(
    `❌ [${context}] Message error | chatId=${chatId} | ${err.message}`,
  );

  Sentry.captureException(err, {
    tags: {
      type: "message_handler",
      context,
    },
    extra: {
      chatId: String(chatId),
      ...extra,
    },
  });

  alertAdmin("warning", `Message Error — ${context}`, err.message, {
    chatId: String(chatId),
    ...extra,
  });
}

// ─── Telegram Admin Alerts ──────────────────────────────────────────────────

export async function alertAdmin(
  severity: Severity,
  title: string,
  message: string,
  details?: Record<string, any>,
): Promise<void> {
  if (!ADMIN_CHAT_ID) {
    console.log(`[ALERT] No ADMIN_CHAT_ID set — ${severity}: ${title}`);
    return;
  }

  const icon = severity === "critical" ? "🔴" : severity === "warning" ? "🟡" : "ℹ️";
  const time = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  let text = `${icon} <b>${title}</b>\n\n`;
  text += `<b>Error:</b> <code>${escapeHtml(message.slice(0, 500))}</code>\n`;

  if (details) {
    for (const [key, value] of Object.entries(details)) {
      text += `<b>${key}:</b> <code>${escapeHtml(String(value).slice(0, 200))}</code>\n`;
    }
  }

  text += `\n<i>${time} IST</i>`;

  try {
    await adminBot.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: "HTML" });
  } catch (sendErr: any) {
    // Don't let alert failures cascade
    console.error(`❌ Failed to send admin alert: ${sendErr.message}`);
  }
}

// ─── Startup / Shutdown Alerts ──────────────────────────────────────────────

export async function alertStartup() {
  await alertAdmin("info", "Bot Started ✅", "All workers initialized", {
    time: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    env: process.env.NODE_ENV || "development",
  });
}

export async function alertShutdown(reason: string) {
  await alertAdmin("warning", "Bot Shutting Down", reason);
  await Sentry.close(2000);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
