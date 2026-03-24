// src/utils/timezone.ts
// IST timezone helpers — ensures all time calculations are correct
// regardless of server timezone (UTC in Docker, IST locally, etc.)

const IST_TZ = "Asia/Kolkata";
const IST_OFFSET = "+05:30";

/**
 * Build a Date from IST hours/minutes, anchored to the same calendar day
 * as `baseDate` (in IST). This avoids the `setHours()` trap where the
 * server timezone != IST.
 *
 * Example: istDate(someDate, 15, 30) → always 3:30 PM IST that day
 */
export function istDate(
  baseDate: Date,
  hour: number,
  minute: number = 0,
): Date {
  // Get the YYYY-MM-DD of baseDate in IST
  const dateStr = baseDate.toLocaleDateString("en-CA", { timeZone: IST_TZ });
  const isoString = `${dateStr}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${IST_OFFSET}`;
  return new Date(isoString);
}

/**
 * Get the current hour and minute in IST.
 */
export function nowInIST() {
  const now = new Date();
  const istNow = new Date(
    now.toLocaleString("en-US", { timeZone: IST_TZ }),
  );
  return {
    date: now,
    hour: istNow.getHours(),
    minute: istNow.getMinutes(),
  };
}

/**
 * Get "today" at midnight in IST as a proper UTC Date.
 * Useful for date range queries.
 */
export function todayMidnightIST(): Date {
  return istDate(new Date(), 0, 0);
}

/**
 * Add days to a date (returns new Date).
 */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}


export function formatHourMin(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  return `${h}:${minute.toString().padStart(2, "0")} ${period}`;
}

export function formatTime(date: Date): string {
  return new Date(date).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

export function formatDateTime(date: Date): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}