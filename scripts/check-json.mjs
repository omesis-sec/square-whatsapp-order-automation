// Fails if any committed JSON file (package.json, Postman files) is invalid.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const files = [
  "package.json",
  ...readdirSync("postman")
    .filter((name) => name.endsWith(".json"))
    .map((name) => join("postman", name)),
];

let failed = false;

for (const file of files) {
  try {
    JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    failed = true;
    console.error(`Invalid JSON in ${file}: ${error.message}`);
  }
}

if (failed) {
  process.exit(1);
}

console.log(`JSON check passed (${files.length} files)`);
