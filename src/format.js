const { formatDate } = require("./courses");

const ACTION_LABELS = {
  created: "New deadline added",
  explicit_correction: "Deadline updated",
  conflicting_report: "Conflicting dates reported",
  confirmation: "Deadline confirmed",
  logged_noise: "Ignored (not a deadline)",
};

const OUTCOME_LABELS = {
  noise: "No deadline in this message",
  new_task: "New deadline saved",
  update: "Existing deadline updated",
  contradiction: "Needs your confirmation",
};

const STATUS_LABELS = {
  confirmed: "Confirmed",
  needs_confirmation: "Needs confirmation",
};

/** Gemini sometimes returns "Unknown" / "N/A" as a course or title. */
const EMPTY_LABEL = /^(unknown|n\/?a|none|null|untitled(?:\s+task)?|date unknown|tbd|tba|-+)$/i;

function cleanLabel(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || EMPTY_LABEL.test(text)) return null;
  if (/^(due date|deadline|date|submission)$/i.test(text)) return null;
  return text;
}

/** Keep the stored name unless the new one is a real improvement. */
function preferTitle(incoming, existing) {
  const next = cleanLabel(incoming);
  const prev = cleanLabel(existing);
  if (!next) return prev;
  if (!prev) return next;
  return prev;
}

function formatDueDisplay(iso) {
  if (!iso) return "Date unknown";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatWeightage(w) {
  if (w == null) return null;
  return `${w}%`;
}

/** One-line summary for a task card or ingest item */
function taskSummary({ subject, task, due_date, status }) {
  const sub = subject || "General";
  const name = task || "Untitled";
  const due = due_date ? `due ${formatDueDisplay(due_date)}` : "date unknown";
  if (status === "needs_confirmation") {
    return `${sub} · ${name} · ${due} · needs confirmation`;
  }
  return `${sub} · ${name} · ${due}`;
}

function formatTaskRow(t) {
  const subject = t.course ?? null;
  const task = t.title;
  return {
    id: t.id,
    subject,
    task,
    task_type: t.task_type,
    due_date: t.due_date,
    due_display: formatDueDisplay(t.due_date),
    weightage: t.weightage ?? null,
    weightage_display: formatWeightage(t.weightage),
    status: t.status,
    status_label: STATUS_LABELS[t.status] || t.status,
    summary: taskSummary({ subject, task, due_date: t.due_date, status: t.status }),
    claimed_due_dates: t.claimed_due_dates,
    version_reasons: t.version_reasons,
    updated_at: t.updated_at,
  };
}

function formatIngestItem(result) {
  const ext = result.extraction || {};
  if (result.classification === "noise" || ext.is_noise) {
    return {
      action: "logged_noise",
      action_label: ACTION_LABELS.logged_noise,
      subject: null,
      task: null,
      task_type: null,
      due_date: null,
      due_display: null,
      weightage: null,
      weightage_display: null,
      status: null,
      status_label: null,
      task_id: null,
      summary: "No academic deadline found in this message.",
      conflict: null,
    };
  }

  const subject = cleanLabel(ext.course) || result.saved_course || null;
  const task = cleanLabel(ext.title) || result.saved_title || null;
  const due_date = ext.due_date || result.saved_due_date || result.kept_due_date || null;
  const status = result.status || ext.status || null;

  const item = {
    action: result.action || result.classification,
    action_label: ACTION_LABELS[result.action] || result.classification,
    subject,
    task,
    task_type: ext.task_type || null,
    due_date,
    due_display: formatDueDisplay(due_date),
    weightage: ext.weightage ?? null,
    weightage_display: formatWeightage(ext.weightage),
    status,
    status_label: status ? STATUS_LABELS[status] || status : null,
    task_id: result.task_id || null,
    summary: taskSummary({ subject, task, due_date, status }),
    conflict: null,
  };

  if (result.kept_due_date && result.reported_due_date) {
    item.conflict = {
      kept: result.kept_due_date,
      kept_display: formatDueDisplay(result.kept_due_date),
      reported: result.reported_due_date,
      reported_display: formatDueDisplay(result.reported_due_date),
      message: `Two different dates on record: ${formatDueDisplay(result.kept_due_date)} vs ${formatDueDisplay(result.reported_due_date)}`,
    };
    item.summary = `${subject || "Task"} · ${task || "Deadline"} · ${item.conflict.message}`;
  }

  return item;
}

function formatIngestResponse(raw) {
  const items = (raw.results || []).map(formatIngestItem);
  const outcome = raw.classification;

  let summary = OUTCOME_LABELS[outcome] || outcome;
  if (outcome === "noise") {
    summary = OUTCOME_LABELS.noise;
  } else if (items.length === 1 && items[0].summary) {
    summary = `${items[0].action_label}: ${items[0].summary}`;
  } else if (items.length > 1) {
    summary = `${items.length} deadlines processed from this message`;
  }

  return {
    message_id: raw.message_id,
    outcome,
    outcome_label: OUTCOME_LABELS[outcome] || outcome,
    summary,
    items,
  };
}

module.exports = {
  formatDueDisplay,
  formatWeightage,
  taskSummary,
  formatTaskRow,
  formatIngestItem,
  formatIngestResponse,
  cleanLabel,
  preferTitle,
  ACTION_LABELS,
  OUTCOME_LABELS,
  STATUS_LABELS,
};
