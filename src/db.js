require("dotenv").config();
const { MongoClient, ObjectId } = require("mongodb");

const DB_NAME = "deadline_agent";

let client;
let db;

function withDbName(url) {
  if (!url) throw new Error("DATABASE_URL is not set");
  // If the path after host is empty or just "/", inject our DB name.
  try {
    const u = new URL(url);
    if (!u.pathname || u.pathname === "/") {
      u.pathname = `/${DB_NAME}`;
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function connect() {
  if (db) return db;
  client = new MongoClient(withDbName(process.env.DATABASE_URL));
  await client.connect();
  db = client.db();
  await ensureIndexes(db);
  return db;
}

async function ensureIndexes(database) {
  await database.collection("courses").createIndex({ name: 1 }, { unique: true });
  await database.collection("tasks").createIndex({ status: 1, due_date: 1 });
  await database.collection("tasks").createIndex({ course_id: 1 });
  await database.collection("task_versions").createIndex({ task_id: 1, created_at: 1 });
  await database.collection("messages").createIndex({ received_at: -1 });
}

async function close() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

function oid(id) {
  if (!id) return null;
  if (id instanceof ObjectId) return id;
  return ObjectId.createFromHexString(String(id));
}

module.exports = { connect, close, oid, ObjectId, DB_NAME };
