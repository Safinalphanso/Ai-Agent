const { connect, oid } = require("./db");
const { formatDate } = require("./courses");
const { formatTaskRow, formatDueDisplay } = require("./format");

async function dueThisWeek(fromDate = new Date()) {
  const db = await connect();
  const start = startOfDay(fromDate);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);

  const tasks = await db
    .collection("tasks")
    .find({
      due_date: { $gte: start, $lte: end },
    })
    .sort({ due_date: 1 })
    .toArray();

  return hydrateTasks(db, tasks);
}

async function needsConfirmation() {
  const db = await connect();
  const tasks = await db
    .collection("tasks")
    .find({ status: "needs_confirmation" })
    .sort({ updated_at: -1 })
    .toArray();

  const hydrated = await hydrateTasks(db, tasks);

  // Attach distinct due dates claimed in versions so both sides of a conflict show
  for (const t of hydrated) {
    const versions = await db
      .collection("task_versions")
      .find({ task_id: oid(t.id) })
      .sort({ created_at: 1 })
      .toArray();
    const claimed = [
      ...new Set(
        versions
          .map((v) => (v.due_date ? formatDate(v.due_date) : null))
          .filter(Boolean)
      ),
    ];
    t.claimed_due_dates = claimed;
    if (claimed.length > 1) {
      t.conflict_display = claimed.map(formatDueDisplay).join(" vs ");
    }
    t.version_reasons = versions.map((v) => ({
      due_date: v.due_date ? formatDate(v.due_date) : null,
      reason: v.reason,
      at: v.created_at,
    }));
  }

  return hydrated;
}

async function listTasks() {
  const db = await connect();
  const tasks = await db.collection("tasks").find({}).sort({ due_date: 1 }).toArray();
  return hydrateTasks(db, tasks);
}

async function taskHistory(taskId) {
  const db = await connect();
  const task = await db.collection("tasks").findOne({ _id: oid(taskId) });
  if (!task) return null;

  const [hydrated] = await hydrateTasks(db, [task]);
  const formattedTask = hydrated;

  const versions = await db
    .collection("task_versions")
    .find({ task_id: oid(taskId) })
    .sort({ created_at: 1 })
    .toArray();

  const withMessages = [];
  for (const v of versions) {
    let source_excerpt = null;
    if (v.source_message_id) {
      const msg = await db.collection("messages").findOne({ _id: v.source_message_id });
      source_excerpt = msg ? msg.raw_text.slice(0, 120) : null;
    }
    withMessages.push({
      id: String(v._id),
      due_date: v.due_date ? formatDate(v.due_date) : null,
      due_display: v.due_date ? formatDueDisplay(formatDate(v.due_date)) : "Date unknown",
      weightage: v.weightage,
      weightage_display: v.weightage != null ? `${v.weightage}%` : null,
      reason: v.reason,
      reason_label: {
        initial: "First mention",
        explicit_correction: "Date corrected",
        conflicting_report: "Different date reported",
        confirmation: "Same date confirmed",
      }[v.reason] || v.reason,
      date_resolution_note: v.date_resolution_note || null,
      created_at: v.created_at,
      source_excerpt,
    });
  }

  return { task: formattedTask, versions: withMessages };
}

async function hydrateTasks(db, tasks) {
  const courseIds = [
    ...new Set(
      tasks
        .map((t) => t.course_id)
        .filter((id) => id != null)
        .map((id) => String(id))
    ),
  ];
  const courses = courseIds.length
    ? await db
        .collection("courses")
        .find({ _id: { $in: courseIds.map(oid) } })
        .toArray()
    : [];
  const byId = Object.fromEntries(courses.map((c) => [String(c._id), c]));

  return tasks.map((t) =>
    formatTaskRow({
      id: String(t._id),
      course: t.course_id ? byId[String(t.course_id)]?.name ?? null : null,
      title: t.title,
      task_type: t.task_type,
      due_date: t.due_date ? formatDate(t.due_date) : null,
      weightage: t.weightage ?? null,
      status: t.status,
      updated_at: t.updated_at,
      claimed_due_dates: t.claimed_due_dates,
      version_reasons: t.version_reasons,
    })
  );
}

function startOfDay(d) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}

module.exports = {
  dueThisWeek,
  needsConfirmation,
  listTasks,
  taskHistory,
};
