import { createMachine, assign } from "xstate";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TaskMachineContext {
  taskId: string;
  userId: string;
  chatId: string;
  title: string;
  subject: string | null; // UPSC subject tag (e.g., "Polity", "Geography")
  level: 1 | 2; // 1 = Study Partner, 2 = Strict Mentor
  scheduledStart: string; // ISO string (serializable for Redis)
  scheduledEnd: string;
  estimatedMinutes: number;
  snoozeCount: number;
  escalationTier: number;
  missReason: string | null;
}

export type TaskMachineEvent =
  | { type: "PRE_TASK_WINDOW" }
  | { type: "START_TIME_REACHED" }
  | { type: "OVERDUE_THRESHOLD" }
  | { type: "END_TIME_REACHED" }
  | { type: "SILENCE_TIMEOUT" }
  | { type: "USER_CONFIRMED" }
  | { type: "USER_SNOOZED" }
  | { type: "USER_COMPLETED" }
  | { type: "USER_PARTIAL" }
  | { type: "USER_SKIPPED" }
  | { type: "REASON_PROVIDED"; reason: string }
  | { type: "SNOOZE_EXPIRED" }
  | { type: "NEXT_ESCALATION" };

// ─── Machine Definition ──────────────────────────────────────────────────────

export const taskLifecycleMachine = createMachine(
  {
    id: "taskLifecycle",
    initial: "scheduled",
    context: {} as TaskMachineContext,
    types: {
      context: {} as TaskMachineContext,
      events: {} as TaskMachineEvent,
    },

    states: {
      // ── Task exists, waiting for pre-task window ──────────────────────
      scheduled: {
        on: {
          PRE_TASK_WINDOW: { target: "preTask" },
          START_TIME_REACHED: { target: "active" },
          OVERDUE_THRESHOLD: { target: "active.overdue" },
          END_TIME_REACHED: { target: "endTimeCheckIn" },
          // User can complete/skip before the task even starts
          USER_COMPLETED: { target: "resolved.completed" },
          USER_SKIPPED: { target: "resolved.skippedByUser" },
        },
      },

      // ── Pre-task reminder phase ───────────────────────────────────────
      preTask: {
        entry: ["sendPreTaskReminder", "scheduleSilenceTimeout"],
        on: {
          USER_SNOOZED: {
            target: "preTask",
            actions: assign({
              snoozeCount: ({ context }) => context.snoozeCount + 1,
            }),
            // Re-entering preTask re-fires entry actions (new reminder)
            reenter: true,
          },
          USER_CONFIRMED: { target: "awaitingStart" },
          USER_SKIPPED: { target: "resolved.skippedByUser" },
          USER_COMPLETED: { target: "resolved.completed" },
          START_TIME_REACHED: { target: "active" },
          OVERDUE_THRESHOLD: { target: "active.overdue" },
          END_TIME_REACHED: { target: "endTimeCheckIn" },
          // Silence in preTask — just move to awaiting start
          SILENCE_TIMEOUT: { target: "awaitingStart" },
        },
      },

      // ── Waiting for start time after preTask is done ──────────────────
      awaitingStart: {
        on: {
          START_TIME_REACHED: { target: "active" },
          OVERDUE_THRESHOLD: { target: "active.overdue" },
          END_TIME_REACHED: { target: "endTimeCheckIn" },
          USER_COMPLETED: { target: "resolved.completed" },
          USER_SKIPPED: { target: "resolved.skippedByUser" },
        },
      },

      // ── Task should be happening now ──────────────────────────────────
      active: {
        initial: "onTime",
        // These transitions work from ANY active sub-state
        on: {
          USER_COMPLETED: { target: "resolved.completed" },
          USER_PARTIAL: { target: "resolved.partial" },
          USER_SKIPPED: [
            { target: "resolutionRequired", guard: "isLevel2" },
            { target: "resolved.skippedByUser" },
          ],
          USER_CONFIRMED: { target: ".onTime" },
          END_TIME_REACHED: { target: "#taskLifecycle.endTimeCheckIn" },
        },
        states: {
          onTime: {
            on: {
              OVERDUE_THRESHOLD: { target: "overdue" },
            },
          },
          overdue: {
            entry: ["sendOverdueReminder", "scheduleSilenceTimeout"],
            on: {
              NEXT_ESCALATION: {
                target: "escalating",
                guard: "hasMoreEscalations",
              },
              SILENCE_TIMEOUT: [
                {
                  target: "escalating",
                  guard: "hasMoreEscalations",
                },
                // No more escalations — Level 1 auto-resolves on silence
                {
                  target: "#taskLifecycle.resolved.missedNoResponse",
                  guard: "isLevel1",
                },
                // Level 2 wants a reason
                {
                  target: "#taskLifecycle.resolutionRequired",
                },
              ],
            },
          },
          escalating: {
            entry: [
              "sendEscalationMessage",
              "incrementEscalation",
              "scheduleSilenceTimeout",
            ],
            on: {
              NEXT_ESCALATION: {
                target: "escalating",
                guard: "hasMoreEscalations",
                reenter: true,
              },
              SILENCE_TIMEOUT: [
                {
                  target: "escalating",
                  guard: "hasMoreEscalations",
                  reenter: true,
                },
                {
                  target: "#taskLifecycle.resolved.missedNoResponse",
                  guard: "isLevel1",
                },
                {
                  target: "#taskLifecycle.resolutionRequired",
                },
              ],
            },
          },
        },
      },

      // ── End time reached — ask how it went ───────────────────────────
      endTimeCheckIn: {
        entry: ["sendEndTimeCheckIn", "scheduleSilenceTimeout"],
        on: {
          USER_COMPLETED: { target: "resolved.completed" },
          USER_PARTIAL: { target: "resolved.partial" },
          USER_SKIPPED: [
            { target: "resolutionRequired", guard: "isLevel2" },
            { target: "resolved.skippedByUser" },
          ],
          SILENCE_TIMEOUT: [
            { target: "resolutionRequired", guard: "isLevel2" },
            { target: "resolved.endTimeAutoComplete" },
          ],
        },
      },

      // ── Task needs closure (Level 2) ──────────────────────────────────
      resolutionRequired: {
        entry: ["sendReasonRequest", "scheduleSilenceTimeout"],
        on: {
          REASON_PROVIDED: {
            target: "resolved.skippedWithReason",
            actions: assign({
              missReason: ({ event }) => event.reason,
            }),
          },
          USER_COMPLETED: { target: "resolved.completed" },
          USER_PARTIAL: { target: "resolved.partial" },
          // If they go silent even on the reason request
          SILENCE_TIMEOUT: { target: "resolved.missedNoResponse" },
        },
      },

      // ── Terminal states ────────────────────────────────────────────────
      resolved: {
        initial: "completed",
        entry: ["emitAnalyticsEvent", "cleanupMachine"],
        states: {
          completed: { type: "final" },
          partial: { type: "final" },
          skippedByUser: { type: "final" },
          skippedWithReason: { type: "final" },
          missedNoResponse: { type: "final" },
          endTimeAutoComplete: { type: "final" },
        },
      },
    },
  },
  {
    guards: {
      isLevel1: ({ context }) => context.level === 1,
      isLevel2: ({ context }) => context.level === 2,
      hasMoreEscalations: ({ context }) => {
        const maxTiers: Record<number, number> = { 1: 0, 2: 2 };
        return context.escalationTier < (maxTiers[context.level] ?? 0);
      },
    },
    actions: {
      incrementEscalation: assign({
        escalationTier: ({ context }) => context.escalationTier + 1,
      }),

      // ── These are placeholder names ──────────────────────────────────
      // Actual implementations are in task-machine-effects.ts
      // They get called from task-machine.service.ts AFTER the transition
      // We define them here so XState doesn't complain about unknown actions

      sendPreTaskReminder: () => {
        /* handled externally */
      },
      sendOverdueReminder: () => {
        /* handled externally */
      },
      sendEscalationMessage: () => {
        /* handled externally */
      },
      sendReasonRequest: () => {
        /* handled externally */
      },
      scheduleSilenceTimeout: () => {
        /* handled externally */
      },
      sendEndTimeCheckIn: () => {
        /* handled externally */
      },
      emitAnalyticsEvent: () => {
        /* handled externally */
      },
      cleanupMachine: () => {
        /* handled externally */
      },
    },
  },
);

// ─── Helper: Get a readable state string from snapshot ───────────────────────

export function getStateString(
  snapshotValue: string | Record<string, any>,
): string {
  if (typeof snapshotValue === "string") return snapshotValue;

  const keys = Object.keys(snapshotValue);
  if (keys.length === 0) return "unknown";

  const parent = keys[0] as string;
  const child = snapshotValue[parent];

  if (typeof child === "string") return `${parent}.${child}`;
  if (typeof child === "object" && child !== null) {
    const childKeys = Object.keys(child);
    if (childKeys.length > 0) {
      return `${parent}.${childKeys[0]}.${child[childKeys[0] as string]}`;
    }
  }
  return parent;
}
