#!/usr/bin/env node
require("dotenv").config();
const { connect, close } = require("../src/db");

async function main() {
  await connect();
  console.log("Database connected. Add subjects via the UI or POST /courses.");
  await close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
