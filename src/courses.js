const { connect, oid } = require("./db");

const SEED_COURSES = [
  { name: "DBMS", aliases: ["Database Systems", "Db Mgmt Sys", "Database Management", "DB"] },
  { name: "OS", aliases: ["Operating Systems", "Operating System", "Opsys"] },
  { name: "CN", aliases: ["Computer Networks", "Networks", "Networking"] },
  { name: "SE", aliases: ["Software Engineering", "Soft Eng"] },
  { name: "AI", aliases: ["Artificial Intelligence", "ML", "Machine Learning"] },
];

async function seedCourses() {
  const db = await connect();
  const col = db.collection("courses");
  for (const c of SEED_COURSES) {
    await col.updateOne(
      { name: c.name },
      { $setOnInsert: { ...c, created_at: new Date() } },
      { upsert: true }
    );
  }
  return col.find({}).toArray();
}

async function listCourses() {
  const db = await connect();
  return db.collection("courses").find({}).toArray();
}

async function findOrCreateCourse(name) {
  if (!name) return null;
  const db = await connect();
  const col = db.collection("courses");
  const normalized = name.trim();
  const existing = await col.findOne({
    $or: [
      { name: { $regex: `^${escapeRegex(normalized)}$`, $options: "i" } },
      { aliases: { $elemMatch: { $regex: `^${escapeRegex(normalized)}$`, $options: "i" } } },
    ],
  });
  if (existing) return existing;

  const doc = {
    name: normalized,
    aliases: [],
    created_at: new Date(),
  };
  const result = await col.insertOne(doc);
  return { _id: result.insertedId, ...doc };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getOpenTasks(limit = 40) {
  const db = await connect();
  const tasks = await db
    .collection("tasks")
    .find({})
    .sort({ updated_at: -1 })
    .limit(limit)
    .toArray();

  const courseIds = [
    ...new Set(
      tasks
        .map((t) => t.course_id)
        .filter((id) => id != null)
        .map((id) => String(id))
    ),
  ];
  const courses = courseIds.length
    ? await db
        .collection("courses")
        .find({ _id: { $in: courseIds.map(oid) } })
        .toArray()
    : [];
  const byId = Object.fromEntries(courses.map((c) => [String(c._id), c]));

  return tasks.map((t) => ({
    id: String(t._id),
    course: t.course_id ? byId[String(t.course_id)]?.name ?? null : null,
    course_aliases: t.course_id ? byId[String(t.course_id)]?.aliases ?? [] : [],
    title: t.title,
    task_type: t.task_type,
    due_date: t.due_date ? formatDate(t.due_date) : null,
    weightage: t.weightage ?? null,
    status: t.status,
  }));
}

function formatDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

module.exports = {
  seedCourses,
  listCourses,
  findOrCreateCourse,
  getOpenTasks,
  formatDate,
};
