// Regenerates the shipped rule lists from phrases.json.
//
//   bun scripts/sync-rules.mjs          write page/rules.js and the middleware block
//   bun scripts/sync-rules.mjs --check  exit 1 when either file is out of date
//
// The middleware cannot import another file (magpie loads it as one module), so
// the JSON is inlined into two places and this script is the only writer.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const JSON_PATH = path.join(ROOT, "phrases.json");
const PAGE_PATH = path.join(ROOT, "page/rules.js");
const MIDDLEWARE_PATH = path.join(ROOT, "prompt-guard.middleware.js");

const source = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));

if (!Array.isArray(source.phrases) || source.phrases.length === 0) {
  throw new Error("phrases.json has no phrases");
}

const rules = source.phrases.map((phrase) => {
  const rule = { on: true, find: phrase.find, replace: phrase.replace, mode: phrase.mode === "regex" ? "regex" : "text" };
  return rule;
});

const seen = new Set();
for (const rule of rules) {
  if (seen.has(rule.find)) throw new Error(`duplicate phrase: ${rule.find}`);
  seen.add(rule.find);
  if (!rule.find.trim()) throw new Error("empty find");
  if (typeof rule.replace !== "string" || !rule.replace.length) throw new Error(`empty replace for ${rule.find}`);
}

const body = rules
  .map((rule) => {
    const lines = ["  {", "    on: true,", `    find: ${JSON.stringify(rule.find)},`];
    lines.push(`    replace: ${JSON.stringify(rule.replace)},`, `    mode: ${JSON.stringify(rule.mode)},`, "  },");
    return lines.join("\n");
  })
  .join("\n");

const pageFile = `// The rules the plugin ships, generated from phrases.json by
// scripts/sync-rules.mjs — edit the JSON, not this file.
//
// magpie serves page files as classic scripts, so this file publishes one array
// on the global instead of exporting. test/middleware.test.mjs keeps it equal to
// the middleware's copy.

/** @typedef {{on: boolean, find: string, replace: string, mode: "text"|"regex"}} PromptGuardRule */

/** @type {PromptGuardRule[]} */
globalThis.PROMPT_GUARD_RULES = [
${body}
];
`;

const middleware = fs.readFileSync(MIDDLEWARE_PATH, "utf8");
const BEGIN = "  // <rules:begin>";
const END = "  // <rules:end>";
const beginAt = middleware.indexOf(BEGIN);
const endAt = middleware.indexOf(END);
if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
  throw new Error("prompt-guard.middleware.js lost its <rules:begin>/<rules:end> markers");
}
const patched =
  middleware.slice(0, beginAt + BEGIN.length) + "\n" + body + "\n" + middleware.slice(endAt);

const check = process.argv.includes("--check");
const stale = [];
if (fs.readFileSync(PAGE_PATH, "utf8") !== pageFile) stale.push("page/rules.js");
if (middleware !== patched) stale.push("prompt-guard.middleware.js");

if (check) {
  if (stale.length) {
    console.error(`out of date with phrases.json: ${stale.join(", ")}`);
    process.exit(1);
  }
  console.log(`rules in sync: ${rules.length}`);
  process.exit(0);
}

fs.writeFileSync(PAGE_PATH, pageFile);
fs.writeFileSync(MIDDLEWARE_PATH, patched);
console.log(`wrote ${rules.length} rules to page/rules.js and prompt-guard.middleware.js`);
