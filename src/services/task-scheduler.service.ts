import { taskReminderQueue } from "../queue";

export async function scheduleTaskReminders(taskId: string, task: any) {
  const startTime = new Date(task.scheduledStart);
  const endTime = new Date(task.scheduledEnd);

  const startReminderTime = new Date(startTime.getTime() - 5 * 60 * 1000);

  if (startReminderTime > new Date()) {
    await taskReminderQueue.add(
      "start-reminder",
      { taskId, reminderType: "start" },
      { delay: startReminderTime.getTime() - Date.now() },
    );
    console.log(
      `📅 Start reminder scheduled for ${startReminderTime.toLocaleString()}`,
    );
  }

  const overdueReminderTime = new Date(startTime.getTime() + 30 * 60 * 1000);

  if (overdueReminderTime > new Date()) {
    await taskReminderQueue.add(
      "overdue-reminder",
      { taskId, reminderType: "overdue" },
      { delay: overdueReminderTime.getTime() - Date.now() },
    );
    console.log(
      `📅 Overdue reminder scheduled for ${overdueReminderTime.toLocaleString()}`,
    );
  }

  if (endTime > new Date()) {
    await taskReminderQueue.add(
      "end-reminder",
      { taskId, reminderType: "end" },
      { delay: endTime.getTime() - Date.now() },
    );
    console.log(`📅 End reminder scheduled for ${endTime.toLocaleString()}`);
  }
}
