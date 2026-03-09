# CiviLock — Feature List

> Accountability bot for competitive exam aspirants. Currently deployed for UPSC, designed to be exam-agnostic.

---

## Onboarding
- Name, wake/sleep schedule capture
- Exam profile — target year, attempt number, optional subject, weak subjects
- Strictness level — Study Partner (gentle) or Strict Mentor (confrontational)
- Schedule capture — text or photo of timetable, AI-parsed into study blocks

## Study Plan Management
- AI-powered schedule parsing from text or photo (handles any format)
- Weekly plans with day-specific overrides (e.g., different Sunday schedule)
- Plan scope detection — daily, weekly, monthly, multi-month
- Auto-scheduled plan review when scope expires

## Daily Auto-Scheduling
- Every night (30 min before sleep), tomorrow's study blocks auto-generated from saved plan
- User receives a summary of next day's schedule with block count and total hours
- State machine instance created per block with timed reminders

## Smart Reminders (State Machine)
- 5-minute pre-task reminder with snooze/skip buttons
- Overdue nudge if task not started
- Two strictness behaviors from the same system:

### Level 1 — Study Partner
- Simple reminder → one overdue nudge → backs off on silence
- End-of-task check-in → auto-completes on 30 min silence
- Max 2 chase messages per task

### Level 2 — Strict Mentor
- Soft confirmation ("Planning to start?") with commitment button
- 2-tier escalation on silence ("Still planning?" → "Even 15 min counts")
- 3+ snooze avoidance flag
- Mandatory reason collection on skip (ran out of time / low energy / avoided / got busy)
- End-of-task check-in with mandatory response

## Completion Tracking
- Mark blocks as completed, partial, or skipped
- Per-task resolution stored with metadata (snooze count, escalation tier, miss reason)
- Silence events tracked per block

## Daily Check-In
- AI-generated end-of-day summary (tone matches strictness level)
- Per-subject hourly breakdown — hours scheduled, completed, skipped
- Yesterday vs today comparison
- Avoidance alerts surfaced
- Silence callout for Level 2 ("You went silent during 2 blocks today")

## Weekly Check-In (Every Sunday)
- AI-generated weekly accountability review at user's check-in time
- Full subject-wise hourly breakdown — completed / scheduled / skipped per subject
- Week-over-week completion rate trend
- Avoidance alerts — subjects skipped 3+ times called out
- Weak subject monitoring — flags subjects with < 1h study all week
- L1 tone: celebratory, goal-oriented ("Try 3h on Economy this week")
- L2 tone: confrontational, data-driven ("This is avoidance, not bad luck")

## Weekly Summary (`/week`)
- Subject-wise hours — completed / scheduled / skipped per subject
- Overall completion rate with week-over-week trend
- Current streak tracking
- Avoidance alerts — subjects skipped 3+ times flagged
- Weak subject monitoring — flags weak subjects with < 1h study

## Exam Countdown
- Days until exam shown in interactions and check-ins
- Used as motivational pressure (Level 2) or context (Level 1)

## Natural Language Task Management
- Add tasks via natural language ("polity at 2pm for 2 hours")
- AI suggests time slots based on existing schedule
- Update or delete tasks conversationally

## Analytics
- Task resolution events written to analytics collection
- Per-task metadata: snooze count, escalation tier, miss reason, subject
- Powers daily/weekly insights and avoidance detection

## Commands
| Command | Description |
|---|---|
| `/start` | Begin onboarding |
| `/today` | View today's study blocks |
| `/plan` | Manually plan tomorrow |
| `/week` | Weekly subject-wise breakdown |
| `/complete` | Mark a task complete |
| `/strictness` | Switch between Study Partner / Strict Mentor |
| `/help` | All commands |

## Rate Limiting & Cost Control
- Per-user message rate limit (30/hour)
- Message length and photo size validation
- Centralized LLM service — all AI calls routed through a single layer
- Per-call token and cost tracking (stored in MongoDB)
- Monthly global API budget cap with fast Redis-based check
- Per-user, per-day, and global usage queries for monitoring
- Cost breakdown by purpose (conversation, schedule parse, check-in, etc.)

## Monitoring & Error Alerting
- Sentry integration for all errors (jobs, message handling, Express routes)
- Per-job error capture with user context, retry count, and severity classification
- Telegram admin alerts — instant notification on critical failures
- Express error middleware — catches route handler crashes
- Message + callback handler error tracking
- Startup/shutdown alerts to admin channel
- Global uncaughtException and unhandledRejection handlers
- Bull-Board queue dashboard (`/admin/queues`) with basic auth
- Health endpoint (`/health`) — checks MongoDB, Redis, and all queue statuses

## Product Analytics (PostHog)
- 15+ tracked events across onboarding, tasks, check-ins, and commands
- Onboarding funnel — drop-off tracking at each step
- Task lifecycle — reminder_sent → interacted vs silent → completed/skipped
- Per-subject completion tracking with escalation events
- Daily + weekly check-in delivery tracking
- Command usage analytics (/today, /week, /plan, etc.)
- User identification with UPSC profile properties for cohort analysis

## Technical Foundation
- Telegram Bot API (user bot + dedicated admin bot for alerts)
- XState state machines (one per task) persisted in Redis
- BullMQ job queues for timed events and scheduled jobs
- MongoDB Atlas for users, tasks, study plans, analytics
- Redis container for state machines, job queues, and rate limiting
- Anthropic Claude API for NLP and coaching tone
- Centralized LLM service with automatic usage tracking
- Per-user job scheduling (not global crons)
- IST-aware timezone utilities — all scheduling correct regardless of server TZ
- PostHog SDK for product analytics

## Deployment
- DigitalOcean Droplet — 2GB RAM / 1 CPU / 50GB SSD
- MongoDB Atlas — 512MB shared cluster
- Docker Compose — bot + Redis container
- Dockerfile based on `oven/bun:1`
- `.dockerignore` for clean builds

---

*Last updated: 2026-03-08*
