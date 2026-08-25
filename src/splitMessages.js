/**
 * Split pasted text into individual messages.
 * - Blank-line separated blocks when present (multi-line WhatsApp forwards)
 * - Otherwise one message per non-empty line
 */
function splitMessages(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];

  const hasBlankLine = /\n\s*\n/.test(raw);
  const parts = hasBlankLine
    ? raw.split(/\n\s*\n+/)
    : raw.split(/\n/);

  return parts.map((p) => p.trim()).filter(Boolean);
}

const MAX_BATCH = 100;

module.exports = { splitMessages, MAX_BATCH };
