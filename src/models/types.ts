import type { ObjectId } from "mongodb";

// ─── Projects ────────────────────────────────────────────────────────────────

export interface Project {
  _id?: ObjectId;
  userId: string;
  title: string;
  status: "active" | "completed";
  createdAt: Date;
}

// ─── Action Stations (Study Blocks) ──────────────────────────────────────────

export interface ActionStation {
  _id?: ObjectId;
  projectId: ObjectId;
  userId: ObjectId;
  title: string;
  subject: string | null;
  emoji?: string;
  status: "pending" | "in_progress" | "completed" | "partial" | "skipped";
  scheduledStart: Date;
  scheduledEnd: Date;
  estimatedMinutes: number;
  priority: number;
  isRecurring: boolean;
  recurrenceRule?: string;
  sourceBlockIndex?: number;
  createdAt: Date;
  completedAt?: Date;

  startReminderSent?: boolean;
  overdueReminderSent?: boolean;
  endReminderSent?: boolean;

  machineMetadata?: {
    resolvedState: string;
    snoozeCount: number;
    escalationTier: number;
    missReason: string | null;
    subject: string | null;
  };
}

// ─── UPSC Subjects ───────────────────────────────────────────────────────────

export const UPSC_SUBJECTS = [
  "GS1 (History/Geo/Society)",
  "GS2 (Polity/IR/Governance)",
  "GS3 (Economy/Env/S&T)",
  "GS4 (Ethics)",
  "Essay",
  "CSAT",
  "Optional Subject",
  "Current Affairs",
  "Answer Writing",
] as const;

export type UPSCSubject = (typeof UPSC_SUBJECTS)[number];

// ─── UPSC Profile ────────────────────────────────────────────────────────────

export interface UPSCProfile {
  targetYear: number;
  attemptNumber: number;
  optionalSubject: string | null;
  preparationMode: "coaching" | "self-study";
  weakSubjects: string[];
}

// ─── Study Plan ──────────────────────────────────────────────────────────────

export interface StudyBlock {
  title: string;
  subject: string | null;
  emoji: string;
  startHour: number;
  startMinute: number;
  durationMinutes: number;
}

export interface StudyPlan {
  blocks: StudyBlock[];
  dayOverrides?: Record<number, StudyBlock[]>;
  scope: {
    type: string;
    description: string;
    reviewAt: string;
  };
  rawInput: string;
  source: "text" | "photo";
  createdAt: string;
  updatedAt: string;
}

// ─── User Profile Blueprint ──────────────────────────────────────────────────
// Accumulated over time from conversations. The "living document" of the user.

export interface UserProfile {
  // Basics (collected naturally during conversation)
  name: string | null;
  strictnessLevel: 1 | 2;
  dailyReviewTime: string | null;    // "22:00" HH:MM
  wakeTime: string | null;           // "06:30" HH:MM — explicit or inferred

  // Study context (picked up from conversations over time)
  exam: string | null;               // "UPSC", "CAT", etc.
  optionalSubject: string | null;
  weakSubjects: string[];

  // Behavioral notes (AI-generated from conversations)
  notes: string[];                   // ["Takes Sundays off", "Struggles with Economy", "Night owl"]

  lastUpdated: Date;
}

// ─── User ────────────────────────────────────────────────────────────────────

export interface User {
  _id: ObjectId | string;
  name: string;
  telegramChatId: string;
  strictnessLevel: 1 | 2;
  dailyCheckInTime: string | null;
  weeklyReviewTime: string | null;
  wakeTime: string | null;           // NEW: explicit or inferred wake time
  sleepSchedule: {
    wakeHour: number;
    wakeMinute: number;
    sleepHour: number;
    sleepMinute: number;
  } | null;
  upscProfile: UPSCProfile | null;
  studyPlan: StudyPlan | null;
  profile: UserProfile;              // NEW: the living blueprint
  onboardingComplete: boolean;
  timezone: string;
  createdAt: Date;
}

// ─── Parsed Task (from natural language) ─────────────────────────────────────

export interface ParsedTask {
  title: string;
  hour: number;
  minute: number;
  durationMinutes: number;
  emoji: string;
  subject?: string;
}

// ─── Classifier types ────────────────────────────────────────────────────────

export type MessageCategory =
  | "task_or_schedule"
  | "schedule_set"
  | "schedule_update"
  | "conversation";

export interface ClassifierResult {
  category: MessageCategory;
  needs_llm: boolean;
  extracted: {
    name: string | null;
    review_time: string | null;
    strictness: 1 | 2 | null;
    wake_time: string | null;
  };
  quick_reply: string | null;
}

export interface TaskHandlerResult {
  type: "task_add" | "schedule_set" | "task_update" | "task_delete" | "clarify";
  tasks: Array<{
    title: string;
    subject: string | null;
    emoji: string;
    startHour: number | null;
    startMinute: number | null;
    durationMinutes: number;
    date: "today" | "tomorrow" | null;
  }> | null;
  schedule_raw: string | null;
  reply: string;
}

export interface ConversationHandlerResult {
  reply: string;
  user_note: string | null;
}