# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime & Tools

Use Bun instead of Node.js for all commands:
- `bun --watch src/index.ts` - Run dev server with hot reload
- `bun src/scripts/seed.ts` - Seed database with sample data
- `bun src/scripts/complete-tasks.ts` - Mark tasks as completed (utility script)
- `bun test` - Run tests

## Architecture Overview

This is a Telegram-based accountability scheduler bot with AI-powered task management and check-ins.

### Core Stack
- **Runtime**: Bun
- **Databases**: MongoDB (user data, tasks) + Redis (job queues, conversation state)
- **Job Queuing**: BullMQ with two queues:
  - `daily-checkIn` - Daily accountability check-ins
  - `task-reminders` - Start/overdue/end reminders for tasks
- **AI**: Anthropic Claude API (Haiku 4.5) for:
  - Natural language task parsing
  - Conversational task management
  - Adaptive accountability coaching (3 strictness levels)
- **Notifications**: Telegram Bot API

### Database Collections
- `users` - User profiles with sleep schedule, strictness level, onboarding state
- `actionStations` - Scheduled tasks with status tracking (pending/in_progress/completed/partial/skipped)
- `projects` - Task groupings (not heavily used currently)

### Key Services

**src/services/telegram.service.ts**
- Telegram bot initialization
- Registers all handlers (onboarding, commands, messages, callbacks)
- `sendTelegramMessage()` - Safe message sending with HTML parse fallback
- `parseTime()` - Natural language time parsing ("2pm", "14:00", etc.)

**src/services/conversation.service.ts**
- Stateful conversational AI for task management
- `processUserMessage()` - Main entry point, uses Claude API with history
- Handles 5 intent types: task_captured, task_updated, task_deleted, slot_confirmed/selected/rejected, not_a_task
- `getUserCurrentDayCycle()` / `getUserNextDayCycle()` - Handle custom sleep schedules (supports wake time after midnight)

**src/services/agent.service.ts**
- `generateAgentResponse()` - Daily check-in personality based on strictness level (1=gentle, 2=balanced, 3=tough-love)
- `parseTasksFromMessage()` - Legacy task parsing (being replaced by conversation.service.ts)

**src/services/conversation-state.service.ts**
- Redis-backed conversation history management
- Prevents context window overflow by summarizing old history

**src/services/task-scheduler.service.ts**
- Schedules BullMQ jobs for task reminders:
  - Start reminder: 5 minutes before task
  - Overdue reminder: 30 minutes after start
  - End reminder: at task end time

**src/services/checkin-scheduler.service.ts**
- `scheduleDailyCheckin()` - Creates recurring check-in jobs based on user's daily check-in time

### Workers (src/jobs/)

**daily-checkin.ts**
- Analyzes yesterday's task completion
- Generates AI-powered feedback using strictness level
- Sends Telegram message with results

**task-reminders.ts**
- Processes start/overdue/end reminders
- Sends Telegram notifications with inline buttons for quick status updates

### Telegram Handlers (src/services/telegram-handlers/)

**onboarding.handler.ts**
- `/start` - Initiates onboarding flow
- Collects: name, sleep schedule, check-in time, strictness level
- Uses callback queries for user selections

**command.handler.ts**
- `/today`, `/tomorrow` - Show scheduled tasks
- `/add` - Quick task addition
- `/update`, `/move` - Task modification
- `/delete`, `/cancel` - Task removal
- `/preferences` - Change settings

**message.handler.ts**
- Natural language task management (integrates conversation.service.ts)
- Maintains conversation state in Redis
- Handles task confirmations and slot selections

**callback.handler.ts**
- Processes inline button clicks
- Quick task status updates (completed, partial, skipped)
- Onboarding selections

### Important Patterns

1. **Time Handling**
   - All times in Asia/Kolkata timezone
   - "Today" and "tomorrow" relative to user's wake/sleep cycle, not calendar days
   - Tasks scheduled past midnight count as same "day" if before sleep time

2. **Task Scheduling Flow**
   - User message → conversation.service.ts extracts intent
   - If new task: suggest 2 time slots
   - User confirms → saveConfirmedTask() creates task
   - scheduleTaskReminders() queues 3 reminder jobs

3. **Conversation State**
   - History stored in Redis with TTL
   - Includes both user and assistant messages
   - Used to maintain context across interactions

4. **Environment Variables**
   - Uses dotenv (though Bun loads .env automatically)
   - Required: MONGODB_URI, REDIS_HOST/PORT, ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN

## Development Workflow

1. **Start infrastructure**: `docker compose up -d` (MongoDB + Redis)
2. **Run dev server**: `bun run dev` (watches src/index.ts)
3. **Seed test data**: `bun run seed`
4. **Debug endpoints**:
   - `POST /api/debug/trigger-checkin` - Manual check-in test
   - `GET /api/debug/jobs` - Inspect BullMQ delayed jobs

## Testing

Use `bun test` to run tests.
