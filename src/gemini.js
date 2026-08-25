const { GoogleGenAI, Type } = require("@google/genai");

const { localNoiseExtraction, tryLocalExtraction, pickRelevantOpenTasks, hasUpdateLanguage } = require("./localExtract");
const { cleanLabel } = require("./format");
const extractionCache = require("./extractionCache");

const CONFIDENCE_THRESHOLD = 0.6;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
/** Tried in order when primary returns 503 / high demand. Override with GEMINI_FALLBACK_MODELS=a,b */
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-2.5-flash,gemini-2.0-flash")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((m) => m !== MODEL);
// Free-tier flash models are typically ~5 RPM. Override with GEMINI_RPM if your quota differs.
const RPM_LIMIT = Math.max(1, Number(process.env.GEMINI_RPM || 5));
const MIN_INTERVAL_MS = Math.ceil(60_000 / RPM_LIMIT) + 250;
const MAX_RETRIES = 5;
/** Pack this many hard msgs into one Gemini call — 15 msgs / call keeps 70 msgs under ~4 min. */
const GEMINI_CHUNK = Math.max(1, Number(process.env.GEMINI_CHUNK || 15));
/** Soft SLA for a batch of ~70 messages (ms). */
const BATCH_SLA_MS = Math.max(60_000, Number(process.env.BATCH_SLA_MS || 4 * 60_000));

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
        },
        required: ["is_noise", "confidence"],
      },
    },
  },
  required: ["extractions"],
};

const BATCH_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          i: { type: Type.NUMBER },
          extractions: EXTRACTION_SCHEMA.properties.extractions,
        },
        required: ["i", "extractions"],
      },
    },
  },
  required: ["results"],
};

/** Compact prompt — dates resolved in backend; matching rules only. */
const SYSTEM_PROMPT = `Extract student deadlines from ONE message. JSON only.

Rules:
1. is_noise=true: social chat, memes, plans — no academic deadline.
2. ONE extraction unless message names 2+ distinct assignments.
3. due_date: YYYY-MM-DD only if message states a date/relative phrase; else null.
4. Match open_tasks by same course+title → set matched_task_id:
   explicit_correction ("updated to","not X","moved to","changed to") |
   conflicting_report (different date, no override words) |
   confirmation (same date restated) |
   new (no match)
5. course from message or null. weightage number or null.`;

const BATCH_PROMPT = `Extract deadlines from EACH message in the list. Return {results:[{i, extractions:[...]}, ...]}.
Same rules as single-message extraction. i = message index. One result object per input message.`;

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

/** 503 / overloaded / temporarily unavailable — retry with backoff. */
function isUnavailableError(err) {
  if (err?.status === 503 || err?.status === 500 || err?.status === 502) return true;
  const msg = String(err?.message || err);
  return (
    msg.includes('"code":503') ||
    /UNAVAILABLE|high demand|overloaded|try again later|temporarily/i.test(msg)
  );
}

/**
 * Pull retryDelay from Gemini error payloads, e.g. "Please retry in 58.4s"
 * or details[].retryDelay / "retryDelay":"58s".
 */
function parseRetryDelayMs(err, attempt = 1) {
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
  if (isUnavailableError(err)) {
    // Cap backoff so a batch of 50–70 msgs still finishes within ~4 minutes
    return Math.min(12_000, Math.round(2500 * 2 ** (attempt - 1) + Math.random() * 800));
  }
  // Fallback for 429 without delay hint
  return 60_000 + 750;
}

function getResponseText(response) {
  if (response?.text) return response.text;
  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.map((p) => p.text || "").join("");
  }
  return "";
}

/** Parse Gemini JSON — handles fences, trailing junk, and truncated output. */
function parseGeminiJson(raw) {
  if (!raw || typeof raw !== "string") {
    throw new SyntaxError("Empty Gemini response");
  }

  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced) text = fenced[1].trim();

  const tryParse = (s) => JSON.parse(s);

  try {
    return tryParse(text);
  } catch {
    const start = text.indexOf("{");
    if (start < 0) throw new SyntaxError("No JSON object in Gemini response");

    const slice = text.slice(start);
    try {
      return tryParse(slice);
    } catch {
      const repaired = repairTruncatedJson(slice);
      if (repaired) return tryParse(repaired);
      throw new SyntaxError(`Invalid JSON from Gemini: ${slice.slice(0, 120)}…`);
    }
  }
}

function repairTruncatedJson(s) {
  let t = s.trim();

  // Close an unterminated string value
  const unescapedQuotes = t.match(/(?<!\\)"/g) || [];
  if (unescapedQuotes.length % 2 === 1) t += '"';

  // Drop trailing partial key/value after last complete field
  t = t
    .replace(/,\s*"[^"\\]*(?:\\.[^"\\]*)*"?\s*:\s*"[^"\\]*(?:\\.[^"\\]*)*$/, "")
    .replace(/,\s*"[^"\\]*(?:\\.[^"\\]*)*$/, "")
    .replace(/,\s*$/, "");

  const openObj = (t.match(/\{/g) || []).length;
  const closeObj = (t.match(/\}/g) || []).length;
  const openArr = (t.match(/\[/g) || []).length;
  const closeArr = (t.match(/\]/g) || []).length;

  for (let i = 0; i < openArr - closeArr; i++) t += "]";
  for (let i = 0; i < openObj - closeObj; i++) t += "}";

  try {
    JSON.parse(t);
    return t;
  } catch {
    return null;
  }
}

function isJsonParseError(err) {
  if (err instanceof SyntaxError) return true;
  return /JSON|Unterminated string|Unexpected token/i.test(String(err?.message || err));
}

async function extractAndMatch(messageText, openTasks, receivedAt, source) {
  const receivedIso =
    receivedAt instanceof Date ? receivedAt.toISOString() : new Date(receivedAt).toISOString();
  const compactTasks = pickRelevantOpenTasks(openTasks, messageText);

  // 1) Local high-confidence (noise + clear deadlines) — zero API cost
  const local = tryLocalExtraction(messageText, openTasks, receivedAt);
  if (local) {
    process.stderr.write(
      local[0]?.is_noise
        ? "  ⚡ local noise (0 Gemini tokens)\n"
        : "  ⚡ local extract (0 Gemini tokens)\n"
    );
    return normalizeExtractions(local, messageText, openTasks, receivedAt);
  }

  // 2) Cache — zero API cost for duplicate text + same task state
  const cached = extractionCache.get(messageText, compactTasks);
  if (cached) {
    process.stderr.write("  ⚡ cache hit (0 Gemini tokens)\n");
    return normalizeExtractions(cached, messageText, openTasks, receivedAt);
  }

  const userPayload = {
    received_at: receivedIso.slice(0, 10),
    source: source || "unknown",
    message: messageText,
    open_tasks: compactTasks,
  };

  const parsed = await callGeminiJson({
    system: SYSTEM_PROMPT,
    payload: userPayload,
    schema: EXTRACTION_SCHEMA,
    maxOutputTokens: 1024,
  });
  const extractions = Array.isArray(parsed.extractions) ? parsed.extractions : [parsed];
  if (!extractions.length) {
    throw new SyntaxError("Gemini returned empty extractions array");
  }
  extractionCache.set(messageText, compactTasks, extractions);
  return normalizeExtractions(extractions, messageText, openTasks, receivedAt);
}

/**
 * Extract many hard messages in ONE Gemini call (then normalize each).
 * Returns Map index → extractions[]
 */
async function extractAndMatchChunk(items, openTasks, receivedAt, source) {
  const receivedIso =
    receivedAt instanceof Date ? receivedAt.toISOString() : new Date(receivedAt).toISOString();

  const payload = {
    received_at: receivedIso.slice(0, 10),
    source: source || "unknown",
    open_tasks: pickRelevantOpenTasks(openTasks, items.map((x) => x.text).join(" "), 20),
    messages: items.map((x) => ({ i: x.i, message: x.text })),
  };

  const parsed = await callGeminiJson({
    system: `${SYSTEM_PROMPT}\n\n${BATCH_PROMPT}`,
    payload,
    schema: BATCH_SCHEMA,
    maxOutputTokens: 4096,
    maxRetries: 3,
  });

  const byIndex = new Map();
  for (const row of parsed.results || []) {
    const extractions = Array.isArray(row.extractions) ? row.extractions : [];
    byIndex.set(Number(row.i), extractions);
  }
  return byIndex;
}

async function callGeminiJson({ system, payload, schema, maxOutputTokens, maxRetries = MAX_RETRIES }) {
  const ai = getClient();
  let lastError;
  let modelIndex = 0;
  const modelChain = [MODEL, ...FALLBACK_MODELS];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await waitForRateSlot();
    const model = modelChain[Math.min(modelIndex, modelChain.length - 1)];

    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: 0,
          maxOutputTokens,
        },
      });

      return parseGeminiJson(getResponseText(response));
    } catch (err) {
      lastError = err;
      if (isAuthError(err)) throw err;

      const retryable =
        isRateLimitError(err) || isUnavailableError(err) || isJsonParseError(err);

      if (retryable && attempt < maxRetries) {
        if (isJsonParseError(err)) {
          process.stderr.write(
            `  ⚠ bad JSON from ${model} — retry ${attempt}/${maxRetries}\n`
          );
          await sleep(300 * attempt);
          continue;
        }

        if (isUnavailableError(err) && modelIndex < modelChain.length - 1) {
          modelIndex += 1;
          process.stderr.write(
            `  ⚠ ${model} overloaded (503) — trying ${modelChain[modelIndex]} ` +
              `(attempt ${attempt}/${maxRetries})\n`
          );
        }

        const delay = parseRetryDelayMs(err, attempt);
        const kind = isUnavailableError(err) ? "503/unavailable" : "429";
        process.stderr.write(
          `  ⏳ ${kind} from ${model} — sleeping ${(delay / 1000).toFixed(1)}s ` +
            `(attempt ${attempt}/${maxRetries})\n`
        );
        await sleep(delay);
        lastCallAt = Date.now() - MIN_INTERVAL_MS;
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error("Gemini extraction failed");
}

function getClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenAI({ apiKey: key });
}

function normalizeExtractions(extractions, messageText, openTasks = [], receivedAt = new Date()) {
  const { applyResolvedDueDate } = require("./dates");

  let list = extractions.map((e) => {
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

    let item = {
      is_noise: Boolean(e.is_noise),
      course: cleanLabel(e.course),
      title: cleanLabel(e.title),
      task_type: e.task_type || null,
      due_date: e.due_date || null,
      weightage: e.weightage == null ? null : Number(e.weightage),
      matched_task_id: matched,
      relation: e.is_noise ? null : relation || "new",
      confidence,
      reasoning: e.reasoning || "",
      date_resolution_note: e.date_resolution_note || null,
    };

    if (!item.is_noise) {
      item = applyResolvedDueDate(item, messageText, receivedAt);
      item = attachMatchIfObvious(item, openTasks, messageText);
    }

    return item;
  });

  list = dedupeExtractions(list);
  return list;
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
  const hits = wb.filter((w) => wa.has(w)).length;
  return hits >= Math.min(2, wb.length);
}

function attachMatchIfObvious(item, openTasks, messageText) {
  if (item.is_noise) return item;

  if (!item.matched_task_id) {
    const msg = norm(messageText);
    const candidates = openTasks.filter((t) => {
      const courseOk =
        !item.course ||
        !t.course ||
        norm(item.course) === norm(t.course) ||
        (t.course_aliases || []).some((a) => norm(a) === norm(item.course));
      if (!courseOk) return false;
      return (
        titlesOverlap(item.title, t.title) ||
        titlesOverlap(msg, t.title) ||
        (item.course &&
          norm(t.course) === norm(item.course) &&
          msg.includes(norm(t.title).split(" ").slice(0, 2).join(" ")))
      );
    });
    if (candidates.length !== 1) return item;
    item.matched_task_id = candidates[0].id;
  }

  const match = openTasks.find((t) => String(t.id) === String(item.matched_task_id));
  if (!match) return item;

  // Resolve language, or any stated date on a task that already needs confirmation.
  if (hasUpdateLanguage(messageText) || (item.due_date && match.status === "needs_confirmation")) {
    item.relation = "explicit_correction";
  } else if (item.due_date && match.due_date && item.due_date === match.due_date) {
    item.relation = "confirmation";
  } else if (item.due_date && match.due_date && item.due_date !== match.due_date) {
    item.relation = "conflicting_report";
  } else if (item.due_date && !match.due_date) {
    item.relation = "explicit_correction";
  } else {
    item.relation = "confirmation";
  }

  return item;
}

/** Collapse duplicate extractions for the same task into one. */
function dedupeExtractions(list) {
  const nonNoise = list.filter((e) => !e.is_noise);
  const noise = list.filter((e) => e.is_noise);

  if (nonNoise.length <= 1) {
    return nonNoise.length ? nonNoise : noise.slice(0, 1);
  }

  const groups = [];
  for (const e of nonNoise) {
    const existing = groups.find((g) => sameTaskGroup(g.rep, e));
    if (existing) {
      existing.items.push(e);
    } else {
      groups.push({ rep: e, items: [e] });
    }
  }

  const merged = groups.map(({ items }) => {
    if (items.length === 1) return items[0];
    const rank = (e) => {
      let s = 0;
      if (e.relation === "explicit_correction") s += 40;
      else if (e.relation === "conflicting_report") s += 30;
      else if (e.relation === "confirmation") s += 20;
      else if (e.relation === "new") s += 5;
      if (e.due_date) s += 15;
      if (e.matched_task_id) s += 10;
      s += e.confidence || 0;
      return s;
    };
    const best = items.slice().sort((a, b) => rank(b) - rank(a))[0];
    // Carry forward the best matched id / due from any sibling
    if (!best.matched_task_id) {
      const withId = items.find((i) => i.matched_task_id);
      if (withId) best.matched_task_id = withId.matched_task_id;
    }
    if (!best.due_date) {
      const withDue = items.find((i) => i.due_date);
      if (withDue) {
        best.due_date = withDue.due_date;
        best.date_resolution_note = withDue.date_resolution_note;
      }
    }
    return best;
  });

  return merged.length ? merged : noise.slice(0, 1);
}

function sameTaskGroup(a, b) {
  if (a.matched_task_id && b.matched_task_id && a.matched_task_id === b.matched_task_id) {
    return true;
  }
  if (a.matched_task_id && !b.matched_task_id) {
    return titlesOverlap(a.title, b.title) && (!a.course || !b.course || norm(a.course) === norm(b.course));
  }
  if (b.matched_task_id && !a.matched_task_id) {
    return titlesOverlap(a.title, b.title) && (!a.course || !b.course || norm(a.course) === norm(b.course));
  }
  return (
    titlesOverlap(a.title, b.title) &&
    (!a.course || !b.course || norm(a.course) === norm(b.course))
  );
}

module.exports = {
  extractAndMatch,
  extractAndMatchChunk,
  normalizeExtractions,
  CONFIDENCE_THRESHOLD,
  SYSTEM_PROMPT,
  MODEL,
  RPM_LIMIT,
  MIN_INTERVAL_MS,
  GEMINI_CHUNK,
  BATCH_SLA_MS,
};
