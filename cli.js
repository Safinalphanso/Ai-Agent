#!/usr/bin/env node
/**
 * Student deadline agent CLI
 *
 *   node cli.js ingest "DBMS report due 28th, 20%"
 *   node cli.js ingest "OS lab due next Friday" --source whatsapp --at 2026-08-24T09:02:00Z
 *   node cli.js due-this-week
 *   node cli.js needs-confirmation
 *   node cli.js list
 *   node cli.js history <taskId>
 *   node cli.js run-corpus
 *   node cli.js reset
 */

require("dotenv").config();
const { connect, close } = require("./src/db");
const { seedCourses } = require("./src/courses");
const { ingestMessage } = require("./src/pipeline");
const { dueThisWeek, needsConfirmation, listTasks, taskHistory } = require("./src/queries");

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    printHelp();
    return;
  }

  await connect();
  await seedCourses();

  try {
    switch (cmd) {
      case "ingest":
        await cmdIngest(rest);
        break;
      case "due-this-week":
        printTasks(await dueThisWeek(), "Due this week");
        break;
      case "needs-confirmation":
        await cmdNeedsConfirmation();
        break;
      case "list":
        printTasks(await listTasks(), "All tasks");
        break;
      case "history":
        await cmdHistory(rest[0]);
        break;
      case "run-corpus":
        await cmdRunCorpus();
        break;
      case "reset":
        await cmdReset();
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        printHelp();
        process.exitCode = 1;
    }
  } finally {
    await close();
  }
}

function printHelp() {
  console.log(`Student deadline agent

Commands:
  ingest <text> [--source TYPE] [--at ISO]   Forward one message
  due-this-week                              SQL-style query from DB
  needs-confirmation                         Tasks awaiting student confirmation
  list                                       All stored tasks
  history <taskId>                           Version audit trail
  run-corpus                                 Replay data/test-messages.json
  reset                                      Wipe messages/tasks/versions (keeps courses)
`);
}

async function cmdIngest(args) {
  const { text, source, at } = parseIngestArgs(args);
  if (!text) {
    console.error('Usage: node cli.js ingest "your message" [--source whatsapp] [--at 2026-08-24T09:00:00Z]');
    process.exitCode = 1;
    return;
  }
  const result = await ingestMessage({
    text,
    source,
    receivedAt: at ? new Date(at) : new Date(),
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseIngestArgs(args) {
  let source = "whatsapp";
  let at = null;
  const textParts = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source") {
      source = args[++i];
    } else if (args[i] === "--at") {
      at = args[++i];
    } else {
      textParts.push(args[i]);
    }
  }
  return { text: textParts.join(" ").trim(), source, at };
}

async function cmdNeedsConfirmation() {
  const tasks = await needsConfirmation();
  console.log(`\nNeeds confirmation (${tasks.length})\n`);
  for (const t of tasks) {
    console.log(`• [${t.course || "?"}] ${t.title}`);
    console.log(`  live due_date: ${t.due_date ?? "(unknown)"}  status: ${t.status}`);
    if (t.claimed_due_dates?.length) {
      console.log(`  claimed dates: ${t.claimed_due_dates.join(" vs ")}`);
    }
    if (t.version_reasons?.length) {
      for (const v of t.version_reasons) {
        console.log(`    - ${v.reason}: ${v.due_date ?? "null"}`);
      }
    }
    console.log(`  id: ${t.id}\n`);
  }
}

function printTasks(tasks, heading) {
  console.log(`\n${heading} (${tasks.length})\n`);
  if (!tasks.length) {
    console.log("(none)\n");
    return;
  }
  for (const t of tasks) {
    const weight = t.weightage != null ? `${t.weightage}%` : "—";
    console.log(
      `• ${t.due_date ?? "????-??-??"}  [${t.status}]  ${t.course || "?"} — ${t.title} (${t.task_type}, ${weight})`
    );
    console.log(`  id: ${t.id}`);
  }
  console.log();
}

async function cmdHistory(taskId) {
  if (!taskId) {
    console.error("Usage: node cli.js history <taskId>");
    process.exitCode = 1;
    return;
  }
  const data = await taskHistory(taskId);
  if (!data) {
    console.error("Task not found");
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

async function cmdRunCorpus() {
  const messages = require("./data/test-messages.json");
  const { RPM_LIMIT, MIN_INTERVAL_MS, MODEL } = require("./src/gemini");
  const estMin = ((messages.length * MIN_INTERVAL_MS) / 60_000).toFixed(1);
  console.log(
    `Replaying ${messages.length} messages via ${MODEL} ` +
      `(~${RPM_LIMIT} RPM, ≥${(MIN_INTERVAL_MS / 1000).toFixed(1)}s between calls, ~${estMin} min)...\n`
  );
  let i = 0;
  for (const m of messages) {
    i += 1;
    process.stdout.write(`[${i}/${messages.length}] ${m.source || "msg"}: ${m.text.slice(0, 70)}... `);
    try {
      const result = await ingestMessage({
        text: m.text,
        source: m.source || "whatsapp",
        receivedAt: m.received_at ? new Date(m.received_at) : new Date(),
      });
      const actions = result.results.map((r) => r.action || r.classification).join(",");
      console.log(`→ ${result.classification} (${actions})`);
    } catch (err) {
      console.log(`→ ERROR: ${err.message}`);
    }
  }
  console.log("\n--- Due this week ---");
  printTasks(await dueThisWeek(new Date("2026-08-23T00:00:00Z")), "Due this week (from 2026-08-23)");
  console.log("--- Needs confirmation ---");
  await cmdNeedsConfirmation();
}

async function cmdReset() {
  const db = await connect();
  await db.collection("messages").deleteMany({});
  await db.collection("task_versions").deleteMany({});
  await db.collection("tasks").deleteMany({});
  console.log("Cleared messages, tasks, and task_versions.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  close();
});
