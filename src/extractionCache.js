/**
 * In-memory LRU cache for Gemini extractions (identical message text).
 * Avoids repeat API calls during batch ingest / re-runs.
 */

const MAX_ENTRIES = 150;

/** @type {Map<string, object[]>} */
const cache = new Map();

function cacheKey(text, taskFingerprint) {
  return `${norm(text)}|${taskFingerprint}`;
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function fingerprintTasks(tasks) {
  return (tasks || [])
    .map((t) => `${t.id}:${t.due || ""}`)
    .sort()
    .join(",");
}

function get(text, openTasks) {
  const key = cacheKey(text, fingerprintTasks(openTasks));
  if (!cache.has(key)) return null;
  const val = cache.get(key);
  cache.delete(key);
  cache.set(key, val);
  return val;
}

function set(text, openTasks, extractions) {
  const key = cacheKey(text, fingerprintTasks(openTasks));
  if (cache.has(key)) cache.delete(key);
  cache.set(key, extractions);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function clear() {
  cache.clear();
}

module.exports = { get, set, clear };
