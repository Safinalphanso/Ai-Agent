# Student Deadline Agent

Ingest scattered student messages (WhatsApp, email, class, syllabus). Extract deadlines into MongoDB, update instead of duplicating, flag contradictions / unknown dates, and answer queries from the database — never from chat history.

## Quick start (≈5 minutes)

### 1. Prerequisites
- Node.js 18+
- MongoDB Atlas (or local) connection string
- [Gemini API key](https://aistudio.google.com/apikey)

### 2. Configure
```bash
cp .env.example .env
```
Edit `.env`:
```
PORT=3000
DATABASE_URL=mongodb+srv://USER:PASSWORD@cluster.mongodb.net/deadline_agent?appName=Cluster0
GEMINI_API_KEY=your_key_here
```

### 3. Install & run
```bash
npm install
npm run setup          # seed courses (DBMS, OS, CN, SE, AI)
```

**CLI (recommended for the demo):**
```bash
# Forward one message
node cli.js ingest "DBMS report submission on 28th August, worth 20%" --source email

# Explicit correction (updates, does not duplicate)
node cli.js ingest "DBMS report due 25th not 28th" --source whatsapp

# Unknown deadline → needs_confirmation, due_date null
node cli.js ingest "Hackathon registration closes soon, don't miss it"

# Contradiction walkthrough (colloquial Fridays)
# "next Friday" = week after nearest Friday; "this Friday" = nearest upcoming
node cli.js ingest "OS Lab 3 is due Friday 28 August" --source class --at 2026-08-20T12:30:00Z
node cli.js ingest "OS lab due next Friday" --source whatsapp --at 2026-08-24T09:02:00Z
node cli.js ingest "OS lab submission deadline: this Friday" --source email --at 2026-08-25T18:40:00Z

node cli.js needs-confirmation
node cli.js due-this-week
node cli.js list
```

**Replay the full 80-message corpus:**
```bash
node cli.js reset
node cli.js run-corpus
```

**HTTP API + frontend (recommended for interactive testing):**
```bash
# terminal 1 — API
npm run dev

# terminal 2 — UI (from ../frontend)
cd ../frontend && npm install && npm run dev
# open http://localhost:5173
```

The UI can forward messages, run demo presets (noise / correction / unknown / Friday conflict), list tasks, open version history, and reset the DB.

## What it does

| Case | Behavior |
|------|----------|
| Noise ("football at 6?") | Logged only — no task |
| New deadline | Insert task + `task_versions` (`initial`) |
| Explicit correction ("25th not 28th") | Update live `due_date`, append version |
| Conflicting report (no override words) | **Keep** live date, append version, `needs_confirmation` |
| Unknown date ("closes soon") | Insert with `due_date: null`, `needs_confirmation` |
| "What's due this week?" | Plain Mongo query — no LLM |

## Architecture

One Gemini structured-output call per message (`extractAndMatch`) sees the open task list and returns `relation`: `new` | `explicit_correction` | `conflicting_report` | `confirmation` (or `is_noise`). The backend only routes — it does not re-judge.

```
message → open tasks from Mongo → Gemini JSON schema → pipeline router → Mongo
                                                              ↓
                                              queries (due this week / needs confirmation)
```

**Full write-up** (file structure, every scenario with examples, test formats, architecture diagrams): [`docs/COMPLETE-SYSTEM-GUIDE.md`](docs/COMPLETE-SYSTEM-GUIDE.md).

See also [`docs/deadline-agent-flow.md`](docs/deadline-agent-flow.md) for the original reference design (adapted here from Postgres to MongoDB collections with the same fields).

## Project layout

```
cli.js                 # CLI entry
server.js              # Express API
src/db.js              # Mongo connection
src/courses.js         # Courses + open-task context
src/gemini.js          # Structured Gemini call
src/pipeline.js        # Relation router
src/queries.js         # Read path (no LLM)
data/test-messages.json # 80 fake messages (noise, contradiction, unknown date)
```

## Demo checklist (screen recording)

1. Reset DB → ingest DBMS report (28th, 20%) → list
2. Ingest "due 25th not 28th" → show updated date (not a second task)
3. Ingest "Hackathon registration closes soon" → `needs-confirmation` with null date
4. OS lab Fri 28 Aug → WhatsApp "next Friday" (→ Sep 4, conflict) → email "this Friday" (→ Aug 28, confirmation) → `needs-confirmation` still shows both dates
5. `due-this-week` / `list` from DB

## Notes

- Keys stay in `.env` (gitignored). Never commit secrets.
- Model: `gemini-2.5-flash` only (no fake fallback models).
- Rate limit: proactive spacing for free-tier **5 RPM** (`GEMINI_RPM` to override), plus real `sleep` on 429 using the API's `retryDelay`.
- Confidence below 0.6 refuses to update an existing task (avoids silent wrong merges).
