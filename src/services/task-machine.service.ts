import { createActor } from "xstate";
import {
  taskLifecycleMachine,
  getStateString,
  type TaskMachineContext,
  type TaskMachineEvent,
} from "../machines/task-lifecycle.machine.js";
import { executeEffects } from "./task-machine-effects.js";
import { connection, taskReminderQueue } from "../queue.js";

const MACHINE_PREFIX = "machine:";
const MACHINE_TTL = 60 * 60 * 24; // 24 hours

// ─── Create a new machine for a task ─────────────────────────────────────────

export async function createTaskMachine(
  task: {
    _id: string;
    userId: string;
    title: string;
    subject?: string | null;
    scheduledStart: Date;
    scheduledEnd: Date;
    estimatedMinutes?: number;
  },
  user: {
    telegramChatId: string;
    strictnessLevel: number;
  },
): Promise<void> {
  const context: TaskMachineContext = {
    taskId: task._id,
    userId: task.userId,
    chatId: user.telegramChatId,
    title: task.title,
    subject: task.subject ?? null,
    level: (user.strictnessLevel === 2 ? 2 : 1) as 1 | 2,
    scheduledStart: task.scheduledStart.toISOString(),
    scheduledEnd: task.scheduledEnd.toISOString(),
    estimatedMinutes: task.estimatedMinutes ?? 60,
    snoozeCount: 0,
    escalationTier: 0,
    missReason: null,
  };

  // Create actor with initial context
  const actor = createActor(taskLifecycleMachine, {
    input: context,
    snapshot: taskLifecycleMachine.resolveState({
      value: "scheduled",
      context,
    }),
  });

  actor.start();
  const snapshot = actor.getPersistedSnapshot();
  actor.stop();

  await connection.set(
    `${MACHINE_PREFIX}${task._id}`,
    JSON.stringify(snapshot),
    "EX",
    MACHINE_TTL,
  );

  // Schedule all timed events via BullMQ
  await scheduleTimedEvents(task._id, task.scheduledStart, task.scheduledEnd);

  console.log(`🤖 State machine created for task: ${task.title}`);
}

// ─── Send an event to an existing machine ────────────────────────────────────

export async function sendMachineEvent(
  taskId: string,
  event: TaskMachineEvent,
): Promise<{
  previousState: string;
  newState: string;
  context: TaskMachineContext;
} | null> {
  const key = `${MACHINE_PREFIX}${taskId}`;

  // Load from Redis
  const saved = await connection.get(key);
  if (!saved) {
    console.warn(`⚠️ No machine found for task: ${taskId}`);
    return null;
  }

  const snapshot = JSON.parse(saved);
  const previousState = getStateString(snapshot.value);

  // Check if already in final state
  if (previousState.startsWith("resolved")) {
    console.log(`⏭️ Machine already resolved for task: ${taskId}`);
    return null;
  }

  // Cancel any pending silence timeout when user responds
  if (event.type.startsWith("USER_")) {
    await cancelSilenceTimeout(taskId);
  }

  if (event.type === "USER_SNOOZED") {
    const lastSnoozeKey = `snooze-cooldown:${taskId}`;
    const recent = await connection.get(lastSnoozeKey);
    if (recent) {
      console.log(`⏭️ Snooze cooldown active for task: ${taskId}`);
      return null;
    }
    await connection.set(lastSnoozeKey, "1", "EX", 30);
  }

  // Rehydrate, send event, capture new state
  const actor = createActor(taskLifecycleMachine, { snapshot });
  actor.start();
  actor.send(event);

  const newSnapshot = actor.getPersistedSnapshot();
  const newSnapshotState = actor.getSnapshot();
  const newState = getStateString(newSnapshotState.value);
  const context = newSnapshotState.context;

  actor.stop();

  // Persist updated state
  if (newState.startsWith("resolved")) {
    // Final state — clean up after effects run
    await connection.set(key, JSON.stringify(newSnapshot), "EX", 60); // short TTL for cleanup
  } else {
    await connection.set(key, JSON.stringify(newSnapshot), "EX", MACHINE_TTL);
  }

  console.log(
    `🔄 [${context.title}] ${previousState} → ${newState} (event: ${event.type})`,
  );

  // Execute side effects based on transition
  await executeEffects(taskId, previousState, newState, context, event);

  return { previousState, newState, context };
}

// ─── Schedule timed BullMQ events ────────────────────────────────────────────

async function scheduleTimedEvents(
  taskId: string,
  scheduledStart: Date,
  scheduledEnd: Date,
): Promise<void> {
  const now = Date.now();

  // Pre-task window: 5 minutes before start
  const preTaskTime = scheduledStart.getTime() - 5 * 60 * 1000;
  if (preTaskTime > now) {
    await taskReminderQueue.add(
      "state-event",
      { taskId, event: { type: "PRE_TASK_WINDOW" } },
      { delay: preTaskTime - now, jobId: `pre-task-${taskId}` },
    );
    console.log(`  📅 PRE_TASK_WINDOW at ${new Date(preTaskTime).toLocaleString()}`);
  } else if (scheduledStart.getTime() > now) {
    // We are already inside the 5-min pre-task window! Fire it immediately.
    await taskReminderQueue.add(
      "state-event",
      { taskId, event: { type: "PRE_TASK_WINDOW" } },
      { delay: 0, jobId: `pre-task-${taskId}` },
    );
    console.log(`  📅 PRE_TASK_WINDOW fired immediately (already in window)`);
  }

  // Start time reached
  const overdueTime = scheduledStart.getTime() + 30 * 60 * 1000;
  if (scheduledStart.getTime() > now) {
    await taskReminderQueue.add(
      "state-event",
      { taskId, event: { type: "START_TIME_REACHED" } },
      { delay: scheduledStart.getTime() - now, jobId: `start-${taskId}` },
    );
    console.log(`  📅 START_TIME_REACHED at ${scheduledStart.toLocaleString()}`);
  } else if (overdueTime > now) {
    // We are already running the task! Fire start event immediately.
    await taskReminderQueue.add(
      "state-event",
      { taskId, event: { type: "START_TIME_REACHED" } },
      { delay: 0, jobId: `start-${taskId}` },
    );
    console.log(`  📅 START_TIME_REACHED fired immediately (already running)`);
  }

  // Overdue threshold: 30 minutes after start
  const scheduledEndMs = scheduledEnd.getTime();
  if (overdueTime > now) {
    await taskReminderQueue.add(
      "state-event",
      { taskId, event: { type: "OVERDUE_THRESHOLD" } },
      { delay: overdueTime - now, jobId: `overdue-${taskId}` },
    );
    console.log(`  📅 OVERDUE_THRESHOLD at ${new Date(overdueTime).toLocaleString()}`);
  } else if (scheduledEndMs > now) {
    // We are already overdue! Fire overdue event immediately.
    await taskReminderQueue.add(
      "state-event",
      { taskId, event: { type: "OVERDUE_THRESHOLD" } },
      { delay: 0, jobId: `overdue-${taskId}` },
    );
    console.log(`  📅 OVERDUE_THRESHOLD fired immediately (already overdue)`);
  }

  // End time reached
  if (scheduledEndMs > now) {
    await taskReminderQueue.add(
      "state-event",
      { taskId, event: { type: "END_TIME_REACHED" } },
      { delay: scheduledEndMs - now, jobId: `end-${taskId}` },
    );
    console.log(`  📅 END_TIME_REACHED at ${scheduledEnd.toLocaleString()}`);
  } else {
    // Task is completely in the past. Fire end time.
    await taskReminderQueue.add(
      "state-event",
      { taskId, event: { type: "END_TIME_REACHED" } },
      { delay: 0, jobId: `end-${taskId}` },
    );
    console.log(`  📅 END_TIME_REACHED fired immediately (task already ended)`);
  }
}

// ─── Silence timeout management ──────────────────────────────────────────────

export async function scheduleSilenceTimeout(
  taskId: string,
  level: 1 | 2,
): Promise<void> {
  // Cancel any existing silence timeout first
  await cancelSilenceTimeout(taskId);

  const delays: Record<number, number> = {
    1: 30 * 60 * 1000, // 30 min for Study Partner
    2: 15 * 60 * 1000, // 15 min for Strict Mentor
  };

  await taskReminderQueue.add(
    "state-event",
    { taskId, event: { type: "SILENCE_TIMEOUT" } },
    {
      delay: delays[level] ?? 30 * 60 * 1000,
      jobId: `silence-${taskId}`,
    },
  );
}

export async function cancelSilenceTimeout(taskId: string): Promise<void> {
  try {
    const job = await taskReminderQueue.getJob(`silence-${taskId}`);
    if (job) {
      await job.remove();
      console.log(`  🔇 Cancelled silence timeout for ${taskId}`);
    }
  } catch (e) {
    // Job may have already been processed — that's fine
  }
}

// ─── Cancel all pending jobs for a task ──────────────────────────────────────

export async function cancelAllTaskJobs(taskId: string): Promise<void> {
  const jobIds = [
    `pre-task-${taskId}`,
    `start-${taskId}`,
    `overdue-${taskId}`,
    `end-${taskId}`,
    `silence-${taskId}`,
  ];

  for (const jobId of jobIds) {
    try {
      const job = await taskReminderQueue.getJob(jobId);
      if (job) {
        await job.remove();
      }
    } catch (e) {
      // Job may not exist or already processed
    }
  }
  console.log(`  🧹 Cleaned up all jobs for task: ${taskId}`);
}
