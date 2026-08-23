const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { connect, close } = require("./src/db");
const { seedCourses } = require("./src/courses");
const { ingestMessage } = require("./src/pipeline");
const { dueThisWeek, needsConfirmation, listTasks, taskHistory } = require("./src/queries");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    message: "Student deadline agent",
    endpoints: [
      "POST /ingest { text, source?, received_at? }",
      "GET /tasks",
      "GET /tasks/due-this-week",
      "GET /tasks/needs-confirmation",
      "GET /tasks/:id/history",
      "POST /reset",
    ],
  });
});

app.post("/ingest", async (req, res) => {
  try {
    const { text, source, received_at } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text is required" });
    }
    const result = await ingestMessage({
      text,
      source: source || "api",
      receivedAt: received_at ? new Date(received_at) : new Date(),
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/tasks", async (_req, res) => {
  try {
    res.json(await listTasks());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/tasks/due-this-week", async (_req, res) => {
  try {
    res.json(await dueThisWeek());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/tasks/needs-confirmation", async (_req, res) => {
  try {
    res.json(await needsConfirmation());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/tasks/:id/history", async (req, res) => {
  try {
    const data = await taskHistory(req.params.id);
    if (!data) return res.status(404).json({ error: "not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/reset", async (_req, res) => {
  try {
    const db = await connect();
    await db.collection("messages").deleteMany({});
    await db.collection("task_versions").deleteMany({});
    await db.collection("tasks").deleteMany({});
    res.json({ ok: true, cleared: ["messages", "task_versions", "tasks"] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
  await connect();
  await seedCourses();
  app.listen(PORT, () => {
    console.log(`Deadline agent API on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await close();
  process.exit(0);
});
