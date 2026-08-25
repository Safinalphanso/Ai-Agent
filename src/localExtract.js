/**
 * Fast local extraction — skip Gemini when the message is unambiguous.
 * Returns extractions[] or null if Gemini is still needed.
 */

const { resolveDateFromMessage } = require("./dates");

const DEADLINE_SIGNALS =
  /\b(due|deadline|submit|submission|assignment|homework|\bhw\b|lab report|lab work|quiz|exam|test|report|worksheet|project|registration|closes|worth\s+\d+|%\s+of|grade|marks|assessment|coursework|essay|presentation|midterm|mid-sem|practical|portfolio|rehearsal|olympiad|scholarship)\b/i;

const DATE_SIGNALS =
  /\b(\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}|20\d{2}-\d{2}-\d{2}|tomorrow|today|day after tomorrow|next\s+(?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this\s+(?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\bon\s+the\s+\d{1,2}(?:st|nd|rd|th)?\b|\bdue\s+(?:on\s+)?(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?\b|\b(?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)/i;

const NOISE_PATTERNS = [
  /\b(anyone up for|who(?:'s| is) (?:in|coming|free)|let(?:'s| us) (?:meet|go|play))\b/i,
  /\b(football|cricket|basketball|volleyball|badminton|tennis|pub|bar|party|movie|netflix|lunch|dinner|breakfast|brunch|coffee|hangout|biryani)\b/i,
  /\b(lol|lmao|rofl|haha|meme|gif|sticker)\b/i,
  /\b(good (?:morning|night|luck)|thanks|thank you|see you|ttyl|np\b|no problem)\b/i,
  /\b(was yesterday|already submitted|already done|missed it)\b/i,
  /\b(drive link|answer key|waking up|ttyl)\b/i,
];

const UPDATE_LANG =
  /\b(?:not\s+\d+(?:st|nd|rd|th)?|actually|moved\s+to|correction|rescheduled|cancelled|canceled|updated?\s+to|due date updated|changed\s+to|now\s+due|extended\s+to|confirmed\s+(?:on|for|as|at)|date\s+confirmed|confirm(?:ed)?\s+(?:the\s+)?date|the (?:due )?date is|it'?s on|definitely|confirmed|remains)\b/i;

function hasUpdateLanguage(text) {
  return UPDATE_LANG.test(String(text || ""));
}

const UNKNOWN_DATE =
  /\b(soon|coming up|tbd|tba|until further notice|approaching|closing soon|closes soon)\b/i;

const COURSE_RE =
  /\b(Science|Maths|Mathematics|English|Physics|Chemistry|History|Biology|Geography|Economics|Statistics|French|Art|Music|Drama|Philosophy|PE|Computer Science|Computer|Robotics|Political Science|Pol(?:itical)?\s*Sci)\b/i;

const TASK_TYPE_HINTS = [
  [/quiz/i, "quiz"],
  [/exam|midterm|mid-sem|oral/i, "exam"],
  [/lab/i, "lab"],
  [/registration|signup|sign-up|application/i, "registration"],
  [/worksheet|assignment|homework|\bhw\b|essay|report|project|portfolio|presentation|case study|reading log|script/i, "assignment"],
];

function isLikelyNoise(messageText) {
  const t = String(messageText || "").trim();
  if (!t) return true;
  if (DEADLINE_SIGNALS.test(t) || DATE_SIGNALS.test(t)) return false;
  if (NOISE_PATTERNS.some((re) => re.test(t))) return true;
  if (t.length < 100 && /\?/.test(t) && /\b(anyone|who|when are we|you free|wanna|did you|class cancelled)\b/i.test(t)) {
    return true;
  }
  return false;
}

function noiseExtraction() {
  return [
    {
      is_noise: true,
      course: null,
      title: null,
      task_type: null,
      due_date: null,
      weightage: null,
      matched_task_id: null,
      relation: null,
      confidence: 0.98,
      reasoning: "local: noise",
      date_resolution_note: null,
    },
  ];
}

function localNoiseExtraction(messageText) {
  if (!isLikelyNoise(messageText)) return null;
  return noiseExtraction();
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titlesOverlap(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = new Set(na.split(" ").filter((w) => w.length > 2));
  const wb = nb.split(" ").filter((w) => w.length > 2);
  if (!wa.size || !wb.length) return false;
  return wb.filter((w) => wa.has(w)).length >= Math.min(2, wb.length);
}

function inferTaskType(text) {
  for (const [re, type] of TASK_TYPE_HINTS) {
    if (re.test(text)) return type;
  }
  return "other";
}

function inferWeightage(text) {
  const m =
    text.match(/\bworth\s+(\d+)\s*%/i) ||
    text.match(/\b(\d+)\s*%\s*(?:of\s+)?(?:grade|final|marks)?/i) ||
    text.match(/\b(\d+)\s*marks?\b/i);
  return m ? Number(m[1]) : null;
}

function inferCourse(text) {
  const m = text.match(COURSE_RE);
  if (!m) return null;
  let c = m[1];
  if (/^mathematics$/i.test(c)) return "Maths";
  if (/^computer$/i.test(c)) return "Computer Science";
  if (/political|pol\s*sci/i.test(c)) return "Political Science";
  return c;
}

function inferTitle(text, course) {
  const cleaned = text
    .replace(/^(reminder(?:\s+from[^:]+)?:|just confirming|all set —)\s*/i, "")
    .trim();

  const coursePart = course ? escapeRe(course) : "[A-Za-z][A-Za-z\\s]{0,20}?";
  const withCourse = cleaned.match(
    new RegExp(
      "\\b(" +
        coursePart +
        ")\\s+([A-Za-z0-9][A-Za-z0-9\\s\\-]{2,40}?)\\s+(?:due|deadline|submission|submit|on|is|moved|rescheduled|updated|closes|closing)",
      "i"
    )
  );
  if (withCourse) {
    const title = `${withCourse[1]} ${withCourse[2]}`.replace(/\s+/g, " ").trim();
    return title.slice(0, 80);
  }

  const duePart = cleaned.match(
    /^(.{8,60}?)\s+(?:due|deadline|submission|closes|closing|moved|rescheduled|updated)/i
  );
  if (duePart) return duePart[1].replace(/\s+/g, " ").trim().slice(0, 80);

  if (course) return `${course} assignment`;
  return "Untitled task";
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMatch(openTasks, messageText, course, title) {
  if (!openTasks?.length) return null;
  const msg = norm(messageText);
  const candidates = openTasks.filter((t) => {
    const courseOk =
      !course ||
      !t.course ||
      norm(t.course) === norm(course) ||
      (t.course_aliases || []).some((a) => norm(a) === norm(course));
    if (!courseOk) return false;
    return (
      titlesOverlap(title, t.title) ||
      titlesOverlap(msg, t.title) ||
      (course &&
        norm(t.course) === norm(course) &&
        msg.includes(norm(t.title).split(" ").slice(0, 2).join(" ")))
    );
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function relationFor(messageText, match, dueDate) {
  const cancelled = /\bcancelled\b|\bcanceled\b|until further notice/i.test(messageText);
  if (cancelled) return "explicit_correction";

  if (!match) return "new";

  if (hasUpdateLanguage(messageText)) return "explicit_correction";

  // Task is already unconfirmed — a stated date is the student resolving it.
  if (dueDate && match.status === "needs_confirmation") return "explicit_correction";

  if (dueDate && match.due_date && dueDate === match.due_date) return "confirmation";
  if (dueDate && match.due_date && dueDate !== match.due_date) return "conflicting_report";
  if (dueDate && !match.due_date) return "explicit_correction";
  return "confirmation";
}

/**
 * High-confidence local extraction. Returns null if Gemini should handle it.
 * Skips multi-task messages ("AND", ". Also") — those go to Gemini.
 */
function tryLocalExtraction(messageText, openTasks = [], receivedAt = new Date()) {
  const text = String(messageText || "").trim();
  if (!text) return noiseExtraction();

  if (isLikelyNoise(text)) return noiseExtraction();

  // Multi-task → Gemini
  if (/\bAND\b/.test(text) || /\.\s*Also\b/i.test(text) || /;\s*.+\bdue\b/i.test(text)) {
    return null;
  }

  const hasDeadlineCue = DEADLINE_SIGNALS.test(text) || DATE_SIGNALS.test(text);
  if (!hasDeadlineCue) return null;

  const resolved = resolveDateFromMessage(text, receivedAt);
  const dueDate = resolved?.due_date || null;
  const unknown = !dueDate && UNKNOWN_DATE.test(text);

  // Need either a resolved date or explicit unknown — otherwise Gemini
  if (!dueDate && !unknown && !UPDATE_LANG.test(text) && !/\bcancelled\b|\bcanceled\b/i.test(text)) {
    // Sarcasm with "due tomorrow" already has date — handled above
    // Vague without unknown words → Gemini
    if (!DATE_SIGNALS.test(text)) return null;
  }

  const course = inferCourse(text);
  const title = inferTitle(text, course);
  const task_type = inferTaskType(text);
  const weightage = inferWeightage(text);
  const match = findMatch(openTasks, text, course, title);

  // Ambiguous: deadline-ish but no course and no match → Gemini for safety
  if (!course && !match && !unknown) {
    return null;
  }

  let finalDue = dueDate;
  if (/\bcancelled\b|\bcanceled\b|until further notice/i.test(text)) {
    finalDue = null;
  }

  const relation = relationFor(text, match, finalDue);

  return [
    {
      is_noise: false,
      course,
      title,
      task_type,
      due_date: finalDue,
      weightage,
      matched_task_id: match?.id || null,
      relation,
      confidence: 0.92,
      reasoning: "local: high-confidence pattern",
      date_resolution_note: resolved?.note || null,
    },
  ];
}

function pickRelevantOpenTasks(openTasks, messageText, limit = 12) {
  if (!openTasks?.length) return [];
  const msg = norm(messageText);
  const msgWords = new Set(msg.split(" ").filter((w) => w.length > 2));

  const scored = openTasks.map((t) => {
    let score = 0;
    const title = norm(t.title);
    const course = norm(t.course);
    if (course && msg.includes(course)) score += 8;
    if (title && msg.includes(title)) score += 10;
    for (const w of title.split(" ").filter((x) => x.length > 2)) {
      if (msgWords.has(w)) score += 2;
    }
    if (t.status === "needs_confirmation") score += 1;
    return { t, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter((s) => s.score > 0).slice(0, limit);
  const picked = top.length ? top : scored.slice(0, Math.min(limit, scored.length));
  return picked.map(({ t }) => ({
    id: t.id,
    course: t.course,
    title: t.title,
    due: t.due_date,
    status: t.status,
  }));
}

module.exports = {
  isLikelyNoise,
  localNoiseExtraction,
  tryLocalExtraction,
  pickRelevantOpenTasks,
  hasUpdateLanguage,
  DEADLINE_SIGNALS,
};
