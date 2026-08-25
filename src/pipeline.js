const { connect, oid } = require("./db");
const { getOpenTasks, findOrCreateCourse, formatDate } = require("./courses");
const {
  extractAndMatch,
  extractAndMatchChunk,
  normalizeExtractions,
  GEMINI_CHUNK,
  BATCH_SLA_MS,
} = require("./gemini");
const { tryLocalExtraction } = require("./localExtract");
const { formatIngestResponse, cleanLabel, preferTitle } = require("./format");

/**
 * Ingest one forwarded message: local/Gemini extract+match, then backend routes on relation.
 */
async function ingestMessage({ text, source = "whatsapp", receivedAt = new Date() }) {
  const db = await connect();
  const received = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);
  const openTasks = await getOpenTasks();
  const extractions = await extractAndMatch(text, openTasks, received, source);
  return persistIngest(db, text, source, received, extractions);
}

/**
 * Fast batch for 50–70+ messages within ~4 minutes.
 * Local extract handles most msgs instantly; Gemini only for ambiguous ones (chunks of 15).
 */
async function ingestMessagesFast({
  messages,
  source = "whatsapp",
  receivedAt = new Date(),
  onProgress,
}) {
  const db = await connect();
  const received = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);
  const list = (messages || []).map((m) => String(m || "").trim()).filter(Boolean);
  const started = Date.now();
  const out = [];
  const counts = {
    noise: 0,
    new_task: 0,
    update: 0,
    contradiction: 0,
    error: 0,
    local: 0,
    gemini: 0,
  };

  let openTasks = await getOpenTasks();
  const refreshOpen = async () => {
    openTasks = await getOpenTasks();
  };

  let i = 0;
  while (i < list.length) {
    const elapsed = Date.now() - started;
    const overBudget = elapsed > BATCH_SLA_MS * 0.85;

    // Drain local-resolvable messages (no Gemini, no rate limit)
    while (i < list.length) {
      const text = list[i];
      const local = tryLocalExtraction(text, openTasks, received);
      if (!local && !overBudget) break;

      try {
        const extractions = local
          ? normalizeExtractions(local, text, openTasks, received)
          : // Over budget: force best-effort local / noise-safe path
            normalizeExtractions(
              tryLocalExtraction(text, openTasks, received) || [
                {
                  is_noise: !/\b(due|deadline|assignment|quiz|exam|lab|report|worksheet)\b/i.test(
                    text
                  ),
                  course: null,
                  title: text.slice(0, 60),
                  task_type: "other",
                  due_date: null,
                  weightage: null,
                  matched_task_id: null,
                  relation: "new",
                  confidence: 0.4,
                  reasoning: "batch: time-budget fallback",
                },
              ],
              text,
              openTasks,
              received
            );

        const result = await persistIngest(db, text, source, received, extractions);
        counts.local += 1;
        if (counts[result.outcome] != null) counts[result.outcome] += 1;
        out.push(rowOk(i, text, result, local ? "local" : "budget-local"));
        if (!extractions.every((e) => e.is_noise)) await refreshOpen();
      } catch (err) {
        counts.error += 1;
        out.push(rowFail(i, text, err.message));
      }
      i += 1;
      if (onProgress) onProgress({ current: i, total: list.length, elapsed_ms: Date.now() - started });
    }

    if (i >= list.length) break;
    if (Date.now() - started > BATCH_SLA_MS) {
      process.stderr.write(`  ⏱ batch SLA ${BATCH_SLA_MS / 1000}s reached — local-only for remainder\n`);
      continue;
    }

    // Pack next consecutive Gemini-needed messages into ONE call
    const chunk = [];
    while (i + chunk.length < list.length && chunk.length < GEMINI_CHUNK) {
      const text = list[i + chunk.length];
      if (tryLocalExtraction(text, openTasks, received)) break;
      chunk.push({ i: i + chunk.length, text });
    }
    if (!chunk.length) chunk.push({ i, text: list[i] });

    process.stderr.write(
      `  🚀 Gemini chunk: ${chunk.length} msgs → 1 call (#${chunk[0].i + 1}–#${chunk[chunk.length - 1].i + 1}) ` +
        `[${((Date.now() - started) / 1000).toFixed(0)}s elapsed]\n`
    );

    let byIndex = null;
    try {
      byIndex = await extractAndMatchChunk(chunk, openTasks, received, source);
      counts.gemini += 1;
    } catch (err) {
      process.stderr.write(`  ⚠ chunk failed (${err.message}) — local fallback for chunk\n`);
    }

    for (const item of chunk) {
      try {
        const raw = byIndex?.get(item.i);
        let extractions;
        if (raw?.length) {
          extractions = normalizeExtractions(raw, item.text, openTasks, received);
        } else {
          const local = tryLocalExtraction(item.text, openTasks, received);
          if (local) {
            extractions = normalizeExtractions(local, item.text, openTasks, received);
          } else {
            // Last resort single call only if we still have SLA budget
            if (Date.now() - started < BATCH_SLA_MS * 0.9) {
              extractions = await extractAndMatch(item.text, openTasks, received, source);
            } else {
              extractions = normalizeExtractions(
                [
                  {
                    is_noise: false,
                    course: null,
                    title: item.text.slice(0, 60),
                    task_type: "other",
                    due_date: null,
                    weightage: null,
                    matched_task_id: null,
                    relation: "new",
                    confidence: 0.35,
                    reasoning: "batch: chunk miss + SLA",
                  },
                ],
                item.text,
                openTasks,
                received
              );
            }
          }
        }
        const result = await persistIngest(db, item.text, source, received, extractions);
        if (counts[result.outcome] != null) counts[result.outcome] += 1;
        out.push(rowOk(item.i, item.text, result, byIndex ? "gemini-chunk" : "fallback"));
        if (!extractions.every((e) => e.is_noise)) await refreshOpen();
      } catch (err) {
        counts.error += 1;
        out.push(rowFail(item.i, item.text, err.message));
      }
      if (onProgress) {
        onProgress({ current: item.i + 1, total: list.length, elapsed_ms: Date.now() - started });
      }
    }

    i = chunk[chunk.length - 1].i + 1;
  }

  const ok = out.filter((r) => r.ok).length;
  const elapsed_ms = Date.now() - started;
  return {
    total: list.length,
    processed: ok,
    failed: counts.error,
    elapsed_ms,
    elapsed_s: Math.round(elapsed_ms / 1000),
    within_sla: elapsed_ms <= BATCH_SLA_MS,
    counts,
    summary: `Processed ${ok}/${list.length} in ${Math.round(elapsed_ms / 1000)}s (SLA ${BATCH_SLA_MS / 1000}s) — local: ${counts.local}, gemini_calls: ${counts.gemini}, new: ${counts.new_task}, updated: ${counts.update}, needs confirmation: ${counts.contradiction}, noise: ${counts.noise}, errors: ${counts.error}`,
    results: out,
  };
}

function rowOk(i, text, result, path) {
  return {
    index: i + 1,
    preview: text.length > 80 ? `${text.slice(0, 80)}…` : text,
    ok: true,
    path,
    ...result,
  };
}

function rowFail(i, text, error) {
  return {
    index: i + 1,
    preview: text.length > 80 ? `${text.slice(0, 80)}…` : text,
    ok: false,
    error,
  };
}

async function persistIngest(db, text, source, received, extractions) {
  const results = [];
  let primaryClassification = "noise";
  let primaryMatchedId = null;

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
    const display = outcome.task_id ? await loadTaskDisplay(db, outcome.task_id) : null;
    results.push({
      extraction,
      ...outcome,
      saved_course: display?.course || null,
      saved_title: display?.title || null,
      saved_due_date: display?.due_date || null,
    });
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

  return formatIngestResponse({
    message_id: String(messageId),
    classification: primaryClassification,
    results,
  });
}

async function applyExtraction(db, extraction, messageId) {
  if (extraction.is_noise) {
    return { classification: "noise", task_id: null, action: "logged_noise" };
  }

  let relation = extraction.relation || "new";

  // Student stated a date on a task that already needs confirmation → write it as truth.
  if (
    extraction.due_date &&
    (relation === "confirmation" || relation === "conflicting_report")
  ) {
    const existing = await loadMatchedTask(db, extraction);
    if (existing?.status === "needs_confirmation") {
      relation = "explicit_correction";
    }
  }

  switch (relation) {
    case "explicit_correction":
      return applyCorrection(db, extraction, messageId);
    case "conflicting_report":
      return applyConflict(db, extraction, messageId);
    case "confirmation":
      return applyConfirmation(db, extraction, messageId);
    case "new":
    default:
      // Last-resort: never create a duplicate of an obvious existing task
      return applyNewOrMatch(db, extraction, messageId);
  }
}

async function applyNewOrMatch(db, extraction, messageId) {
  const existing = await findSimilarTask(db, extraction);
  if (existing) {
    extraction.matched_task_id = String(existing._id);
    const existingDue = existing.due_date ? formatDate(existing.due_date) : null;
    const newDue = extraction.due_date || null;

    if (newDue && existing.status === "needs_confirmation") {
      return applyCorrection(db, extraction, messageId);
    }
    if (newDue && existingDue && newDue !== existingDue) {
      return applyConflict(db, extraction, messageId);
    }
    if (newDue && newDue !== existingDue) {
      return applyCorrection(db, extraction, messageId);
    }
    return applyConfirmation(db, extraction, messageId);
  }
  return applyNew(db, extraction, messageId);
}

async function findSimilarTask(db, extraction) {
  if (extraction.matched_task_id) {
    try {
      const byId = await db.collection("tasks").findOne({ _id: oid(extraction.matched_task_id) });
      if (byId) return byId;
    } catch {
      /* ignore bad id */
    }
  }

  const tasks = await db.collection("tasks").find({}).sort({ updated_at: -1 }).limit(50).toArray();
  if (!tasks.length) return null;

  const courseIds = [...new Set(tasks.map((t) => t.course_id).filter(Boolean).map(String))];
  const courses = courseIds.length
    ? await db
        .collection("courses")
        .find({ _id: { $in: courseIds.map(oid) } })
        .toArray()
    : [];
  const courseById = Object.fromEntries(courses.map((c) => [String(c._id), c]));

  const titleNorm = normTitle(extraction.title);
  const courseNorm = normTitle(extraction.course);

  for (const t of tasks) {
    const c = t.course_id ? courseById[String(t.course_id)] : null;
    const cName = c ? normTitle(c.name) : "";
    const courseOk =
      !courseNorm ||
      !cName ||
      cName === courseNorm ||
      (c.aliases || []).some((a) => normTitle(a) === courseNorm);
    if (!courseOk) continue;
    if (titlesSimilar(titleNorm, normTitle(t.title))) return t;
  }
  return null;
}

function normTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titlesSimilar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const wa = new Set(a.split(" ").filter((w) => w.length > 2));
  const wb = b.split(" ").filter((w) => w.length > 2);
  if (!wa.size || !wb.length) return false;
  return wb.filter((w) => wa.has(w)).length >= Math.min(2, wb.length);
}

async function applyNew(db, extraction, messageId) {
  const course = await findOrCreateCourse(cleanLabel(extraction.course));
  const due = parseDue(extraction.due_date);
  const status = due == null ? "needs_confirmation" : "confirmed";
  const now = new Date();

  const task = {
    course_id: course?._id ?? null,
    title: cleanLabel(extraction.title) || "Untitled task",
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
  const title = preferTitle(extraction.title, task.title);
  if (title && title !== task.title) update.title = title;
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

async function loadTaskDisplay(db, taskId) {
  const task = await db.collection("tasks").findOne({ _id: oid(taskId) });
  if (!task) return null;
  let course = null;
  if (task.course_id) {
    const doc = await db.collection("courses").findOne({ _id: task.course_id });
    course = doc?.name || null;
  }
  return {
    course,
    title: task.title || null,
    due_date: task.due_date ? formatDate(task.due_date) : null,
  };
}

function parseDue(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // Store as UTC midnight for that calendar day
  const iso = value.length >= 10 ? value.slice(0, 10) : formatDate(d);
  return new Date(`${iso}T00:00:00.000Z`);
}

module.exports = { ingestMessage, ingestMessagesFast };
