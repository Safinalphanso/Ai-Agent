#!/usr/bin/env node
require("dotenv").config();
const { connect, close } = require("../src/db");
const { seedCourses } = require("../src/courses");

async function main() {
  await connect();
  const courses = await seedCourses();
  console.log(`Seeded ${courses.length} courses:`);
  for (const c of courses) {
    console.log(`  - ${c.name} (${(c.aliases || []).join(", ")})`);
  }
  await close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
