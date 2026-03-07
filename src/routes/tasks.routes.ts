import { Router } from "express";
import { getDb } from "../db";
import type { ActionStation } from "../models/types";
import { ObjectId } from "mongodb";
import { scheduleTaskReminders } from "../services/task-scheduler.service";

const router = Router();

// router.post("/tasks", async (req, res) => {
//   const db = getDb();
//   const actionStations = db.collection("actionStations");

//   const task: ActionStation = {
//     userId: new ObjectId(req.body.userId),
//     projectId: new ObjectId(req.body.projectId),
//     title: req.body.title,
//     scheduledStart: new Date(req.body.scheduledStart),
//     scheduledEnd: new Date(req.body.scheduledEnd),
//     priority: req.body.priority,
//     status: "pending",
//     isRecurring: req.body.isRecurring || false,
//     recurrenceRule: req.body.recurrenceRule,
//     createdAt: new Date(),
//   };

//   const result = await actionStations.insertOne(task);

//   await scheduleTaskReminders(result.insertedId.toString(), task);

//   return res.json({ success: true, taskId: result.insertedId });
// });

router.put("/tasks/:id/complete", async (req, res) => {
  const db = getDb();
  const actionStations = db.collection("actionStations");

  await actionStations.updateOne(
    { _id: new ObjectId(req.params.id) },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
      },
    },
  );
  res.json({ success: true });
});

router.get("/tasks/today", async (req, res) => {
  const db = getDb();
  const actionStations = db.collection("actionStations");

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endOfDay = new Date(today);
  endOfDay.setHours(23, 59, 59, 999);

  const tasks = await actionStations
    .find<ActionStation>({
      userId: new ObjectId(req.body.userId),
      scheduledFor: { $gte: today, $lte: endOfDay },
    })
    .toArray();

  res.json({
    success: true,
    tasks,
  });
});

export default router;
