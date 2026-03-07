import type { ObjectId } from "mongodb";

export interface Project {
  _id?: ObjectId;
  userId: string;
  title: string;
  status: "active" | "completed";
  createdAt: Date;
}

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
  // Default daily blocks
  blocks: StudyBlock[];

  // Day-specific overrides (0=Sun, 1=Mon, ..., 6=Sat)
  dayOverrides?: Record<number, StudyBlock[]>;

  // AI-inferred: what scope does this plan cover
  scope: {
    type: string; // "daily", "weekly", "monthly", "multi_month", "yearly" — AI decides
    description: string; // "Same schedule every day", "Weekly Mon-Sat with Sunday off", "3-month coaching plan (Mar-May)"
    reviewAt: string; // ISO date — when to ask user if plan needs updating
  };

  // Raw input preserved (so user can say "show me what I sent")
  rawInput: string; // text content or "photo" or "pdf"
  source: "text" | "photo";

  createdAt: string;
  updatedAt: string;
}

// ─── User ────────────────────────────────────────────────────────────────────

export interface User {
  _id: ObjectId | string;
  name: string;
  email?: string;
  telegramChatId: string;
  strictnessLevel: 1 | 2;
  dailyCheckInTime: string | null;
  weeklyReviewTime: string | null;
  sleepSchedule: {
    wakeHour: number;
    wakeMinute: number;
    sleepHour: number;
    sleepMinute: number;
  } | null;
  upscProfile: UPSCProfile | null;
  studyPlan: StudyPlan | null;
  onboardingComplete: boolean;
  timezone: string;
  createdAt: Date;
}

export interface ParsedTask {
  title: string;
  hour: number;
  minute: number;
  durationMinutes: number;
  emoji: string;
  subject?: string;
}
