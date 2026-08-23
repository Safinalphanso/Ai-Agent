const { GoogleGenAI, Type } = require("@google/genai");

const CONFIDENCE_THRESHOLD = 0.6;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
// Free-tier gemini-2.5-flash is typically 5 RPM. Override with GEMINI_RPM if your quota differs.
const RPM_LIMIT = Math.max(1, Number(process.env.GEMINI_RPM || 5));
const MIN_INTERVAL_MS = Math.ceil(60_000 / RPM_LIMIT) + 250;
const MAX_RETRIES = 5;

const EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    extractions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          is_noise: { type: Type.BOOLEAN },
          course: { type: Type.STRING, nullable: true },
          title: { type: Type.STRING, nullable: true },
          task_type: {
            type: Type.STRING,
            nullable: true,
            enum: ["assignment", "quiz", "exam", "lab", "registration", "other"],
          },
          due_date: { type: Type.STRING, nullable: true },
          weightage: { type: Type.NUMBER, nullable: true },
          matched_task_id: { type: Type.STRING, nullable: true },
          relation: {
            type: Type.STRING,
            nullable: true,
            enum: ["new", "explicit_correction", "conflicting_report", "confirmation"],
          },
          confidence: { type: Type.NUMBER },
          reasoning: { type: Type.STRING },
          date_resolution_note: { type: Type.STRING, nullable: true },
        },
        required: ["is_noise", "confidence", "reasoning"],
      },
    },
  },
  required: ["extractions"],
};

const SYSTEM_PROMPT = `You are a student deadline extraction agent.
Given ONE forwarded message and the student's current open tasks, extract academic deadlines and decide how each relates to existing tasks.

Rules (follow strictly):
1. Skip pure noise — social plans, memes, venting, sarcasm with no real announcement, past-tense "was yesterday" reminiscing with no upcoming deadline. For noise: is_noise=true and leave other fields null.
2. NEVER invent a due_date. If the message does not state or clearly imply a specific date, due_date must be null.
3. Resolve relative dates against the message's received_at. Output due_date as ISO YYYY-MM-DD.
   Fixed colloquial weekday rule (do NOT improvise):
   - "this <weekday>" / bare "<weekday>" → the nearest upcoming occurrence of that weekday in the current week (relative to received_at).
   - "next <weekday>" → SKIP the nearest upcoming one; land on the occurrence in the week AFTER that.
   Examples anchored on Monday 2026-08-24 (nearest Friday = 2026-08-28):
     - "this Friday" / "Friday" → 2026-08-28
     - "next Friday" → 2026-09-04  (skips 08-28)
   Examples anchored on Tuesday 2026-08-25:
     - "this Friday" → 2026-08-28
     - "next Friday" → 2026-09-04
   Always fill date_resolution_note when you resolve a relative phrase, e.g.
   "resolved 'next Friday' from received_at 2026-08-24 → skipped nearest Fri 2026-08-28 → 2026-09-04".
4. Matching: set matched_task_id to an existing open task id when the message clearly refers to that same work. If confidence < 0.6 or the course/title is ambiguous across multiple tasks, treat as relation=new with course=null rather than guessing.
5. relation meanings:
   - new: no matching open task (or low-confidence match)
   - explicit_correction: message contains override language ("not X", "actually", "moved to", "correction:", "rescheduled to", "cancelled") AND refers to a matched task — update the stored value
   - conflicting_report: message states a different due_date/weightage than the matched task BUT has NO override language — do not treat as a correction
   - confirmation: message restates the same value already stored on the matched task
6. A message may contain multiple tasks — return one extraction object per task. Pure noise messages return a single extraction with is_noise=true.
7. Course names: prefer canonical names from the open-task list / aliases (DBMS, OS, CN, SE, AI).
8. weightage is a number like 20 for 20%. Null if unknown.
9. Past due dates for brand-new tasks: treat as noise (do not create overdue ghost tasks).

Few-shot relation examples:
- Stored: DBMS report due 2026-08-28. Message: "DBMS report due 25th not 28th" → explicit_correction (has "not 28th")
- Stored: OS lab due 2026-08-28. Message Mon 2026-08-24: "OS lab due next Friday" → due_date=2026-09-04, conflicting_report (no override words; differs from stored)
- Stored: OS lab due 2026-08-28 (status may already be needs_confirmation). Message Tue 2026-08-25: "OS lab submission deadline: this Friday" → due_date=2026-08-28, confirmation (matches stored live due_date)
- Stored: DBMS report due 2026-08-25. Message: "reminder — DBMS report due 25th" → confirmation
- Message: "anyone up for football at 6?" → is_noise=true
- Message: "Hackathon registration closes soon" → new, due_date=null
`;

/** Timestamp of the last *attempted* Gemini call (for proactive spacing). */
let lastCallAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stay under free-tier RPM by spacing calls. Actually sleeps — does not busy-loop.
 */
async function waitForRateSlot() {
  const now = Date.now();
  const wait = lastCallAt + MIN_INTERVAL_MS - now;
  if (wait > 0) {
    process.stderr.write(`  ⏳ rate limit: sleeping ${(wait / 1000).toFixed(1)}s\n`);
    await sleep(wait);
  }
  lastCallAt = Date.now();
}

function isAuthError(err) {
  const msg = String(err?.message || err);
  return (
    msg.includes("API_KEY_INVALID") ||
    msg.includes("API key not valid") ||
    err?.status === 403
  );
}

function isRateLimitError(err) {
  if (err?.status === 429) return true;
  const msg = String(err?.message || err);
  return msg.includes('"code":429') || /resource.?exhausted|rate.?limit|quota/i.test(msg);
}

/**
 * Pull retryDelay from Gemini error payloads, e.g. "Please retry in 58.4s"
 * or details[].retryDelay / "retryDelay":"58s".
 */
function parseRetryDelayMs(err) {
  const msg = String(err?.message || err);
  const patterns = [
    /retry in ([\d.]+)\s*s/i,
    /retryDelay["'\s:]*["']?([\d.]+)s/i,
    /"retryDelay"\s*:\s*"([\d.]+)s"/i,
  ];
  for (const re of patterns) {
    const m = msg.match(re);
    if (m) return Math.ceil(parseFloat(m[1]) * 1000) + 750;
  }
  // Fallback: wait a full minute window
  return 60_000 + 750;
}

function getClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenAI({ apiKey: key });
}

async function extractAndMatch(messageText, openTasks, receivedAt, source) {
  const ai = getClient();
  const receivedIso =
    receivedAt instanceof Date ? receivedAt.toISOString() : new Date(receivedAt).toISOString();

  const userPayload = {
    received_at: receivedIso,
    source: source || "unknown",
    message: messageText,
    open_tasks: openTasks,
  };

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await waitForRateSlot();

    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [
          {
            role: "user",
            parts: [{ text: `${SYSTEM_PROMPT}\n\nINPUT:\n${JSON.stringify(userPayload, null, 2)}` }],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: EXTRACTION_SCHEMA,
          temperature: 0.1,
        },
      });

      const text = response.text;
      const parsed = JSON.parse(text);
      const extractions = Array.isArray(parsed.extractions) ? parsed.extractions : [parsed];
      return normalizeExtractions(extractions);
    } catch (err) {
      lastError = err;
      if (isAuthError(err)) throw err;

      if (isRateLimitError(err) && attempt < MAX_RETRIES) {
        const delay = parseRetryDelayMs(err);
        process.stderr.write(
          `  ⏳ 429 from ${MODEL} — sleeping ${(delay / 1000).toFixed(1)}s ` +
            `(attempt ${attempt}/${MAX_RETRIES})\n`
        );
        await sleep(delay);
        // After an explicit backoff, treat the clock as "just waited" so the
        // next proactive throttle doesn't add another full interval on top.
        lastCallAt = Date.now() - MIN_INTERVAL_MS;
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error("Gemini extraction failed");
}

function normalizeExtractions(extractions) {
  return extractions.map((e) => {
    const confidence = typeof e.confidence === "number" ? e.confidence : 0;
    let relation = e.relation ?? null;
    let matched = e.matched_task_id || null;

    if (
      !e.is_noise &&
      matched &&
      relation &&
      relation !== "new" &&
      confidence < CONFIDENCE_THRESHOLD
    ) {
      relation = "new";
      matched = null;
    }

    return {
      is_noise: Boolean(e.is_noise),
      course: e.course || null,
      title: e.title || null,
      task_type: e.task_type || null,
      due_date: e.due_date || null,
      weightage: e.weightage == null ? null : Number(e.weightage),
      matched_task_id: matched,
      relation: e.is_noise ? null : relation || "new",
      confidence,
      reasoning: e.reasoning || "",
      date_resolution_note: e.date_resolution_note || null,
    };
  });
}

module.exports = {
  extractAndMatch,
  CONFIDENCE_THRESHOLD,
  SYSTEM_PROMPT,
  MODEL,
  RPM_LIMIT,
  MIN_INTERVAL_MS,
};
