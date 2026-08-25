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
const { ingestMessage } = require("./src/pipeline");
const { dueThisWeek, needsConfirmation, listTasks, taskHistory } = require("./src/queries");
const extractionCache = require("./src/extractionCache");

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    printHelp();
    return;
  }

  await connect();

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
  reset                                      Wipe messages/tasks/versions/courses
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
  console.log(`\n${result.outcome_label}`);
  console.log(result.summary);
  for (const item of result.items || []) {
    console.log(`\n  ${item.action_label}`);
    if (item.subject || item.task) {
      console.log(`  Subject: ${item.subject || "—"}`);
      console.log(`  Task:    ${item.task || "—"}`);
      console.log(`  Due:     ${item.due_display || "Date unknown"}`);
      if (item.status_label) console.log(`  Status:  ${item.status_label}`);
    } else {
      console.log(`  ${item.summary}`);
    }
    if (item.conflict) console.log(`  ${item.conflict.message}`);
    if (item.task_id) console.log(`  id: ${item.task_id}`);
  }
  console.log();
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
    console.log(`• ${t.summary}`);
    console.log(`  Subject: ${t.subject || "—"}  |  Task: ${t.task}`);
    console.log(`  Due: ${t.due_display}  |  Status: ${t.status_label}`);
    if (t.conflict_display) console.log(`  Conflict: ${t.conflict_display}`);
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
    console.log(`• ${t.summary}`);
    console.log(
      `  Subject: ${t.subject || "—"}  |  Task: ${t.task}  |  Type: ${t.task_type}` +
        (t.weightage_display ? `  |  Weight: ${t.weightage_display}` : "")
    );
    console.log(`  Due: ${t.due_display}  |  Status: ${t.status_label}`);
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
  const t = data.task;
  console.log(`\nSubject: ${t.subject || "—"}`);
  console.log(`Task:    ${t.task}`);
  console.log(`Due:     ${t.due_display}  |  Status: ${t.status_label}\n`);
  for (const v of data.versions || []) {
    console.log(`• ${v.reason_label} — ${v.due_display}`);
    if (v.source_excerpt) console.log(`  “${v.source_excerpt}”`);
  }
  console.log();
}

async function cmdRunCorpus() {
  const messages = require("./data/test-messages.json");
  const { RPM_LIMIT, MIN_INTERVAL_MS, MODEL } = require("./src/gemini");

  const estMin = ((messages.length * MIN_INTERVAL_MS) / 60_000).toFixed(1);
  console.log(
    `Replaying ${messages.length} messages via ${MODEL} ` +
      `(~${RPM_LIMIT} RPM, ≥${(MIN_INTERVAL_MS / 1000).toFixed(1)}s between calls, ~${estMin} min)...\n`
  );
  console.log("Required cases covered in corpus:");
  console.log("  • noise — e.g. football / lunch / memes");
  console.log("  • contradiction — Maths 'next Friday' vs 'this Friday'");
  console.log("  • unknown deadline — e.g. 'Science fair registration closes soon'\n");

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
      const actions = (result.items || []).map((i) => i.action || result.outcome).join(",");
      console.log(`→ ${result.outcome} (${actions})`);
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
  await db.collection("courses").deleteMany({});
  extractionCache.clear();
  console.log("Cleared messages, tasks, task_versions, courses, and extraction cache.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  close();
});
