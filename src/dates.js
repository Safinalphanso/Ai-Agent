/**
 * Deterministic date resolution for student messages.
 * Anchors relative phrases and bare day-of-month on receivedAt (defaults to now).
 */

const WEEKDAYS = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function toYmd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function utcMidnight(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/** Nearest upcoming weekday (0=Sun). If today is that weekday, return today. */
function nearestWeekday(from, weekday) {
  const start = utcMidnight(from);
  const diff = (weekday - start.getUTCDay() + 7) % 7;
  return addDays(start, diff);
}

/** Skip nearest, land on the one in the week after. */
function nextWeekday(from, weekday) {
  const nearest = nearestWeekday(from, weekday);
  return addDays(nearest, 7);
}

/**
 * Resolve a relative / partial date phrase in message text.
 * Returns { due_date: "YYYY-MM-DD", note } or null if nothing to resolve.
 */
function resolveDateFromMessage(messageText, receivedAt = new Date()) {
  const text = String(messageText || "");
  const anchor = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);
  if (Number.isNaN(anchor.getTime())) return null;
  const from = utcMidnight(anchor);

  // Explicit ISO already in message — leave to Gemini / caller
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) {
    return { due_date: iso[1], note: `explicit ISO date ${iso[1]}` };
  }

  // tomorrow / today
  if (/\bday after tomorrow\b/i.test(text)) {
    const d = addDays(from, 2);
    return { due_date: toYmd(d), note: `resolved 'day after tomorrow' from ${toYmd(from)} → ${toYmd(d)}` };
  }
  if (/\btomorrow\b/i.test(text)) {
    const d = addDays(from, 1);
    return { due_date: toYmd(d), note: `resolved 'tomorrow' from ${toYmd(from)} → ${toYmd(d)}` };
  }
  if (/\btoday\b/i.test(text) && /\b(due|deadline|submit|submission)\b/i.test(text)) {
    return { due_date: toYmd(from), note: `resolved 'today' → ${toYmd(from)}` };
  }

  // next Friday / this Monday / Friday
  const nextWd = text.match(
    /\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i
  );
  if (nextWd) {
    const wd = WEEKDAYS[nextWd[1].toLowerCase()];
    const d = nextWeekday(from, wd);
    return {
      due_date: toYmd(d),
      note: `resolved 'next ${nextWd[1]}' from ${toYmd(from)} → skipped nearest → ${toYmd(d)}`,
    };
  }

  const thisWd = text.match(
    /\b(?:this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i
  );
  // Avoid matching weekday inside unrelated words; require due/deadline context OR "this <day>"
  if (thisWd) {
    const hasThis = /\bthis\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(
      text
    );
    const dueContext = /\b(due|deadline|submit|submission|by)\b/i.test(text);
    if (hasThis || dueContext) {
      const wd = WEEKDAYS[thisWd[1].toLowerCase()];
      const d = nearestWeekday(from, wd);
      return {
        due_date: toYmd(d),
        note: `resolved '${hasThis ? "this " : ""}${thisWd[1]}' from ${toYmd(from)} → ${toYmd(d)}`,
      };
    }
  }

  // "29th" / "29 August" / "August 29" / "29th Aug"
  const monthNames = {
    january: 0,
    jan: 0,
    february: 1,
    feb: 1,
    march: 2,
    mar: 2,
    april: 3,
    apr: 3,
    may: 4,
    june: 5,
    jun: 5,
    july: 6,
    jul: 6,
    august: 7,
    aug: 7,
    september: 8,
    sep: 8,
    sept: 8,
    october: 9,
    oct: 9,
    november: 10,
    nov: 10,
    december: 11,
    dec: 11,
  };

  const withMonth = text.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\b(?:\s*,?\s*(20\d{2}))?/i
  );
  if (withMonth) {
    const day = Number(withMonth[1]);
    const month = monthNames[withMonth[2].toLowerCase()];
    const year = withMonth[3] ? Number(withMonth[3]) : from.getUTCFullYear();
    const d = new Date(Date.UTC(year, month, day));
    // If month/day already passed this year and year wasn't explicit, roll to next year
    if (!withMonth[3] && d < from) {
      d.setUTCFullYear(year + 1);
    }
    return {
      due_date: toYmd(d),
      note: `resolved '${withMonth[0]}' from ${toYmd(from)} → ${toYmd(d)}`,
    };
  }

  const monthFirst = text.match(
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:\s*,?\s*(20\d{2}))?/i
  );
  if (monthFirst) {
    const month = monthNames[monthFirst[1].toLowerCase()];
    const day = Number(monthFirst[2]);
    const year = monthFirst[3] ? Number(monthFirst[3]) : from.getUTCFullYear();
    const d = new Date(Date.UTC(year, month, day));
    if (!monthFirst[3] && d < from) d.setUTCFullYear(year + 1);
    return {
      due_date: toYmd(d),
      note: `resolved '${monthFirst[0]}' from ${toYmd(from)} → ${toYmd(d)}`,
    };
  }

  // Bare day: "29th" / "updated to 29" — use current month, or next month if day already passed
  const bareDay = text.match(
    /\b(?:due|deadline|updated?\s+to|moved\s+to|on|by)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i
  );
  if (bareDay) {
    const day = Number(bareDay[1]);
    if (day >= 1 && day <= 31) {
      let year = from.getUTCFullYear();
      let month = from.getUTCMonth();
      let d = new Date(Date.UTC(year, month, day));
      if (d < from) {
        month += 1;
        if (month > 11) {
          month = 0;
          year += 1;
        }
        d = new Date(Date.UTC(year, month, day));
      }
      return {
        due_date: toYmd(d),
        note: `resolved day-of-month '${bareDay[1]}' from ${toYmd(from)} → ${toYmd(d)}`,
      };
    }
  }

  return null;
}

/**
 * Prefer deterministic resolution from message text; keep Gemini date if we find nothing.
 */
function applyResolvedDueDate(extraction, messageText, receivedAt) {
  const resolved = resolveDateFromMessage(messageText, receivedAt);
  if (!resolved) return extraction;

  // Always prefer code resolution for relative/partial phrases (more reliable than LLM)
  return {
    ...extraction,
    due_date: resolved.due_date,
    date_resolution_note: resolved.note,
  };
}

module.exports = {
  resolveDateFromMessage,
  applyResolvedDueDate,
  nearestWeekday,
  nextWeekday,
  toYmd,
};
