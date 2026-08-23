const { connect, oid } = require("./db");
const { getOpenTasks, findOrCreateCourse, formatDate } = require("./courses");
const { extractAndMatch } = require("./gemini");

/**
 * Ingest one forwarded message: Gemini extract+match, then backend routes on relation.
 */
async function ingestMessage({ text, source = "whatsapp", receivedAt = new Date() }) {
  const db = await connect();
  const received = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);

  const openTasks = await getOpenTasks();
  const extractions = await extractAndMatch(text, openTasks, received, source);

  const results = [];
  let primaryClassification = "noise";
  let primaryMatchedId = null;

  // Insert message first so versions can reference it
  const msgInsert = await db.collection("messages").insertOne({
    raw_text: text,
    source,
    received_at: received,
    classification: "pending",
    matched_task_id: null,
  });
  const messageId = msgInsert.insertedId;

  for (const extraction of extractions) {
    const outcome = await applyExtraction(db, extraction, messageId);
    results.push({ extraction, ...outcome });
    if (!extraction.is_noise) {
      primaryClassification = outcome.classification;
      primaryMatchedId = outcome.task_id || primaryMatchedId;
    }
  }

  if (extractions.every((e) => e.is_noise)) {
    primaryClassification = "noise";
  } else if (results.some((r) => r.classification === "contradiction")) {
    primaryClassification = "contradiction";
  } else if (results.some((r) => r.classification === "update")) {
    primaryClassification = "update";
  } else if (results.some((r) => r.classification === "new_task")) {
    primaryClassification = "new_task";
  }

  await db.collection("messages").updateOne(
    { _id: messageId },
    {
      $set: {
        classification: primaryClassification,
        matched_task_id: primaryMatchedId ? oid(primaryMatchedId) : null,
        extractions,
      },
    }
  );

  return {
    message_id: String(messageId),
    classification: primaryClassification,
    results,
  };
}

async function applyExtraction(db, extraction, messageId) {
  if (extraction.is_noise) {
    return { classification: "noise", task_id: null, action: "logged_noise" };
  }

  const relation = extraction.relation || "new";

  switch (relation) {
    case "explicit_correction":
      return applyCorrection(db, extraction, messageId);
    case "conflicting_report":
      return applyConflict(db, extraction, messageId);
    case "confirmation":
      return applyConfirmation(db, extraction, messageId);
    case "new":
    default:
      return applyNew(db, extraction, messageId);
  }
}

async function applyNew(db, extraction, messageId) {
  const course = await findOrCreateCourse(extraction.course);
  const due = parseDue(extraction.due_date);
  const status = due == null ? "needs_confirmation" : "confirmed";
  const now = new Date();

  const task = {
    course_id: course?._id ?? null,
    title: extraction.title || "Untitled task",
    task_type: extraction.task_type || "other",
    due_date: due,
    weightage: extraction.weightage,
    status,
    created_at: now,
    updated_at: now,
  };

  const inserted = await db.collection("tasks").insertOne(task);
  await db.collection("task_versions").insertOne({
    task_id: inserted.insertedId,
    due_date: due,
    weightage: extraction.weightage,
    source_message_id: messageId,
    reason: "initial",
    date_resolution_note: extraction.date_resolution_note || null,
    created_at: now,
  });

  return {
    classification: "new_task",
    task_id: String(inserted.insertedId),
    action: "created",
    status,
  };
}

async function applyCorrection(db, extraction, messageId) {
  const task = await loadMatchedTask(db, extraction);
  if (!task) return applyNew(db, extraction, messageId);

  const due = parseDue(extraction.due_date);
  const now = new Date();

  // Cancelled / postponed indefinitely → clear date, needs confirmation
  const clearingDate = due == null;
  const status = clearingDate ? "needs_confirmation" : "confirmed";

  const update = {
    updated_at: now,
    status,
  };
  if (extraction.due_date !== undefined) update.due_date = due;
  if (extraction.weightage != null) update.weightage = extraction.weightage;
  if (extraction.title) update.title = extraction.title;
  if (extraction.task_type) update.task_type = extraction.task_type;

  await db.collection("tasks").updateOne({ _id: task._id }, { $set: update });
  await db.collection("task_versions").insertOne({
    task_id: task._id,
    due_date: due,
    weightage: extraction.weightage ?? task.weightage ?? null,
    source_message_id: messageId,
    reason: "explicit_correction",
    date_resolution_note: extraction.date_resolution_note || null,
    created_at: now,
  });

  return {
    classification: "update",
    task_id: String(task._id),
    action: "explicit_correction",
    status,
  };
}

async function applyConflict(db, extraction, messageId) {
  const task = await loadMatchedTask(db, extraction);
  if (!task) return applyNew(db, extraction, messageId);

  const due = parseDue(extraction.due_date);
  const now = new Date();

  // Do NOT overwrite live tasks.due_date
  await db.collection("tasks").updateOne(
    { _id: task._id },
    { $set: { status: "needs_confirmation", updated_at: now } }
  );
  await db.collection("task_versions").insertOne({
    task_id: task._id,
    due_date: due,
    weightage: extraction.weightage ?? task.weightage ?? null,
    source_message_id: messageId,
    reason: "conflicting_report",
    date_resolution_note: extraction.date_resolution_note || null,
    created_at: now,
  });

  return {
    classification: "contradiction",
    task_id: String(task._id),
    action: "conflicting_report",
    status: "needs_confirmation",
    kept_due_date: task.due_date ? formatDate(task.due_date) : null,
    reported_due_date: due ? formatDate(due) : null,
  };
}

async function applyConfirmation(db, extraction, messageId) {
  const task = await loadMatchedTask(db, extraction);
  if (!task) return applyNew(db, extraction, messageId);

  const due = parseDue(extraction.due_date) ?? task.due_date;
  const now = new Date();

  await db.collection("task_versions").insertOne({
    task_id: task._id,
    due_date: due,
    weightage: extraction.weightage ?? task.weightage ?? null,
    source_message_id: messageId,
    reason: "confirmation",
    date_resolution_note: extraction.date_resolution_note || null,
    created_at: now,
  });
  // Status unchanged — confirming the live date does not clear an open conflict
  await db.collection("tasks").updateOne({ _id: task._id }, { $set: { updated_at: now } });

  return {
    classification: "update",
    task_id: String(task._id),
    action: "confirmation",
    status: task.status,
  };
}

async function loadMatchedTask(db, extraction) {
  if (!extraction.matched_task_id) return null;
  try {
    return await db.collection("tasks").findOne({ _id: oid(extraction.matched_task_id) });
  } catch {
    return null;
  }
}

function parseDue(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // Store as UTC midnight for that calendar day
  const iso = value.length >= 10 ? value.slice(0, 10) : formatDate(d);
  return new Date(`${iso}T00:00:00.000Z`);
}

module.exports = { ingestMessage };
