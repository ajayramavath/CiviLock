import express from "express";
import type { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import tasksRouter from "./routes/tasks.routes";
import { connectDb, getDb } from "./db";
import { startDailyCheckInWorker } from "./jobs/daily-checkin";
import { startWeeklyCheckInWorker } from "./jobs/weekly-checkin";
import {
  dailyCheckInQueue,
  weeklyCheckInQueue,
  taskReminderQueue,
  connection,
} from "./queue";
import { ObjectId } from "mongodb";
import { startTaskReminderWorker } from "./jobs/task-reminders";
import {
  scheduleDailyCheckin,
  scheduleWeeklyCheckin,
} from "./services/checkin-scheduler.service";
import {
  startNightlySchedulerWorker,
  setupNightlyScheduler,
  nightlySchedulerQueue,
} from "./jobs/nightly-scheduler";
import {
  startMorningNudgeWorker,
  setupMorningNudge,
  morningNudgeQueue,
} from "./jobs/morning-nudge";
import {
  initMonitoring,
  setupExpressErrorHandler,
  alertStartup,
  alertShutdown,
} from "./services/monitoring.service";
import { initPostHog, shutdownPostHog } from "./services/posthog.service";

// ─── Bull-Board ──────────────────────────────────────────────────────────────
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
const app = express();
app.use(express.json());

// ─── Basic Auth Middleware for /admin routes ─────────────────────────────────

function adminAuth(req: Request, res: Response, next: NextFunction) {
  const expectedUser = process.env.ADMIN_USERNAME || "admin";
  const expectedPass = process.env.ADMIN_PASSWORD;

  if (!expectedPass) {
    res.status(403).json({ error: "Admin access not configured" });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="CiviLock Admin"');
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const base64 = authHeader.slice(6);
  const decoded = Buffer.from(base64, "base64").toString("utf-8");
  const [user, pass] = decoded.split(":");

  if (user === expectedUser && pass === expectedPass) {
    next();
    return;
  }

  res.set("WWW-Authenticate", 'Basic realm="CiviLock Admin"');
  res.status(401).json({ error: "Invalid credentials" });
}

// ─── Bull-Board Setup ─────────────────────────────────────────────────────────

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");

createBullBoard({
  queues: [
    new BullMQAdapter(dailyCheckInQueue),
    new BullMQAdapter(weeklyCheckInQueue),
    new BullMQAdapter(taskReminderQueue),
    new BullMQAdapter(nightlySchedulerQueue),
    new BullMQAdapter(morningNudgeQueue),
  ],
  serverAdapter,
});

app.use("/admin/queues", adminAuth, serverAdapter.getRouter());

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use("/api", tasksRouter);

// ─── Health Check ────────────────────────────────────────────────────────────

const startTime = Date.now();

app.get("/health", async (req, res) => {
  const uptimeMs = Date.now() - startTime;
  const uptimeHours = Math.floor(uptimeMs / 3600000);
  const uptimeMinutes = Math.floor((uptimeMs % 3600000) / 60000);

  let mongoStatus = "disconnected";
  try {
    const db = getDb();
    await db.command({ ping: 1 });
    mongoStatus = "connected";
  } catch { }

  let redisStatus = "disconnected";
  try {
    const pong = await connection.ping();
    redisStatus = pong === "PONG" ? "connected" : "error";
  } catch { }

  async function queueStats(queue: any) {
    try {
      const [waiting, active, failed, delayed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getFailedCount(),
        queue.getDelayedCount(),
      ]);
      return { waiting, active, failed, delayed, status: "ok" };
    } catch {
      return { status: "error" };
    }
  }

  const [dailyStats, weeklyStats, reminderStats, nightlyStats, morningStats] =
    await Promise.all([
      queueStats(dailyCheckInQueue),
      queueStats(weeklyCheckInQueue),
      queueStats(taskReminderQueue),
      queueStats(nightlySchedulerQueue),
      queueStats(morningNudgeQueue),
    ]);

  const overallStatus =
    mongoStatus === "connected" && redisStatus === "connected"
      ? "ok"
      : mongoStatus === "disconnected" && redisStatus === "disconnected"
        ? "down"
        : "degraded";

  res.json({
    status: overallStatus,
    uptime: `${uptimeHours}h ${uptimeMinutes}m`,
    serverTime: {
      utc: new Date().toISOString(),
      ist: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    },
    checks: {
      mongo: mongoStatus,
      redis: redisStatus,
    },
    queues: {
      "daily-checkIn": dailyStats,
      "weekly-checkIn": weeklyStats,
      "task-reminders": reminderStats,
      "nightly-scheduler": nightlyStats,
      "morning-nudge": morningStats,
    },
  });
});

// ─── Debug Routes ────────────────────────────────────────────────────────────

app.post("/api/debug/trigger-checkin", async (req, res) => {
  await dailyCheckInQueue.add("manual-test", {
    userId: "69935c2c4a523ed634512966",
  });
  res.json({ success: true });
});

app.get("/api/debug/jobs", async (req, res) => {
  const delayed = await taskReminderQueue.getDelayed();

  res.json({
    serverTime: {
      utc: new Date().toISOString(),
      ist: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      timestamp: Date.now(),
      timezone: process.env.TZ || "not set",
    },
    delayed: delayed.map((j) => {
      const processAt = j.timestamp + (j.opts.delay || 0);
      return {
        name: j.name,
        data: j.data,
        jobTimestamp: j.timestamp,
        delay: j.opts.delay,
        processAt_utc: new Date(processAt).toISOString(),
        processAt_ist: new Date(processAt).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
        }),
        msFromNow: processAt - Date.now(),
        minFromNow: Math.round((processAt - Date.now()) / 60000),
      };
    }),
  });
});

app.get("/debug-sentry", function mainHandler(req, res) {
  throw new Error("My first Sentry error!");
});

// ─── Startup ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const dbUrl = process.env.MONGODB_URI || "mongodb://localhost:27017/scheduler";

async function scheduleExistingUsers() {
  const db = getDb();

  const users = await db
    .collection("users")
    .find({ dailyCheckInTime: { $ne: null } })
    .toArray();

  console.log(`📅 Scheduling jobs for ${users.length} existing users...`);

  for (const user of users) {
    if (user.dailyCheckInTime) {
      await scheduleDailyCheckin(user._id, user.dailyCheckInTime);
      await scheduleWeeklyCheckin(user._id, user.dailyCheckInTime);
    }
    // Nightly blocks are now handled by the global hourly scheduler,
    // no per-user scheduling needed
  }
}

async function start() {
  initMonitoring();
  initPostHog();
  await connectDb(dbUrl);

  // Start all workers
  startDailyCheckInWorker();
  startWeeklyCheckInWorker();
  startTaskReminderWorker();
  startNightlySchedulerWorker();
  startMorningNudgeWorker();

  // Schedule recurring jobs
  await setupNightlyScheduler();
  await setupMorningNudge();

  // Schedule check-ins for existing users
  await scheduleExistingUsers();

  setupExpressErrorHandler(app);
  app.listen(PORT, () => {
    console.log(`listening on port ${PORT}`);
    console.log(`📊 Bull-Board: http://localhost:${PORT}/admin/queues`);
  });
  await alertStartup();
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  await shutdownPostHog();
  await alertShutdown("SIGTERM received");
  process.exit(0);
});
process.on("SIGINT", async () => {
  await shutdownPostHog();
  await alertShutdown("SIGINT received (Ctrl+C)");
  process.exit(0);
});

start();